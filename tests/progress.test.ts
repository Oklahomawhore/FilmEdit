import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createTask } from '../packages/application/src/workflow.js';
import { taskProgress } from '../packages/application/src/progress.js';

test('progress distinguishes a live worker from an abandoned running row, and reports material gaps', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '汽车' });
  store.updateTask(task.id, 'running', 'materials');
  assert.equal(taskProgress(store, task.id).status, 'interrupted');
  store.acquireLease(`task:${task.id}`, 'worker');
  store.event(task.id, 'materials.attempt', { attempt: 2 });
  assert.equal(taskProgress(store, task.id).status, 'running');
  assert.equal(taskProgress(store, task.id).attempt, 3);
  store.saveArtifact(task.id, 'materials.gaps', [{ needId: 'visual_1', reason: '缺少侧面行驶' }]);
  store.updateTask(task.id, 'blocked', 'materials', { code: 'MATERIALS_MISSING', message: '缺少侧面行驶' });
  assert.match(taskProgress(store, task.id).nextAction, /补充缺失素材/);
  assert.match(taskProgress(store, task.id).current!, /侧面行驶/);
  store.updateTask(task.id, 'blocked', 'editorial', { code: 'MODEL_BALANCE', message: '模型服务余额不足' });
  assert.match(taskProgress(store, task.id).nextAction, /充值后从当前检查点恢复/);
  store.updateTask(task.id, 'blocked', 'editorial', { code: 'SCORING_INPUT_TOO_LONG' });
  assert.match(taskProgress(store, task.id).nextAction, /保留当前产物/);
  store.updateTask(task.id, 'running', 'layout');
  assert.equal(
    taskProgress(store, task.id).attempt,
    undefined,
    'material attempt does not become a layout attempt',
  );
});
