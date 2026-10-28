import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewAudience, validateReviewCoverage } from '../packages/application/src/audience-review.js';
import { audienceSchema } from '../packages/core/src/domain.js';
import { createTask } from '../packages/application/src/workflow.js';
import { audience, completeAudience, editorial, fixture } from './helpers.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';
import { FilmError, hash } from '../packages/core/src/util.js';
import { validateAudience } from '../packages/core/src/ir.js';

test('an observer repairs media IDs used as identities inside its own session without seeing the goal', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'PRIVATE_ENTITY_REQUIREMENT' });
  const cut = editorial();
  let calls = 0;
  const driver: AgentDriver = {
    async run(request) {
      calls++;
      assert.ok(request.instruction.includes('entityId'));
      assert.ok(!JSON.stringify(request.input).includes('PRIVATE_ENTITY_REQUIREMENT'));
      const report = completeAudience();
      report.evidence[0]!.entityId = cut.shots[0]!.assetId;
      assert.throws(() => request.validateOutput!(request.schema.parse(report)), { code: 'EVIDENCE_ENTITY' });
      report.evidence[0]!.entityId = 'observed_car';
      return request.validateOutput!(request.schema.parse(report));
    },
  };
  const result = await reviewAudience({
    store,
    taskId: task.id,
    key: 'entity-report',
    agent: driver,
    request: {
      role: 'editorial_audience',
      schema: audienceSchema,
      editorial: cut,
      instruction: 'Observe',
      input: {},
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.evidence[0]!.entityId, 'observed_car');
  assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
});

test('explicit review budget exhaustion blocks without asking the editor to regenerate', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'private', budgets: { stageRounds: 1 } });
  const bad = completeAudience();
  bad.evidence[0]!.bindingId = 'unknown';
  const driver: AgentDriver = {
    async run(request) {
      return request.schema.parse(bad);
    },
  };
  await assert.rejects(
    reviewAudience({
      store,
      taskId: task.id,
      key: 'limited',
      agent: driver,
      request: {
        role: 'editorial_audience',
        schema: audienceSchema,
        editorial: editorial(),
        instruction: 'Observe',
        input: {},
      },
    }),
    { code: 'REVIEW_EXHAUSTED' },
  );
  assert.ok(store.artifact(task.id, 'limited.candidate', false));
  assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
});

test('submission rejects incomplete coverage inside the same observer session before accepting the report', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'PRIVATE_TARGET', budgets: { stageRounds: 1 } });
  const cut = editorial();
  const incomplete = completeAudience();
  incomplete.evidence[0]!.end = 1;
  let sessions = 0;
  const driver: AgentDriver = {
    async run(request) {
      sessions++;
      assert.equal(hash(request.editorial), hash(cut));
      assert.throws(() => request.validateOutput!(request.schema.parse(incomplete)), {
        code: 'EVIDENCE_COVERAGE',
      });
      assert.ok(!JSON.stringify(request.input).includes('PRIVATE_TARGET'));
      return request.validateOutput!(request.schema.parse(completeAudience()));
    },
  };
  const result = await reviewAudience({
    store,
    taskId: task.id,
    agent: driver,
    key: 'submission-coverage',
    request: {
      role: 'editorial_audience',
      schema: audienceSchema,
      editorial: cut,
      instruction: 'Observe',
      input: {},
    },
  });
  assert.equal(result.evidence[0]!.end, 2);
  assert.equal(sessions, 1);
  assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
  assert.ok(store.artifact(task.id, 'submission-coverage'));
});

test('report repairs retain the same timeline, resume invalid report, and keep user intent private', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'PRIVATE_CREATOR_GOAL' });
  const cut = editorial(),
    key = 'review-test';
  const invalid = completeAudience();
  invalid.evidence[0]!.end = 3;
  store.saveArtifact(task.id, `${key}.candidate`, invalid);
  const before = hash(cut);
  let calls = 0;
  const driver: AgentDriver = {
    async run(request) {
      calls++;
      assert.equal(request.role, 'editorial_audience');
      assert.equal(hash(request.editorial), before);
      assert.ok(!JSON.stringify(request.input).includes('PRIVATE_CREATOR_GOAL'));
      const input = request.input as any;
      assert.equal(input.validationErrors.code, 'EVIDENCE_RANGE');
      assert.deepEqual(input.previousReview, invalid);
      assert.equal(input.evidenceBindings[0].end, 2);
      return request.schema.parse(completeAudience());
    },
  };
  const request = {
    role: 'editorial_audience' as const,
    schema: audienceSchema,
    editorial: cut,
    instruction: 'Observe',
    input: { cut },
  };
  await reviewAudience({ store, taskId: task.id, agent: driver, request, key });
  assert.equal(calls, 1);
  assert.equal(hash(cut), before);
  await reviewAudience({ store, taskId: task.id, agent: driver, request, key });
  assert.equal(calls, 1, 'valid review is reused');
});

