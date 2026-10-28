import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.js';
import { createTask } from '../packages/application/src/workflow.js';
import { Store } from '../packages/infrastructure/src/store.js';

test('schema migration makes task configuration explicit without rerunning or changing accepted artifacts', async (t) => {
  const fixtureData = await fixture();
  let store = fixtureData.store;
  t.after(async () => {
    store.close();
    await rm(fixtureData.root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: '历史作品', materials: { strategy: 'local_only' } });
  const script = store.saveArtifact(task.id, 'script', { narration: '保持原稿' }, true);
  store.updateTask(task.id, 'paused', 'editorial');
  const { creative, composition, ...oldSpec } = task.spec;
  store.db.prepare('UPDATE tasks SET spec=?,cost=3 WHERE id=?').run(JSON.stringify(oldSpec), task.id);
  store.db.prepare('DELETE FROM migrations WHERE version=5').run();
  store.close();
  store = new Store(fixtureData.store.home);
  const migrated = store.task(task.id);
  assert.equal(migrated.spec.creative.enabled, false);
  assert.equal(migrated.spec.composition.aspectRatio, 'auto');
  assert.equal(migrated.status, 'paused');
  assert.equal(migrated.stage, 'editorial');
  assert.equal(migrated.cost, 3);
  assert.equal(migrated.version, task.version);
  assert.equal(store.artifact(task.id, 'script')!.hash, script.hash);
  assert.ok(
    (await readdir(path.join(store.home, 'backups'))).some((name) => name.startsWith('before-schema-6-')),
  );
  assert.ok(store.db.prepare('SELECT 1 FROM migrations WHERE version=5').get());
});

test('schema 6 separates existing learning workspaces without losing checkpoints or changing production', async (t) => {
  const f = await fixture();
  let store = f.store;
  t.after(async () => {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const production = await createTask(store, { prompt: '保持暂停的作品' });
  const workspace = await createTask(store, { prompt: '已有学习实验' });
  store.updateTask(production.id, 'paused', 'editorial');
  store.db
    .prepare(
      "INSERT INTO experiments(id,kind,state,config,result) VALUES('experiment_old','technique','blocked','{}',?)",
    )
    .run(JSON.stringify({ taskId: workspace.id, error: { code: 'CANCELLED', message: 'interrupted' } }));
  const checkpoint = store.saveArtifact(workspace.id, 'learning.checkpoint', { nextAttempt: 4 }, true);
  store.db.prepare('UPDATE tasks SET cost=2.5 WHERE id=?').run(workspace.id);
  store.db.exec(
    'ALTER TABLE experiments DROP COLUMN task_id; ALTER TABLE experiments DROP COLUMN error; ALTER TABLE tasks DROP COLUMN purpose; DELETE FROM migrations WHERE version=6;',
  );
  store.close();
  store = new Store(f.store.home);
  assert.deepEqual(
    store.tasks().map((t) => t.id),
    [production.id],
  );
  assert.deepEqual(
    store.tasks('learning').map((t) => t.id),
    [workspace.id],
  );
  assert.equal(store.task(production.id).status, 'paused');
  assert.equal(store.task(production.id).stage, 'editorial');
  assert.equal(store.task(workspace.id).cost, 2.5);
  assert.equal(store.artifact(workspace.id, 'learning.checkpoint')!.hash, checkpoint.hash);
  const experiment = store.db.prepare("SELECT * FROM experiments WHERE id='experiment_old'").get()!;
  assert.equal(experiment.task_id, workspace.id);
  assert.equal(JSON.parse(experiment.error as string).code, 'CANCELLED');
  assert.deepEqual(JSON.parse(experiment.result as string), { taskId: workspace.id });
  assert.throws(() => store.productionTask(workspace.id), { code: 'TASK_PURPOSE' });
  assert.ok(
    (await readdir(path.join(store.home, 'backups'))).some((name) => name.startsWith('before-schema-6-')),
  );
});
