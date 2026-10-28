import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { audience, editorial, fixture } from './helpers.js';
import {
  acceptancePlanSchema,
  validateAcceptancePlan,
  type AcceptanceSource,
  type Predicate,
} from '../packages/core/src/acceptance.js';
import { scoreAcceptance } from '../packages/media/src/acceptance-scoring.js';
import type { SemanticModel } from '../packages/media/src/scoring.js';
import { compileAcceptance, acceptanceSources } from '../packages/application/src/acceptance.js';
import { createTask } from '../packages/application/src/workflow.js';
import type { CreativeBrief } from '../packages/core/src/creative-domain.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';

const source: AcceptanceSource = {
  id: 'requirement',
  text: '画面要求',
  quote: '用户原句',
  group: 'fixed',
  modality: 'visual',
  stage: 'editorial',
};
const model: SemanticModel = {
  version: 'test-atomic-exact',
  async compare(pairs) {
    return pairs.map(({ premise, hypothesis }) => ({
      similarity: 1,
      entailment: premise === hypothesis ? 0.99 : 0.01,
      contradiction: 0,
      neutral: premise === hypothesis ? 0.01 : 0.99,
    }));
  },
};
const plan = (checks: Predicate[]) =>
  acceptancePlanSchema.parse({ schemaVersion: 1, sources: [{ sourceId: source.id, checks }] });
const score = (checks: Predicate[], observation = audience('静止画面')) =>
  scoreAcceptance(model, [source], plan(checks), observation, { editorial: editorial(), stage: 'editorial' });

test('global program contradictions are rejected before editing, including across separate sources', () => {
  const narration: Predicate = { kind: 'track_count', role: 'narration', value: 1 };
  const rule = (name: 'silent' | 'narration_only' | 'no_narration' | 'no_music'): Predicate => ({
    kind: 'program',
    rule: name,
    value: null,
  });
  for (const checks of [
    [narration, rule('narration_only'), rule('silent')],
    [rule('narration_only'), rule('no_narration')],
    [rule('no_music'), { kind: 'track_count', role: 'music', value: 1 } as Predicate],
    [narration, { kind: 'track_count', role: 'all', value: 0 } as Predicate],
    [narration, rule('narration_only'), { kind: 'track_count', role: 'all', value: 2 } as Predicate],
  ])
    assert.throws(() => validateAcceptancePlan(plan(checks), [source], 4), { code: 'ACCEPTANCE_CONFLICT' });
  assert.doesNotThrow(() => validateAcceptancePlan(plan([narration, rule('narration_only')]), [source], 4));
  assert.doesNotThrow(() =>
    validateAcceptancePlan(
      plan([rule('silent'), { kind: 'track_count', role: 'all', value: 0 }]),
      [source],
      4,
    ),
  );
  const sources = [source, { ...source, id: 'other' }];
  assert.throws(
    () =>
      validateAcceptancePlan(
        {
          schemaVersion: 1,
          sources: [
            { sourceId: source.id, checks: [narration] },
            { sourceId: 'other', checks: [rule('silent')] },
          ],
        },
        sources,
        4,
      ),
    { code: 'ACCEPTANCE_CONFLICT' },
  );
});

test('all requires complete temporal coverage; same content outside the interval cannot satisfy it', async () => {
  const check: Predicate = {
    kind: 'observation',
    modality: 'visual',
    claim: '静止画面',
    coverage: 'all',
    interval: { start: 0, end: 3 },
  };
  const observed = audience('静止画面');
  assert.equal((await score([check], observed)).passed, false);
  observed.evidence[0]!.end = 3;
  assert.equal((await score([check], observed)).passed, true);
  observed.evidence[0]!.start = 3;
  observed.evidence[0]!.end = 4;
  assert.equal((await score([{ ...check, coverage: 'some' }], observed)).passed, false);
  assert.equal((await score([check], observed)).passed, false);
});