test('interrupting a report repair preserves the invalid report and never creates editorial feedback', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'private', budgets: { stageRounds: null } });
  const controller = new AbortController();
  const bad = completeAudience();
  bad.evidence.push(bad.evidence[0]!);
  const driver: AgentDriver = {
    async run(request) {
      controller.abort();
      return request.schema.parse(bad);
    },
  };
  await assert.rejects(
    reviewAudience({
      store,
      taskId: task.id,
      key: 'interrupted',
      agent: driver,
      signal: controller.signal,
      request: {
        role: 'editorial_audience',
        schema: audienceSchema,
        editorial: editorial(),
        instruction: 'Observe',
        input: {},
      },
    }),
  );
  assert.ok(store.artifact(task.id, 'interrupted.candidate', false));
  assert.equal(
    (store.artifact(task.id, 'interrupted.repair', false)?.data as any).code,
    'EVIDENCE_DUPLICATE',
  );
  assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
});

test('an oversized cached report is repaired by the observer without exposing requirements or changing the cut', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'PRIVATE_CREATOR_GOAL' });
  const key = 'capacity-review',
    cut = editorial(),
    original = hash(cut);
  const verbose = completeAudience('冗长的事实描述');
  store.saveArtifact(task.id, key, verbose, true);
  let calls = 0;
  const compact = completeAudience('同一事实');
  const driver: AgentDriver = {
    async run(request) {
      calls++;
      assert.equal(request.role, 'editorial_audience');
      assert.equal(hash(request.editorial), original);
      const input = request.input as any;
      assert.equal(input.validationErrors.code, 'EVIDENCE_CAPACITY');
      assert.deepEqual(input.previousReview, verbose);
      assert.ok(!JSON.stringify(input).includes('PRIVATE_CREATOR_GOAL'));
      return request.schema.parse(compact);
    },
  };
  const options = {
    store,
    taskId: task.id,
    key,
    agent: driver,
    request: {
      role: 'editorial_audience' as const,
      instruction: 'Observe',
      input: {},
      schema: audienceSchema,
      editorial: cut,
    },
    validateEvaluation: async (report: ReturnType<typeof audience>) => {
      if (report.summary === verbose.summary)
        throw new FilmError(
          'EVIDENCE_CAPACITY',
          'Evidence text is too long; keep all facts and shorten prose',
        );
    },
  };
  assert.deepEqual(await reviewAudience(options), compact);
  assert.deepEqual(await reviewAudience(options), compact);
  assert.equal(calls, 1);
  assert.equal(hash(cut), original);
  assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
  assert.ok(store.events(task.id).some((event) => event.type === 'review.repair_requested'));
});

test('capacity validation infrastructure errors preserve the report instead of requesting arbitrary rewrites', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'capacity infrastructure' });
  store.saveArtifact(task.id, 'capacity-fault', completeAudience(), true);
  await assert.rejects(
    reviewAudience({
      store,
      taskId: task.id,
      key: 'capacity-fault',
      agent: {
        async run() {
          throw new Error('Observer must not run');
        },
      },
      request: {
        role: 'editorial_audience',
        instruction: 'Observe',
        input: {},
        schema: audienceSchema,
        editorial: editorial(),
      },
      validateEvaluation: async () => {
        throw new FilmError('MODEL_REQUIRED', 'Scoring model unavailable');
      },
    }),
    { code: 'MODEL_REQUIRED' },
  );
  assert.equal(store.artifact(task.id, 'capacity-fault.repair', false), undefined);
  assert.ok(store.artifact(task.id, 'capacity-fault'));
});

