import { semanticFixture } from './helpers.js';
import { intentReviewFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../packages/infrastructure/src/store.js';
import { rejectRepeatedState } from '../packages/infrastructure/src/loop-progress.js';
import { FilmError } from '../packages/core/src/util.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { MaterialMatcher } from '../packages/application/src/materials.js';
import { compileAcceptance } from '../packages/application/src/acceptance.js';
import { reviewAudience } from '../packages/application/src/audience-review.js';
import { CreativeEngine } from '../packages/application/src/creativity.js';
import { taskProgress } from '../packages/application/src/progress.js';
import { reviewTask, reviewArtifact } from '../packages/application/src/review.js';
import { audienceSchema, scriptSchema } from '../packages/core/src/domain.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';
import {
  fixture,
  asset,
  audience,
  completeAudience,
  editorial,
  conceptFixture,
  acceptanceFixture,
} from './helpers.js';

test('rejected-state cycles survive restart, ignore revision counters and reset with actual task scope', async () => {
  const { store } = await fixture();
  const task = await createTask(store, { prompt: 'cycle fixture' });
  rejectRepeatedState(
    store,
    task.id,
    'script',
    'draft',
    { revision: 1, content: 'same' },
    { missing: 'ending' },
  );
  rejectRepeatedState(
    store,
    task.id,
    'script',
    'draft',
    { revision: 2, content: 'different' },
    { missing: 'ending' },
  );
  const home = store.home;
  store.close();
  const reopened = new Store(home);
  try {
    assert.throws(
      () =>
        rejectRepeatedState(
          reopened,
          task.id,
          'script',
          'draft',
          { revision: 99, content: 'same' },
          { missing: 'ending' },
        ),
      { code: 'NO_PROGRESS' },
    );
    assert.ok(reopened.artifact(task.id, 'script.no_progress', false));
    // New feedback is new information even when the candidate has not changed.
    rejectRepeatedState(reopened, task.id, 'script', 'draft', { content: 'same' }, { missing: 'opening' });
    reopened.invalidateFrom(task.id, ['script']);
    rejectRepeatedState(
      reopened,
      task.id,
      'script',
      'draft',
      { revision: 1, content: 'same' },
      { missing: 'ending' },
    );
    reopened.db.prepare('UPDATE tasks SET version=version+1 WHERE id=?').run(task.id);
    rejectRepeatedState(
      reopened,
      task.id,
      'script',
      'draft',
      { revision: 1, content: 'same' },
      { missing: 'ending' },
    );
    assert.ok(
      (reopened.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type='loop.rejected'")
        .get(task.id)!.n as number) > 4,
    );
  } finally {
    reopened.close();
  }
});

test('stage revisions have no total limit; external review errors resume the same candidate', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'progress fixture' });
  const runner = new TaskRunner(store, task.id);
  let generations = 0;
  await (runner as any).loop(
    'script',
    async () => ({ content: ++generations }),
    async () => ({ passed: generations === 8, feedback: 'not ready' }),
  );
  assert.equal(generations, 8);
  assert.equal(
    store.artifact(task.id, 'script')!.data && (store.artifact(task.id, 'script')!.data as any).content,
    8,
  );
  const generate = async () => {
    generations++;
    return { revision: 1, content: 'a cut' };
  };
  await assert.rejects(
    (runner as any).loop('editorial', generate, async () => {
      throw new FilmError('MODEL_BALANCE', 'temporary provider outage');
    }),
    { code: 'MODEL_BALANCE' },
  );
  assert.ok(store.artifact(task.id, 'editorial.pending_assessment'));
  const resumed = new TaskRunner(store, task.id);
  await (resumed as any).loop('editorial', generate, async () => ({ passed: true, feedback: {} }));
  assert.equal(generations, 9, 'resume did not regenerate the pending cut');
  assert.ok(!store.events(task.id).some((event) => event.type === 'loop.no_progress'));
});

