import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../packages/infrastructure/src/store.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { LocalTts } from '../../packages/media/src/tts.js';
import { projectRoot } from '../../packages/infrastructure/src/process.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import { defaultRender } from '../../packages/core/src/ir.js';
import { Renderer } from '../../packages/media/src/render.js';

const modelDir = process.env.FILMEDIT_MODEL_DIR ?? path.join(projectRoot, '.filmedit/models');
const model = process.env.FILMEDIT_TTS_MODEL ?? path.join(modelDir, 'tts/zh_CN-huayan-medium.onnx');
const python = process.env.FILMEDIT_PYTHON ?? path.join(projectRoot, '.venv/bin/python');

test(
  'local Piper generates audible Chinese narration and renders it without HTTP or TTS credentials',
  {
    timeout: 180000,
    skip: !existsSync(model) || !existsSync(python) ? 'Provision local Piper model and Python first' : false,
  },
  async (t) => {
    const changes = { FILMEDIT_TTS_MODEL: model, FILMEDIT_PYTHON: python, FILMEDIT_TTS_SPEED: '1' };
    const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
    Object.assign(process.env, changes);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    t.mock.method(globalThis, 'fetch', () => {
      throw new Error('Local TTS must not request an HTTP service');
    });
    const store = new Store(await mkdtemp(path.join(tmpdir(), 'filmedit-local-tts-')));
    t.after(() => store.close());
    const task = await createTask(store, { prompt: '本地旁白测试', materials: { strategy: 'local_only' } });
    const runner = new TaskRunner(store, task.id);
    const text = '你好，今天我们来讲奥迪的故事。';
    const voice = await new LocalTts(runner.library).synthesize(text);
    assert.ok(voice.duration > 1 && voice.duration < 30);
    assert.deepEqual(voice.transcript, [{ start: 0, end: voice.duration, text }]);
    const events = store.events(task.id);
    assert.ok(events.some((e) => e.type === 'tts.completed' && (e.data as any).rms > 0.0001));
    const second = await new LocalTts(runner.library).synthesize(text);
    assert.notEqual(second.source.path, voice.source.path, 'new synthesis must not overwrite pinned media');
    await runner.library.resolve(voice.id);
    const image = path.join(task.policy.workspace, 'background.png');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x480',
      '-frames:v',
      '1',
      image,
    ]);
    const picture = await runner.library.importFile(image, 'generated');
    const duration = Math.ceil(voice.duration) + 1;
    const editorial = editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration,
      shots: [{ id: 'shot_one', assetId: picture.id, start: 0, duration, sourceStart: 0 }],
      audio: [
        {
          id: 'narration_one',
          assetId: voice.id,
          role: 'narration',
          start: 0,
          sourceStart: 0,
          duration: voice.duration,
        },
      ],
    });
    const render = defaultRender(editorial, { width: 320, height: 480, fps: 8 });
    const movie = await new Renderer(runner.library, runner.processes).render(editorial, render);
    const probe = await runner.processes.run('ffprobe', [
      '-v',
      'error',
      '-show_streams',
      '-of',
      'json',
      movie.path,
    ]);
    assert.ok(JSON.parse(probe.stdout).streams.some((stream: any) => stream.codec_type === 'audio'));
    const volume = await runner.processes.run('ffmpeg', [
      '-hide_banner',
      '-i',
      movie.path,
      '-vn',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ]);
    assert.match(volume.stderr, /mean_volume: -?\d+(\.\d+)? dB/);
    assert.equal(globalThis.fetch.mock?.callCount?.() ?? 0, 0);
  },
);

test(
  'local ASR reads speech from the final audio mix instead of trusting the source transcript',
  {
    timeout: 180000,
    skip:
      !existsSync(model) || !existsSync(python) || !existsSync(path.join(modelDir, 'whisper'))
        ? 'Provision local TTS and Whisper before this acceptance check'
        : false,
  },
  async (t) => {
    const changes = {
      FILMEDIT_TTS_MODEL: model,
      FILMEDIT_PYTHON: python,
      FILMEDIT_MODEL_DIR: modelDir,
      FILMEDIT_TTS_SPEED: '1',
    };
    const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
    Object.assign(process.env, changes);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const store = new Store(await mkdtemp(path.join(tmpdir(), 'filmedit-mix-asr-')));
    t.after(() => store.close());
    const task = await createTask(store, { prompt: '实际混音转录', materials: { strategy: 'local_only' } });
    const runner = new TaskRunner(store, task.id);
    const voice = await new LocalTts(runner.library).synthesize('你好，今天我们来讲一个关于汽车的故事。');
    const duration = Math.ceil(voice.duration) + 1,
      file = path.join(task.policy.workspace, 'silent.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=blue:s=64x64:r=8:d=${duration}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      file,
    ]);
    const video = await runner.library.importFile(file, 'generated');
    const edit = editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration,
      shots: [{ id: 'base', assetId: video.id, sourceStart: 0, start: 0, duration }],
      audio: [
        {
          id: 'speech',
          assetId: voice.id,
          role: 'narration',
          sourceStart: 0,
          start: 0.5,
          duration: voice.duration,
        },
      ],
    });
    const output = path.join(task.policy.workspace, 'mix.mp4');
    await new Renderer(runner.library, runner.processes).mix(edit, file, output);
    const rendered = await runner.library.importFile(output, 'generated');
    assert.deepEqual(rendered.transcript, [], 'rendered asset has no inherited transcript');
    await runner.library.analyzeAudio(rendered.id, 'asr');
    const actual = store.asset(task.id, rendered.id).transcript;
    assert.ok(actual.length > 0, 'Whisper should recognize the actual mixed speech');
    assert.match(actual.map((s) => s.text).join(''), /今天|汽车|故事/);
    assert.ok(actual.every((s) => s.start >= 0 && s.end <= duration));
  },
);
