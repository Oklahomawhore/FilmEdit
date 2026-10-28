import { semanticFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, acceptanceFixture } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import {
  requestScriptMaterialRepair,
  validateScriptMaterialRepair,
} from '../packages/application/src/material-repair.js';
import { MaterialMatcher } from '../packages/application/src/materials.js';
import { scriptSchema } from '../packages/core/src/domain.js';
import { hash, FilmError } from '../packages/core/src/util.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';

const script = scriptSchema.parse({
  title: '节奏',
  topic: '车',
  angle: '对比',
  personaId: 'observer',
  narration: '',
  facts: [],
  beats: [
    { id: 'a', text: '观察车身', visualQuery: '连续八秒腰线', durationHint: 4 },
    { id: 'b', text: '座舱慢下来', visualQuery: '座椅', durationHint: 4 },
  ],
});
const decision = {
  action: 'revise_script' as const,
  scriptHash: hash(script),
  beatIds: ['a'],
  reason: '脚本追加连续机位限制',
  instructions: '用两个已观察区间组合实现对比，保持所有冻结条件',
};
const repaired = {
  ...script,
  beats: [{ ...script.beats[0]!, visualQuery: '两段车身高光顺序切换' }, script.beats[1]!],
};
function missing(store: Awaited<ReturnType<typeof fixture>>['store'], taskId: string, includeMatch = true) {
  store.saveArtifact(
    taskId,
    'materials.requirements',
    {
      scriptHash: hash(script),
      requirements: [
        { id: 'visual_1', beatId: 'a', kind: 'visual', query: '连续八秒腰线' },
        { id: 'visual_2', beatId: 'b', kind: 'visual', query: '座椅' },
      ],
    },
    true,
  );
  store.saveArtifact(taskId, 'materials.candidate', {
    status: 'missing',
    matches: includeMatch
      ? [
          {
            needId: 'visual_2',
            assetId: 'fixture',
            sourceStart: 1,
            sourceEnd: 3,
            frameTimes: [1, 2],
            observation: 'fixture only',
          },
        ]
      : [],
    gaps: [
      {
        needId: 'visual_1',
        attemptedQueries: ['authorized local clips'],
        reason: 'continuous interval unavailable',
      },
    ],
  });
}

test('material repairs reject changing narration, untouched beats, beat order, stale baselines and no-op rewrites', () => {
  const context = { previousScript: script, decision };
  assert.deepEqual(validateScriptMaterialRepair(repaired, context), repaired);
  for (const candidate of [
    script,
    { ...repaired, narration: 'changed' },
    { ...repaired, beats: [repaired.beats[0]!, { ...repaired.beats[1]!, text: 'changed' }] },
    { ...repaired, beats: [...repaired.beats].reverse() },
  ])
    assert.throws(() => validateScriptMaterialRepair(candidate, context), { code: 'SCRIPT_REPAIR_SCOPE' });
  assert.throws(
    () =>
      validateScriptMaterialRepair(repaired, {
        ...context,
        decision: { ...decision, scriptHash: 'f'.repeat(64) },
      }),
    { code: 'SCRIPT_REPAIR_SCOPE' },
  );
});

test('missing source alone does not authorize a rewrite; blocked decision and scoped user edits retain approvals', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '保留用户条件' });
  store.saveArtifact(task.id, 'script', script, true);
  let calls = 0;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      calls++;
      return request.schema.parse({ action: 'blocked', reason: '需要改变冻结创意，不能仅改脚本' });
    },
  };
  missing(store, task.id, false);
  assert.equal(await requestScriptMaterialRepair(store, task.id, agent, script), false);
  assert.equal(calls, 0);
  missing(store, task.id);
  assert.equal(await requestScriptMaterialRepair(store, task.id, agent, script), false);
  assert.equal(calls, 1);
  store.saveArtifact(task.id, 'revision.guard', { scope: { start: 0, end: 1 } }, true);
  assert.equal(await requestScriptMaterialRepair(store, task.id, agent, script), false);
  assert.equal(calls, 1);
  assert.deepEqual(store.artifact(task.id, 'script')!.data, script);
});

test('automatic material repair retains every current user revision and includes them in its decision context', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '车身与座舱' });
  const instructions = [
    { stage: 'script', data: { instruction: '保留当前旁白', previousArtifact: script } },
    { stage: 'editorial', data: { instruction: '先座舱后车身', previousArtifact: { old: 'edit' } } },
    {
      stage: 'layout',
      data: { instruction: '保持左右并排，源画面不能裁切', previousArtifact: { old: 'layout' } },
    },
  ];
  for (const item of instructions)
    store.saveArtifact(task.id, `${item.stage}.user_revision`, item.data, true);
  store.saveArtifact(task.id, 'editorial', { old: true }, true);
  store.saveArtifact(task.id, 'layout', { old: true }, true);
  missing(store, task.id);
  const previousRequirements = store.artifact(task.id, 'materials.requirements')!.data as any;
  const previousResult = store.artifact(task.id, 'materials.candidate', false)!.data;
  let input: any;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      input = request.input;
      return request.schema.parse(decision);
    },
  };
  assert.equal(await requestScriptMaterialRepair(store, task.id, agent, script), true);
  for (const item of instructions)
    assert.deepEqual(store.artifact(task.id, `${item.stage}.user_revision`)?.data, item.data, item.stage);
  assert.deepEqual(input.userRevisions, instructions);
  assert.equal(store.artifact(task.id, 'editorial'), undefined);
  assert.equal(store.artifact(task.id, 'layout'), undefined);
  assert.deepEqual(store.artifact(task.id, 'materials.prior_search')?.data, {
    scriptHash: hash(script),
    requirements: previousRequirements.requirements,
    result: previousResult,
  });
  assert.equal(store.artifact(task.id, 'materials'), undefined, 'search history is not matching approval');
  const matcherAgent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      assert.equal(request.role, 'materials');
      const input = request.input as any;
      assert.deepEqual(input.priorSearch.result, previousResult);
      assert.equal(input.priorSearch.requirements[0].query, '连续八秒腰线');
      assert.equal(input.requirements[0].query, '两段车身高光顺序切换');
      return request.schema.parse({
        status: 'missing',
        matches: [],
        gaps: input.requirements.map((need: any) => ({
          needId: need.id,
          reason: 'old clues have not been verified for the new requirements',
          attemptedQueries: ['prior search'],
        })),
      });
    },
  };
  const runner = new TaskRunner(store, task.id, undefined, {
    agent: matcherAgent,
    model: { version: 'fixture', compare: async () => [] },
  });
  await assert.rejects(new MaterialMatcher(store, task.id, runner.library, matcherAgent).run(repaired), {
    code: 'MATERIALS_MISSING',
  });
  assert.equal(store.artifact(task.id, 'materials'), undefined);
});

