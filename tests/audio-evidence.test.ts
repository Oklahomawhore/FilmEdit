import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, asset } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { fileHash } from '../packages/infrastructure/src/files.js';
import {
  AudioAnalyzer,
  soundAnalysisSchema,
  timelineAudioEvidence,
  type AudioEvidence,
} from '../packages/media/src/audio-evidence.js';
import { reviewMaterials } from '../packages/application/src/material-review.js';
import { validateMaterialResult, type MaterialNeed } from '../packages/core/src/materials.js';
import { editorialSchema } from '../packages/core/src/domain.js';
import type { FilmTool } from '../packages/agent-runtime/src/pi-runtime.js';
import { PythonSemanticModel } from '../packages/media/src/scoring.js';

const evidence = (assetId: string, start: number, end: number, label = 'Engine'): AudioEvidence => ({
  assetId,
  sha256: 'a'.repeat(64),
  version: 'fixture-only',
  sourceStart: start,
  sourceEnd: end,
  duration: end - start,
  transcript: [],
  unalignedWords: [],
  windows: [
    {
      start,
      end,
      rmsDb: -20,
      peakDb: -5,
      contentStatus: 'analyzed',
      tags: [{ label, score: 0.8 }],
      similarities: [{ label, description: label, cosine: 0.5 }],
    },
  ],
});

test('empty ASR and beats do not approve an audio match; independent source review owns its repair and cache', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'PRIVATE_TARGET', materials: { strategy: 'local_only' } });
  const runner = new TaskRunner(store, task.id);
  store.saveAsset({
    ...asset,
    taskId: task.id,
    transcript: [],
    unalignedWords: [],
    beats: [],
    analyzed: { asr: true, beats: true },
  });
  t.mock.method(runner.library, 'resolve', async () => '/fixture-only');
  const analyze = t.mock.method(AudioAnalyzer.prototype, 'analyze', async (id, start, end) =>
    evidence(id, start, end, start ? 'Bird' : 'Engine'),
  );
  const needs: MaterialNeed[] = [{ id: 'birds', kind: 'audio', query: '鸟鸣', audioRole: 'ambient' }];
  let reviews = 0;
  const agent = {
    async run(request: any) {
      reviews++;
      assert.equal(request.role, 'materials_review');
      assert.equal(request.toolAccess, 'none');
      assert.ok(!JSON.stringify(request.input).includes('AUTHOR_SAYS_BIRD'));
      assert.ok(!JSON.stringify(request.input).includes('PRIVATE_TARGET'));
      const clip = request.input.clips[0];
      const report = {
        verdict: clip.audio.windows[0].tags[0].label === 'Bird' ? 'matched' : 'mismatch',
        observation: 'fixture source judgment',
        evidence: [{ matchIndex: 0, time: clip.evidenceTimes[0] }],
      };
      assert.throws(() => request.validateOutput({ ...report, evidence: [{ matchIndex: 0, time: 99 }] }), {
        code: 'MATERIAL_EVIDENCE',
      });
      return request.validateOutput(report);
    },
  };
  const match = {
    needId: 'birds',
    assetId: asset.id,
    sourceStart: 0,
    sourceEnd: 1,
    frameTimes: [],
    observation: 'AUTHOR_SAYS_BIRD',
  };
  validateMaterialResult({ status: 'ready', matches: [match], gaps: [] }, needs, store.assets(task.id));
  const rejected = await reviewMaterials(store, task.id, runner.library, agent, needs, [match]);
  assert.equal(rejected.passed, false);
  assert.equal(rejected.checks.length, 1, 'audio needs cannot be silently skipped');
  assert.deepEqual(
    await reviewMaterials(store, task.id, runner.library, agent, needs, [
      { ...match, observation: 'changed author claim' },
    ]),
    rejected,
  );
  assert.equal(reviews, 1, 'changing a claim does not change source evidence');
  const accepted = await reviewMaterials(store, task.id, runner.library, agent, needs, [
    { ...match, sourceStart: 2, sourceEnd: 3 },
  ]);
  assert.equal(accepted.passed, true);
  assert.equal(reviews, 2);
  analyze.mock.mockImplementation(async (id, start, end) => {
    const result = evidence(id, start, end, 'Bird');
    result.windows[0]!.peakDb = -160;
    return result;
  });
  await assert.rejects(
    reviewMaterials(store, task.id, runner.library, agent, needs, [
      { ...match, sourceStart: 4, sourceEnd: 5 },
    ]),
    { code: 'MATERIAL_EVIDENCE' },
  );
});

