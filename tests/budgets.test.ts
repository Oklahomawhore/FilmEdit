import { semanticFixture } from './helpers.js';
import { acceptanceFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { budgetsSchema, taskInputSchema } from '../packages/core/src/domain.js';
import {
  agentBudgetOptions,
  type AgentDriver,
  type AgentRequest,
} from '../packages/agent-runtime/src/agents.js';
import { learningConfigSchema } from '../packages/application/src/learning.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { TaskService } from '../packages/application/src/task-service.js';

import { Store } from '../packages/infrastructure/src/store.js';
import { fixture } from './helpers.js';

const unlimited = { stageRounds: null, renderRounds: null, agentTurns: null, usd: null };
const oldLimits = { stageRounds: 3, renderRounds: 3, agentTurns: 24, usd: 10 };

test('omitted/null budgets persist as unlimited and do not send SDK limits despite prior cost', () => {
  const spec = taskInputSchema.parse({ prompt: '测试' });
  assert.deepEqual(spec.budgets, unlimited);
  assert.deepEqual(taskInputSchema.parse(JSON.parse(JSON.stringify(spec))).budgets, unlimited);
  assert.deepEqual(agentBudgetOptions(spec.budgets, 1000), {});
  assert.deepEqual(agentBudgetOptions(budgetsSchema.parse(unlimited), 1000), {});
  const learning = learningConfigSchema.parse({ kind: 'technique', query: '卡点' });
  assert.equal(learning.usd, null);
  assert.equal(learning.maxAttempts, null);
});

test('explicit finite limits still work without the former schema ceilings', () => {
  const budgets = budgetsSchema.parse({ stageRounds: 50, renderRounds: 50, agentTurns: 200, usd: 20 });
  assert.deepEqual(agentBudgetOptions(budgets, 11), { maxTurns: 200, maxBudgetUsd: 9 });
  assert.throws(() => agentBudgetOptions(budgets, 20), { code: 'BUDGET_EXHAUSTED' });
  assert.deepEqual(agentBudgetOptions(budgetsSchema.parse({ agentTurns: 2 }), 1000), { maxTurns: 2 });
  for (const invalid of [0, -1, Infinity, 'unlimited'])
    assert.equal(budgetsSchema.safeParse({ usd: invalid }).success, false);
});

test('unlimit persists across restart without changing cost, checkpoints, permissions or history', async () => {
  const { store } = await fixture();
  let reopened: Store | undefined;
  try {
    const task = await createTask(store, {
      creative: { enabled: false },
      prompt: '恢复任务',
      budgets: oldLimits,
    });
    store.addCost(task.id, 10.013149);
    store.saveArtifact(task.id, 'script.candidate', { title: '第三版' });
    for (let round = 0; round < 3; round++) store.event(task.id, 'stage.attempt', { stage: 'script', round });
    store.updateTask(task.id, 'blocked', 'script', { code: 'AGENT_FAILED' });
    const updated = await new TaskService(store).budgets(task.id, {});
    assert.equal(updated.status, 'blocked');
    assert.equal(updated.cost, 10.013149);
    assert.deepEqual(updated.policy, task.policy);
    assert.deepEqual(updated.spec.budgets, unlimited);
    const snapshot = JSON.parse(await readFile(`${task.policy.workspace}/task.json`, 'utf8'));
    assert.deepEqual(snapshot.spec.budgets, unlimited);
    reopened = new Store(store.home);
    assert.deepEqual(reopened.task(task.id).spec.budgets, unlimited);
    assert.deepEqual(reopened.artifact(task.id, 'script.candidate', false)?.data, { title: '第三版' });
    const events = reopened.events(task.id);
    assert.equal(events.filter((e) => e.type === 'stage.attempt').length, 3);
    assert.deepEqual(events.find((e) => e.type === 'budgets.changed')?.data, {
      before: oldLimits,
      after: unlimited,
    });
  } finally {
    reopened?.close();
    store.close();
  }
});

test('changing budgets rejects active leases and running tasks', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    creative: { enabled: false },
    prompt: '测试',
    budgets: oldLimits,
  });
  assert.ok(store.acquireLease(`task:${task.id}`, 'worker'));
  assert.throws(() => store.setTaskBudgets(task.id, {}), { code: 'TASK_BUSY' });
  store.releaseLease(`task:${task.id}`, 'worker');
  store.updateTask(task.id, 'running', 'script');
  assert.throws(() => store.setTaskBudgets(task.id, {}), { code: 'TASK_BUSY' });
  assert.deepEqual(store.task(task.id).spec.budgets, oldLimits);
});

test('unlimited changing revisions remain cancellable and preserve rejection checkpoints', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    creative: { enabled: false },
    prompt: '测试取消',
    materials: { strategy: 'local_only' },
  });
  const controller = new AbortController();
  let drafts = 0;
  const agent: AgentDriver = {
    async run<T>(request: AgentRequest<T>): Promise<T> {
      const compiled = acceptanceFixture(request);
      if (compiled !== undefined) return compiled;
      if (request.role === 'script') {
        drafts++;
        if (drafts === 5) controller.abort();
        return request.schema.parse({
          title: '测试候选',
          topic: '测试',
          angle: '测试',
          personaId: 'persona_maker',
          narration: '',
          beats: [{ id: 'beat_a', text: `第 ${drafts} 版不同内容`, visualQuery: 'test', durationHint: 2 }],
          facts: [],
        });
      }
      return request.schema.parse({
        passed: false,
        issues: [{ severity: 'blocking', message: '需要修改', evidence: 'beat_a' }],
      });
    },
  };
  const model = { version: 'fixture', compare: async () => [] };
  await assert.rejects(new TaskRunner(store, task.id, controller.signal, { agent, model }).run(), {
    name: 'AbortError',
  });
  assert.equal(drafts, 5);
  assert.equal(store.task(task.id).status, 'cancelled');
  assert.ok(store.artifact(task.id, 'script.feedback', false));
  assert.equal(store.artifact(task.id, 'script'), undefined);
  assert.ok(!store.events(task.id).some((event) => event.type === 'loop.no_progress'));
  assert.ok(store.acquireLease(`task:${task.id}`, 'replacement'));
});
