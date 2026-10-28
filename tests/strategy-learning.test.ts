import { intentReviewFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, conceptFixture } from './helpers.js';
import { createTask } from '../packages/application/src/workflow.js';
import { LearningService } from '../packages/application/src/learning.js';
import { CreativeEngine } from '../packages/application/src/creativity.js';
import { CreativeStore } from '../packages/infrastructure/src/creative-store.js';
import { StrategyStore } from '../packages/infrastructure/src/strategy-store.js';
import { Workbench } from '../packages/application/src/workbench.js';
import { TaskService } from '../packages/application/src/task-service.js';
import { validateStrategyGroups } from '../packages/application/src/strategy-learning.js';
import {
  scoreStrategy,
  validateStrategyRules,
  type StrategyRules,
} from '../packages/core/src/creative-strategy.js';
import { FilmError, canonical } from '../packages/core/src/util.js';
import type { AgentDriver, AgentRequest } from '../packages/agent-runtime/src/agents.js';
import type { AssetLibrary } from '../packages/media/src/assets.js';
import type { SemanticModel } from '../packages/media/src/scoring.js';

async function setup(t: test.TestContext, count = 10) {
  const f = await fixture();
  t.after(async () => {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const account = f.store.createAccount('测试账号');
  const other = f.store.createAccount('隔离账号');
  const creative = new CreativeStore(f.store);
  for (let i = 0; i < count; i++) {
    const task = await createTask(f.store, { accountId: account, prompt: `独立题材 ${i}` });
    const left = conceptFixture(`left_${i}`, `题材 ${i}`),
      right = conceptFixture(`right_${i}`, `题材 ${i}`);
    left.proposal.expression.music = i % 2 ? 'drone' : 'swing';
    right.proposal.expression.music = i % 2 ? 'swing' : 'drone';
    creative.archive(task.id, left);
    creative.archive(task.id, right);
    creative.feedback(task.id, {
      expectedVersion: task.version,
      left: left.id,
      right: right.id,
      choice: i % 2 ? 'right' : 'left',
      level: 'concept',
      comment: `PRIVATE_HUMAN_LABEL_${i}`,
    });
  }
  return { ...f, account, other, creative, strategies: new StrategyStore(f.store) };
}

function fixtureAgent(mode: 'improve' | 'same' | 'left_bias' = 'improve') {
  const requests: AgentRequest<unknown>[] = [];
  let failAfter: number | null = null;
  const agent: AgentDriver = {
    async run(request) {
      requests.push(request as AgentRequest<unknown>);
      if (failAfter !== null && requests.length >= failAfter) {
        failAfter = null;
        throw new FilmError('AGENT_FAILED', 'fixture provider interruption');
      }
      assert.equal(request.toolAccess, 'none');
      const input = request.input as any;
      let output: unknown;
      if (request.role === 'strategy_partition') {
        assert.ok(!canonical(input).includes('PRIVATE_HUMAN_LABEL'));
        assert.ok(!canonical(input).includes('choice'));
        output = {
          groups: input.examples.map((e: any) => ({
            topic: e.subjects[0],
            exampleIds: [e.id],
            previousTopicIds: input.previousTopics
              .filter((p: any) => e.subjects.includes(p.subject))
              .map((p: any) => p.id),
          })),
        };
      } else if (request.role === 'strategy_learner') {
        output = {
          rules: [
            {
              id: 'rhythmic_contrast',
              operator: 'context_transfer',
              appliesWhen: '熟悉角色进入轻松的生活情境',
              mechanism: '用轻快音乐让观众识别情绪反差',
              avoidWhen: ['需要持续沉重情绪时'],
              evidence: [
                { preferenceId: input.examples[0].id, kind: 'support', lesson: '被选方案的联系容易理解' },
                { preferenceId: input.examples[1].id, kind: 'counterexample', lesson: '被拒方案情绪不适用' },
              ],
            },
          ],
        };
      } else {
        assert.equal(request.role, 'strategy_predict');
        const encoded = canonical(input);
        for (const privateField of [
          'PRIVATE_HUMAN_LABEL',
          'preferenceId',
          'sourceHash',
          'taskId',
          'knowledgeIds',
          'assetIds',
          'commitments',
        ])
          assert.ok(!encoded.includes(privateField), privateField);
        const preferred = input.left.proposal.expression.music === 'swing' ? 'left' : 'right';
        const choice =
          mode === 'left_bias' && input.methods.length
            ? 'left'
            : mode === 'same' || !input.methods.length
              ? preferred === 'left'
                ? 'right'
                : 'left'
              : preferred;
        output = { choice, reason: 'fixture decision, not real taste evidence' };
      }
      const parsed = request.schema.parse(output);
      return request.validateOutput ? request.validateOutput(parsed) : parsed;
    },
  };
  return {
    agent,
    requests,
    interruptAt: (n: number) => {
      failAfter = n;
    },
  };
}

test('strategy learning requires human evidence, never uses model opinions or other accounts', async (t) => {
  const f = await setup(t, 0),
    driver = fixtureAgent();
  const service = new LearningService(f.store, () => driver.agent);
  const experimentId = service.enqueue({ kind: 'strategy', scope: f.account });
  await assert.rejects(service.run(experimentId), { code: 'STRATEGY_EVIDENCE_REQUIRED' });
  assert.equal(driver.requests.length, 0);
  assert.equal(f.strategies.pending(), null);
  assert.equal(f.strategies.seenTopics(f.account, 'default').length, 0);
  assert.equal(f.strategies.seenTopics(f.other, 'default').length, 0);
  assert.throws(() => service.enqueue({ kind: 'strategy', scope: 'account_missing' }), {
    code: 'STRATEGY_SCOPE',
  });
  assert.equal(
    f.store.db.prepare('SELECT state FROM experiments WHERE id=?').get(experimentId)!.state,
    'blocked',
  );
});

test('publish only blind held-out improvement; freeze for tasks, invalidate corrected feedback, direct retract', async (t) => {
  const f = await setup(t),
    driver = fixtureAgent();
  assert.deepEqual(f.strategies.pending(), { kind: 'strategy', scope: f.account, audience: 'default' });
  const service = new LearningService(f.store, () => driver.agent);
  const experimentId = service.enqueue({ kind: 'strategy', scope: f.account });
  const result = (await service.run(experimentId)) as any;
  assert.equal(result.published, true);
  assert.equal(result.evaluation.wins, 5);
  assert.equal(result.evaluation.p, 1 / 32);
  assert.equal(driver.requests.length, 22); // grouping + induction + both orders of two models on 5 topics
  assert.equal(f.strategies.active(f.other, 'default'), null);
  assert.equal(f.strategies.active(f.account, 'other-audience'), null);
  assert.equal(f.strategies.seenTopics(f.account, 'default').length, 10);
  assert.equal(f.strategies.pending(), null);
  assert.deepEqual(await service.run(experimentId), result);
  assert.equal(driver.requests.length, 22);
  const dataset = f.store.artifact<any>(result.taskId, 'learning.strategy.dataset')!.data;
  const learner = driver.requests.find((r) => r.role === 'strategy_learner')!.input as any;
  assert.equal(learner.examples.length, 5);
  assert.ok(dataset.heldout.every((h: any) => !learner.examples.some((e: any) => e.id === h.id)));
  assert.deepEqual(f.creative.taste(f.account).strategy?.rules, result.rules);

  const task = await createTask(f.store, {
    accountId: f.account,
    prompt: '新主题，当前要求优先',
    creative: { knowledge: 'local' },
  });
  const snapshotAgent: AgentDriver = {
    async run(request) {
      if (request.role === 'intent') {
        assert.ok(!canonical(request.input).includes('rhythmic_contrast'));
        return request.schema.parse({ schemaVersion: 1, constraints: [], openQuestions: [] });
      }
      if (request.role === 'intent_review') return intentReviewFixture(request);
      assert.equal(request.role, 'creative');
      assert.equal((request.input as any).learnedMethods.version, result.version);
      throw new FilmError('FIXTURE_STOP', 'inspect actual creative context');
    },
  };
  const run = () =>
    new CreativeEngine(f.store, task.id, snapshotAgent, {} as AssetLibrary, {} as SemanticModel).run();
  await assert.rejects(run(), { code: 'FIXTURE_STOP' });
  const frozen = f.store.artifact(task.id, 'creative.sampling')!;
  const source = dataset.training[0];
  f.creative.feedback(source.taskId, { ...source.preference, comment: '用户纠正先前理由' });
  assert.equal(f.strategies.inspect(f.account, 'default').state, 'stale');
  assert.equal(f.creative.taste(f.account).strategy, null);
  await assert.rejects(run(), { code: 'FIXTURE_STOP' });
  assert.equal(f.store.artifact(task.id, 'creative.sampling')!.hash, frozen.hash);

  const w = new Workbench(f.store, new TaskService(f.store), { autoStart: false });
  t.after(() => w.close());
  const command = {
    requestId: 'retract-method',
    command: 'creative.strategy.retract',
    args: { scope: f.account, version: result.version, reason: '用户要求撤回' },
  };
  await assert.rejects(w.command(command, { kind: 'conversation', messageId: 'm' }), {
    code: 'EXPLICIT_ACTION_REQUIRED',
  });
  const removed = await w.command({ ...command, requestId: 'direct-retract' });
  assert.equal(removed.state, 'retracted');
  assert.equal(f.strategies.inspect(f.account, 'default').state, 'none');
  assert.equal(f.store.artifact(task.id, 'creative.sampling')!.hash, frozen.hash);
  assert.deepEqual(await service.run(experimentId), result); // completed experiment cannot republish
  assert.equal(f.strategies.inspect(f.account, 'default').state, 'none');
});

test('resume same candidate and prediction checkpoint; evaluated topics cannot be reused to tune a new candidate', async (t) => {
  const f = await setup(t),
    driver = fixtureAgent();
  const service = new LearningService(f.store, () => driver.agent);
  const experimentId = service.enqueue({ kind: 'strategy', scope: f.account });
  driver.interruptAt(5);
  await assert.rejects(service.run(experimentId), { code: 'AGENT_FAILED' });
  assert.equal(f.strategies.active(f.account, 'default'), null);
  const row = f.store.db.prepare('SELECT task_id FROM experiments WHERE id=?').get(experimentId)!;
  const candidate = f.store.artifact(row.task_id as string, 'learning.strategy.candidate')!;
  const result = (await service.run(experimentId)) as any;
  assert.equal(result.published, true);
  assert.equal(f.store.artifact(row.task_id as string, 'learning.strategy.candidate')!.id, candidate.id);
  assert.equal(driver.requests.filter((r) => r.role === 'strategy_learner').length, 1);
  assert.equal(driver.requests.length, 23); // exactly one failed request retried
  const another = service.enqueue({ kind: 'strategy', scope: f.account });
  await assert.rejects(service.run(another), { code: 'STRATEGY_EVIDENCE_REQUIRED' });
  assert.equal(driver.requests.filter((r) => r.role === 'strategy_learner').length, 1);
});

test('no improvement and position-biased predictions cannot publish', async (t) => {
  for (const mode of ['same', 'left_bias'] as const) {
    await t.test(mode, async (sub) => {
      const f = await setup(sub),
        driver = fixtureAgent(mode);
      const service = new LearningService(f.store, () => driver.agent);
      const result = (await service.run(service.enqueue({ kind: 'strategy', scope: f.account }))) as any;
      assert.equal(result.published, false);
      assert.equal(f.strategies.active(f.account, 'default'), null);
      assert.equal(
        f.store.db.prepare("SELECT COUNT(*) AS n FROM experiments WHERE state='completed'").get()!.n,
        1,
      );
    });
  }
});

test('background scheduler uses eligible feedback and yields to foreground production', async (t) => {
  const f = await setup(t),
    driver = fixtureAgent();
  const service = new LearningService(f.store, () => driver.agent);
  const task = f.store.tasks()[0]!;
  f.store.updateTask(task.id, 'running', 'creative');
  assert.deepEqual(await service.tick(), { state: 'foreground_busy' });
  assert.equal(driver.requests.length, 0);
  f.store.updateTask(task.id, 'paused', 'creative');
  const result = (await service.tick()) as any;
  assert.equal(result.published, true);
  assert.equal(result.scope, f.account);
  assert.equal(f.store.db.prepare('SELECT kind FROM experiments').get()!.kind, 'strategy');
});

test('historical topic aliases are excluded even if their original preferences are absent', async (t) => {
  const f = await setup(t),
    driver = fixtureAgent();
  f.strategies.recordExposure(f.account, 'default', ['历史 IP 及其角色'], 'previous_experiment');
  const agent: AgentDriver = {
    async run(request) {
      if (request.role !== 'strategy_partition') return driver.agent.run(request);
      const input = request.input as any;
      assert.equal(input.previousTopics[0].subject, '历史 IP 及其角色');
      const output = request.schema.parse({
        groups: input.examples.map((e: any) => ({
          topic: 'fixture: same historical franchise alias',
          exampleIds: [e.id],
          previousTopicIds: [input.previousTopics[0].id],
        })),
      });
      return request.validateOutput!(output);
    },
  };
  const service = new LearningService(f.store, () => agent);
  await assert.rejects(service.run(service.enqueue({ kind: 'strategy', scope: f.account })), {
    code: 'STRATEGY_EVIDENCE_REQUIRED',
  });
  assert.equal(driver.requests.length, 0);
});

test('publication is atomic and changes to feedback during evaluation prevent activation', async (t) => {
  const f = await setup(t),
    driver = fixtureAgent();
  const service = new LearningService(f.store, () => driver.agent);
  const experimentId = service.enqueue({ kind: 'strategy', scope: f.account });
  f.store.db.exec(
    "CREATE TRIGGER fail_strategy BEFORE INSERT ON events WHEN NEW.type='learning.strategy.evaluated' BEGIN SELECT RAISE(ABORT,'injected publication failure'); END",
  );
  await assert.rejects(service.run(experimentId), /injected publication failure/);
  const row = f.store.db.prepare('SELECT task_id,state FROM experiments WHERE id=?').get(experimentId)!;
  assert.equal(row.state, 'blocked');
  assert.equal(f.strategies.active(f.account, 'default'), null);
  assert.equal(f.store.artifact(row.task_id as string, 'learning.strategy.evaluation'), undefined);
  f.store.db.exec('DROP TRIGGER fail_strategy');
  const example = f.strategies.examples(f.account, 'default')[0]!;
  f.creative.feedback(example.taskId, { ...example.preference, choice: 'both_bad' });
  await assert.rejects(service.run(experimentId), { code: 'STRATEGY_FEEDBACK_CHANGED' });
  assert.equal(driver.requests.length, 22);
  assert.equal(f.strategies.active(f.account, 'default'), null);
});

test('controller rejects missing/duplicate topics, invented citations and weak evaluation', async (t) => {
  const f = await setup(t, 2),
    examples = f.strategies.examples(f.account, 'default');
  assert.throws(
    () =>
      validateStrategyGroups(
        { groups: [{ topic: '重复', exampleIds: [examples[0]!.id, examples[0]!.id], previousTopicIds: [] }] },
        examples,
      ),
    { code: 'STRATEGY_PARTITION' },
  );
  const cloned = { ...examples[1]!, left: examples[0]!.left };
  assert.throws(
    () =>
      validateStrategyGroups(
        { groups: examples.map((e) => ({ topic: '同一题材', exampleIds: [e.id], previousTopicIds: [] })) },
        [examples[0]!, cloned],
      ),
    { code: 'STRATEGY_PARTITION' },
  );
  const rules: StrategyRules = {
    rules: [
      {
        id: 'rule',
        operator: 'context_transfer',
        appliesWhen: '条件',
        mechanism: '方法',
        avoidWhen: ['反例'],
        evidence: [
          { preferenceId: examples[0]!.id, kind: 'support', lesson: '支持' },
          { preferenceId: 'invented', kind: 'counterexample', lesson: '假的引用' },
        ],
      },
    ],
  };
  assert.throws(() => validateStrategyRules(rules, examples), { code: 'STRATEGY_INVALID' });
  const expected = Array(5).fill('left');
  const predictions = (choice: 'left' | 'right') => expected.map(() => ({ choice, reason: 'fixture' }));
  assert.equal(scoreStrategy(expected, predictions('right'), predictions('left')).passed, true);
  assert.equal(scoreStrategy(expected, predictions('left'), predictions('left')).passed, false);
  assert.equal(
    scoreStrategy(expected, predictions('right'), [
      ...predictions('left').slice(0, 4),
      { choice: 'right', reason: 'error' },
    ]).passed,
    false,
  );
});
