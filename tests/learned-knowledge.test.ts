import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { createTask } from '../packages/application/src/workflow.js';
import { Workbench } from '../packages/application/src/workbench.js';
import { TaskService } from '../packages/application/src/task-service.js';
import { LearningService } from '../packages/application/src/learning.js';
import { CreativeStore } from '../packages/infrastructure/src/creative-store.js';
import { canonical } from '../packages/core/src/util.js';

test('retract learned knowledge atomically from memory and culture, preserving provenance and task snapshots', async (t) => {
  const { store, root } = await fixture();
  const w = new Workbench(store, new TaskService(store), { autoStart: false });
  t.after(async () => {
    await w.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const service = new LearningService(store);
  const experimentId = service.enqueue({ kind: 'script', query: '验收来源' });
  const learning = await createTask(store, { prompt: '学习' }, 'task_learning', 'learning');
  const memoryIds = ['source_narrative', 'inferred'].map((provenance, i) =>
    store.addMemory(null, {
      kind: i ? 'angle' : 'persona',
      content: i ? '地铁观察角度' : '人物自述夜班经历',
      tags: [i ? '地铁' : '夜班'],
      provenance: provenance as 'source_narrative' | 'inferred',
      confidence: 0.7,
      source: `https://example.org/video#t=${i},${i + 1}&experiment=${experimentId}`,
    }),
  );
  const culture = new CreativeStore(store);
  const bundle = {
    sources: [
      {
        id: 's',
        url: 'https://example.org/video',
        title: '来源',
        excerpt: '人物的叙述',
        observedAt: '2026-10-24T00:00:00Z',
      },
    ],
    entities: memoryIds.map((_, i) => ({
      id: `e${i}`,
      name: i ? '地铁' : '夜班',
      kind: 'situation',
      description: i ? '地铁观察角度' : '人物自述夜班经历',
      audience: '',
      context: '来源视频',
      tags: [],
      provenance: i ? 'inferred' : 'source_narrative',
      sourceIds: ['s'],
      confidence: 0.7,
    })),
    relations: [
      { from: 'e0', to: 'e1', relation: '同一来源', sourceIds: ['s'], provenance: 'source_narrative' },
    ],
  };
  const shared = culture.ingest('global', bundle);
  const account = store.createAccount('另一个账号');
  const privateBundle = culture.ingest(account, bundle);
  const privateMemory = store.addMemory(account, {
    kind: 'experience',
    content: '用户亲历',
    tags: [],
    provenance: 'user',
    confidence: 1,
  });
  const result = {
    taskId: learning.id,
    memoryIds,
    cultureIds: shared.entities.map((e) => e.id),
    review: { passed: true },
  };
  store.db
    .prepare("UPDATE experiments SET state='completed',task_id=?,result=? WHERE id=?")
    .run(learning.id, canonical(result), experimentId);
  const production = await createTask(store, { prompt: '使用快照制作' });
  const snapshot = store.saveArtifact(production.id, 'memory', store.memories(null), true);
  const knowledgeSnapshot = store.saveArtifact(production.id, 'creative.knowledge', shared, true);
  const page = await w.command({
    requestId: 'read',
    command: 'learning.knowledge',
    args: { experimentId, limit: 1 },
  });
  assert.equal(page.total, 2);
  assert.equal(page.nextOffset, 1);
  assert.equal(page.items[0].memory.provenance, 'source_narrative');
  assert.equal(page.items[0].state, 'active');
  const secondPage = await w.command({
    requestId: 'read-next',
    command: 'learning.knowledge',
    args: { experimentId, offset: page.nextOffset, limit: 1 },
  });
  assert.equal(secondPage.items[0].memoryId, memoryIds[1]);
  assert.equal(secondPage.nextOffset, null);
  const command = {
    requestId: 'retract',
    command: 'learning.retract',
    args: { experimentId, memoryId: memoryIds[0], reason: '人物经历被错误关联，撤回本条' },
  };
  await assert.rejects(
    w.command({ ...command, requestId: 'model-retract' }, { kind: 'conversation', messageId: 'message_x' }),
    {
      code: 'EXPLICIT_ACTION_REQUIRED',
    },
  );
  await assert.rejects(
    w.command({ ...command, requestId: 'other-account', args: { ...command.args, memoryId: privateMemory } }),
    { code: 'LEARNING_MEMORY_MISSING' },
  );
  const another = service.enqueue({ kind: 'script', query: '未完成学习' });
  await assert.rejects(
    w.command({ ...command, requestId: 'unpublished', args: { ...command.args, experimentId: another } }),
    { code: 'LEARNING_PUBLICATION' },
  );
  const missingMemory = () => !store.memories(null, '夜班').some((m) => m.id === memoryIds[0]);
  assert.equal(missingMemory(), false);
  store.db.exec(
    "CREATE TRIGGER fail_retract BEFORE INSERT ON events WHEN NEW.type='learning.knowledge.retracted' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END",
  );
  await assert.rejects(w.command({ ...command, requestId: 'audit-failure' }), /injected audit failure/);
  assert.equal(missingMemory(), false);
  assert.ok(culture.search('global', '夜班').entities.some((e) => e.id === shared.entities[0]!.id));
  assert.equal(culture.search('global', '').relations.length, 1);
  store.db.exec('DROP TRIGGER fail_retract');
  const removed = await w.command(command);
  await assert.rejects(w.command(command, { kind: 'conversation', messageId: 'message_x' }), {
    code: 'REQUEST_CONFLICT',
  });
  assert.equal(removed.memory.provenance, 'source_narrative');
  assert.equal(removed.memory.confidence, 0.7);
  assert.equal(removed.culture.relations.length, 1);
  assert.equal(missingMemory(), true);
  assert.deepEqual(
    culture.search('global', '').entities.map((e) => e.id),
    [shared.entities[1]!.id],
  );
  assert.equal(culture.search('global', '').relations.length, 0);
  assert.ok(culture.search(account, '夜班').entities.some((e) => e.id === privateBundle.entities[0]!.id));
  assert.ok(store.memories(account).some((m) => m.id === privateMemory));
  assert.ok(store.memories(null, '地铁').some((m) => m.id === memoryIds[1]));
  assert.equal(store.artifact(production.id, 'memory')!.hash, snapshot.hash);
  assert.deepEqual(store.artifact(production.id, 'creative.knowledge')!.data, knowledgeSnapshot.data);
  assert.deepEqual(await w.command({ ...command, requestId: 'repeat' }), removed);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM events WHERE type='learning.knowledge.retracted'").get()!.n,
    1,
  );
  const after = await w.command({
    requestId: 'after',
    command: 'learning.knowledge',
    args: { experimentId },
  });
  assert.equal(after.items[0].state, 'retracted');
  assert.equal(after.items[0].retraction.reason, command.args.reason);
  assert.equal(after.items[1].state, 'active');
  assert.deepEqual(
    await service.run(experimentId),
    result,
    'completed publication is history, not a republish command',
  );
  assert.equal(missingMemory(), true);
});

test('unexplained missing learned records are errors, not fabricated user retractions', async (t) => {
  const { store, root } = await fixture();
  const w = new Workbench(store, new TaskService(store), { autoStart: false });
  t.after(async () => {
    await w.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const experimentId = new LearningService(store).enqueue({ kind: 'script', query: '坏数据' });
  const task = await createTask(store, { prompt: '学习' }, 'task_missing', 'learning');
  store.db
    .prepare("UPDATE experiments SET state='completed',task_id=?,result=? WHERE id=?")
    .run(
      task.id,
      canonical({ taskId: task.id, memoryIds: ['memory_missing'], cultureIds: [] }),
      experimentId,
    );
  await assert.rejects(
    w.command({ requestId: 'read', command: 'learning.knowledge', args: { experimentId } }),
    { code: 'LEARNING_MEMORY_MISSING' },
  );
  await assert.rejects(
    w.command({
      requestId: 'remove',
      command: 'learning.retract',
      args: { experimentId, memoryId: 'memory_missing', reason: '明确撤回' },
    }),
    { code: 'LEARNING_MEMORY_MISSING' },
  );
});
