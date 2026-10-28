import test from 'node:test';
import assert from 'node:assert/strict';
import { audience, editorial } from './helpers.js';
import { renderSchema } from '../packages/core/src/domain.js';
import {
  acceptancePlanSchema,
  validateAcceptancePlan,
  type AcceptanceSource,
} from '../packages/core/src/acceptance.js';
import { scoreAcceptance } from '../packages/media/src/acceptance-scoring.js';
import type { SemanticModel } from '../packages/media/src/scoring.js';

const source: AcceptanceSource = {
  id: 'timing',
  text: '时间要求',
  quote: '时间要求',
  group: 'expression',
  modality: 'visual',
  stage: 'render',
};
const render = renderSchema.parse({
  schemaVersion: 1,
  editorialHash: 'a'.repeat(64),
  canvas: { width: 640, height: 360, fps: 30 },
  nodes: [
    { id: 'picture', bindingId: 'shot_a', kind: 'media', placement: { mode: 'rect', rect: [0, 0, 1, 1] } },
  ],
});
const model: SemanticModel = {
  version: 'exact-time-fixture',
  async compare(pairs) {
    return pairs.map(({ premise, hypothesis }) => ({
      similarity: 1,
      entailment: premise === hypothesis ? 0.99 : 0,
      contradiction: 0,
      neutral: premise === hypothesis ? 0.01 : 1,
    }));
  },
};
const parsed = (check: unknown) =>
  acceptancePlanSchema.parse({ schemaVersion: 1, sources: [{ sourceId: source.id, checks: [check] }] });
const evaluate = (check: unknown, observed = observations()) =>
  scoreAcceptance(model, [source], parsed(check), observed, {
    editorial: editorial(),
    render,
    stage: 'render',
  });
function observations() {
  const observed = audience('小窗关闭');
  observed.evidence = [0, 1, 1.8].map((start, i) => ({
    ...observed.evidence[0]!,
    id: `window_${i}`,
    start,
    end: [1, 1.8, 3][i]!,
    observation: '小窗关闭',
  }));
  observed.events = [0.5, 1.3, 2.1].map((at, i) => ({ at, text: '小窗关闭', evidenceIds: [`window_${i}`] }));
  observed.claims = [];
  return observed;
}
const spacing = {
  kind: 'event_spacing',
  modality: 'visual',
  event: '小窗关闭',
  seconds: 0.8,
  interval: { start: 0, end: 3 },
};

test('event spacing checks every adjacent grounded timestamp, not only an ordered pair', async () => {
  assert.equal((await evaluate(spacing)).passed, true);
  const wrong = observations();
  wrong.events[2]!.at = 2.7;
  assert.equal((await evaluate(spacing, wrong)).passed, false);
  wrong.events[2]!.at = 2.12;
  assert.equal((await evaluate(spacing, wrong)).passed, true, 'one render frame permits quantization');
  wrong.events[2]!.at = 2.2;
  assert.equal(
    (await evaluate(spacing, wrong)).passed,
    false,
    'tolerance cannot expand to hide the wrong rhythm',
  );
});

test('simultaneous distinct events fail spacing while identical repeated records do not create events', async () => {
  const duplicate = observations();
  duplicate.events.push(structuredClone(duplicate.events[0]!));
  assert.equal((await evaluate(spacing, duplicate)).passed, true);
  const simultaneous = observations();
  simultaneous.evidence.push({ ...simultaneous.evidence[0]!, id: 'another_window' });
  simultaneous.events.push({ at: 0.5, text: '小窗关闭', evidenceIds: ['another_window'] });
  assert.equal((await evaluate(spacing, simultaneous)).passed, false);
});

test('spacing requires complete interval coverage, at least two events and genuine event grounding', async () => {
  const missing = observations();
  missing.evidence[1]!.start = 1.1;
  assert.equal((await evaluate(spacing, missing)).passed, false);
  const one = observations();
  one.events = [one.events[0]!];
  one.claims = [{ text: '观察', evidenceIds: one.evidence.map((e) => e.id), confidence: 1 }];
  assert.equal((await evaluate(spacing, one)).passed, false);
  const invented = observations();
  invented.evidence[1]!.observation = '小窗没有关闭';
  assert.equal(
    (await evaluate(spacing, invented)).passed,
    false,
    'do not silently discard an ungrounded event',
  );
  const outside = observations();
  outside.events[1]!.at = 1.9;
  assert.equal((await evaluate(spacing, outside)).passed, false);
});

test('point checks inspect the state at that frame without requiring it throughout the remaining film', async () => {
  const observed = audience('窗口可见');
  observed.evidence[0]!.end = 1;
  observed.evidence.push({
    ...observed.evidence[0]!,
    id: 'closed',
    start: 1,
    end: 2,
    observation: '没有小窗',
  });
  observed.evidence.push({ ...observed.evidence[0]!, id: 'reopened', start: 2, end: 4 });
  observed.claims[0]!.evidenceIds = observed.evidence.map((e) => e.id);
  const point = { kind: 'at', modality: 'visual', claim: '没有小窗', at: 1 };
  assert.equal((await evaluate(point, observed)).passed, true);
  assert.equal(
    (await evaluate({ ...point, at: 2 }, observed)).passed,
    false,
    'half-open intervals use the new frame at a cut',
  );
  assert.equal(
    (await evaluate({ ...point, at: 4 }, observed)).passed,
    false,
    'work endpoint means the final rendered frame',
  );
  assert.throws(() => validateAcceptancePlan(parsed({ ...point, at: 5 }), [source], 4), {
    code: 'ACCEPTANCE_TIME',
  });
});

test('temporal measurements wait for rendered evidence and reject invalid spacing declarations', async () => {
  const result = await scoreAcceptance(
    model,
    [{ ...source, stage: 'editorial' }],
    parsed(spacing),
    observations(),
    { editorial: editorial(), stage: 'editorial' },
  );
  assert.equal(result.deferred.length, 1);
  assert.equal(result.expression, null, 'deferred is not supported');
  assert.throws(() => parsed({ ...spacing, seconds: 0 }));
  const noRender = await scoreAcceptance(model, [source], parsed(spacing), observations(), {
    editorial: editorial(),
    stage: 'render',
  });
  assert.equal(noRender.passed, false, 'frame precision is required');
});

test('timing precision and score identity follow the actual preview or export frame rate', async () => {
  const observed = observations();
  observed.events[2]!.at = 2.14;
  const run = (renderedFps: number) =>
    scoreAcceptance(model, [source], parsed(spacing), observed, {
      editorial: editorial(),
      render,
      renderedFps,
      stage: 'render',
    });
  const preview = await run(12),
    final = await run(30);
  assert.equal(preview.passed, true);
  assert.equal(final.passed, false);
  assert.notEqual(preview.expression!.inputHash, final.expression!.inputHash);
});