test('whole evaluates complete interval evidence without converting a relationship into a per-shot obligation', async () => {
  const observed = audience('一只手把碎纸拼成一棵树');
  observed.evidence[0]!.end = 2;
  observed.evidence.push({
    ...observed.evidence[0]!,
    id: 'second',
    start: 2,
    end: 4,
    observation: '镜头切到街头的一棵真实树木',
  });
  observed.claims[0]!.evidenceIds.push('second');
  const check: Predicate = {
    kind: 'observation',
    modality: 'visual',
    claim: '纸上的树与真实树木形成视觉类比',
    coverage: 'whole',
    interval: null,
  };
  const expected = '0–2秒（visual）：一只手把碎纸拼成一棵树\n2–4秒（visual）：镜头切到街头的一棵真实树木';
  const calls: string[] = [];
  const aggregate: SemanticModel = {
    version: 'whole-fixture',
    async compare(pairs) {
      return pairs.map(({ premise }) => {
        calls.push(premise);
        return {
          similarity: 1,
          entailment: premise === expected ? 0.99 : 0.01,
          contradiction: 0,
          neutral: premise === expected ? 0.01 : 0.99,
        };
      });
    },
  };
  const evaluate = (predicate: Predicate, output = observed, model = aggregate) =>
    scoreAcceptance(model, [source], plan([predicate]), output, {
      editorial: editorial(),
      stage: 'editorial',
    });
  assert.equal((await evaluate(check)).passed, true);
  assert.deepEqual(calls, [expected]);
  assert.equal((await evaluate({ ...check, coverage: 'all' })).passed, false);
  assert.equal((await evaluate({ ...check, coverage: 'some' })).passed, false);
  const missing = structuredClone(observed);
  missing.evidence[1]!.start = 3;
  const before = calls.length;
  assert.equal((await evaluate(check, missing)).passed, false);
  assert.equal(calls.length, before, 'incomplete interval must not be scored');
  const wrongModality = structuredClone(observed);
  wrongModality.evidence[1]!.modality = 'audio';
  assert.equal((await evaluate(check, wrongModality)).passed, false);
  const extra = structuredClone(observed);
  extra.evidence.push({ ...extra.evidence[0]!, id: 'contrary', observation: '画面其实是无关的广告' });
  extra.claims[0]!.evidenceIds.push('contrary');
  assert.equal(
    (await evaluate(check, extra)).passed,
    false,
    'do not cherry-pick only the two supportive observations',
  );
  const tooLong: SemanticModel = {
    version: 'overflow',
    async compare(pairs) {
      return pairs.map(() => ({
        similarity: 1,
        entailment: 1,
        contradiction: 0,
        neutral: 0,
        inputTooLong: true,
      }));
    },
  };
  assert.equal((await evaluate(check, observed, tooLong)).passed, false, 'no truncation or overflow pass');
  const contrary: SemanticModel = {
    version: 'contradiction',
    async compare(pairs) {
      return pairs.map(() => ({ similarity: 1, entailment: 0, contradiction: 1, neutral: 0 }));
    },
  };
  const rejected = await evaluate(check, observed, contrary);
  assert.equal(rejected.passed, false);
  assert.equal(rejected.fixed?.criteria[0]!.status, 'contradicted');
});

test('ambience counts refer to the actual IR role, not an unrenderable ambient role', async () => {
  const ir = editorial();
  ir.audio.push({
    id: 'wind',
    assetId: 'asset_a',
    role: 'ambience',
    sourceStart: 0,
    start: 0,
    duration: 4,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    duck: false,
  });
  const check: Predicate = { kind: 'track_count', role: 'ambience', value: 1 };
  assert.equal(
    (await scoreAcceptance(model, [source], plan([check]), audience(), { editorial: ir, stage: 'editorial' }))
      .passed,
    true,
  );
  assert.throws(
    () =>
      validateAcceptancePlan(plan([check, { kind: 'program', rule: 'silent', value: null }]), [source], 4),
    { code: 'ACCEPTANCE_CONFLICT' },
  );
});

test('temporal order uses grounded event times, rejects reversal and unsupported event labels', async () => {
  const observed = audience('关门');
  observed.evidence[0]!.end = 1;
  observed.evidence.push({ ...observed.evidence[0]!, id: 'leave', start: 2, end: 3, observation: '离开' });
  observed.events = [
    { text: '关门', at: 0.5, evidenceIds: ['evidence_a'] },
    { text: '离开', at: 2.5, evidenceIds: ['leave'] },
  ];
  const check: Predicate = { kind: 'order', modality: 'visual', before: '关门', after: '离开' };
  assert.equal((await score([check], observed)).passed, true);
  observed.evidence[0]!.start = 3;
  observed.evidence[0]!.end = 4;
  observed.events[0]!.at = 3.5;
  assert.equal((await score([check], observed)).passed, false);
  observed.evidence[0]!.observation = '一张纸';
  assert.equal((await score([check], observed)).passed, false);
});

test('quantity checks require the count in cited evidence, not just an observer number', async () => {
  const observed = audience('人的数量为2');
  observed.quantities = [{ subject: '人', count: 3, confidence: 1, evidenceIds: ['evidence_a'] }];
  const check: Predicate = { kind: 'count', modality: 'visual', subject: '人', operator: 'eq', value: 3 };
  assert.equal((await score([check], observed)).passed, false);
  observed.evidence[0]!.observation = '人的数量为3';
  assert.equal((await score([check], observed)).passed, true);
  assert.equal((await score([{ ...check, operator: 'lte', value: 2 }], observed)).passed, false);
});

test('program checks use IR; repeated narration cannot prove a visual requirement', async () => {
  const observed = audience('静止画面');
  observed.evidence[0]!.modality = 'audio';
  const check: Predicate = {
    kind: 'observation',
    modality: 'visual',
    claim: '静止画面',
    coverage: 'some',
    interval: null,
  };
  for (let i = 0; i < 10; i++) observed.claims.push(observed.claims[0]!);
  assert.equal((await score([check], observed)).passed, false);
  assert.equal(
    (await score([{ kind: 'program', rule: 'no_added_text', value: null }], observed)).passed,
    false,
  );
  assert.equal((await score([{ kind: 'track_count', role: 'all', value: 0 }], observed)).passed, true);
});

