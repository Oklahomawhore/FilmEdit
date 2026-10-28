import { semanticFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, conceptFixture, acceptanceFixture } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import {
  repairCreativeImplementation,
  validateImplementationRevision,
} from '../packages/application/src/creative-revision.js';
import { MaterialMatcher } from '../packages/application/src/materials.js';
import { hash, FilmError } from '../packages/core/src/util.js';
import { scriptSchema } from '../packages/core/src/domain.js';
import type { CreativeBrief, ConceptIR } from '../packages/core/src/creative-domain.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';
const base = conceptFixture('original', '车身与座舱');
base.proposal.expression.music = '';
base.beats[0]!.audio = '';
base.bridge = 'PRIVATE_CORE_MEANING';
const brief: CreativeBrief = {
  schemaVersion: 1,
  intent: { schemaVersion: 1, constraints: [], openQuestions: [] },
  concept: base,
  seed: 'unchanged',
  round: 0,
  knowledgeHash: 'knowledge',
  operatorVersion: 'fixture',
  tasteVersion: 'fixture',
  selection: [{ id: base.id, weight: 1, probability: 1 }],
};
const script = scriptSchema.parse({
  title: '原方案',
  topic: '车身与座舱',
  angle: '反差',
  personaId: 'observer',
  narration: '',
  facts: [],
  beats: [{ id: 'opening', text: '快慢对比', visualQuery: '连续八秒侧身', durationHint: 4 }],
});
function changed(description = '两段侧身按节奏切换'): ConceptIR {
  return {
    ...base,
    proposal: { ...base.proposal, expression: { ...base.proposal.expression, editing: description } },
    beats: [{ ...base.beats[0]!, action: description }],
    commitments: base.commitments.map((c) => ({ ...c, text: description })),
  };
}
const review = { passed: true, issues: [] };
const audience = {
  understood: '对比',
  connection: '快慢',
  understandable: true,
  feasible: true,
  emotion: '轻松',
  issues: [],
};
const model = { version: 'control-flow-fixture', compare: async () => [] };
async function setup() {
  const { store } = await fixture();
  const task = await createTask(store, {
    prompt: 'PRIVATE_USER',
    creative: { knowledge: 'local' },
    materials: { strategy: 'local_only' },
  });
  store.saveArtifact(task.id, 'creative.brief', brief, true);
  store.saveArtifact(task.id, 'creative.intent', brief.intent, true);
  store.saveArtifact(task.id, 'script', script, true);
  store.saveArtifact(task.id, 'layout', { old: true }, true);
  const gap = () => {
    store.saveArtifact(
      task.id,
      'materials.requirements',
      {
        scriptHash: hash(script),
        requirements: [{ id: 'visual_1', beatId: 'opening', kind: 'visual', query: '连续八秒侧身' }],
      },
      true,
    );
    store.saveArtifact(task.id, 'materials.candidate', {
      status: 'missing',
      matches: [
        {
          needId: 'visual_1',
          assetId: 'fixture',
          sourceStart: 0,
          sourceEnd: 2,
          frameTimes: [0, 1],
          observation: 'fixture available interval',
        },
      ],
      gaps: [
        {
          needId: 'visual_1',
          attemptedQueries: ['authorized library'],
          reason: 'not enough continuous source',
        },
      ],
    });
  };
  gap();
  return { store, task, gap };
}

test('implementation revision keeps the original idea, voice, beat identities and every commitment', () => {
  assert.ok(validateImplementationRevision(changed(), base));
  assert.throws(() => validateImplementationRevision(base, base), { code: 'CREATIVE_REVISION_SCOPE' });
  for (const candidate of [
    { ...changed(), bridge: 'different idea' },
    {
      ...changed(),
      proposal: { ...changed().proposal, content: { ...base.proposal.content, narration: 'added voice' } },
    },
    { ...changed(), commitments: [] },
    { ...changed(), beats: [{ ...base.beats[0]!, id: 'new_story' }] },
  ])
    assert.throws(() => validateImplementationRevision(candidate, base), { code: 'CREATIVE_REVISION_SCOPE' });
});

