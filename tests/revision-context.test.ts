import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { createTask } from '../packages/application/src/workflow.js';
import { TaskService } from '../packages/application/src/task-service.js';
import { Workbench } from '../packages/application/src/workbench.js';
import {
  readUserRevisions,
  invalidateDerivedArtifacts,
} from '../packages/application/src/revision-context.js';

test('derived invalidation preserves only current user inputs, not old inputs, feedback, approvals or engineering instructions', async (t) => {
  const { store, root } = await fixture();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: '作品' });
  store.saveArtifact(task.id, 'editorial.user_revision', { instruction: '已明确撤回的旧指令' }, true);
  store.invalidateFrom(task.id, ['editorial.user_revision']);
  store.saveArtifact(task.id, 'layout.user_revision', { instruction: '已被新指令取代' }, true);
  const latest = store.saveArtifact(task.id, 'layout.user_revision', { instruction: '保留源画面' }, true);
  store.saveArtifact(task.id, 'script.engineering_revision', { instruction: '工程修复' }, true);
  store.saveArtifact(task.id, 'layout.feedback', { instruction: '模型建议' }, true);
  store.saveArtifact(task.id, 'layout', { approved: true }, true);
  invalidateDerivedArtifacts(store, task.id, ['script', 'editorial', 'layout', 'render']);
  assert.deepEqual(readUserRevisions(store, task.id), [{ stage: 'layout', data: latest.data }]);
  assert.equal(store.artifact(task.id, 'layout.user_revision')!.hash, latest.hash);
  assert.equal(store.artifact(task.id, 'layout'), undefined);
  assert.equal(store.artifact(task.id, 'layout.feedback', false), undefined);
  assert.ok(
    store.db.prepare('select 1 from artifacts where id=?').get(latest.id),
    'original history remains',
  );
  invalidateDerivedArtifacts(store, task.id, ['layout.user_revision']);
  assert.deepEqual(readUserRevisions(store, task.id), [], 'an explicit withdrawal is not undone');
});

test('instruction preservation and invalidation roll back together', async (t) => {
  const { store, root } = await fixture();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: '作品' });
  const instruction = store.saveArtifact(task.id, 'layout.user_revision', { instruction: '分屏' }, true);
  const layout = store.saveArtifact(task.id, 'layout', { version: 1 }, true);
  const rows = () =>
    store.db.prepare('select id,hash from artifacts where task_id=? order by rowid').all(task.id);
  const before = rows();
  t.mock.method(store, 'saveArtifact', () => {
    throw new Error('write failed');
  });
  assert.throws(() => invalidateDerivedArtifacts(store, task.id, ['layout']), /write failed/);
  assert.equal(store.artifact(task.id, 'layout')!.id, layout.id);
  assert.equal(store.artifact(task.id, 'layout.user_revision')!.id, instruction.id);
  assert.deepEqual(rows(), before);
});

test('upstream user edits and permission changes preserve pending downstream instructions', async (t) => {
  const { store, root } = await fixture();
  const service = new TaskService(store);
  const workbench = new Workbench(store, service, { autoStart: false });
  t.after(async () => {
    await workbench.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: '作品' });
  await workbench.command({
    requestId: 'layout-first',
    command: 'task.revise',
    taskId: task.id,
    args: { kind: 'layout', expectedVersion: task.version, instruction: '左右并排，不裁主体' },
  });
  await workbench.command({
    requestId: 'script-next',
    command: 'task.revise',
    taskId: task.id,
    args: { kind: 'script', expectedVersion: store.task(task.id).version, instruction: '重新安排开头的设问' },
  });
  const current = readUserRevisions(store, task.id);
  assert.deepEqual(
    current.map((item) => item.stage),
    ['script', 'layout'],
  );
  assert.equal((current[1]!.data as any).instruction, '左右并排，不裁主体');
  store.saveArtifact(task.id, 'layout', { stale: true }, true);
  await service.permissions(task.id, { readPaths: [], writePaths: [], denyPaths: [] });
  assert.deepEqual(readUserRevisions(store, task.id), current);
  assert.equal(store.artifact(task.id, 'layout'), undefined);
});
