import test from 'node:test';
import assert from 'node:assert/strict';
import { editorialSchema } from '../packages/core/src/domain.js';
import { frozenIntervals } from '../packages/media/src/quality.js';
import { type QualityReport, QUALITY_VERSION } from '../packages/media/src/quality.js';
import { fixture, audience, editorial, asset } from './helpers.js';
import { AudioAnalyzer } from '../packages/media/src/audio-evidence.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';
import type { AudienceIR, EditorialIR } from '../packages/core/src/domain.js';
import { defaultRender } from '../packages/core/src/ir.js';

const cut = (overlay = false) =>
  editorialSchema.parse({
    schemaVersion: 1,
    revision: 0,
    duration: 10,
    shots: [
      {
        id: 'freeze_a',
        assetId: 'asset_a',
        start: 0,
        duration: 3,
        sourceStart: 0,
        techniques: [{ id: 'freeze', version: 1 }],
      },
      { id: 'moving', assetId: 'asset_a', start: 3, duration: 7, sourceStart: 3 },
      ...(overlay
        ? [{ id: 'overlay', assetId: 'asset_b', track: 1, start: 0, duration: 10, sourceStart: 0 }]
        : []),
    ],
  });

test('visual review cache changes with measured quality evidence, without regenerating editorial or layout', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'PRIVATE_USER_TARGET' });
  let calls = 0;
  const seen: unknown[] = [];
  const agent: AgentDriver = {
    async run(request) {
      calls++;
      assert.equal(request.role, 'visual_audience');
      assert.ok(!JSON.stringify(request.input).includes('PRIVATE_USER_TARGET'));
      seen.push((request.input as any).observation.visualAnalysis);
      const report = audience('图形静止');
      report.evidence[0]!.bindingId = 'element_0001';
      report.evidence.push({
        ...report.evidence[0]!,
        id: 'second',
        bindingId: 'element_0002',
        start: 2,
        end: 4,
      });
      report.claims[0]!.evidenceIds.push('second');
      if (request.renderedAudio) {
        report.evidence.push({
          id: 'mix',
          bindingId: 'rendered_audio',
          start: 0,
          end: 4,
          modality: 'audio',
          observation: '最终混音中有持续环境声',
        });
        report.events.push({ at: 0, text: '混音有环境声', evidenceIds: ['mix'] });
      }
      return request.schema.parse(report);
    },
  };
  const runner = new TaskRunner(store, task.id, undefined, {
    agent,
    model: {
      version: 'empty-acceptance-fixture',
      async compare() {
        return [];
      },
    },
  });
  (runner as any).acceptance = {
    version: 'fixture',
    inputHash: 'fixture',
    sources: [],
    plan: { schemaVersion: 1, sources: [] },
  };
  t.mock.method(runner.library, 'importFile', async () => ({ ...asset, taskId: task.id }));
  t.mock.method(AudioAnalyzer.prototype, 'analyze', async (assetId) => ({
    assetId,
    version: 'fixture',
    sha256: asset.sha256,
    sourceStart: 0,
    sourceEnd: 4,
    duration: 4,
    transcript: [],
    unalignedWords: [],
    windows: [
      {
        start: 0,
        end: 4,
        rmsDb: -10,
        peakDb: -2,
        contentStatus: 'analyzed',
        tags: [{ label: 'Engine', score: 0.7 }],
        similarities: [{ label: 'engine', description: 'An engine.', cosine: 0.5 }],
      },
    ],
  }));
  const review = (e: EditorialIR, q: QualityReport, version: string): Promise<AudienceIR> =>
    (runner as any).visualReview(e, q, version, defaultRender(e, { width: 640, height: 360, fps: 8 }));
  const quality: QualityReport = {
    passed: true,
    issues: [],
    frames: [],
    continuousClips: [],
    visualAnalysis: { version: QUALITY_VERSION, frozenIntervals: [], blackIntervals: [] },
    source: { path: '/unused-controller-fixture', duration: 4, fps: 8 },
    metadata: {},
  };
  await review(editorial(), quality, 'same-render');
  await review(editorial(), quality, 'same-render');
  assert.equal(calls, 1);
  const measured = {
    ...quality,
    visualAnalysis: {
      ...quality.visualAnalysis,
      frozenIntervals: [{ start: 2, end: 4, declaredFreeze: false }],
    },
  };
  await review(editorial(), measured, 'same-render');
  assert.equal(calls, 2);
  assert.deepEqual(seen[1], measured.visualAnalysis);
  await review(
    editorial(),
    { ...measured, audioAnalysis: { peakDb: -2, rmsDb: -10, silentIntervals: [] } },
    'same-render',
  );
  assert.equal(calls, 3);
  assert.equal(store.artifact(task.id, 'editorial'), undefined);
  assert.equal(store.artifact(task.id, 'layout'), undefined);
});

test('freeze intervals include EOF, separate declared holds from excess time and respect other video tracks', () => {
  const log =
    '[freezedetect] lavfi.freezedetect.freeze_start: 0\n' +
    '[freezedetect] lavfi.freezedetect.freeze_duration: 4\n' +
    '[freezedetect] lavfi.freezedetect.freeze_end: 4\n' +
    '[freezedetect] lavfi.freezedetect.freeze_start: 8\n';
  assert.deepEqual(frozenIntervals(log, cut()), [
    { start: 0, end: 3, declaredFreeze: true },
    { start: 3, end: 4, declaredFreeze: false },
    { start: 8, end: 10, declaredFreeze: false },
  ]);
  assert.deepEqual(frozenIntervals(log, cut(true)), [
    { start: 0, end: 4, declaredFreeze: false },
    { start: 8, end: 10, declaredFreeze: false },
  ]);
  assert.deepEqual(frozenIntervals('ordinary scan with no frozen interval', cut()), []);
  assert.deepEqual(frozenIntervals('freeze_start: 1e-1\nfreeze_end: 3.5\n', cut()), [
    { start: 0.1, end: 3, declaredFreeze: true },
    { start: 3, end: 3.5, declaredFreeze: false },
  ]);
});