test('truncated semantic inputs and omitted compilation sources cannot pass', async () => {
  const check: Predicate = {
    kind: 'observation',
    modality: 'visual',
    claim: '静止画面',
    coverage: 'some',
    interval: null,
  };
  const tooLong: SemanticModel = {
    version: 'test-too-long',
    async compare(pairs) {
      return pairs.map(() => ({
        similarity: 1,
        entailment: 1,
        contradiction: 0,
        neutral: 0,
        inputTooLong: true,
      }));
    },
  };
  assert.equal(
    (
      await scoreAcceptance(tooLong, [source], plan([check]), audience(), {
        editorial: editorial(),
        stage: 'editorial',
      })
    ).passed,
    false,
  );
  assert.throws(() => validateAcceptancePlan({ schemaVersion: 1, sources: [] }, [source], 4), {
    code: 'ACCEPTANCE_SOURCE',
  });
  assert.throws(
    () => validateAcceptancePlan(plan([{ ...check, interval: { start: 3, end: 5 } }]), [source], 4),
    { code: 'ACCEPTANCE_TIME' },
  );
});

test('compiler resumes audit of the same plan, repairs changed meaning, and preserves the cut for reassessment', async (t) => {
  const { store, root } = await fixture();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: '人物关门' });
  const brief = {
    intent: { constraints: [] },
    concept: {
      id: 'concept',
      commitments: [{ id: 'commitment', text: '画面显示人物关门', modality: 'visual', stage: 'editorial' }],
    },
  } as unknown as CreativeBrief;
  const cut = store.saveArtifact(task.id, 'editorial', editorial(), true);
  store.saveArtifact(task.id, 'script', { text: 'frozen' }, true);
  let compilations = 0,
    audits = 0;
  const agent: AgentDriver = {
    async run(req) {
      assert.equal(req.toolAccess, 'none');
      assert.ok(!JSON.stringify(req.input).includes('shot_a'), 'compiler must not see actual cut or score');
      const sources = (req.input as any).sources;
      assert.ok(
        sources.every((s: any) => !('quote' in s)),
        'provenance quotes are not new obligations',
      );
      if (req.role === 'acceptance') {
        compilations++;
        if (compilations === 2)
          assert.equal((req.input as any).feedback.review.sources[0].verdict, 'changed');
        if (compilations === 3)
          assert.equal((req.input as any).feedback.review.sources[0].counterexamples.length, 1);
        return req.schema.parse({
          schemaVersion: 1,
          sources: sources.map((s: any) => ({
            sourceId: s.id,
            checks: [{ kind: 'playback_rate', region: 'all', rate: 1, approximate: false, interval: null }],
          })),
        });
      }
      assert.equal(req.role, 'acceptance_review');
      audits++;
      if (audits === 1) throw new Error('audit interrupted');
      return req.schema.parse({
        sources: sources.map((s: any) => ({
          sourceId: s.id,
          verdict: audits === 2 ? 'changed' : 'equivalent',
          counterexamples:
            audits === 3
              ? [
                  {
                    direction: 'checks_without_requirement',
                    scenario: 'A counterexample cannot be ignored even if the verdict says equivalent',
                  },
                ]
              : [],
          reason: '动作含义核对',
        })),
      });
    },
  };
  await assert.rejects(compileAcceptance(store, task.id, agent, brief), /audit interrupted/);
  assert.equal(
    store.artifact(task.id, 'editorial')!.hash,
    cut.hash,
    'unreviewed plan cannot invalidate work',
  );
  const compiled = await compileAcceptance(store, task.id, agent, brief);
  assert.equal(compilations, 3);
  assert.equal(audits, 4);
  assert.equal(store.artifact(task.id, 'editorial'), undefined);
  assert.equal(
    (store.artifact(task.id, 'editorial.pending_assessment')!.data as any).candidateHash,
    cut.hash,
  );
  assert.ok(store.artifact(task.id, 'script'));
  assert.deepEqual(compiled.sources, acceptanceSources(brief));
  assert.deepEqual(await compileAcceptance(store, task.id, agent, brief), compiled);
  assert.equal(audits, 4);
});

