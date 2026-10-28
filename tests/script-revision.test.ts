import { semanticFixture } from './helpers.js';
import { acceptanceFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { type AgentDriver, type AgentRequest } from '../packages/agent-runtime/src/agents.js';
import { scriptSchema } from '../packages/core/src/domain.js';

import {
  scriptReviewInput,
  scriptReviewCacheKey,
  prepareScriptReview,
  SCRIPT_REVIEW_VERSION,
  scriptRevisionContext,
} from '../packages/application/src/script-revision.js';
import { hash } from '../packages/core/src/util.js';

const draft = scriptSchema.parse({
  title: '品牌历史',
  topic: '历史',
  angle: 'SECRET_CREATOR_ANGLE',
  personaId: 'SECRET_PERSONA',
  narration: '',
  beats: [{ id: 'b1', text: '原公司保留名字，新公司改名。', visualQuery: '实拍', durationHint: 4 }],
  facts: [],
});
const model = () => ({ version: 'fixture', compare: async () => [] });

test('script audience sees the actual script, without creator explanation or persona expectations', () => {
  const input = scriptReviewInput('audience_review', draft, '解释品牌历史', { duration: 90 }, [
    { content: 'SECRET_MEMORY' },
  ]);
  assert.ok(!JSON.stringify(input).includes('SECRET_'));
  assert.ok(JSON.stringify(input).includes(draft.beats[0]!.visualQuery));
  assert.ok(!('title' in input.script), 'Internal title must not create a promise to the audience');
  assert.ok(!('text' in input.script.beats[0]!), 'Only the actual narration is presented as audible');
  assert.equal(input.script.beats[0]!.plannedAction, draft.beats[0]!.text);
  assert.equal(input.script.narration, '', 'Planned actions must not become spoken narration');
  const key = scriptReviewCacheKey('facts_review', draft, 'policy1', []);
  assert.notEqual(key, scriptReviewCacheKey('facts_review', { ...draft, title: 'new claim' }, 'policy1', []));
  assert.notEqual(key, scriptReviewCacheKey('facts_review', draft, 'policy2', []));
});

test('independent script review can see conflicting action and source descriptions', () => {
  const script = {
    ...draft,
    beats: [
      { id: 'b4', text: '车仍定格，关闭所有小窗', visualQuery: '窗口关完后填满无车空镜', durationHint: 2 },
    ],
  };
  const input = scriptReviewInput('audience_review', script, 'SECRET_TARGET', {}, []);
  assert.equal(input.script.beats[0]!.plannedAction, script.beats[0]!.text);
  assert.equal(input.script.beats[0]!.visualQuery, script.beats[0]!.visualQuery);
  assert.ok(!JSON.stringify(input).includes('SECRET_'));
});

test('revisions receive the previous full draft, named feedback and regression history; blockers still reject', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    creative: { enabled: false },
    prompt: '解释品牌历史',
  });
  store.saveArtifact(task.id, 'script.candidate', draft);
  store.saveArtifact(task.id, 'script.review_policy', { version: SCRIPT_REVIEW_VERSION }, true);
  const oldReview = {
    passed: false,
    issues: [{ severity: 'blocking', message: '缺少主语', evidence: 'b1' }],
  };
  store.saveArtifact(task.id, 'script.reviews', [oldReview]);
  store.saveArtifact(task.id, 'script.feedback', [oldReview]);
  let drafts = 0;
  const agent: AgentDriver = {
    async run<T>(request: AgentRequest<T>): Promise<T> {
      const compiled = acceptanceFixture(request);
      if (compiled !== undefined) return compiled;
      if (request.role === 'script') {
        const input = request.input as any;
        assert.deepEqual(input.previousScript, drafts === 0 ? draft : { ...draft, title: '修订1' });
        assert.equal(input.previousScriptHash, hash(input.previousScript));
        assert.ok(input.revisionHistory.length);
        if (drafts === 1) {
          assert.equal(input.feedback.scriptHash, hash(input.previousScript));
          assert.equal(input.feedback.blocking[0].role, 'audience_review');
          assert.equal(store.artifact(task.id, 'script'), undefined);
        }
        drafts++;
        return request.schema.parse({ ...draft, title: `修订${drafts}` });
      }
      if (request.role === 'materials') throw new Error('reached_materials');
      return request.schema.parse(
        request.role === 'audience_review' && drafts === 1 ? oldReview : { passed: true, issues: [] },
      );
    },
  };
  await assert.rejects(
    new TaskRunner(store, task.id, undefined, { agent, model: model() }).run(),
    /reached_materials/,
  );
  assert.equal(drafts, 2);
  assert.equal(store.artifact<any>(task.id, 'script')?.data.title, '修订2');
});