test('identical rejected scripts block with checkpoints, release their lease and can be revised', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'script cycle', creative: { enabled: false } });
  let drafts = 0;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      const compiled = acceptanceFixture(request);
      if (compiled !== undefined) return compiled;
      if (request.role === 'script') {
        drafts++;
        assert.ok(drafts < 4, 'external guard: an unchanged failure must not loop indefinitely');
        return request.schema.parse({
          title: 'same',
          topic: 'fixture',
          angle: 'fixture',
          personaId: 'persona_maker',
          narration: '',
          beats: [{ id: 'a', text: 'same', visualQuery: 'test', durationHint: 2 }],
          facts: [],
        });
      }
      return request.schema.parse({
        passed: false,
        issues: [{ severity: 'blocking', message: '缺少结尾', evidence: 'a' }],
      });
    },
  };
  await assert.rejects(
    new TaskRunner(store, task.id, undefined, {
      agent,
      model: { version: 'fixture', compare: async () => [] },
    }).run(),
    { code: 'NO_PROGRESS' },
  );
  assert.equal(drafts, 2);
  assert.equal(store.task(task.id).status, 'blocked');
  assert.equal(
    taskProgress(store, task.id).nextAction,
    '查看重复拒绝的候选与评审；修改方案、补充素材或纠正要求后，从当前检查点继续',
  );
  assert.ok(store.artifact(task.id, 'script.candidate', false));
  assert.ok(store.artifact(task.id, 'script.feedback', false));
  const report = store.artifact(task.id, 'script.no_progress', false)!;
  assert.ok(
    reviewTask(store, task.id)
      .nodes.find((node) => node.id === 'script_review')!
      .artifacts.some((item) => item.id === report.id),
  );
  assert.equal(reviewArtifact(store, task.id, report.id).data.candidate.title, 'same');
  assert.equal(store.artifact(task.id, 'script'), undefined);
  assert.equal(store.artifact(task.id, 'script.pending_assessment'), undefined);
  assert.ok(store.acquireLease(`task:${task.id}`, 'replacement'));
  store.releaseLease(`task:${task.id}`, 'replacement');
  await (new TaskRunner(store, task.id) as any).loop(
    'script',
    async () => ({ content: 'added ending' }),
    async () => ({ passed: true, feedback: {} }),
  );
  assert.ok(store.artifact(task.id, 'script'));
});

test('rejected intent parsing stops before any creative sampling or material access', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    prompt: '固定角色，剩下自由发挥',
    creative: { knowledge: 'local' },
  });
  const runner = new TaskRunner(store, task.id);
  let attempts = 0;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      if (request.role === 'intent') {
        assert.ok(++attempts < 4);
        return request.schema.parse({ schemaVersion: 1, constraints: [], openQuestions: [] });
      }
      assert.equal(request.role, 'intent_review');
      return request.schema.parse({
        classifications: [],
        passed: false,
        issues: [{ severity: 'blocking', message: '遗漏固定角色', evidence: '固定角色' }],
      });
    },
  };
  await assert.rejects(
    new CreativeEngine(store, task.id, agent, runner.library, {
      version: 'fixture',
      compare: async () => [],
    }).run(),
    { code: 'NO_PROGRESS' },
  );
  assert.equal(attempts, 2);
  assert.equal(store.artifact(task.id, 'creative.intent'), undefined);
  assert.ok(store.artifact(task.id, 'creative.intent.no_progress', false));
});

test('returning between stages does not erase identical rejected-state history', async (t) => {
  for (const failure of ['MATERIAL_REPAIR', 'NARRATIVE_REPAIR'])
    await t.test(failure, async (t) => {
      const { store } = await fixture();
      t.after(() => store.close());
      const task = await createTask(store, { prompt: 'cross-stage loop', creative: { enabled: false } });
      store.saveAsset({ ...asset, taskId: task.id, frames: [{ time: 0, path: '/fixture/frame.jpg' }] });
      const agent: AgentDriver = {
        async run(request) {
          const semantic = semanticFixture(request);
          if (semantic) return semantic;
          const compiled = acceptanceFixture(request);
          if (compiled !== undefined) return compiled;
          if (request.role === 'materials')
            return request.schema.parse({
              status: 'ready',
              gaps: [],
              matches: [
                {
                  needId: 'visual_1',
                  assetId: asset.id,
                  sourceStart: 0,
                  sourceEnd: 1,
                  frameTimes: [0],
                  observation: 'fixture',
                },
              ],
            });
          assert.equal(request.role, 'materials_review');
          return request.schema.parse({
            verdict: 'matched',
            observation: 'fixture matches',
            evidence: [{ matchIndex: 0, time: 0 }],
          });
        },
      };
      const runner = new TaskRunner(store, task.id, undefined, {
        agent,
        model: { version: 'fixture', compare: async () => [] },
      });
      runner.library.resolve = async () => '/fixture/video.mp4';
      runner.library.frames = async (_asset, times) =>
        times.map((time) => ({ time, path: '/fixture/frame.jpg' }));
      (runner as any).script = async () =>
        scriptSchema.parse({
          title: 'fixture',
          topic: 'fixture',
          angle: 'fixture',
          personaId: 'fixture',
          narration: '',
          beats: [{ id: 'a', text: 'fixture', visualQuery: 'fixture', durationHint: 1 }],
        });
      let edits = 0;
      (runner as any).edit = async () => {
        assert.ok(++edits < 4, 'external test guard: cross-stage cycle must stop');
        if (failure === 'MATERIAL_REPAIR')
          throw new FilmError(failure, 'same request', {
            needIds: ['visual_1'],
            reason: 'same unresolved mismatch',
          });
        const cut = { ...editorial(), revision: edits };
        store.saveArtifact(task.id, 'editorial', cut, true);
        return cut;
      };
      (runner as any).layout = async () => {
        throw new FilmError('NARRATIVE_REPAIR', 'same mismatch', { reason: 'same unresolved narrative' });
      };
      await assert.rejects(runner.run(), { code: 'NO_PROGRESS' });
      assert.equal(edits, 2);
      const report = store.artifact(task.id, 'workflow.no_progress', false)!;
      assert.ok(report);
      assert.equal(store.task(task.id).status, 'blocked');
      assert.ok(
        reviewTask(store, task.id)
          .nodes.find((node) => node.id === 'quality')!
          .artifacts.some((item) => item.id === report.id),
      );
    });
});

