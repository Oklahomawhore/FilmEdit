import { intentReviewFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';
import type { SemanticModel } from '../packages/media/src/scoring.js';
import type { MemoryRow } from '../packages/infrastructure/src/store.js';

// Stop at the first generation request. This tests real workflow context assembly, not model taste.
const model: SemanticModel = {
  version: 'memory-fixture',
  async compare(pairs) {
    return pairs.map(() => ({ similarity: 1, entailment: 1, contradiction: 0, neutral: 0 }));
  },
};
const stopped = new Error('memory observation complete');

test('account settings survive global knowledge growth; current intent stays independent and resume keeps its snapshot', async (t) => {
  const { store, root } = await fixture();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const account = store.createAccount('本账号'),
    other = store.createAccount('其他账号');
  const setting = store.addMemory(account, {
    kind: 'setting',
    content: '偏爱爵士配乐，活泼独白',
    tags: [],
    provenance: 'user',
    confidence: 1,
  });
  const secret = store.addMemory(other, {
    kind: 'experience',
    content: '水星相关的私有经历',
    tags: ['水星'],
    provenance: 'user',
    confidence: 1,
  });
  for (let i = 0; i < 240; i++) {
    const memoryId = store.addMemory(null, {
      kind: 'topic',
      content: `水星话题 ${i}`,
      tags: ['水星'],
      provenance: 'inferred',
      confidence: 0.5,
    });
    store.db.prepare("UPDATE memories SET created='2099-01-01 00:00:00' WHERE id=?").run(memoryId);
  }
  for (let i = 0; i < 35; i++) {
    const memoryId = store.addMemory(account, {
      kind: 'feedback',
      content: `过去作品的意见 ${i}`,
      tags: [],
      provenance: 'user',
      confidence: 1,
    });
    store.db
      .prepare('UPDATE memories SET created=? WHERE id=?')
      .run(`2098-01-01 00:00:${String(i).padStart(2, '0')}`, memoryId);
  }
  const input = {
    prompt: '讲水星，本次使用冷静的第三人称',
    accountId: account,
    materials: { strategy: 'local_only' as const },
    creative: { knowledge: 'local' as const },
  };
  let context: any;
  const agent: AgentDriver = {
    async run(request) {
      const value = request.input as any;
      if (request.role === 'intent') {
        assert.equal(
          value.memory,
          undefined,
          'past preference is not an input to explicit-intent extraction',
        );
        return request.schema.parse({
          schemaVersion: 1,
          constraints: [
            {
              id: 'tone',
              dimension: 'expression',
              field: 'tone',
              value: '冷静的第三人称',
              strength: 'fixed',
              match: 'semantic',
              polarity: 'require',
              modality: 'audio',
              source: 'prompt',
              quote: '冷静的第三人称',
              confidence: 1,
            },
          ],
          openQuestions: [],
        });
      }
      if (request.role === 'intent_review') return intentReviewFixture(request);
      assert.equal(request.role, 'creative');
      context = value;
      throw stopped;
    },
  };
  const observe = async (taskId: string) => {
    await assert.rejects(
      new TaskRunner(store, taskId, undefined, { agent, model }).run(),
      (error) => error === stopped,
    );
    return store.artifact<MemoryRow[]>(taskId, 'memory')!;
  };
  const task = await createTask(store, input);
  const original = await observe(task.id);
  assert.ok(
    original.data.some((memory) => memory.id === setting),
    'global learning must not evict account settings',
  );
  assert.ok(
    original.data.some((memory) => memory.id === 'persona_observer'),
    'Persona candidates have their own retrieval space',
  );
  assert.equal(
    original.data.some((memory) => memory.id === secret),
    false,
  );
  assert.equal(context.intent.constraints[0].value, '冷静的第三人称');
  assert.ok(context.memory.some((memory: MemoryRow) => memory.id === setting));
  assert.ok(
    original.data.filter((memory) => memory.kind === 'feedback').length < 35,
    'only a bounded recent feedback window belongs in the initial context',
  );
  store.correctMemory(account, setting, { content: '偏好短句和具体事实', tags: [] });
  const resumed = await observe(task.id);
  assert.equal(resumed.hash, original.hash, 'resume preserves the task memory snapshot');
  const next = await createTask(store, input);
  const updated = await observe(next.id);
  assert.equal(updated.data.find((memory) => memory.id === setting)!.content, '偏好短句和具体事实');
  assert.equal(
    updated.data.some((memory) => memory.id === secret),
    false,
  );
  const free = await createTask(store, { ...input, accountId: undefined });
  const freeSnapshot = await observe(free.id);
  assert.equal(
    freeSnapshot.data.some((memory) => memory.accountId !== null),
    false,
  );
});
