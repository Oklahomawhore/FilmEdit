// Verify maintenance against a copy of real, previously published knowledge; never retract the source.
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../dist/packages/infrastructure/src/store.js';
import { Workbench } from '../dist/packages/application/src/workbench.js';
import { TaskService } from '../dist/packages/application/src/task-service.js';
import { hash } from '../dist/packages/core/src/util.js';

const base = path.resolve('.filmedit/verification/product-20261023');
const source = new DatabaseSync(path.join(base, 'real-learning-script-v2/filmedit.sqlite'), {
  readOnly: true,
});
const home = path.resolve(process.argv[2] ?? path.join(base, 'learning-curation-v26'));
const snapshot = (db) =>
  hash({
    memories: db.prepare('SELECT * FROM memories ORDER BY id').all(),
    artifacts: db.prepare('SELECT * FROM artifacts ORDER BY id').all(),
    experiments: db.prepare('SELECT * FROM experiments ORDER BY id').all(),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
  });
const originalHash = snapshot(source);
await mkdir(home); // Refuse to overwrite an earlier diagnostic.
await backup(source, path.join(home, 'filmedit.sqlite'));
let store = new Store(home);
let workbench = new Workbench(store, new TaskService(store), { autoStart: false });
const report = { diagnosticOnly: true, remoteModelCalled: false, sourceMutated: false, home };
try {
  const experiment = store.db
    .prepare(
      "SELECT id FROM experiments WHERE kind='script' AND state='completed' ORDER BY created DESC LIMIT 1",
    )
    .get();
  assert.ok(experiment);
  const read = (key, offset = 0) =>
    workbench.command({
      requestId: key,
      command: 'learning.knowledge',
      args: { experimentId: experiment.id, offset, limit: 10 },
    });
  const before = await read('before');
  const record = before.items[0];
  const artifactHash = hash(store.db.prepare('SELECT * FROM artifacts ORDER BY id').all());
  report.experimentId = experiment.id;
  report.sourceMemoryCount = before.total;
  report.testedMemoryId = record.memoryId;
  report.sourceProvenance = record.memory.provenance;
  assert.equal(record.state, 'active');
  assert.ok(record.memory.source.includes('&experiment='));
  const command = {
    requestId: 'retract',
    command: 'learning.retract',
    args: {
      experimentId: experiment.id,
      memoryId: record.memoryId,
      reason: '隔离副本的撤回验证，非知识真实性结论',
    },
  };
  const removed = await workbench.command(command);
  assert.deepEqual(removed.memory, record.memory);
  assert.deepEqual(await workbench.command({ ...command, requestId: 'repeat' }), removed);
  await workbench.close();
  store.close();
  store = new Store(home);
  workbench = new Workbench(store, new TaskService(store), { autoStart: false });
  const after = await read('after-reopen');
  assert.equal(after.items[0].state, 'retracted');
  assert.equal(after.items[0].memory.provenance, record.memory.provenance);
  let items = after.items;
  if (after.nextOffset !== null) items = items.concat((await read('next', after.nextOffset)).items);
  assert.equal(items.length, before.total);
  assert.equal(items.filter((item) => item.state === 'active').length, before.total - 1);
  assert.equal(
    store.memories(null, '', 100).some((m) => m.id === record.memoryId),
    false,
  );
  assert.equal(
    store.db.prepare('SELECT 1 FROM memory_fts WHERE memory_id=?').get(record.memoryId),
    undefined,
  );
  assert.equal(hash(store.db.prepare('SELECT * FROM artifacts ORDER BY id').all()), artifactHash);
  assert.equal(snapshot(source), originalHash);
  report.passed = true;
  report.activeAfterRetraction = before.total - 1;
  report.originalSourceHash = originalHash;
  report.historyPreserved = true;
  report.reopenAndIdempotencyPassed = true;
  report.scope =
    'Real local-video learning records on an isolated database copy; cultural graph deletion is covered by separate transaction tests.';
} finally {
  await workbench.close();
  store.close();
  source.close();
  await writeFile(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