test('changing only source-match prose cannot evade a cycle; changing the source interval can resolve it', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '反射', materials: { strategy: 'local_only' } });
  const runner = new TaskRunner(store, task.id);
  store.saveAsset({
    ...asset,
    taskId: task.id,
    frames: [
      { time: 0, path: '/fixture0' },
      { time: 2, path: '/fixture2' },
    ],
  });
  t.mock.method(runner.library, 'resolve', async () => '/fixture');
  t.mock.method(runner.library, 'frames', async (_id, times) =>
    times!.map((time) => ({ time, path: `/fixture${time}` })),
  );
  const script = scriptSchema.parse({
    title: '反射',
    topic: '镜面',
    angle: '内外空间',
    personaId: 'observer',
    narration: '',
    beats: [{ id: 'a', text: '', visualQuery: '镜面中的车辆反射', durationHint: 1 }],
  });
  const original = store.saveArtifact(task.id, 'script', script, true);
  let matches = 0,
    reviews = 0,
    start = 0;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      if (request.role === 'materials') {
        matches++;
        assert.ok(matches < 5);
        return request.schema.parse({
          status: 'ready',
          gaps: [],
          matches: [
            {
              needId: 'visual_1',
              assetId: asset.id,
              sourceStart: start,
              sourceEnd: start + 1,
              frameTimes: [start],
              observation: `author claim ${matches}`,
            },
          ],
        });
      }
      reviews++;
      return request.schema.parse({
        verdict: start ? 'matched' : 'mismatch',
        observation: start ? '反射可见' : '只有镜面外壳',
        evidence: [{ matchIndex: 0, time: start }],
      });
    },
  };
  const run = () => new MaterialMatcher(store, task.id, runner.library, agent).run(script);
  await assert.rejects(run(), { code: 'NO_PROGRESS' });
  assert.equal(matches, 2);
  assert.equal(reviews, 1, 'the same source keeps its independent rejection');
  assert.equal(store.artifact(task.id, 'script')!.hash, original.hash);
  assert.equal(store.artifact(task.id, 'materials.pending'), undefined);
  start = 2;
  assert.equal((await run()).matches[0]!.sourceStart, 2);
  assert.equal(reviews, 2);
});

test('repeated bad observer evidence stops only report repair; a corrected report reuses the cut', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'private' });
  const saved = store.saveArtifact(task.id, 'editorial', editorial(), true);
  let calls = 0,
    fixed = false;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      calls++;
      assert.ok(calls < 4);
      const report = completeAudience();
      if (!fixed) report.evidence[0]!.bindingId = 'missing';
      return request.schema.parse(report);
    },
  };
  const run = () =>
    reviewAudience({
      store,
      taskId: task.id,
      agent,
      key: 'report-fixture',
      request: {
        role: 'editorial_audience',
        schema: audienceSchema,
        editorial: editorial(),
        instruction: '',
        input: {},
      },
    });
  await assert.rejects(run(), { code: 'NO_PROGRESS' });
  assert.equal(calls, 2);
  assert.equal(store.artifact(task.id, 'editorial')!.hash, saved.hash);
  assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
  fixed = true;
  await run();
  assert.equal(calls, 3);
});

