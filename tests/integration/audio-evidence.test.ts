import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, audience } from '../helpers.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { LocalTts } from '../../packages/media/src/tts.js';
import { AudioAnalyzer, type AudioEvidence } from '../../packages/media/src/audio-evidence.js';
import { projectRoot } from '../../packages/infrastructure/src/process.js';
import { Renderer } from '../../packages/media/src/render.js';
import { inspectVideo } from '../../packages/media/src/quality.js';
import { defaultRender } from '../../packages/core/src/ir.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import type { AgentDriver } from '../../packages/agent-runtime/src/agents.js';
import type { FilmTool } from '../../packages/agent-runtime/src/pi-runtime.js';

test(
  'sandboxed sound analysis ignores source claims and final review detects an actually muted mix',
  { timeout: 240000 },
  async (t) => {
    const changes = {
      FILMEDIT_PYTHON: process.env.FILMEDIT_PYTHON ?? path.join(projectRoot, '.venv/bin/python'),
      FILMEDIT_MODEL_DIR: process.env.FILMEDIT_MODEL_DIR ?? path.join(projectRoot, '.filmedit/models'),
    };
    const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
    Object.assign(process.env, changes);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const { store } = await fixture();
    t.after(() => store.close());
    const task = await createTask(store, { prompt: 'PRIVATE_TARGET', materials: { strategy: 'local_only' } });
    const runner = new TaskRunner(store, task.id, AbortSignal.timeout(220000));
    const voice = await new LocalTts(runner.library).synthesize('你好，今天我们来讲一个关于汽车的故事。');
    store.saveAsset({
      ...voice,
      source: { ...voice.source, title: 'AUTHOR_CLAIMS_BIRDS' },
      transcript: [{ start: 0, end: voice.duration, text: 'AUTHOR_CLAIMS_BIRDS' }],
      analyzed: { asr: true },
    });
    const execute = runner.processes.run.bind(runner.processes);
    let workers = 0;
    t.mock.method(runner.processes, 'run', async (command, args, options) => {
      if (args[1] === 'sound') {
        workers++;
        assert.equal(options?.env?.HF_HUB_OFFLINE, '1');
        assert.ok(!options?.domains?.length, 'offline worker receives no network access');
      }
      return execute(command, args, options);
    });
    const analyzer = new AudioAnalyzer(runner.library);
    const source = await analyzer.analyze(voice.id, 0, voice.duration);
    assert.ok(source.windows[0]!.tags.some((tag) => tag.label === 'Speech' && tag.score > 0.5));
    assert.equal(source.windows[0]!.similarities[0]!.label, 'speech');
    assert.ok(
      source.windows.every((window) =>
        window.similarities.every(
          (item) => Number.isFinite(item.cosine) && item.cosine >= -1 && item.cosine <= 1,
        ),
      ),
    );
    assert.match(source.transcript.map((word) => word.text).join(''), /今天|汽车|故事/);
    assert.ok(!JSON.stringify(source).includes('AUTHOR_CLAIMS_BIRDS'));
    assert.deepEqual(await analyzer.analyze(voice.id, 0, voice.duration), source);
    assert.equal(workers, 1, 'identical source interval and models reuse evidence');
    const duration = Math.ceil(voice.duration) + 2;
    const videoFile = path.join(task.policy.workspace, 'base.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=64x64:r=8:d=${duration}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      videoFile,
    ]);
    const video = await runner.library.importFile(videoFile, 'generated');
    const edit = editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration,
      shots: [{ id: 'picture', assetId: video.id, sourceStart: 0, start: 0, duration }],
      audio: [
        {
          id: 'speech',
          assetId: voice.id,
          role: 'narration',
          sourceStart: 0,
          start: 0.5,
          duration: voice.duration,
          volume: 0,
        },
      ],
    });
    const silentFile = path.join(task.policy.workspace, 'muted.mp4');
    const renderer = new Renderer(runner.library, runner.processes);
    await renderer.mix(edit, videoFile, silentFile);
    const silent = await runner.library.importFile(silentFile, 'generated');
    const quiet = await analyzer.analyze(silent.id, 0, silent.duration);
    assert.ok(quiet.windows.every((window) => window.peakDb <= -150));
    assert.deepEqual(quiet.transcript, [], 'source speech is not audible in a muted final mix');
    const render = defaultRender(edit, { width: 64, height: 64, fps: 8 });
    const quality = await inspectVideo(silentFile, edit, render, runner.processes);
    assert.ok(quality.audioAnalysis);
    let observed: AudioEvidence | undefined;
    const driver: AgentDriver = {
      async run(request) {
        assert.equal(request.role, 'visual_audience');
        const input = (request.input as any).observation;
        assert.ok(!JSON.stringify(input).includes('AUTHOR_CLAIMS_BIRDS'));
        assert.ok(!JSON.stringify(input).includes('PRIVATE_TARGET'));
        observed = input.renderedSound;
        assert.deepEqual(input.renderedTranscript, []);
        assert.equal(request.renderedAudio, true);
        assert.deepEqual(input.renderedAudioBinding, { id: 'rendered_audio', start: 0, end: duration });
        const report = audience('测试评审：混音没有可听声音');
        report.evidence[0]!.bindingId = 'element_0001';
        report.evidence[0]!.end = duration;
        report.evidence.push({
          id: 'mix',
          bindingId: 'rendered_audio',
          start: 0,
          end: duration,
          modality: 'audio',
          observation: '最终混音全程实测静音，含旁白绑定结束后的区间',
        });
        report.events.push({ at: 0, text: '成片静音', evidenceIds: ['mix'] });
        report.issues = [
          { kind: 'technical', severity: 'blocking', message: '测试反例：旁白被静音', time: 0.5 },
        ];
        return request.schema.parse(report);
      },
    };
    const reviewer = new TaskRunner(store, task.id, runner.signal, {
      agent: driver,
      model: {
        version: 'empty-plan-fixture',
        async compare() {
          return [];
        },
      },
    });
    (reviewer as any).acceptance = {
      version: 'fixture',
      inputHash: 'fixture',
      sources: [],
      plan: { schemaVersion: 1, sources: [] },
    };
    const review = await (reviewer as any).visualReview(edit, quality, 'muted-mix-test', render);
    assert.equal(observed?.sha256, silent.sha256, 'reviewer receives the actual mixed file evidence');
    assert.ok(observed?.windows.every((window) => window.peakDb <= -150));
    assert.equal(review.issues[0]?.severity, 'blocking');
    const tools: FilmTool[] = (runner.agent as any).createTools(
      { role: 'visual_audience', renderedVideo: quality.source },
      true,
    );
    const result = await tools
      .find((tool) => tool.name === 'rendered_audio')!
      .execute({ start: 0.5, end: 1.5 });
    const interval: AudioEvidence = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(interval.sourceStart, 0.5);
    assert.equal(interval.sourceEnd, 1.5);
    assert.ok(interval.windows.every((window) => window.peakDb <= -150));
    const audible = structuredClone(edit);
    audible.audio[0]!.volume = 1;
    const audibleFile = path.join(task.policy.workspace, 'audible.mp4');
    await renderer.mix(audible, videoFile, audibleFile);
    const loud = await runner.library.importFile(audibleFile, 'generated');
    const mixed = await analyzer.analyze(loud.id, 0, loud.duration);
    assert.ok(mixed.windows.some((window) => window.peakDb > -30));
    assert.match(mixed.transcript.map((word) => word.text).join(''), /今天|汽车|故事/);
    assert.notEqual(mixed.sha256, quiet.sha256);
    await runner.library.resolve(voice.id);
  },
);