test('new script review policy discards stale feedback and re-assesses the unchanged candidate', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '固定旁白，画面自由', creative: { enabled: false } });
  store.saveArtifact(task.id, 'script.candidate', draft);
  store.saveArtifact(task.id, 'script.review_policy', { version: SCRIPT_REVIEW_VERSION - 1 }, true);
  store.saveArtifact(task.id, 'script.reviews', [
    { passed: false, issues: [{ severity: 'blocking', message: 'audio-only rejection', evidence: 'b1' }] },
  ]);
  store.saveArtifact(task.id, 'script.feedback', { stale: true });
  prepareScriptReview(store, task.id);
  assert.equal(store.artifact(task.id, 'script.feedback', false), undefined);
  assert.equal(store.artifact<any>(task.id, 'script.pending_assessment')!.data.candidateHash, hash(draft));
  assert.deepEqual(scriptRevisionContext(store, task.id, undefined).revisionHistory, []);
  assert.ok(
    store.db.prepare("SELECT 1 FROM artifacts WHERE task_id=? AND stage='script.reviews'").get(task.id),
    'History is retained',
  );
  const agent: AgentDriver = {
    async run(req) {
      const semantic = semanticFixture(req);
      if (semantic) return semantic;
      const compiled = acceptanceFixture(req);
      if (compiled !== undefined) return compiled;
      assert.notEqual(req.role, 'script', 'Do not regenerate before applying the corrected reviewer');
      if (req.role === 'materials') throw new Error('reached_materials');
      if (req.role === 'audience_review') assert.equal(req.toolAccess, 'none');
      return req.schema.parse({ passed: true, issues: [] });
    },
  };
  await assert.rejects(
    new TaskRunner(store, task.id, undefined, { agent, model: model() }).run(),
    /reached_materials/,
  );
  assert.equal(store.artifact(task.id, 'script')!.hash, hash(draft));
});

test('interrupted assessment resumes the same draft and reuses only completed passing reviews', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    creative: { enabled: false },
    prompt: '解释品牌历史',
  });
  const calls: string[] = [];
  let interrupt = true;
  const agent: AgentDriver = {
    async run<T>(request: AgentRequest<T>): Promise<T> {
      const compiled = acceptanceFixture(request);
      if (compiled !== undefined) return compiled;
      calls.push(request.role);
      if (request.role === 'script') return request.schema.parse(draft);
      if (request.role === 'audience_review' && interrupt) {
        interrupt = false;
        throw new Error('interrupted');
      }
      if (request.role === 'materials') throw new Error('reached_materials');
      return request.schema.parse({ passed: true, issues: [] });
    },
  };
  await assert.rejects(
    new TaskRunner(store, task.id, undefined, { agent, model: model() }).run(),
    /interrupted/,
  );
  assert.equal(store.artifact(task.id, 'script'), undefined);
  assert.ok(store.artifact(task.id, 'script.pending_assessment'));
  await assert.rejects(
    new TaskRunner(store, task.id, undefined, { agent, model: model() }).run(),
    /reached_materials/,
  );
  assert.equal(calls.filter((x) => x === 'script').length, 1);
  assert.equal(calls.filter((x) => x === 'facts_review').length, 1);
  assert.equal(calls.filter((x) => x === 'audience_review').length, 2);
  assert.ok(store.artifact(task.id, 'script'));
  assert.equal(store.artifact(task.id, 'script.pending_assessment'), undefined);
});
