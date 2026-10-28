import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createTask } from '../packages/application/src/workflow.js';
import { reviewArtifact } from '../packages/application/src/review.js';

test('review audio is tied to the exact script version, never the current task narration', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '历史版本' }),
    other = await createTask(store, { prompt: '另一个任务' });
  const first = store.saveArtifact(task.id, 'script', { narration: '第一版' }, true);
  const second = store.saveArtifact(task.id, 'script.candidate', { narration: '第二版' });
  store.saveArtifact(task.id, 'narration', { scriptHash: first.hash, assetId: 'voice_one' }, true);
  assert.equal(reviewArtifact(store, task.id, first.id).narration.assetId, 'voice_one');
  assert.equal(reviewArtifact(store, task.id, second.id).narration, undefined);
  store.saveArtifact(task.id, 'narration', { scriptHash: second.hash, assetId: 'voice_two' }, true);
  assert.equal(reviewArtifact(store, task.id, first.id).narration.assetId, 'voice_one');
  assert.equal(reviewArtifact(store, task.id, second.id).narration.assetId, 'voice_two');
  assert.throws(() => reviewArtifact(store, other.id, first.id), { code: 'ARTIFACT_MISSING' });
});