test('compiler freezes independently approved checks across repair and interruption; changed input starts fresh', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '人物关门后离开' });
  const brief = {
    intent: { constraints: [] },
    concept: {
      id: 'concept',
      commitments: [
        { id: 'door', text: '人物关门', modality: 'visual', stage: 'editorial' },
        { id: 'leave', text: '人物离开', modality: 'visual', stage: 'editorial' },
      ],
    },
  } as unknown as CreativeBrief;
  const compiledInputs: string[][] = [],
    reviewedInputs: string[][] = [];
  const agent: AgentDriver = {
    async run(request) {
      const sources = (request.input as any).sources as AcceptanceSource[];
      const context = (request.input as any).context;
      assert.deepEqual(
        context.sources.map((s: AcceptanceSource) => s.id),
        ['expression_0', 'expression_1'],
      );
      assert.ok(context.sources.every((s: AcceptanceSource) => !('quote' in s)));
      if (request.role === 'acceptance') {
        compiledInputs.push(sources.map((s) => s.id));
        const output = {
          schemaVersion: 1,
          sources: sources.map((s) => ({
            sourceId: s.id,
            checks: [{ kind: 'playback_rate', region: 'all', rate: 1, approximate: false, interval: null }],
          })),
        };
        if (compiledInputs.length === 2) {
          assert.deepEqual(
            sources.map((s) => s.id),
            ['expression_1'],
          );
          const overwrite = request.schema.parse({
            ...output,
            sources: [
              ...output.sources,
              {
                sourceId: 'expression_0',
                checks: [
                  { kind: 'playback_rate', region: 'all', rate: 1, approximate: false, interval: null },
                ],
              },
            ],
          });
          assert.throws(() => request.validateOutput!(overwrite), { code: 'ACCEPTANCE_SOURCE' });
        }
        return request.validateOutput!(request.schema.parse(output));
      }
      reviewedInputs.push(sources.map((s) => s.id));
      if (reviewedInputs.length === 2) throw new Error('audit interrupted after partial approval');
      return request.schema.parse({
        sources: sources.map((s) => ({
          sourceId: s.id,
          verdict: 'equivalent',
          reason: 'fixture audit',
          counterexamples:
            reviewedInputs.length === 1 && s.id === 'expression_1'
              ? [
                  {
                    direction: 'checks_without_requirement',
                    scenario: 'An equivalent label with a counterexample cannot be frozen',
                  },
                ]
              : [],
        })),
      });
    },
  };
  await assert.rejects(compileAcceptance(store, task.id, agent, brief), /audit interrupted/);
  const result = await compileAcceptance(store, task.id, agent, brief);
  assert.deepEqual(compiledInputs, [['expression_0', 'expression_1'], ['expression_1']]);
  assert.deepEqual(reviewedInputs, [['expression_0', 'expression_1'], ['expression_1'], ['expression_1']]);
  assert.equal((result.plan.sources[0]!.checks[0] as { rate: number }).rate, 1);
  assert.equal(result.plan.sources.length, 2);
  brief.concept.commitments[0]!.text = '人物打开门';
  const changed = await compileAcceptance(store, task.id, agent, brief);
  assert.notEqual(changed.inputHash, result.inputHash);
  assert.deepEqual(compiledInputs.at(-1), ['expression_0', 'expression_1']);
  assert.deepEqual(reviewedInputs.at(-1), ['expression_0', 'expression_1']);
});

test('acceptance retains frozen technical context and invalidates compilation when that context changes', async (t) => {
  const { store, root } = await fixture();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: '实拍汽车短片，不要旁白。' });
  const brief = {
    intent: {
      constraints: [],
      technical: [{ kind: 'no_narration', value: true, quote: '不要旁白。' }],
    },
    concept: {
      id: 'concept',
      commitments: [{ id: 'vehicle', text: '画面中有汽车', modality: 'visual', stage: 'editorial' }],
    },
  } as unknown as CreativeBrief;
  let compilations = 0;
  const agent: AgentDriver = {
    async run(request) {
      const input = request.input as any;
      assert.deepEqual(input.context.technical, brief.intent.technical);
      assert.deepEqual(input.context.sources, input.sources);
      if (request.role === 'acceptance') {
        compilations++;
        return request.schema.parse({
          schemaVersion: 1,
          sources: input.sources.map((s: AcceptanceSource) => ({
            sourceId: s.id,
            checks: [{ kind: 'playback_rate', region: 'all', rate: 1, approximate: false, interval: null }],
          })),
        });
      }
      return request.schema.parse({
        sources: input.sources.map((s: AcceptanceSource) => ({
          sourceId: s.id,
          verdict: 'equivalent',
          reason: 'fixture',
          counterexamples: [],
        })),
      });
    },
  };
  const first = await compileAcceptance(store, task.id, agent, brief);
  assert.equal(compilations, 1);
  await compileAcceptance(store, task.id, agent, brief);
  assert.equal(compilations, 1);
  brief.intent.technical = [{ kind: 'silent', value: true, quote: '全片静音。' }];
  const changed = await compileAcceptance(store, task.id, agent, brief);
  assert.notEqual(changed.inputHash, first.inputHash);
  assert.equal(
    compilations,
    2,
    'same semantic sources with different technical conditions must be recompiled',
  );
});