test('sound evidence uses the requested interval and model version; source checks precede cached results', async (t) => {
  const { store, root } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'evidence fixture' });
  const runner = new TaskRunner(store, task.id);
  const file = path.join(task.policy.workspace, 'source.wav');
  await writeFile(file, 'fixture media, ffmpeg and inference mocked in this unit test');
  store.saveAsset({
    ...asset,
    taskId: task.id,
    kind: 'audio',
    source: { kind: 'local', path: file },
    sha256: await fileHash(file),
  });
  const models = path.join(root, 'models');
  await mkdir(models);
  const manifest = path.join(models, 'manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      audio: { revision: 'sound-v1' },
      audio_text: { revision: 'text-v1' },
      whisper: { revision: 'speech-v1' },
    }),
  );
  const old = process.env.FILMEDIT_MODEL_DIR;
  process.env.FILMEDIT_MODEL_DIR = models;
  t.after(() => {
    if (old === undefined) delete process.env.FILMEDIT_MODEL_DIR;
    else process.env.FILMEDIT_MODEL_DIR = old;
  });
  let calls = 0;
  let incomplete = false;
  t.mock.method(runner.processes, 'run', async (command, args, options) => {
    calls++;
    if (command === 'ffmpeg') {
      assert.equal(args[args.indexOf('-ss') + 1], '2');
      assert.equal(args[args.indexOf('-t') + 1], '2');
      assert.ok(args.includes('file,pipe'));
      assert.equal(args[args.indexOf('-ar') + 1], '48000');
      return { stdout: '', stderr: '', code: 0 };
    }
    assert.equal(args[1], 'sound');
    assert.equal(options?.env?.HF_HUB_OFFLINE, '1');
    return {
      stdout: JSON.stringify({
        duration: 2,
        windows: [
          {
            start: 0,
            end: incomplete ? 1 : 2,
            rmsDb: -20,
            peakDb: -5,
            contentStatus: 'analyzed',
            tags: [{ label: 'Speech', score: 0.9 }],
            similarities: [{ label: 'speech', description: 'A person speaking.', cosine: 0.5 }],
          },
        ],
        transcript: [{ start: 0.2, end: 0.5, text: 'word' }],
        unalignedWords: [{ time: 0, text: 'unlocated' }],
      }),
      stderr: '',
      code: 0,
    };
  });
  const analyzer = new AudioAnalyzer(runner.library);
  const semantics = { embedding: { revision: 'embedding-v1' }, nli: { revision: 'nli-v1' } };
  await writeFile(
    manifest,
    JSON.stringify({
      ...semantics,
      audio: { revision: 'sound-v1' },
      audio_text: { revision: 'text-v1' },
      whisper: { revision: 'speech-v1' },
    }),
  );
  const scoringVersion = (await PythonSemanticModel.create(runner.processes)).version;
  const first = await analyzer.analyze(asset.id, 2, 4);
  assert.equal(first.windows[0]!.start, 2);
  assert.deepEqual(first.transcript, [{ start: 2.2, end: 2.5, text: 'word' }]);
  assert.deepEqual(first.unalignedWords, [{ time: 2, text: 'unlocated' }]);
  assert.deepEqual(await analyzer.analyze(asset.id, 2, 4), first);
  assert.equal(calls, 2);
  await writeFile(
    manifest,
    JSON.stringify({
      ...semantics,
      audio: { revision: 'sound-v1' },
      audio_text: { revision: 'text-v2' },
      whisper: { revision: 'speech-v1' },
    }),
  );
  assert.equal(
    (await PythonSemanticModel.create(runner.processes)).version,
    scoringVersion,
    'Installing a sound model must not change semantic scoring identity',
  );
  incomplete = true;
  await assert.rejects(analyzer.analyze(asset.id, 2, 4), { code: 'AUDIO_EVIDENCE' });
  incomplete = false;
  assert.notEqual((await analyzer.analyze(asset.id, 2, 4)).version, first.version);
  assert.equal(calls, 6, 'bad output was not cached');
  runner.policy.data.denies.push(file);
  await assert.rejects(analyzer.analyze(asset.id, 2, 4), { code: 'PATH_DENIED' });
  runner.policy.data.denies.pop();
  await writeFile(file, 'changed');
  await assert.rejects(analyzer.analyze(asset.id, 2, 4), { code: 'ASSET_CHANGED' });
  assert.equal(calls, 6);
});

