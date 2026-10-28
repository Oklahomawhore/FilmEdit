import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createTask } from '../packages/application/src/workflow.js';
import { Store } from '../packages/infrastructure/src/store.js';
test('SQLite persists checkpoints and account memory is isolated', async () => {
  const { store } = await fixture();
  const a = store.createAccount('A'),
    b = store.createAccount('B');
  store.addMemory(a, {
    kind: 'setting',
    content: '偏好简洁',
    tags: ['简洁'],
    provenance: 'user',
    confidence: 1,
  });
  store.addMemory(b, {
    kind: 'experience',
    content: '在工厂上夜班',
    tags: ['夜班'],
    provenance: 'user',
    confidence: 1,
  });
  assert.ok(!store.memories(a).some((m) => m.accountId === b));
  assert.ok(store.memories(a, '偏好简洁').some((m) => m.content === '偏好简洁'));
  assert.throws(
    () =>
      store.addMemory(a, {
        kind: 'experience',
        content: '虚构',
        tags: [],
        provenance: 'fictional',
        confidence: 1,
      }),
    { code: 'MEMORY_PROVENANCE' },
  );
  const task = await createTask(store, { prompt: '测试', accountId: a });
  store.saveArtifact(task.id, 'editorial', { revision: 1 }, true);
  const home = store.home;
  store.close();
  const reopened = new Store(home);
  assert.equal(reopened.task(task.id).spec.accountId, a);
  assert.deepEqual(reopened.artifact(task.id, 'editorial')!.data, { revision: 1 });
  reopened.invalidate(task.id, ['editorial']);
  assert.equal(reopened.artifact(task.id, 'editorial'), undefined);
  assert.ok(reopened.artifact(task.id, 'editorial', false));
  reopened.close();
});
test('task and learning leases prevent concurrent ownership', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  assert.ok(store.acquireLease('learning', 'one'));
  assert.equal(store.acquireLease('learning', 'two'), false);
  store.releaseLease('learning', 'two');
  assert.equal(store.acquireLease('learning', 'two'), false);
  store.releaseLease('learning', 'one');
  assert.ok(store.acquireLease('learning', 'two'));
});

test('memory corrections are account-scoped, searchable, audited, and preserve fictional provenance', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const a = store.createAccount('A'),
    b = store.createAccount('B');
  const memory = store.addMemory(a, {
    kind: 'persona',
    content: '虚构的夜班经历',
    tags: [],
    provenance: 'fictional',
    confidence: 0.5,
  });
  assert.throws(() => store.correctMemory(b, memory, { content: '污染账号', tags: [] }), {
    code: 'MEMORY_MISSING',
  });
  store.correctMemory(a, memory, { content: '虚构的雨中散步经历', tags: ['散步'] });
  const corrected = store.memories(a, '雨中散步').find((m) => m.id === memory)!;
  assert.equal(corrected.content, '虚构的雨中散步经历');
  assert.equal(corrected.provenance, 'fictional');
  assert.equal(
    store.memories(a, '夜班').some((m) => m.id === memory),
    false,
  );
  store.correctMemory(a, memory, null);
  assert.equal(
    store.memories(a, '散步').some((m) => m.id === memory),
    false,
  );
  const history = store.db
    .prepare('SELECT operation,before_data FROM memory_changes WHERE memory_id=? ORDER BY id')
    .all(memory);
  assert.deepEqual(
    history.map((r) => r.operation),
    ['correct', 'remove'],
  );
  assert.ok(String(history[0]!.before_data).includes('夜班'));
});