test('a new compiler version audits the previous candidate before regeneration without reusing its approval', async (t) => {
  const { store, root } = await fixture();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: '画面中有汽车', output: { fps: 12 } });
  const brief = {
    intent: { constraints: [], technical: [] },
    concept: {
      id: 'concept',
      commitments: [{ id: 'vehicle', text: '画面中有汽车', modality: 'visual', stage: 'editorial' }],
    },
  } as unknown as CreativeBrief;
  const sources = acceptanceSources(brief);
  const oldPlan = {
    schemaVersion: 1,
    sources: [
      {
        sourceId: sources[0]!.id,
        checks: [{ kind: 'playback_rate', region: 'all', rate: 1, approximate: false, interval: null }],
      },
    ],
  };
  store.saveArtifact(
    task.id,
    'acceptance.plan',
    { version: 'previous-compiler', inputHash: 'old', sources, plan: oldPlan },
    true,
  );
  const roles: string[] = [];
  const agent: AgentDriver = {
    async run(request) {
      roles.push(request.role);
      const input = request.input as any;
      assert.equal(input.context.outputFps, 12);
      if (roles.length === 1) {
        assert.equal(request.role, 'acceptance_review');
        assert.deepEqual(input.plan, oldPlan);
        assert.equal(store.artifact<any>(task.id, 'acceptance.plan')!.data.version, 'previous-compiler');
        return request.schema.parse({
          sources: [
            {
              sourceId: sources[0]!.id,
              verdict: 'missing',
              reason: 'new audit rejects old candidate',
              counterexamples: [],
            },
          ],
        });
      }
      if (request.role === 'acceptance')
        return request.schema.parse({
          ...oldPlan,
          sources: [
            {
              sourceId: sources[0]!.id,
              checks: [{ kind: 'playback_rate', region: 'all', rate: 1, approximate: false, interval: null }],
            },
          ],
        });
      return request.schema.parse({
        sources: [
          { sourceId: sources[0]!.id, verdict: 'equivalent', reason: 'corrected', counterexamples: [] },
        ],
      });
    },
  };
  const result = await compileAcceptance(store, task.id, agent, brief);
  assert.deepEqual(roles, ['acceptance_review', 'acceptance', 'acceptance_review']);
  assert.notEqual(result.version, 'previous-compiler');
  assert.equal((result.plan.sources[0]!.checks[0] as { rate: number }).rate, 1);
});

test('state changes are counted from complete evidence, rejecting gaps, overlap and duplicate inflation', async () => {
  const check: Predicate = {
    kind: 'state_changes',
    modality: 'visual',
    states: ['静止', '运动'],
    value: 2,
    interval: null,
  };
  const observed = audience('静止');
  observed.evidence[0]!.end = 1;
  observed.evidence.push({ ...observed.evidence[0]!, id: 'moving', start: 1, end: 3, observation: '运动' });
  observed.evidence.push({ ...observed.evidence[0]!, id: 'still', start: 3, end: 4, observation: '静止' });
  observed.claims[0]!.evidenceIds = observed.evidence.map((e) => e.id);
  assert.equal((await score([check], observed)).passed, true);
  observed.evidence.push({ ...observed.evidence[0]!, id: 'duplicate' });
  observed.claims[0]!.evidenceIds.push('duplicate');
  assert.equal((await score([check], observed)).passed, true);
  assert.equal((await score([{ ...check, value: 3 }], observed)).passed, false);
  observed.evidence[1]!.start = 1.5;
  assert.equal((await score([check], observed)).passed, false);
  observed.evidence[1]!.start = 0.5;
  assert.equal((await score([check], observed)).passed, false);
});

test('mixed requirements use each predicate modality; pending layout checks are not reported as supported', async () => {
  const check: Predicate = {
    kind: 'observation',
    modality: 'visual',
    claim: '静止画面',
    coverage: 'some',
    interval: null,
  };
  const compiled = plan([check, { kind: 'program', rule: 'preserve_frame', value: null }]);
  const output = await scoreAcceptance(
    model,
    [{ ...source, modality: 'text' }],
    compiled,
    audience('静止画面'),
    {
      editorial: editorial(),
      stage: 'editorial',
    },
  );
  assert.equal(output.passed, true);
  assert.equal(output.deferred.length, 1);
  assert.equal(output.fixed!.criteria[0]!.checks.length, 1);
  assert.throws(() => validateAcceptancePlan(plan([{ ...check, claim: '0–3秒是静止画面' }]), [source], 4), {
    code: 'ACCEPTANCE_ATOMIC',
  });
  assert.throws(
    () =>
      validateAcceptancePlan(
        plan([
          { kind: 'state_changes', modality: 'visual', states: ['静止', '静止'], value: 1, interval: null },
        ]),
        [source],
        4,
      ),
    { code: 'ACCEPTANCE_STATES' },
  );
});

