import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import { defaultRender, validateEditorial } from '../../packages/core/src/ir.js';
import { Renderer } from '../../packages/media/src/render.js';
import { inspectVideo } from '../../packages/media/src/quality.js';

test(
  'FFmpeg preprocessing executes speed, reverse and freeze against real source frames',
  { timeout: 60000 },
  async (t) => {
    const { store } = await fixture();
    t.after(() => store.close());
    const task = await createTask(store, { prompt: '手法验证', materials: { strategy: 'local_only' } });
    const runner = new TaskRunner(store, task.id),
      file = path.join(task.policy.workspace, 'ramp.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      "nullsrc=s=64x64:r=4:d=3,geq=r='30+N*15':g=0:b=0,format=yuv420p",
      '-c:v',
      'libx264',
      '-crf',
      '0',
      file,
    ]);
    const asset = await runner.library.importFile(file, 'generated');
    const edit = validateEditorial(
      editorialSchema.parse({
        schemaVersion: 1,
        revision: 0,
        duration: 3,
        shots: [
          {
            id: 'fast',
            assetId: asset.id,
            sourceStart: 0.5,
            start: 0,
            duration: 1,
            speed: 2,
            techniques: [{ id: 'speed', version: 1 }],
          },
          {
            id: 'reverse',
            assetId: asset.id,
            sourceStart: 0.5,
            start: 1,
            duration: 1,
            techniques: [{ id: 'reverse', version: 1 }],
          },
          {
            id: 'freeze',
            assetId: asset.id,
            sourceStart: 0.5,
            start: 2,
            duration: 1,
            techniques: [{ id: 'freeze', version: 1 }],
          },
        ],
      }),
      [asset],
    );
    const dir = await new Renderer(runner.library, runner.processes).prepare(
      edit,
      defaultRender(edit, { width: 64, height: 64, fps: 4 }),
    );
    const values: Record<string, number[]> = {};
    for (const shot of edit.shots) {
      const decoded = path.join(dir, `${shot.id}.rgb`);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-i',
        path.join(dir, 'assets', `${shot.id}.mp4`),
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        decoded,
      ]);
      const data = await readFile(decoded),
        stride = 64 * 64 * 3;
      assert.equal(data.length, stride * 4, `${shot.id} has four output frames`);
      values[shot.id] = Array.from({ length: 4 }, (_, i) => data[i * stride + 32 * 64 * 3 + 32 * 3]!);
    }
    assert.ok(values.fast![3]! - values.fast![0]! > 60, `speed traverses more source frames: ${values.fast}`);
    assert.ok(values.reverse![0]! - values.reverse![3]! > 30, `reverse goes backward: ${values.reverse}`);
    assert.ok(
      Math.max(...values.freeze!) - Math.min(...values.freeze!) < 3,
      `freeze holds one source frame: ${values.freeze}`,
    );
  },
);

test(
  'mixed audio honors offsets, speed duration and ducking while source sound overlaps a picture cut',
  { timeout: 60000 },
  async (t) => {
    const { store } = await fixture();
    t.after(() => store.close());
    const task = await createTask(store, { prompt: '声音验证', materials: { strategy: 'local_only' } });
    const runner = new TaskRunner(store, task.id),
      workspace = task.policy.workspace;
    const tone = async (name: string, hz: number) => {
      const file = path.join(workspace, `${name}.wav`);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${hz}:sample_rate=48000:duration=6`,
        '-c:a',
        'pcm_s16le',
        file,
      ]);
      return runner.library.importFile(file, 'generated');
    };
    const music = await tone('music', 440),
      voice = await tone('voice', 1000);
    const silent = path.join(workspace, 'silent.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=64x64:r=12:d=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      silent,
    ]);
    const video = await runner.library.importFile(silent, 'generated');
    const edit = editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration: 4,
      shots: [
        { id: 'a', assetId: video.id, sourceStart: 0, start: 0, duration: 2 },
        { id: 'b', assetId: video.id, sourceStart: 2, start: 2, duration: 2 },
      ],
      audio: [
        {
          id: 'bgm',
          assetId: music.id,
          role: 'music',
          sourceStart: 0,
          start: 0,
          duration: 4,
          duck: true,
          volume: 0.5,
        },
        {
          id: 'dialogue',
          assetId: voice.id,
          role: 'dialogue',
          sourceStart: 0,
          start: 1,
          duration: 2,
          speed: 2,
          volume: 0.3,
        },
      ],
    });
    const output = path.join(workspace, 'mixed.mp4'),
      raw = path.join(workspace, 'mixed.f32');
    await new Renderer(runner.library, runner.processes).mix(edit, silent, output);
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      output,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      raw,
    ]);
    const data = await readFile(raw),
      rate = 48000;
    const amplitude = (time: number, hz: number) => {
      const start = Math.round(time * rate),
        n = 4800;
      let re = 0,
        im = 0;
      for (let i = 0; i < n; i++) {
        const x = data.readFloatLE((start + i) * 4),
          angle = (2 * Math.PI * hz * i) / rate;
        re += x * Math.cos(angle);
        im += x * Math.sin(angle);
      }
      return (2 * Math.hypot(re, im)) / n;
    };
    const before = amplitude(0.4, 440),
      during = amplitude(1.4, 440),
      after = amplitude(3.4, 440);
    assert.ok(during / before > 0.18 && during / before < 0.32, `music duck ratio ${during / before}`);
    assert.ok(after / before > 0.9 && after / before < 1.1, 'music returns after dialogue');
    assert.ok(
      amplitude(1.4, 1000) > 0.025 && amplitude(2.4, 1000) > 0.025,
      'source sound spans the picture cut without pitch shift',
    );
    assert.ok(
      amplitude(0.4, 1000) < 0.002 && amplitude(3.4, 1000) < 0.002,
      'speech offset and end follow IR',
    );
    const quality = await inspectVideo(
      output,
      edit,
      defaultRender(edit, { width: 64, height: 64, fps: 12 }),
      runner.processes,
    );
    assert.equal(quality.passed, true, JSON.stringify(quality.issues));
    assert.ok(quality.audioAnalysis && quality.audioAnalysis.peakDb < 0 && quality.audioAnalysis.rmsDb > -50);
    assert.ok(
      quality.continuousClips.some((clip) => clip.start + clip.duration >= edit.duration),
      'motion evidence reaches the end of the timeline',
    );
  },
);
