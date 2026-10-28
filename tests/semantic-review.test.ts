import test from 'node:test';
import assert from 'node:assert/strict';
import { audience, editorial, fixture } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import {
  checkHardPredicate,
  reviewAlignment,
  validateSemanticReview,
  prepareAlignmentReview,
} from '../packages/application/src/semantic-review.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';
import type { FrozenAcceptance } from '../packages/application/src/acceptance.js';
import { compileAcceptance } from '../packages/application/src/acceptance.js';
import { defaultRender } from '../packages/core/src/ir.js';
import { hash } from '../packages/core/src/util.js';
import { validateHardTemporalPrecision } from '../packages/core/src/acceptance.js';

const source = {
  id: 'fixed',
  text: '人物关门',
  quote: '人物关门',
  group: 'fixed',
  modality: 'visual',
  stage: 'editorial',
} as const;
const frozen = (): FrozenAcceptance => ({
  version: 'unit',
  inputHash: 'unit',
  sources: [source],
  plan: { schemaVersion: 1, sources: [{ sourceId: source.id, checks: [] }] },
});
const verdict = (status: 'supported' | 'contradicted' | 'insufficient' = 'supported') => ({
  sources: [{ sourceId: source.id, status, reason: 'explicit test verdict', evidenceIds: ['evidence_a'] }],
});

test('semantic reports cannot omit requirements, invent evidence, or use speech to prove pictures', () => {
  const observed = audience();
  assert.throws(() => validateSemanticReview({ sources: [] }, [source], observed), {
    code: 'SEMANTIC_REPORT',
  });
  assert.throws(
    () =>
      validateSemanticReview({ sources: [...verdict().sources, ...verdict().sources] }, [source], observed),
    { code: 'SEMANTIC_REPORT' },
  );
  const invalid = verdict();
  invalid.sources[0]!.evidenceIds = ['invented'];
  assert.throws(() => validateSemanticReview(invalid, [source], observed), { code: 'SEMANTIC_REPORT' });
  observed.evidence[0]!.modality = 'audio';
  assert.throws(() => validateSemanticReview(verdict(), [source], observed), { code: 'SEMANTIC_REPORT' });
  const unknown = verdict('insufficient');
  unknown.sources[0]!.evidenceIds = [];
  assert.equal(validateSemanticReview(unknown, [source], observed).sources[0]!.status, 'insufficient');
});

test('a model pass cannot override program failure; cache binds the whole observed candidate', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'PRIVATE_CREATOR_CONTEXT', creative: { enabled: false } });
  const edit = editorial(),
    observed = audience();
  const plan = frozen();
  plan.plan.sources[0]!.checks = [{ kind: 'program', rule: 'no_added_text', value: null }];
  let calls = 0;
  const agent: AgentDriver = {
    async run(request) {
      calls++;
      assert.equal(request.role, 'semantic_review');
      assert.equal(request.toolAccess, 'none');
      const input = JSON.stringify(request.input);
      assert.ok(!input.includes('PRIVATE_CREATOR_CONTEXT'));
      assert.ok(!input.includes('shot_a'));
      return request.validateOutput!(request.schema.parse(verdict()));
    },
  };
  const run = () =>
    reviewAlignment(store, task.id, agent, plan, observed, { editorial: edit, stage: 'editorial' });
  assert.equal((await run()).passed, false, 'the test cut contains added text');
  await run();
  assert.equal(calls, 1);
  edit.text = [];
  assert.equal((await run()).passed, true);
  assert.equal(calls, 2);
  observed.evidence[0]!.observation = 'a different observation';
  await run();
  assert.equal(calls, 3);
});

test('semantic uncertainty fails acceptance without inventing a numeric similarity', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'test', creative: { enabled: false } });
  const agent: AgentDriver = {
    async run(request) {
      return request.schema.parse(verdict('insufficient'));
    },
  };
  const result = await reviewAlignment(store, task.id, agent, frozen(), audience(), {
    editorial: editorial(),
    stage: 'editorial',
  });
  assert.equal(result.passed, false);
  assert.equal(result.blockingIssues[0]!.status, 'insufficient');
  assert.equal('similarity' in result, false);
  assert.equal(result.deterministic, false);
});