test('sequence checks use the complete chronological evidence, not one frame or the audience conclusion', async () => {
  const observed = audience('蓝色车身');
  observed.evidence.push({
    ...observed.evidence[0]!,
    id: 'cabin',
    start: 2,
    end: 4,
    observation: '米色座舱',
  });
  observed.claims[0]!.text = 'UNSUPPORTED_CONCLUSION';
  observed.claims[0]!.evidenceIds.push('cabin');
  const check: Predicate = {
    kind: 'sequence',
    modality: 'visual',
    claim: '作品从外观转向内饰',
    steps: ['蓝色车身', '米色座舱'],
    interval: null,
  };
  const measured: string[] = [];
  const sequenceModel: SemanticModel = {
    version: 'fixture-sequence',
    async compare(pairs) {
      return pairs.map(({ premise, hypothesis }) => {
        measured.push(premise);
        const ok =
          premise === hypothesis ||
          (premise.includes('0–2秒') &&
            premise.includes('蓝色车身') &&
            premise.includes('2–4秒') &&
            premise.includes('米色座舱'));
        return { similarity: 1, entailment: ok ? 0.99 : 0, contradiction: 0, neutral: ok ? 0.01 : 1 };
      });
    },
  };
  const evaluate = () =>
    scoreAcceptance(sequenceModel, [source], plan([check]), observed, {
      editorial: editorial(),
      stage: 'editorial',
    });
  assert.equal((await evaluate()).passed, true);
  assert.ok(measured.every((p) => !p.includes('UNSUPPORTED_CONCLUSION')));
  [observed.evidence[0]!.observation, observed.evidence[1]!.observation] = ['米色座舱', '蓝色车身'];
  assert.equal(
    (await evaluate()).passed,
    false,
    'A high aggregate score cannot pass reversed narrative steps',
  );
  [observed.evidence[0]!.observation, observed.evidence[1]!.observation] = ['蓝色车身', '米色座舱'];
  observed.evidence[1]!.start = 3;
  assert.equal((await evaluate()).passed, false, 'A temporal gap cannot stand for the complete work');
  observed.evidence[1]!.start = 2;
  observed.evidence[1]!.modality = 'audio';
  assert.equal((await evaluate()).passed, false, 'Audio cannot fill a visual sequence gap');
});

test('complete sequence overflow is an evaluation failure; no observation is silently discarded', async () => {
  const observed = audience('完整长观察');
  observed.evidence[0]!.end = 4;
  const check: Predicate = {
    kind: 'sequence',
    modality: 'visual',
    claim: '整体叙事',
    steps: ['起点状态', '终点状态'],
    interval: null,
  };
  const tooLong: SemanticModel = {
    version: 'fixture-overflow',
    async compare(pairs) {
      assert.ok(pairs.every((p) => p.premise.includes('完整长观察')));
      return pairs.map(() => ({
        similarity: 1,
        entailment: 1,
        contradiction: 0,
        neutral: 0,
        inputTooLong: true,
        inputTokens: 1025,
        maxInputTokens: 512,
      }));
    },
  };
  const result = await scoreAcceptance(tooLong, [source], plan([check]), observed, {
    editorial: editorial(),
    stage: 'editorial',
  });
  assert.equal(result.passed, false);
  assert.equal(result.evaluationErrors[0]!.failure, 'input_too_long');
  assert.deepEqual(result.evaluationErrors[0]!.capacity, {
    inputTokens: 1025,
    maxInputTokens: 512,
    evidenceIds: ['evidence_a'],
  });
});

test('visual expression is evaluated after composition while fixed narrative requirements remain early', async () => {
  const brief = {
    intent: { constraints: [] },
    concept: {
      id: 'split',
      commitments: [
        { id: 'two_windows', text: '左右两个窗口同时可见', modality: 'visual', stage: 'editorial' },
      ],
    },
  } as unknown as CreativeBrief;
  const sources = acceptanceSources(brief);
  assert.equal(sources[0]!.stage, 'render');
  const withFixed = structuredClone(brief);
  withFixed.intent.constraints = [
    {
      id: 'fixed_story',
      dimension: 'content',
      field: 'synopsis',
      strength: 'fixed',
      value: '人物走出房间',
      quote: '人物走出房间',
      source: 'prompt',
      match: 'semantic',
      polarity: 'require',
      modality: 'visual',
    },
  ];
  assert.equal(acceptanceSources(withFixed)[0]!.stage, 'editorial');
  assert.equal(brief.concept.commitments[0]!.stage, 'editorial', 'do not mutate the accepted proposal');
  const checks = acceptancePlanSchema.parse({
    schemaVersion: 1,
    sources: [
      {
        sourceId: sources[0]!.id,
        checks: [
          {
            kind: 'observation',
            modality: 'visual',
            claim: '左右两个窗口同时可见',
            coverage: 'all',
            interval: null,
          },
        ],
      },
    ],
  });
  assert.equal(
    (
      await scoreAcceptance(model, sources, checks, audience('只有一个窗口'), {
        editorial: editorial(),
        stage: 'editorial',
      })
    ).passed,
    true,
  );
  assert.equal(
    (
      await scoreAcceptance(model, sources, checks, audience('只有一个窗口'), {
        editorial: editorial(),
        stage: 'render',
      })
    ).passed,
    false,
    'the requirement must still be enforced on actual rendering',
  );
  const visible = audience('左右两个窗口同时可见');
  visible.evidence[0]!.end = 4;
  assert.equal(
    (await scoreAcceptance(model, sources, checks, visible, { editorial: editorial(), stage: 'render' }))
      .passed,
    true,
  );
});