test('a changed user revision invalidates a cached material repair decision', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '车身与座舱' });
  missing(store, task.id);
  let calls = 0;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      calls++;
      return request.schema.parse({ action: 'blocked', reason: '固定用户构图当前无法实现' });
    },
  };
  store.saveArtifact(task.id, 'layout.user_revision', { instruction: '全片保持分屏' }, true);
  assert.equal(await requestScriptMaterialRepair(store, task.id, agent, script), false);
  assert.equal(await requestScriptMaterialRepair(store, task.id, agent, script), false);
  assert.equal(calls, 1);
  store.saveArtifact(task.id, 'layout.user_revision', { instruction: '允许部分镜头改为单画面' }, true);
  assert.equal(await requestScriptMaterialRepair(store, task.id, agent, script), false);
  assert.equal(calls, 2, 'a decision from older user instructions must not be reused');
});

test('material gap returns to scoped script review before re-matching, preserves acceptance and never uses stale edit', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    prompt: '有节奏的车身和座舱对比',
    creative: { enabled: false },
    materials: { strategy: 'local_only' },
  });
  store.saveArtifact(task.id, 'script', script, true);
  store.saveArtifact(task.id, 'editorial', { stale: true }, true);
  store.saveArtifact(task.id, 'render', { stale: true }, true);
  let matches = 0;
  const roles: string[] = [];
  let acceptanceHash: string | undefined;
  t.mock.method(MaterialMatcher.prototype, 'run', async () => {
    matches++;
    if (matches === 1) {
      missing(store, task.id);
      acceptanceHash = store.artifact(task.id, 'acceptance.plan')!.hash;
      throw new FilmError('MATERIALS_MISSING', 'fixture gap');
    }
    assert.deepEqual(store.artifact(task.id, 'script')!.data, repaired);
    assert.equal(store.artifact(task.id, 'acceptance.plan')!.hash, acceptanceHash);
    assert.equal(store.artifact(task.id, 'editorial'), undefined);
    assert.equal(store.artifact(task.id, 'render'), undefined);
    for (const role of ['facts_review', 'audience_review', 'voice_review']) assert.ok(roles.includes(role));
    throw new Error('reached new matching after reviews');
  });
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      const compiled = acceptanceFixture(request);
      if (compiled !== undefined) return compiled;
      roles.push(request.role);
      if (request.role === 'production_repair') {
        assert.equal(request.toolAccess, 'none');
        const check = request.validateOutput!;
        assert.throws(() => check(request.schema.parse({ ...decision, scriptHash: 'f'.repeat(64) })), {
          code: 'SCRIPT_REPAIR_SCOPE',
        });
        assert.throws(() => check(request.schema.parse({ ...decision, beatIds: ['unknown'] })), {
          code: 'SCRIPT_REPAIR_SCOPE',
        });
        assert.throws(() => check(request.schema.parse({ ...decision, beatIds: ['b'] })), {
          code: 'SCRIPT_REPAIR_SCOPE',
        });
        return check(request.schema.parse(decision));
      }
      if (request.role === 'script') {
        assert.equal(store.artifact(task.id, 'script'), undefined, 'request is not an approval');
        assert.deepEqual((request.input as any).previousScript, script);
        assert.throws(
          () => request.validateOutput!(request.schema.parse({ ...repaired, narration: 'changed' })),
          { code: 'SCRIPT_REPAIR_SCOPE' },
        );
        return request.validateOutput!(request.schema.parse(repaired));
      }
      if (request.role === 'audience_review')
        assert.ok(
          !JSON.stringify(request.input).includes('fixture gap'),
          'blind reviewer does not get repair rationale',
        );
      return request.schema.parse({ passed: true, issues: [] });
    },
  };
  await assert.rejects(
    new TaskRunner(store, task.id, undefined, {
      agent,
      model: { version: 'fixture', compare: async () => [] },
    }).run(),
    /reached new matching after reviews/,
  );
  assert.equal(matches, 2);
  assert.equal(store.task(task.id).version, task.version);
  assert.deepEqual(store.task(task.id).spec, task.spec);
  assert.ok(
    store.db
      .prepare("select 1 from artifacts where task_id=? and stage='script' and hash=?")
      .get(task.id, hash(script)),
    'previous draft retained in history',
  );
});