test('missing observations are repaired by the observer, including explicit unknowns, without a recut', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'PRIVATE_CREATOR_GOAL' });
  const cut = editorial(),
    original = hash(cut),
    key = 'coverage-repair';
  store.saveArtifact(task.id, key, audience(), true);
  let calls = 0;
  const report = await reviewAudience({
    store,
    taskId: task.id,
    key,
    agent: {
      async run(request) {
        calls++;
        const input = request.input as any;
        assert.equal(input.validationErrors.code, 'EVIDENCE_COVERAGE');
        assert.deepEqual(input.validationErrors.details.missing, [
          { bindingId: 'shot_b', modality: 'visual', start: 2, end: 4, uncitedEvidenceIds: [] },
        ]);
        assert.ok(!JSON.stringify(input).includes('PRIVATE_CREATOR_GOAL'));
        const fixed = audience();
        fixed.evidence.push({
          id: 'unknown',
          bindingId: 'shot_b',
          start: 2,
          end: 4,
          modality: 'visual',
          observation: '这一段未能观察，人物动作未知',
        });
        fixed.events.push({ at: 2, text: '此区间无法确认动作', evidenceIds: ['unknown'] });
        return request.schema.parse(fixed);
      },
    },
    request: {
      role: 'editorial_audience',
      schema: audienceSchema,
      editorial: cut,
      instruction: 'Observe',
      input: {},
    },
    validateEvaluation: async (value) => validateReviewCoverage(value, cut),
  });
  assert.equal(calls, 1);
  assert.equal(hash(cut), original);
  assert.match(report.evidence[1]!.observation, /未知/);
  assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
});

test('coverage cannot borrow an overlapping track, uncited evidence or low-confidence claims', () => {
  const cut = editorial();
  cut.shots[1]!.start = 0;
  const report = audience();
  assert.throws(() => validateReviewCoverage(report, cut), { code: 'EVIDENCE_COVERAGE' });
  report.evidence.push({ ...report.evidence[0]!, id: 'second', bindingId: 'shot_b' });
  report.claims.push({ text: '可能发生', confidence: 0.3, evidenceIds: ['second'] });
  assert.throws(
    () => validateReviewCoverage(report, cut),
    (error: any) => {
      assert.equal(error.code, 'EVIDENCE_COVERAGE');
      assert.deepEqual(error.details.missing, [
        { bindingId: 'shot_b', modality: 'visual', start: 0, end: 2, uncitedEvidenceIds: ['second'] },
      ]);
      return true;
    },
  );
  report.events.push({ at: 0, text: '此轨道内容无法确认', evidenceIds: ['second'] });
  validateReviewCoverage(report, cut);
  report.evidence[1]!.end = 1.9;
  assert.throws(
    () => validateReviewCoverage(report, cut),
    (error: any) => error.code === 'EVIDENCE_COVERAGE' && error.details.missing[0].start === 1.9,
  );
});

test('coverage diagnostics distinguish existing but uncited observations from an unobserved interval', () => {
  const cut = editorial();
  const report = audience();
  report.evidence.push(
    { ...report.evidence[0]!, id: 'second_start', bindingId: 'shot_b', start: 2, end: 3 },
    { ...report.evidence[0]!, id: 'second_text', bindingId: 'shot_b', start: 2, end: 4, modality: 'text' },
  );
  assert.throws(
    () => validateReviewCoverage(report, cut),
    (error: any) => {
      assert.deepEqual(error.details.missing, [
        { bindingId: 'shot_b', modality: 'visual', start: 2, end: 4, uncitedEvidenceIds: ['second_start'] },
      ]);
      return true;
    },
  );
  report.events.push({ at: 2, text: '此处的动作无法确认', evidenceIds: ['second_start'] });
  assert.throws(
    () => validateReviewCoverage(report, cut),
    (error: any) => {
      assert.deepEqual(error.details.missing, [
        { bindingId: 'shot_b', modality: 'visual', start: 3, end: 4, uncitedEvidenceIds: [] },
      ]);
      return true;
    },
  );
});

test('actual mixed-audio evidence can cover silent gaps only in a rendered review', () => {
  const cut = editorial();
  cut.shots = [{ ...cut.shots[0]!, duration: 4 }];
  const report = audience();
  report.evidence[0]!.end = 4;
  report.evidence.push({
    id: 'mix',
    bindingId: 'rendered_audio',
    start: 0,
    end: 4,
    modality: 'audio',
    observation: '开头有人声，后两秒混音实测静音',
  });
  report.events.push({ at: 2, text: '混音进入静音', evidenceIds: ['mix'] });
  assert.throws(() => validateAudience(report, cut), { code: 'EVIDENCE_RANGE' });
  validateAudience(report, cut, true);
  validateReviewCoverage(report, cut, true);
  report.evidence[1]!.end = 2;
  assert.throws(() => validateReviewCoverage(report, cut, true), { code: 'EVIDENCE_COVERAGE' });
  report.evidence[1]!.end = 5;
  assert.throws(() => validateAudience(report, cut, true), { code: 'EVIDENCE_RANGE' });
  report.evidence[1]!.end = 4;
  report.evidence[1]!.modality = 'text';
  assert.throws(() => validateAudience(report, cut, true), { code: 'EVIDENCE_MODALITY' });
});