test('source reordering includes independent secondary tracks but never compares source times across tracks', async () => {
  const ir = editorial();
  const check: Predicate = { kind: 'program', rule: 'source_reordered', value: null };
  const evaluate = () =>
    scoreAcceptance(model, [source], plan([check]), audience(), { editorial: ir, stage: 'editorial' });
  ir.shots.push(
    { ...ir.shots[0]!, id: 'overlay_a', track: 1, sourceStart: 7 },
    { ...ir.shots[1]!, id: 'overlay_b', track: 1, sourceStart: 8 },
  );
  assert.equal((await evaluate()).passed, false, 'ordered parallel streams are not a reordered stream');
  ir.shots[3]!.sourceStart = 1;
  assert.equal((await evaluate()).passed, true);
});

test('combined visual meaning of simultaneous tracks waits for composition and remains mandatory on render', async () => {
  const cut = editorial();
  cut.shots = [
    { ...cut.shots[0]!, duration: 4 },
    { ...cut.shots[0]!, id: 'overlay', track: 1, duration: 4 },
  ];
  const check: Predicate = {
    kind: 'observation',
    modality: 'any',
    claim: '两个窗口形成对比',
    coverage: 'whole',
    interval: null,
  };
  let comparisons = 0;
  const judge: SemanticModel = {
    version: 'fixture-composition',
    async compare(pairs) {
      comparisons++;
      return pairs.map(({ premise }) => ({
        similarity: 1,
        entailment: premise.includes('两个窗口') ? 0.99 : 0,
        contradiction: premise.includes('两个窗口') ? 0 : 1,
        neutral: 0,
      }));
    },
  };
  const observed = audience('只有一个窗口，另一轨道被完全遮挡');
  observed.evidence[0]!.end = 4;
  const evaluate = (stage: 'editorial' | 'render', checks = [check]) =>
    scoreAcceptance(judge, [source], plan(checks), observed, { editorial: cut, stage });
  const provisional = await evaluate('editorial');
  assert.equal(provisional.passed, true);
  assert.equal(provisional.fixed, null, 'deferred requirements are not counted as satisfied');
  assert.deepEqual(provisional.deferred, [{ sourceId: source.id, predicate: check }]);
  assert.equal(comparisons, 0, 'do not guess layout from separate source tracks');
  assert.equal(
    (await evaluate('editorial', [check, { kind: 'program', rule: 'no_added_text', value: null }])).passed,
    false,
    'other fixed requirements still block',
  );
  assert.equal((await evaluate('render')).passed, false, 'hidden track must fail final meaning');
  observed.evidence[0]!.observation = '两个窗口形成对比';
  assert.equal((await evaluate('render')).passed, true);
  cut.shots.pop();
  observed.evidence[0]!.observation = '只有一个窗口';
  assert.equal(
    (await evaluate('editorial')).passed,
    false,
    'ordinary single-track meaning is still assessed early',
  );
});

test('semantic sound conditions use the final mix while structural audio rules still apply before render', async () => {
  const check: Predicate = {
    kind: 'observation',
    modality: 'audio',
    claim: '转场没有额外声音',
    coverage: 'some',
    interval: null,
  };
  const before = await score([check]);
  assert.equal(before.fixed, null);
  assert.deepEqual(before.deferred, [{ sourceId: source.id, predicate: check }]);
  assert.equal(
    (await score([check, { kind: 'program', rule: 'narration_only', value: null }])).passed,
    false,
  );
  const observed = audience();
  observed.evidence[0] = {
    ...observed.evidence[0]!,
    bindingId: 'rendered_audio',
    modality: 'audio',
    observation: '转场有额外引擎声',
  };
  assert.equal(
    (
      await scoreAcceptance(model, [source], plan([check]), observed, {
        editorial: editorial(),
        stage: 'render',
      })
    ).passed,
    false,
  );
});

test('necessary facts reject a partially satisfied compound claim without replacing its joint relationship', async () => {
  const joint: Predicate = {
    kind: 'observation',
    modality: 'visual',
    claim: '同一人表现紧张与放松',
    coverage: 'whole',
    interval: null,
  };
  const parts: Predicate[] = ['这个人紧张', '这个人放松'].map((claim) => ({
    kind: 'observation',
    modality: 'visual',
    claim,
    coverage: 'some',
    interval: null,
  }));
  const report = audience('这个人紧张');
  report.evidence[0]!.end = 4;
  // Simulate the measured NLI failure: a compound hypothesis scores highly from one part alone.
  const partialMatch: SemanticModel = {
    version: 'compound-false-positive-fixture',
    async compare(pairs) {
      return pairs.map(({ premise, hypothesis }) => {
        const ok = hypothesis === joint.claim || premise.includes(hypothesis);
        return {
          similarity: ok ? 1 : 0,
          entailment: ok ? 0.99 : 0.01,
          contradiction: 0,
          neutral: ok ? 0.01 : 0.99,
        };
      });
    },
  };
  const evaluate = (checks: Predicate[], observation = report, model = partialMatch) =>
    scoreAcceptance(model, [source], plan(checks), observation, { editorial: editorial(), stage: 'render' });
  assert.equal((await evaluate([joint])).passed, true, 'control reproduces the model failure');
  assert.equal((await evaluate([joint, ...parts])).passed, false, 'a missing necessary fact still blocks');
  const complete = structuredClone(report);
  complete.evidence[0]!.observation = '这个人紧张，然后这个人放松';
  assert.equal((await evaluate([joint, ...parts], complete)).passed, true);
  const wrongRelationship: SemanticModel = {
    version: 'joint-relation-counterexample',
    async compare(pairs) {
      return pairs.map(({ hypothesis }) => ({
        similarity: 1,
        entailment: hypothesis === joint.claim ? 0 : 1,
        contradiction: hypothesis === joint.claim ? 1 : 0,
        neutral: 0,
      }));
    },
  };
  assert.equal(
    (await evaluate([joint, ...parts], complete, wrongRelationship)).passed,
    false,
    'separate facts cannot replace the original relation',
  );
});