test('source sound windows map to actual timeline seconds including source offset and playback speed', () => {
  const binding = {
    id: 'sound',
    assetId: 'asset',
    sourceStart: 4,
    start: 10,
    duration: 2,
    speed: 2,
    volume: 1,
    role: 'effect' as const,
    fadeIn: 0,
    fadeOut: 0,
    duck: false,
  };
  const source = evidence('asset', 4, 8);
  source.transcript = [{ start: 5, end: 6, text: 'word' }];
  source.unalignedWords = [{ time: 6, text: 'uncertain' }];
  const mapped = timelineAudioEvidence(binding, source);
  assert.equal(mapped.windows[0]!.start, 10);
  assert.equal(mapped.windows[0]!.end, 12);
  assert.deepEqual(mapped.transcript, [{ start: 10.5, end: 11, text: 'word' }]);
  assert.deepEqual(mapped.unalignedWords, [{ time: 11, text: 'uncertain' }]);
});

test('observer audio tools inspect only the reviewed cut or rendered mix and bound interval size', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'PRIVATE_TARGET' });
  const runner = new TaskRunner(store, task.id);
  const requests: unknown[] = [];
  t.mock.method(AudioAnalyzer.prototype, 'analyze', async (id, start, end) => {
    requests.push({ id, start, end });
    return evidence(id, start, end);
  });
  const cut = editorialSchema.parse({
    schemaVersion: 1,
    revision: 0,
    duration: 15,
    shots: [{ id: 'visual', assetId: 'picture', start: 0, duration: 15, sourceStart: 0 }],
    audio: [
      { id: 'sound', assetId: 'audio', role: 'effect', start: 10, sourceStart: 4, duration: 2, speed: 2 },
      { id: 'muted', assetId: 'audio', role: 'effect', start: 12, sourceStart: 4, duration: 2, volume: 0 },
    ],
  });
  const toolsFor = (request: unknown, blind = true): FilmTool[] =>
    (runner.agent as any).createTools(request, blind);
  const tools = toolsFor({ role: 'editorial_audience', editorial: cut });
  assert.ok(!tools.some((tool) => tool.name === 'audio_evidence'));
  const audio = tools.find((tool) => tool.name === 'cut_audio')!;
  for (const input of [
    { bindingId: 'unknown', start: 10, end: 11 },
    { bindingId: 'sound', start: 9, end: 11 },
    { bindingId: 'sound', start: 10, end: 13 },
    { bindingId: 'muted', start: 12, end: 13 },
  ])
    await assert.rejects(audio.execute(input), { code: 'EVIDENCE_RANGE' });
  assert.equal(requests.length, 0);
  const result = await audio.execute({ bindingId: 'sound', start: 10.5, end: 11 });
  assert.deepEqual(requests, [{ id: 'audio', start: 5, end: 6 }]);
  const mapped = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(mapped.windows[0].start, 10.5);
  assert.equal(mapped.windows[0].end, 11);
  assert.equal(mapped.bindingId, 'sound');
  t.mock.method(runner.library, 'importFile', async (file) => {
    assert.equal(file, '/actual-mix');
    return { ...asset, id: 'actual_mix', taskId: task.id };
  });
  const renderedTools = toolsFor({
    role: 'visual_audience',
    renderedVideo: { path: '/actual-mix', duration: 60, fps: 30 },
  });
  assert.deepEqual(renderedTools.map((tool) => tool.name).sort(), ['rendered_audio', 'rendered_frames']);
  const rendered = renderedTools.find((tool) => tool.name === 'rendered_audio')!;
  await assert.rejects(rendered.execute({ start: 0, end: 31 }), { code: 'EVIDENCE_RANGE' });
  await assert.rejects(rendered.execute({ start: 59, end: 61 }), { code: 'EVIDENCE_RANGE' });
  await rendered.execute({ start: 2, end: 3 });
  assert.deepEqual(requests.at(-1), { id: 'actual_mix', start: 2, end: 3 });
  const material = toolsFor({ role: 'materials' }, false).find((tool) => tool.name === 'audio_evidence')!;
  await assert.rejects(material.execute({ assetId: 'audio', start: 0, end: 31 }), { code: 'AUDIO_RANGE' });
});

test('short sound observations retain levels without inventing content or silence', () => {
  const observation = evidence('short', 0, 1 / 48000);
  const window = observation.windows[0]!;
  window.contentStatus = 'insufficient_duration';
  window.tags = [];
  window.similarities = [];
  assert.ok(soundAnalysisSchema.safeParse(observation).success);
  window.tags = [{ label: 'Silence', score: 1 }];
  assert.equal(soundAnalysisSchema.safeParse(observation).success, false);
  window.tags = [];
  window.contentStatus = 'analyzed';
  assert.equal(soundAnalysisSchema.safeParse(observation).success, false);
});