test('judge execution/protocol errors preserve the edit and never cache a pass', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'test', creative: { enabled: false } });
  const cut = store.saveArtifact(task.id, 'editorial.candidate', editorial());
  const agent: AgentDriver = {
    async run(request) {
      return request.schema.parse({ sources: [] });
    },
  };
  await assert.rejects(
    reviewAlignment(store, task.id, agent, frozen(), audience(), {
      editorial: editorial(),
      stage: 'editorial',
    }),
    { code: 'SEMANTIC_REPORT' },
  );
  assert.equal(store.artifact(task.id, 'editorial.candidate', false)!.hash, cut.hash);
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) n FROM artifacts WHERE task_id=? AND stage LIKE 'semantic.review.%'")
      .get(task.id)!.n,
    0,
  );
});

test('changing evaluator withdraws verdicts while preserving both IRs and immutable preview', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '人物关门', creative: { enabled: false } });
  const cut = editorial(),
    layout = defaultRender(cut, { width: 320, height: 180, fps: 12 });
  store.saveArtifact(task.id, 'editorial', cut, true);
  store.saveArtifact(task.id, 'layout', layout, true);
  const preview = store.saveArtifact(task.id, 'layout.preview', { path: 'immutable-preview' }, true);
  const old = frozen();
  old.plan.sources[0]!.checks = [
    {
      kind: 'observation',
      modality: 'visual',
      claim: 'old NLI representation',
      coverage: 'some',
      interval: null,
    },
  ];
  store.saveArtifact(task.id, 'acceptance.plan', old, true);
  const roles: string[] = [];
  const agent: AgentDriver = {
    async run(request) {
      roles.push(request.role);
      const sources = (request.input as any).sources;
      return request.schema.parse(
        request.role === 'acceptance'
          ? { schemaVersion: 1, sources: sources.map((s: any) => ({ sourceId: s.id, checks: [] })) }
          : {
              sources: sources.map((s: any) => ({
                sourceId: s.id,
                verdict: 'equivalent',
                reason: 'no numeric obligation',
                counterexamples: [],
              })),
            },
      );
    },
  };
  await compileAcceptance(store, task.id, agent, undefined);
  assert.deepEqual(roles, ['acceptance', 'acceptance_review']);
  for (const [stage, value] of [
    ['editorial', cut],
    ['layout', layout],
  ] as const) {
    assert.equal(store.artifact(task.id, stage), undefined);
    assert.equal(store.artifact(task.id, `${stage}.candidate`, false)!.hash, hash(value));
    assert.equal(
      (store.artifact(task.id, `${stage}.pending_assessment`)!.data as any).candidateHash,
      hash(value),
    );
  }
  assert.equal(store.artifact(task.id, 'layout.preview')!.hash, preview.hash);
});

test('source-frame range errors disclose valid selected intervals, never broaden the observer grant', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'test' }),
    runner = new TaskRunner(store, task.id),
    cut = editorial();
  const shot = cut.shots[0]!;
  shot.sourceStart = 10;
  shot.duration = 2;
  shot.speed = 0.5;
  const tools = (runner.agent as any).createTools({ role: 'editorial_audience', editorial: cut }, true);
  const tool = tools.find((tool: any) => tool.name === 'frame');
  await assert.rejects(tool.execute({ assetId: shot.assetId, times: [10, 11] }, 'range'), (error: any) => {
    assert.equal(error.code, 'EVIDENCE_RANGE');
    assert.deepEqual(error.details.invalidTimes, [11]);
    assert.equal(error.details.ranges[0].end, 11);
    return true;
  });
  await assert.rejects(tool.execute({ assetId: 'outside', times: [0] }, 'grant'), {
    code: 'CAPABILITY_DENIED',
  });
});

test('program presentation checks still reject wrong playback rate and crop', () => {
  const edit = editorial();
  edit.text = [];
  const render = defaultRender(edit, { width: 320, height: 180, fps: 12 });
  const context = { editorial: edit, render, stage: 'render' as const };
  assert.equal(
    checkHardPredicate(
      { kind: 'playback_rate', region: 'all', rate: 2, approximate: false, interval: null },
      context,
    ).status,
    'contradicted',
  );
  render.nodes.find((n) => n.kind === 'media')!.fit = 'cover';
  assert.equal(
    checkHardPredicate({ kind: 'program', rule: 'preserve_frame', value: null }, context).status,
    'contradicted',
  );
});