test('interrupted revision keeps accepted work; resume reuses candidate and commits only after both independent reviews', async (t) => {
  const { store, task } = await setup();
  t.after(() => store.close());
  let generated = 0,
    audited = 0,
    blind = 0;
  const candidate = changed();
  store.saveArtifact(task.id, 'script.user_revision', { instruction: '保持原旁白' }, true);
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      assert.equal(
        store.artifact(task.id, 'creative.brief')!.hash,
        hash(brief),
        'old approval remains before reviews finish',
      );
      assert.ok(store.artifact(task.id, 'script'));
      if (request.role === 'creative') {
        generated++;
        assert.equal(request.toolAccess, 'none');
        const input = request.input as any;
        assert.equal(input.userRevisions[0].data.instruction, '保持原旁白');
        return request.validateOutput!(
          request.schema.parse({
            action: 'revise_implementation',
            briefHash: hash(brief),
            reason: '源时长不足，保留快慢联系',
            concept: candidate,
          }),
        );
      }
      if (request.role === 'creative_revision_review') {
        audited++;
        if (audited === 1) throw new Error('interrupted review');
        return request.schema.parse(review);
      }
      assert.equal(request.role, 'concept_audience');
      blind++;
      assert.ok(!JSON.stringify(request.input).includes('PRIVATE_'));
      assert.ok(!('materialEvidence' in (request.input as any)));
      return request.schema.parse(audience);
    },
  };
  await assert.rejects(
    repairCreativeImplementation(store, task.id, agent, script, brief),
    /interrupted review/,
  );
  assert.ok(store.artifact(task.id, 'layout'));
  const next = await repairCreativeImplementation(store, task.id, agent, script, brief);
  assert.ok(next);
  assert.notEqual(next.concept.id, base.id);
  assert.deepEqual(next.intent, brief.intent);
  assert.equal(next.seed, brief.seed);
  assert.deepEqual(next.selection, [], 'revision does not fabricate sampling probability');
  assert.equal(generated, 1);
  assert.equal(audited, 2);
  assert.equal(blind, 1);
  assert.equal(store.artifact(task.id, 'script'), undefined);
  assert.equal(store.artifact(task.id, 'layout'), undefined);
  assert.ok(store.artifact(task.id, 'script.user_revision'));
  assert.deepEqual(
    store.artifact<any>(task.id, 'creative.implementation_revision')!.data.previousBrief,
    brief,
  );
  assert.equal(store.task(task.id).version, task.version);
});

test('failed fixed conditions cannot be bypassed by an implementation repair', async (t) => {
  const { store, task } = await setup();
  t.after(() => store.close());
  const locked = {
    ...brief,
    intent: {
      ...brief.intent,
      constraints: [
        {
          id: 'car',
          dimension: 'theme' as const,
          field: 'subject',
          value: '必须是车',
          strength: 'fixed' as const,
          match: 'semantic' as const,
          polarity: 'require' as const,
          modality: 'visual' as const,
          source: 'prompt' as const,
          quote: '必须是车',
          confidence: 1,
        },
      ],
    },
  };
  let calls = 0;
  const agent: AgentDriver = {
    async run(request) {
      if (request.role === 'semantic_review')
        return request.schema.parse({
          constraints: (request.input as any).constraints.map((c: any) => ({
            id: c.id,
            status: 'contradicted',
            reason: 'fixed condition mismatch',
          })),
        });
      assert.equal(request.role, 'creative');
      calls++;
      return request.schema.parse(
        calls === 1
          ? {
              action: 'revise_implementation',
              briefHash: hash(locked),
              reason: 'fixture',
              concept: changed(),
            }
          : { action: 'blocked', reason: '不能保持固定条件' },
      );
    },
  };
  const rejected = {
    version: 'rejected-fixture',
    compare: async (pairs: unknown[]) =>
      pairs.map(() => ({ similarity: 0, entailment: 0, contradiction: 1, neutral: 0 })),
  };
  assert.equal(await repairCreativeImplementation(store, task.id, agent, script, locked), undefined);
  assert.equal(store.artifact(task.id, 'creative.brief')!.hash, hash(brief));
  assert.ok(store.artifact(task.id, 'script'));
});

test('workflow re-compiles acceptance and reviews script before matching the revised implementation', async (t) => {
  const { store, task, gap } = await setup();
  t.after(() => store.close());
  let matches = 0,
    compilations = 0;
  const roles: string[] = [];
  let oldPlan = '';
  t.mock.method(MaterialMatcher.prototype, 'run', async () => {
    if (++matches === 1) {
      gap();
      oldPlan = store.artifact(task.id, 'acceptance.plan')!.hash;
      throw new FilmError('MATERIALS_MISSING', 'fixture gap');
    }
    assert.notEqual(store.artifact(task.id, 'acceptance.plan')!.hash, oldPlan);
    assert.ok(store.artifact(task.id, 'script'));
    for (const role of [
      'creative_revision_review',
      'concept_audience',
      'script',
      'facts_review',
      'audience_review',
      'voice_review',
    ])
      assert.ok(roles.includes(role));
    assert.equal(store.artifact(task.id, 'layout'), undefined);
    throw new Error('reached revised material matching');
  });
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      roles.push(request.role);
      if (request.role === 'acceptance') compilations++;
      const compiled = acceptanceFixture(request);
      if (compiled !== undefined) return compiled;
      if (request.role === 'production_repair')
        return request.schema.parse({ action: 'blocked', reason: '冻结创意参数也需修订' });
      if (request.role === 'creative')
        return request.schema.parse({
          action: 'revise_implementation',
          briefHash: hash(brief),
          reason: '调整自选时长',
          concept: changed(),
        });
      if (request.role === 'concept_audience') return request.schema.parse(audience);
      if (request.role === 'script') {
        assert.equal((request.input as any).creativeBrief.concept.bridge, base.bridge);
        return request.schema.parse({
          ...script,
          beats: [{ ...script.beats[0]!, visualQuery: '两段车身切换' }],
        });
      }
      return request.schema.parse(review);
    },
  };
  await assert.rejects(
    new TaskRunner(store, task.id, undefined, { agent, model }).run(),
    /reached revised material matching/,
  );
  assert.equal(compilations, 2);
  assert.equal(matches, 2);
  assert.equal(store.task(task.id).spec.prompt, task.spec.prompt);
  assert.deepEqual(store.artifact<any>(task.id, 'creative.intent')!.data, brief.intent);
});