test('entity facts join on observed identity, never on shared files, keywords, or unrelated subjects', async () => {
  const check: Predicate = {
    kind: 'same_entity',
    modality: 'visual',
    facts: ['这个人紧张', '这个人放松'],
    interval: null,
  };
  const observed = audience('这个人紧张');
  observed.evidence[0]!.entityId = 'person_1';
  observed.evidence.push({
    ...observed.evidence[0]!,
    id: 'relaxed',
    bindingId: editorial().shots[1]!.id,
    observation: '这个人放松',
    start: 2,
    end: 4,
  });
  observed.claims[0]!.evidenceIds.push('relaxed');
  const evaluate = (output = observed, predicate = check, scorer = model) =>
    scoreAcceptance(scorer, [source], plan([predicate]), output, { editorial: editorial(), stage: 'render' });
  assert.equal((await evaluate()).passed, true, 'one entity may span different shots');
  const different = structuredClone(observed);
  different.evidence[1]!.entityId = 'person_2';
  assert.equal((await evaluate(different)).passed, false);
  different.evidence[1]!.bindingId = different.evidence[0]!.bindingId;
  different.evidence[1]!.start = 0;
  different.evidence[1]!.end = 2;
  assert.equal((await evaluate(different)).passed, false, 'same shot does not imply same entity');
  const unknownIdentity = structuredClone(observed);
  unknownIdentity.evidence.forEach((e) => {
    e.entityId = null;
  });
  assert.equal((await evaluate(unknownIdentity)).passed, false);
  const uncited = structuredClone(observed);
  uncited.claims[0]!.evidenceIds = [uncited.evidence[0]!.id];
  assert.equal((await evaluate(uncited)).passed, false);
  const audioOnly = structuredClone(observed);
  audioOnly.evidence.forEach((e) => {
    e.modality = 'audio';
  });
  assert.equal((await evaluate(audioOnly)).passed, false, 'audio cannot satisfy visual facts');
  assert.equal((await evaluate(observed, { ...check, interval: { start: 0, end: 2 } })).passed, false);
  for (const invalidId of [editorial().shots[0]!.id, editorial().shots[0]!.assetId]) {
    const invalid = structuredClone(observed);
    invalid.evidence.forEach((e) => {
      e.entityId = invalidId;
    });
    await assert.rejects(evaluate(invalid), { code: 'EVIDENCE_ENTITY' });
  }
  const overlong: SemanticModel = {
    version: 'overflow-control',
    async compare(pairs) {
      return pairs.map(() => ({
        similarity: 0,
        entailment: 0,
        contradiction: 0,
        neutral: 1,
        inputTooLong: true,
        inputTokens: 600,
        maxInputTokens: 512,
      }));
    },
  };
  const oversized = await evaluate(observed, check, overlong);
  assert.equal(oversized.passed, false);
  assert.ok(JSON.stringify(oversized).includes('input_too_long'));
});

test('capacity diagnostics identify the complete observation group without leaking acceptance text', async () => {
  const observed = audience('第一段人物紧张');
  observed.evidence.push({
    id: 'negative',
    bindingId: 'shot_b',
    start: 2,
    end: 4,
    modality: 'visual',
    observation: '第二段人物仍紧张，未放松',
    entityId: null,
  });
  observed.events.push({ at: 2, text: '仍紧张', evidenceIds: ['negative'] });
  const check: Predicate = {
    kind: 'observation',
    modality: 'visual',
    coverage: 'whole',
    claim: 'PRIVATE_EXPECTED_RELATION',
    interval: null,
  };
  const result = await scoreAcceptance(
    {
      version: 'capacity-group',
      async compare(pairs) {
        assert.equal(pairs.length, 1);
        assert.ok(pairs[0]!.premise.includes('未放松'), 'negative observation is retained');
        return [
          {
            similarity: 0,
            entailment: 0,
            contradiction: 0,
            neutral: 1,
            inputTooLong: true,
            inputTokens: 700,
            maxInputTokens: 512,
          },
        ];
      },
    },
    [source],
    plan([check]),
    observed,
    { editorial: editorial(), stage: 'editorial' },
  );
  const diagnostic = result.evaluationErrors[0]!.capacity;
  assert.deepEqual(diagnostic, {
    inputTokens: 700,
    maxInputTokens: 512,
    evidenceIds: ['evidence_a', 'negative'],
  });
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE_EXPECTED_RELATION'));
  assert.equal(result.passed, false);
});
