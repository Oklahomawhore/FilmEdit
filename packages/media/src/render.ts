import path from 'node:path';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import type { EditorialIR, RenderIR } from '../../core/src/domain.js';
import { validateRender } from '../../core/src/ir.js';
import { compileHtml } from './compositor.js';
import { z } from 'zod';
import {
  resolveExport,
  exportVideoFilter,
  projectCanvas,
  type ExportProfileInput,
  type ExportProfile,
} from '../../core/src/presentation.js';
import { AssetLibrary, modelEnvironment, modelRoots, safeDemuxers, safeProtocols } from './assets.js';
import { ProcessRunner, projectRoot, runtimeScript } from '../../infrastructure/src/process.js';
import { hash, invariant, FilmError } from '../../core/src/util.js';
import { videoFilters } from './techniques.js';
import { tempoFilters, validateTechniques, validateEditingTechniques } from '../../core/src/techniques.js';
import { ReleaseManager } from '../../infrastructure/src/releases.js';
import { PathPolicy } from '../../infrastructure/src/security.js';

const require = createRequire(import.meta.url);
export const RENDERER_VERSION = 'composition-export-v2-immutable';
export class Renderer {
  constructor(
    readonly library: AssetLibrary,
    readonly runner: ProcessRunner,
    readonly releaseOverride?: string,
  ) {}
  private async compileRelease(
    directory: string,
    releaseId: string,
    operation: 'html' | 'filters',
    input: unknown,
  ) {
    const releases = new ReleaseManager(this.library.store);
    await releases.verify(releaseId);
    const release = releases.get(releaseId);
    const workspace = path.join(directory, 'compiler', operation);
    await mkdir(workspace, { recursive: true });
    const source = path.join(workspace, 'input.json');
    await this.library.policy.write(source, JSON.stringify(input));
    const policy = await PathPolicy.create(workspace, {
      materials: { paths: [source], strategy: 'local_only' },
      access: { readPaths: [], writePaths: [], denyPaths: [] },
    });
    try {
      await new ProcessRunner(policy, this.runner.signal).run(
        process.execPath,
        [
          runtimeScript('compiler-worker.js'),
          operation === 'html' ? release.manifest.compiler : release.manifest.filters,
          workspace,
          operation,
        ],
        {
          extraReads: ['dist', 'node_modules', 'package.json'].map((item) =>
            path.join(release.manifest.directory, item),
          ),
        },
      );
      return await this.library.policy.read(
        path.join(workspace, operation === 'html' ? 'output.html' : 'output.json'),
      );
    } catch (error) {
      if (this.library.store.activeRelease() === releaseId)
        releases.rollback('Compiler failed during task rendering');
      throw error;
    }
  }
  async prepare(editorial: EditorialIR, render: RenderIR): Promise<string> {
    validateRender(render, editorial);
    validateTechniques(editorial, render);
    validateEditingTechniques(editorial, this.library.store.assets(this.library.taskId), render.canvas.fps);
    const directory = path.join(
      this.library.policy.data.workspace,
      'render',
      hash({
        editorial,
        render,
        compiler: RENDERER_VERSION,
        release: this.releaseOverride ?? this.library.store.task(this.library.taskId).releaseId,
      }),
    );
    await this.library.policy.check(directory, 'write');
    await mkdir(path.join(directory, 'assets'), { recursive: true });
    const releaseId = this.releaseOverride ?? this.library.store.task(this.library.taskId).releaseId;
    const filterPlan =
      releaseId === 'builtin_v1'
        ? Object.fromEntries(editorial.shots.map((shot) => [shot.id, videoFilters(shot)]))
        : z
            .record(z.string(), z.array(z.string().max(4096)).max(32))
            .parse(
              JSON.parse(
                (await this.compileRelease(directory, releaseId, 'filters', { editorial })).toString(),
              ),
            );
    invariant(
      Object.keys(filterPlan).length === editorial.shots.length &&
        editorial.shots.every((shot) => Array.isArray(filterPlan[shot.id])),
      'RENDER_FILTERS',
      'Filter compiler must return one filter list per shot',
    );
    const prepared = new Map<string, string>();
    for (const shot of editorial.shots) {
      const asset = this.library.store.asset(this.library.taskId, shot.assetId);
      const original = await this.library.resolve(shot.assetId);
      // Learned filters execute only against this selected source, never other task media or the learning reference.
      const sourcePolicy = await PathPolicy.create(directory, {
        materials: { paths: [original], strategy: 'local_only' },
        access: { readPaths: [], writePaths: [], denyPaths: [] },
      });
      const processes = new ProcessRunner(sourcePolicy, this.runner.signal);
      const filters = [...filterPlan[shot.id]!];
      const matte = shot.techniques.some((t) => t.id === 'portrait_matte');
      const key = shot.techniques.some((t) => t.id === 'chromakey');
      if (asset.kind === 'image' && !matte && !key && filters.length === 0) {
        const name = `${shot.id}${path.extname(original)}`;
        await this.library.snapshot(asset.id, path.join(directory, 'assets', name));
        prepared.set(shot.id, `./assets/${name}`);
        continue;
      }
      const alpha = matte || key;
      const freeze = shot.techniques.some((t) => t.id === 'freeze');
      const staticMatte = matte && (asset.kind === 'image' || freeze);
      const name = `${shot.id}.${staticMatte ? 'png' : alpha ? 'webm' : 'mp4'}`;
      const output = path.join(directory, 'assets', name);
      if (freeze) filters.unshift(`trim=end_frame=1`, `tpad=stop_mode=clone:stop_duration=${shot.duration}`);
      else filters.push(`setpts=(PTS-STARTPTS)/${shot.speed}`);
      filters.push(`fps=${render.canvas.fps}`);
      if (matte) {
        const frames = path.join(directory, 'matte', shot.id);
        await mkdir(frames, { recursive: true });
        await processes.run('ffmpeg', [
          '-nostdin',
          '-v',
          'error',
          '-y',
          ...safeProtocols,
          ...safeDemuxers,
          ...(asset.kind === 'image' ? ['-loop', '1'] : ['-ss', String(shot.sourceStart)]),
          '-i',
          original,
          '-an',
          '-vf',
          filters.join(','),
          '-t',
          String(shot.duration),
          ...(staticMatte ? ['-frames:v', '1'] : []),
          path.join(frames, 'source-%06d.png'),
        ]);
        await processes.run(
          process.env.FILMEDIT_PYTHON ?? 'python3',
          [path.join(projectRoot, 'python', 'media_worker.py'), 'matte', frames],
          { extraReads: modelRoots(), env: modelEnvironment(), timeoutMs: 900000 },
        );
        if (staticMatte) {
          await this.library.policy.write(
            output,
            await this.library.policy.read(path.join(frames, 'alpha-000001.png')),
          );
        } else
          await processes.run('ffmpeg', [
            '-nostdin',
            '-v',
            'error',
            '-y',
            '-framerate',
            String(render.canvas.fps),
            '-i',
            path.join(frames, 'alpha-%06d.png'),
            '-c:v',
            'libvpx-vp9',
            '-pix_fmt',
            'yuva420p',
            '-auto-alt-ref',
            '0',
            output,
          ]);
      } else {
        const args = [
          '-nostdin',
          '-v',
          'error',
          '-y',
          ...safeProtocols,
          ...safeDemuxers,
          ...(asset.kind === 'image'
            ? ['-loop', '1']
            : [
                '-ss',
                String(shot.sourceStart),
                '-t',
                String(
                  freeze ? Math.min(0.1, asset.duration - shot.sourceStart) : shot.duration * shot.speed,
                ),
              ]),
          '-i',
          original,
          '-an',
          '-vf',
          filters.join(','),
          '-t',
          String(shot.duration),
          '-c:v',
          alpha ? 'libvpx-vp9' : 'libx264',
          '-pix_fmt',
          alpha ? 'yuva420p' : 'yuv420p',
          ...(alpha ? ['-auto-alt-ref', '0'] : ['-preset', 'veryfast']),
          output,
        ];
        await processes.run('ffmpeg', args, { timeoutMs: 900000 });
      }
      prepared.set(shot.id, `./assets/${name}`);
    }
    await this.library.policy.write(
      path.join(directory, 'gsap.min.js'),
      await readFile(require.resolve('gsap/dist/gsap.min.js')),
    );
    if (releaseId === 'builtin_v1')
      await this.library.policy.write(
        path.join(directory, 'index.html'),
        compileHtml(editorial, render, prepared),
      );
    else
      await this.library.policy.write(
        path.join(directory, 'index.html'),
        await this.compileRelease(directory, releaseId, 'html', {
          editorial,
          render,
          prepared: [...prepared],
        }),
      );
    await this.library.policy.write(path.join(directory, 'ir.json'), JSON.stringify({ editorial, render }));
    return directory;
  }
  async render(editorial: EditorialIR, render: RenderIR, preview = false, exportInput?: ExportProfileInput) {
    const profile = resolveExport(exportInput, render.canvas);
    const effectiveProfile = { ...profile, fps: preview ? Math.min(profile.fps, 12) : profile.fps };
    for (const assetId of new Set([...editorial.shots, ...editorial.audio].map((x) => x.assetId)))
      await this.library.resolve(assetId);
    const directory = await this.prepare(editorial, render);
    const exportRoot = path.join(directory, 'exports', hash({ profile, preview }));
    await this.library.policy.check(exportRoot, 'write');
    await mkdir(exportRoot, { recursive: true });
    // Review imports outputs as immutable, hashed assets. A repeated render must not
    // overwrite a file still referenced by earlier observations or recovery checkpoints.
    const exportDirectory = await mkdtemp(path.join(exportRoot, 'run-'));
    const silent = path.join(exportDirectory, 'silent.mp4');
    const browser = await browserConfiguration();
    const renderPolicy = await PathPolicy.create(directory, {
      materials: {
        paths: [
          path.join(directory, 'assets'),
          path.join(directory, 'index.html'),
          path.join(directory, 'gsap.min.js'),
        ],
        strategy: 'local_only',
      },
      access: { readPaths: [], writePaths: [], denyPaths: [] },
    });
    try {
      await new ProcessRunner(renderPolicy, this.runner.signal).run(
        process.execPath,
        [
          runtimeScript('render-worker.js'),
          directory,
          silent,
          String(effectiveProfile.fps),
          preview ? 'preview' : 'final',
        ],
        {
          browser: true,
          domains: ['localhost', '127.0.0.1'],
          extraReads: [browser.root],
          env: {
            PRODUCER_HEADLESS_SHELL_PATH: browser.binary,
            PUPPETEER_EXECUTABLE_PATH: browser.binary,
            PRODUCER_DISABLE_GPU: 'true',
            PRODUCER_FORCE_SCREENSHOT: 'true',
            PRODUCER_MAX_WORKERS: '1',
          },
          timeoutMs: 3600000,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('LAYOUT_OVERFLOW'))
        throw new FilmError('LAYOUT_OVERFLOW', error.message);
      throw error;
    }
    const output = path.join(exportDirectory, preview ? 'preview.mp4' : 'final.mp4');
    await this.mix(editorial, silent, output, effectiveProfile);
    const result = {
      rendererVersion: RENDERER_VERSION,
      releaseId: this.releaseOverride ?? this.library.store.task(this.library.taskId).releaseId,
      path: output,
      directory,
      exportDirectory,
      editorialHash: hash(editorial),
      renderHash: hash(render),
      preview,
      exportProfile: effectiveProfile,
      exportHash: hash(profile),
      projection: projectCanvas(render.canvas, profile),
    };
    await this.library.policy.write(
      path.join(exportDirectory, 'export.json'),
      JSON.stringify(result, null, 2),
    );
    return result;
  }
  async mix(editorial: EditorialIR, video: string, output: string, profile?: ExportProfile) {
    const args = ['-nostdin', '-v', 'error', '-y', '-i', video];
    const filters: string[] = [];
    for (let i = 0; i < editorial.audio.length; i++) {
      const clip = editorial.audio[i]!;
      const source = await this.library.resolve(clip.assetId);
      args.push(
        ...safeProtocols,
        ...safeDemuxers,
        '-ss',
        String(clip.sourceStart),
        '-t',
        String(clip.duration * clip.speed),
        '-i',
        source,
      );
      const processing = [
        ...tempoFilters(clip.speed),
        `atrim=duration=${clip.duration}`,
        'asetpts=PTS-STARTPTS',
        'aresample=48000',
        `volume=${clip.volume}`,
        ...(clip.fadeIn ? [`afade=t=in:d=${clip.fadeIn}`] : []),
        ...(clip.fadeOut
          ? [`afade=t=out:st=${Math.max(0, clip.duration - clip.fadeOut)}:d=${clip.fadeOut}`]
          : []),
        `adelay=${Math.round(clip.start * 1000)}:all=1`,
      ];
      filters.push(`[${i + 1}:a]${processing.join(',')}[a${i}]`);
    }
    if (editorial.audio.length) {
      // Duck music deterministically over declared speech intervals; no speech detector affects timing.
      const labels = editorial.audio.map((clip, i) => {
        if (!clip.duck || clip.role !== 'music') return `[a${i}]`;
        const speech = editorial.audio.filter((a) => ['narration', 'dialogue'].includes(a.role));
        if (!speech.length) return `[a${i}]`;
        const condition = speech.map((s) => `between(t,${s.start},${s.start + s.duration})`).join('+');
        filters.push(`[a${i}]volume='if(gt(${condition},0),0.25,1)':eval=frame[d${i}]`);
        return `[d${i}]`;
      });
      filters.push(
        `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,alimiter=limit=0.95,apad,atrim=duration=${editorial.duration}[mix]`,
      );
      args.push(
        '-filter_complex',
        filters.join(';'),
        '-map',
        '0:v:0',
        '-map',
        '[mix]',
        '-c:a',
        'aac',
        '-ar',
        '48000',
      );
    } else args.push('-map', '0:v:0', '-an');
    if (profile)
      args.push(
        '-vf',
        exportVideoFilter(profile),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
      );
    else args.push('-c:v', 'copy');
    args.push('-t', String(editorial.duration), '-movflags', '+faststart', output);
    await this.runner.run('ffmpeg', args, { timeoutMs: 900000 });
  }
}
export async function browserConfiguration() {
  const binary: string =
    process.env.PRODUCER_HEADLESS_SHELL_PATH ??
    process.env.PUPPETEER_EXECUTABLE_PATH ??
    (await require('puppeteer').executablePath({ headless: 'shell' }));
  invariant(
    binary && existsSync(binary),
    'BROWSER_MISSING',
    'Install the pinned Puppeteer browser or set PRODUCER_HEADLESS_SHELL_PATH',
  );
  const app = binary.indexOf('.app/');
  return { binary, root: app >= 0 ? binary.slice(0, app + 4) : path.dirname(binary) };
}
