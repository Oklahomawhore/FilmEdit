import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import { defaultRender, validateEditorial } from '../../packages/core/src/ir.js';
import { Renderer } from '../../packages/media/src/render.js';
import { hash } from '../../packages/core/src/util.js';
import { validateScopedEditorial, validateScopedLayout } from '../../packages/core/src/revision.js';

test(
  'different-source split screen, inset and keyed foreground survive actual HTML/FFmpeg rendering',
  { timeout: 180000 },
  async (t) => {
    const { store } = await fixture();
    t.after(() => store.close());
    const task = await createTask(store, {
      prompt: '多轨渲染验收',
      creative: { enabled: false },
      materials: { strategy: 'local_only' },
      output: { duration: 3 },
    });
    const runner = new TaskRunner(store, task.id);
    const sources = [];
    for (const [name, filter] of [
      ['background', 'color=blue:size=320x180:rate=12:duration=3'],
      [
        'foreground',
        'color=lime:size=320x180:rate=12:duration=3,drawbox=x=80:y=40:w=160:h=100:color=red:t=fill',
      ],
    ]) {
      const file = path.join(task.policy.workspace, `${name}.mp4`);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        filter!,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        file,
      ]);
      sources.push(await runner.library.importFile(file, 'generated'));
    }
    const [background, foreground] = sources;
    const cut = validateEditorial(
      editorialSchema.parse({
        schemaVersion: 1,
        revision: 0,
        duration: 3,
        shots: [
          { id: 'base_split', assetId: background!.id, track: 0, sourceStart: 0, start: 0, duration: 1 },
          { id: 'base_full', assetId: background!.id, track: 0, sourceStart: 1, start: 1, duration: 2 },
          { id: 'split', assetId: foreground!.id, track: 1, sourceStart: 0, start: 0, duration: 1 },
          { id: 'inset', assetId: foreground!.id, track: 1, sourceStart: 1, start: 1, duration: 1 },
          {
            id: 'keyed',
            assetId: foreground!.id,
            track: 1,
            sourceStart: 2,
            start: 2,
            duration: 1,
            techniques: [
              { id: 'chromakey', version: 1, params: { color: '0x00ff00', similarity: 0.2, blend: 0 } },
            ],
          },
        ],
      }),
      sources,
    );
    const layout = defaultRender(cut, { width: 320, height: 180, fps: 12 });
    const node = (id: string) => layout.nodes.find((n) => n.bindingId === id)!;
    node('base_split').placement = { mode: 'rect', rect: [0, 0, 0.5, 1] };
    node('split').placement = { mode: 'rect', rect: [0.5, 0, 0.5, 1] };
    node('split').techniques = [{ id: 'split_screen', version: 1, params: {} }];
    node('inset').placement = { mode: 'rect', rect: [0.55, 0.05, 0.4, 0.4] };
    node('inset').techniques = [{ id: 'picture_in_picture', version: 1, params: {} }];
    const result = await new Renderer(runner.library, runner.processes).render(cut, layout);
    const samples = new Map<number, Buffer>();
    for (const [time, red, blue] of [
      [0.5, [240, 90], [80, 90]],
      [1.5, [240, 45], [80, 90]],
      [2.5, [160, 90], [20, 20]],
    ] as const) {
      const frame = path.join(result.exportDirectory, `frame-${time}.rgb`);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        String(time),
        '-i',
        result.path,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        frame,
      ]);
      const rgb = await readFile(frame);
      samples.set(time, rgb);
      const sample = ([x, y]: readonly number[]) => [
        ...rgb.subarray((y! * 320 + x!) * 3, (y! * 320 + x!) * 3 + 3),
      ];
      const r = sample(red),
        b = sample(blue);
      assert.ok(r[0]! > 180 && r[1]! < 60 && r[2]! < 60, `foreground at ${time}s: ${r}`);
      assert.ok(b[2]! > 180 && b[0]! < 60 && b[1]! < 60, `background at ${time}s: ${b}`);
    }
    const revised = structuredClone(cut);
    revised.revision++;
    revised.shots.find((s) => s.id === 'base_split')!.assetId = foreground!.id;
    revised.shots.find((s) => s.id === 'split')!.assetId = background!.id;
    const revisedLayout = { ...layout, editorialHash: hash(revised) };
    const guard = { version: 2, scope: { start: 0, end: 1 }, editorial: cut, layout };
    validateScopedEditorial(revised, guard, sources);
    validateScopedLayout(revisedLayout, revised, guard);
    const revision = await new Renderer(runner.library, runner.processes).render(revised, revisedLayout);
    for (const time of [0.5, 1.5, 2.5]) {
      const frame = path.join(revision.exportDirectory, `comparison-${time}.rgb`);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        String(time),
        '-i',
        revision.path,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        frame,
      ]);
      const data = await readFile(frame),
        original = samples.get(time)!;
      assert.equal(data.length, original.length);
      const difference =
        data.reduce((sum, value, index) => sum + Math.abs(value - original[index]!), 0) / data.length;
      assert.ok(
        time < 1 ? difference > 50 : difference < 2,
        `scoped edit at ${time}s has mean pixel difference ${difference}`,
      );
    }
    store.saveArtifact(task.id, 'verification.multitrack', { ...result, editorial: cut, layout }, true);
  },
);
