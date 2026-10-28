import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixture } from '../helpers.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import { defaultRender } from '../../packages/core/src/ir.js';
import { Renderer } from '../../packages/media/src/render.js';
import { hash } from '../../packages/core/src/util.js';
import { inspectVideo } from '../../packages/media/src/quality.js';

test(
  'same composition exports to 16:9, 4:3 and 9:16 without losing source edges; late shot animation plays',
  { timeout: 240000 },
  async (t) => {
    const { store } = await fixture();
    t.after(() => store.close());
    const task = await createTask(store, {
      prompt: 'export regression',
      creative: { enabled: false },
      materials: { strategy: 'local_only' },
      output: { duration: 2 },
    });
    const runner = new TaskRunner(store, task.id),
      source = path.join(task.policy.workspace, 'edges.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=blue:size=320x180:rate=12:duration=2',
      '-vf',
      'drawbox=x=0:y=0:w=32:h=180:color=red:t=fill,drawbox=x=288:y=0:w=32:h=180:color=lime:t=fill',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      source,
    ]);
    const asset = await runner.library.importFile(source, 'generated');
    const cut = editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration: 2,
      shots: [
        { id: 'first', assetId: asset.id, sourceStart: 0, start: 0, duration: 1 },
        { id: 'later', assetId: asset.id, sourceStart: 0, start: 1, duration: 1 },
      ],
    });
    const ir = defaultRender(cut, { width: 320, height: 180, fps: 12 });
    ir.nodes[1]!.keyframes = [
      { time: 0, x: 0, y: 0, scale: 0.6, rotation: 0, opacity: 1 },
      { time: 1, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    ];
    const original = hash(ir),
      paths: string[] = [];
    const profiles = [
      { aspectRatio: '16:9', width: 320, fps: 12 },
      { aspectRatio: '4:3', height: 180, fps: 12 },
      { aspectRatio: '9:16', height: 320, fps: 15 },
    ] as const;
    for (const profile of profiles) {
      const result = await new Renderer(runner.library, runner.processes).render(cut, ir, false, profile);
      paths.push(result.path);
      const probe = JSON.parse(
        (await runner.processes.run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', result.path]))
          .stdout,
      ).streams[0];
      assert.equal(probe.width, result.exportProfile.width);
      assert.equal(probe.height, result.exportProfile.height);
      assert.equal(
        Number(probe.avg_frame_rate.split('/')[0]) / Number(probe.avg_frame_rate.split('/')[1]),
        profile.fps,
      );
      const frame = path.join(result.exportDirectory, 'frame.rgb');
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        '0.25',
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
      const rgb = await readFile(frame),
        w = probe.width,
        y = Math.floor(probe.height / 2);
      const pixels = Array.from({ length: w }, (_, x) => [
        ...rgb.subarray((y * w + x) * 3, (y * w + x + 1) * 3),
      ]);
      assert.ok(
        pixels.some(([r, g, b]) => r! > 180 && g! < 60 && b! < 60),
        'left red edge survives',
      );
      assert.ok(
        pixels.some(([r, g, b]) => g! > 180 && r! < 60 && b! < 60),
        'right green edge survives',
      );
      assert.equal(hash(ir), original);
      if (profile.aspectRatio === '16:9') {
        const widths: number[] = [];
        for (const time of [1.08, 1.83]) {
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
          const data = await readFile(frame);
          widths.push(
            Array.from(
              { length: w },
              (_, x) => Math.max(...data.subarray((y * w + x) * 3, (y * w + x + 1) * 3)) > 100,
            ).filter(Boolean).length,
          );
        }
        assert.ok(widths[1]! > widths[0]! + 50, `late animation should grow: ${widths}`);
      }
      if (profile.aspectRatio === '9:16') {
        const qa = await inspectVideo(result.path, cut, ir, runner.processes, false, result.exportProfile);
        assert.equal(qa.passed, true, JSON.stringify(qa.issues));
      }
    }
    assert.equal(new Set(paths).size, 3);
    const indexed = await runner.library.importFile(paths[0]!, 'generated');
    const previousBytes = await readFile(indexed.source.path);
    const repeated = await new Renderer(runner.library, runner.processes).render(cut, ir, false, profiles[0]);
    assert.notEqual(
      repeated.path,
      indexed.source.path,
      'an earlier indexed output is immutable, even for the same export request',
    );
    assert.equal(await runner.library.resolve(indexed.id), indexed.source.path);
    assert.deepEqual(await readFile(indexed.source.path), previousBytes);
    assert.equal(repeated.editorialHash, hash(cut));
    assert.equal(repeated.renderHash, original);
  },
);
