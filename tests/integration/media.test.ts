import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../packages/infrastructure/src/store.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { demo } from '../../packages/application/src/demo.js';
import { PathPolicy } from '../../packages/infrastructure/src/security.js';
import { Renderer } from '../../packages/media/src/render.js';
import type { EditorialIR, RenderIR } from '../../packages/core/src/domain.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import { defaultRender } from '../../packages/core/src/ir.js';
import { inspectVideo } from '../../packages/media/src/quality.js';
import { extractJpeg } from '../../packages/media/src/media-frames.js';

test(
  'real frozen output reaches review with EOF intervals and declared freeze separated',
  { timeout: 60000 },
  async (t) => {
    const store = new Store(await mkdtemp(path.join(tmpdir(), 'filmedit-freeze-')));
    t.after(() => store.close());
    const task = await createTask(store, {
      prompt: '冻结检测回归',
      materials: { strategy: 'local_only' },
      output: { width: 320, height: 180, fps: 8, duration: 9 },
    });
    const runner = new TaskRunner(store, task.id);
    const source = path.join(task.policy.workspace, 'frozen.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=8:duration=3',
      '-vf',
      'tpad=start_mode=clone:start_duration=3:stop_mode=clone:stop_duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      source,
    ]);
    const asset = await runner.library.importFile(source, 'generated');
    const edit = editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration: 9,
      shots: [
        {
          id: 'intentional',
          assetId: asset.id,
          start: 0,
          duration: 3.125,
          sourceStart: 0,
          techniques: [{ id: 'freeze', version: 1 }],
        },
        { id: 'should_play', assetId: asset.id, start: 3.125, duration: 5.875, sourceStart: 3.125 },
      ],
    });
    const report = await inspectVideo(source, edit, defaultRender(edit, task.spec.output), runner.processes);
    assert.ok(
      report.issues.some((issue) => /Frozen interval/.test(issue.message)),
      'a detected frozen tail must reach the independent reviewer',
    );
    assert.equal(report.passed, true, 'detector alone cannot decide whether still imagery is intentional');
    assert.ok(
      report.visualAnalysis.frozenIntervals.some((range) => range.declaredFreeze && range.start === 0),
    );
    assert.ok(
      report.visualAnalysis.frozenIntervals.some(
        (range) => !range.declaredFreeze && range.start > 5 && range.end === 9,
      ),
      'freeze without an end marker must extend to EOF',
    );
    assert.ok(report.frames.some((frame) => frame.time > 7));
  },
);

test('12 fps preview of a 30 fps plan includes a valid final JPEG with full-range pixels', async (t) => {
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'filmedit-frames-')));
  t.after(() => store.close());
  const task = await createTask(store, {
    prompt: '抽帧回归',
    materials: { strategy: 'local_only' },
    output: { width: 320, height: 480, fps: 30, duration: 1 },
  });
  const runner = new TaskRunner(store, task.id);
  const source = path.join(task.policy.workspace, 'preview.mp4');
  await runner.processes.run('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=white:size=320x480:rate=12:duration=1',
    '-vf',
    'drawbox=x=0:y=0:w=160:h=480:color=black:t=fill',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-color_range',
    'tv',
    source,
  ]);
  const asset = await runner.library.importFile(source, 'generated');
  const cut = editorialSchema.parse({
    schemaVersion: 1,
    revision: 0,
    duration: 1,
    shots: [{ id: 'shot_a', assetId: asset.id, sourceStart: 0, start: 0, duration: 1 }],
  });
  const report = await inspectVideo(
    source,
    cut,
    defaultRender(cut, task.spec.output),
    runner.processes,
    true,
  );
  assert.equal(report.passed, true);
  assert.equal(report.frames.at(-1)!.time, 11 / 12);
  for (const frame of report.frames) assert.ok((await stat(frame.path)).size > 0);
  const materialFrames = await runner.library.frames(asset.id, [0]);
  const continuous = path.join(task.policy.workspace, 'continuous.jpg');
  await extractJpeg(runner.processes, report.continuousClips[0]!.path, continuous, { time: 0.75 });
  for (const file of [report.frames.at(-1)!.path, materialFrames[0]!.path, continuous]) {
    const probe = await runner.processes.run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=color_range',
      '-of',
      'json',
      file,
    ]);
    assert.equal(JSON.parse(probe.stdout).streams[0].color_range, 'pc');
    const decoded = `${file}.gray`;
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      file,
      '-frames:v',
      '1',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      decoded,
    ]);
    const pixels = await readFile(decoded);
    assert.ok(pixels[80]! < 4, 'black must be expanded to zero, not just relabeled as full range');
    assert.ok(pixels[240]! > 251, 'white must be expanded to 255');
  }
  await assert.rejects(extractJpeg(runner.processes, source, continuous, { time: 2 }), {
    code: 'FRAME_EMPTY',
  });
  await assert.rejects(
    stat(continuous),
    { code: 'ENOENT' },
    'stale frames must not mask an empty extraction',
  );
});

test(
  'real HyperFrames + FFmpeg render produces aligned video/audio and review frames',
  { timeout: 180000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'filmedit-render-'));
    const store = new Store(root);
    t.after(() => store.close());
    const result = await demo(store);
    assert.equal(result.quality.passed, true);
    assert.ok(result.quality.frames.length >= 5);
    assert.equal(result.aiReviewed, false);
    const runner = new TaskRunner(store, result.taskId);
    const editorial = store.artifact<EditorialIR>(result.taskId, 'demo.editorial')!.data;
    const layout = store.artifact<RenderIR>(result.taskId, 'demo.layout')!.data;
    const digest = () =>
      runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-i',
        result.path,
        '-map',
        '0:v:0',
        '-f',
        'framemd5',
        '-',
      ]);
    const first = await digest();
    await new Renderer(runner.library, runner.processes).render(editorial, layout);
    assert.equal(
      (await digest()).stdout,
      first.stdout,
      'Same pinned environment must reproduce decoded frames',
    );
    const overflow = structuredClone(layout);
    const caption = overflow.nodes.find((node) => node.kind === 'text')!;
    caption.placement = { mode: 'rect', rect: [0, 0, 0.05, 0.01] };
    await assert.rejects(new Renderer(runner.library, runner.processes).render(editorial, overflow), {
      code: 'LAYOUT_OVERFLOW',
    });
  },
);
test('asset cache detects changed files and permission revocation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'filmedit-cache-'));
  const file = path.join(root, 'captions.srt');
  await writeFile(file, '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  const store = new Store(path.join(root, 'state'));
  t.after(() => store.close());
  const task = await createTask(store, {
    prompt: 'test',
    materials: { paths: [file], strategy: 'local_only' },
  });
  const runner = new TaskRunner(store, task.id);
  const [asset] = await runner.library.importPaths([file]);
  assert.ok(asset);
  await writeFile(file, 'changed');
  await assert.rejects(runner.library.resolve(asset.id), { code: 'ASSET_CHANGED' });
  const revoked = await PathPolicy.create(task.policy.workspace, {
    ...task.spec,
    access: { ...task.spec.access, denyPaths: [file] },
  });
  store.replacePolicy(task.id, revoked.data);
  await assert.rejects(new TaskRunner(store, task.id).library.resolve(asset.id), { code: 'PATH_DENIED' });
});