test('repeated inequivalent acceptance plans preserve the original requirement and existing cut', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '人物关门' });
  const saved = store.saveArtifact(task.id, 'editorial', editorial(), true);
  let generations = 0,
    fixed = false;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      const sources = (request.input as any).sources;
      if (request.role === 'acceptance') {
        assert.ok(++generations < 4);
        return request.schema.parse({
          schemaVersion: 1,
          sources: sources.map((s: any) => ({
            sourceId: s.id,
            checks: [
              {
                kind: 'playback_rate',
                region: 'all',
                rate: fixed ? 1 : 2,
                approximate: false,
                interval: null,
              },
            ],
          })),
        });
      }
      return request.schema.parse({
        sources: sources.map((s: any) => ({
          sourceId: s.id,
          verdict: fixed ? 'equivalent' : 'changed',
          reason: fixed ? '一致' : '动作相反',
          counterexamples: [],
        })),
      });
    },
  };
  await assert.rejects(compileAcceptance(store, task.id, agent, undefined), { code: 'NO_PROGRESS' });
  assert.equal(generations, 2);
  assert.equal(store.artifact(task.id, 'editorial')!.hash, saved.hash);
  assert.equal(store.artifact(task.id, 'acceptance.plan'), undefined);
  fixed = true;
  await compileAcceptance(store, task.id, agent, undefined);
  assert.equal(generations, 3);
  assert.ok(store.artifact(task.id, 'editorial.pending_assessment'));
});

test('a creative batch cannot avoid cycle detection by changing only candidate IDs', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '自由创作', creative: { knowledge: 'local' } });
  const runner = new TaskRunner(store, task.id);
  let batches = 0;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      if (request.role === 'intent')
        return request.schema.parse({ schemaVersion: 1, constraints: [], openQuestions: [] });
      if (request.role === 'intent_review') return intentReviewFixture(request);
      if (request.role === 'creative') {
        assert.ok(++batches < 4);
        return request.schema.parse({ candidates: [conceptFixture(`ignored_${batches}`, '同一个角色')] });
      }
      assert.equal(request.role, 'concept_audience');
      return request.schema.parse({
        understood: '人物开门',
        connection: '无法理解跨界联系',
        understandable: false,
        feasible: true,
        emotion: '不明',
        issues: [{ severity: 'blocking', message: '联系不成立', evidence: 'opening' }],
      });
    },
  };
  const model = {
    version: 'fixture',
    compare: async (pairs: unknown[]) =>
      pairs.map(() => ({ similarity: 0.99, entailment: 0.99, contradiction: 0, neutral: 0.01 })),
  };
  await assert.rejects(new CreativeEngine(store, task.id, agent, runner.library, model).run(), {
    code: 'NO_PROGRESS',
  });
  assert.equal(batches, 2);
  assert.equal(store.artifact(task.id, 'creative.brief'), undefined);
  assert.ok(store.artifact(task.id, 'creative.feedback', false));
});

test('invalid edit submissions repair inside one editor call before any audience assessment', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    prompt: 'submission validation fixture',
    creative: { enabled: false },
    output: { duration: 4 },
  });
  store.saveAsset({ ...asset, taskId: task.id });
  let calls = 0,
    reviews = 0;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      assert.equal(request.role, 'editor');
      calls++;
      assert.ok(request.validateOutput, 'editor must validate executable constraints at submission');
      const invalid = editorial();
      invalid.shots[0]!.sourceStart = 8;
      await assert.rejects(
        async () => request.validateOutput!(request.schema.parse(invalid)),
        (error: unknown) => {
          assert.ok(error instanceof FilmError);
          assert.equal(error.code, 'MATERIAL_MATCH');
          assert.match(error.message, /shot_a.*\[8, 10\]/);
          assert.match(error.message, /\[0, 7\]/);
          return true;
        },
      );
      assert.equal(reviews, 0);
      assert.equal(store.artifact(task.id, 'editorial.candidate', false), undefined);
      const result = request.schema.parse(editorial());
      await request.validateOutput!(result);
      return result;
    },
  };
  const runner = new TaskRunner(store, task.id, undefined, { agent });
  (runner as any).editorialReview = async () => {
    reviews++;
    return audience();
  };
  (runner as any).alignment = async () => ({ passed: true, evaluationErrors: [] });
  const script = scriptSchema.parse({
    title: 'fixture',
    topic: 'fixture',
    angle: '',
    personaId: 'observer',
    narration: '',
    beats: [{ id: 'beat', text: '', visualQuery: '动作', durationHint: 4 }],
  });
  const manifest = {
    scriptHash: 'fixture',
    reviewVersion: 1,
    requirements: [{ id: 'visual_1', kind: 'visual', query: '动作' }],
    matches: [
      {
        needId: 'visual_1',
        assetId: asset.id,
        sha256: asset.sha256,
        sourceStart: 0,
        sourceEnd: 7,
        observation: 'fixture',
        frameTimes: [0],
      },
    ],
  };
  await (runner as any).edit(script, manifest);
  assert.equal(calls, 1);
  assert.equal(reviews, 1);
  assert.ok(store.artifact(task.id, 'editorial'));
  assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
});