test('audio perception is deferred to the actual mix while global track rules still block violations', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '只用旁白', creative: { enabled: false } });
  const plan = frozen();
  plan.sources[0] = { ...source, modality: 'audio', text: '全片只有旁白，无音乐' };
  const edit = editorial();
  edit.audio = [
    {
      id: 'voice',
      assetId: 'voice_asset',
      start: 0,
      duration: 2,
      sourceStart: 0,
      speed: 1,
      volume: 1,
      role: 'narration',
      duck: false,
      fadeIn: 0,
      fadeOut: 0,
    },
  ];
  let calls = 0;
  const agent: AgentDriver = {
    async run(request) {
      calls++;
      const input = request.input as any;
      assert.ok(input.hardChecks.some((c: any) => c.sourceId === 'technical.narration_only'));
      return request.schema.parse(verdict());
    },
  };
  const observed = audience();
  observed.evidence[0]!.modality = 'audio';
  const technical = [{ kind: 'narration_only' as const, value: true, quote: '只用旁白' }];
  const first = await reviewAlignment(store, task.id, agent, plan, observed, {
    editorial: edit,
    stage: 'editorial',
    technical,
  });
  assert.equal(first.passed, true);
  assert.equal(calls, 0);
  assert.ok(first.deferred.some((d) => d.sourceId === source.id));
  const rendered = await reviewAlignment(store, task.id, agent, plan, observed, {
    editorial: edit,
    stage: 'render',
    technical,
  });
  assert.equal(rendered.passed, true);
  assert.equal(calls, 1);
  assert.equal(rendered.deferred.length, 0);
  edit.audio.push({ ...edit.audio[0]!, id: 'extra_music', role: 'music' });
  const violated = await reviewAlignment(store, task.id, agent, plan, observed, {
    editorial: edit,
    stage: 'render',
    technical,
  });
  assert.equal(violated.passed, false);
  assert.ok(violated.blockingIssues.some((i) => i.sourceId === 'technical.narration_only'));
});

test('semantic protocol changes re-assess existing candidates once, preserving approved media', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'test' });
  const cut = store.saveArtifact(task.id, 'editorial', editorial(), true);
  const preview = store.saveArtifact(task.id, 'layout.preview', { path: 'immutable' }, true);
  store.saveArtifact(task.id, 'editorial.feedback', { obsolete: 'old semantic failure' }, true);
  store.saveArtifact(task.id, 'alignment.protocol', { protocol: 'obsolete' }, true);
  prepareAlignmentReview(store, task.id);
  assert.equal(store.artifact(task.id, 'editorial'), undefined);
  assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
  assert.equal(store.artifact(task.id, 'editorial.candidate', false)!.hash, cut.hash);
  assert.equal(store.artifact(task.id, 'layout.preview')!.hash, preview.hash);
  store.saveArtifact(task.id, 'editorial', editorial(), true);
  prepareAlignmentReview(store, task.id);
  assert.equal(store.artifact(task.id, 'editorial')!.hash, cut.hash);
});

test('compilation must not round source times into frame timestamps and double-quantize a cut', () => {
  const plan = frozen();
  plan.sources[0] = { ...source, text: '7.7-9.9秒0.9x，9.9秒后0.6x' };
  const check = {
    kind: 'playback_rate' as const,
    region: 'all' as const,
    rate: 0.9,
    approximate: false,
    interval: { start: 7.7, end: 9.9 },
  };
  plan.plan.sources[0]!.checks = [check];
  assert.doesNotThrow(() => validateHardTemporalPrecision(plan.plan, plan.sources, 12));
  const edit = editorial();
  edit.text = [];
  edit.duration = 12;
  edit.shots = [
    { ...edit.shots[0]!, start: 0, duration: 9.9, speed: 0.9 },
    { ...edit.shots[1]!, start: 9.9, duration: 2.1, sourceStart: 0, speed: 0.6 },
  ];
  const render = defaultRender(edit, { width: 320, height: 180, fps: 12 });
  const context = { editorial: edit, render, stage: 'render' as const };
  assert.equal(checkHardPredicate(check, context).status, 'supported');
  check.interval.end = 9.9167;
  assert.equal(
    checkHardPredicate(check, context).status,
    'contradicted',
    'the lossy compiled interval incorrectly includes frame 119',
  );
  assert.throws(() => validateHardTemporalPrecision(plan.plan, plan.sources, 12), {
    code: 'ACCEPTANCE_TIME_PRECISION',
  });
  check.interval = { start: 7.6667, end: 9.9 };
  assert.throws(() => validateHardTemporalPrecision(plan.plan, plan.sources, 12), {
    code: 'ACCEPTANCE_TIME_PRECISION',
  });
});
