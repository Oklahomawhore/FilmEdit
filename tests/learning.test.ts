import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.js';
import {
  LearningService,
  decideScriptLearningReview,
  decideTechniqueLearningReview,
  prepareTechniqueContext,
  TECHNIQUE_CONTEXT_VERSION,
} from '../packages/application/src/learning.js';
import { createTask } from '../packages/application/src/workflow.js';

test('new technique input policy retires exposed candidates without deleting evidence or resetting valid recovery', async (t) => {
  const { store, root } = await fixture();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: 'isolation control' }, undefined, 'learning');
  store.saveArtifact(task.id, 'learning.reference', { assetId: 'reference' }, true);
  store.saveArtifact(task.id, 'learning.materials', [{ assetId: 'training' }], true);
  const old = store.saveArtifact(task.id, 'learning.candidate.37', { exposed: true }, true);
  store.saveArtifact(task.id, 'learning.preview', { exposed: true }, true);
  store.saveArtifact(task.id, 'learning.checkpoint', { nextAttempt: 37, feedback: 'exposed' }, true);
  prepareTechniqueContext(store, task.id);
  assert.equal(store.artifact(task.id, 'learning.candidate.37'), undefined);
  assert.equal(store.artifact(task.id, 'learning.preview'), undefined);
  assert.equal(store.artifact(task.id, 'learning.checkpoint'), undefined);
  assert.ok(store.artifact(task.id, 'learning.reference'));
  assert.ok(store.artifact(task.id, 'learning.materials'));
  assert.ok(store.db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(old.id));
  assert.equal((store.artifact(task.id, 'learning.context')!.data as any).version, TECHNIQUE_CONTEXT_VERSION);
  const candidate = store.saveArtifact(task.id, 'learning.candidate.0', { exposed: false }, true);
  const checkpoint = store.saveArtifact(task.id, 'learning.checkpoint', { nextAttempt: 1 }, true);
  prepareTechniqueContext(store, task.id);
  assert.equal(store.artifact(task.id, 'learning.candidate.0')!.id, candidate.id);
  assert.equal(store.artifact(task.id, 'learning.checkpoint')!.id, checkpoint.id);
});

test('technique publication requires observed agreement in every mechanism, never unknown evidence', () => {
  const checks = {
    timing: { verdict: 'same' as const, evidence: '0..1s and 4..5s' },
    motion: { verdict: 'same' as const, evidence: 'static throughout' },
    layout: { verdict: 'same' as const, evidence: 'one frame at center' },
    transition: { verdict: 'same' as const, evidence: 'linear fade to black' },
  };
  assert.equal(decideTechniqueLearningReview({ checks, issues: [] }).passed, true);
  for (const verdict of ['different', 'uncertain'] as const)
    assert.equal(
      decideTechniqueLearningReview({
        checks: { ...checks, transition: { verdict, evidence: 'entry not established' } },
        issues: [{ severity: 'warning', message: 'not enough frames', evidence: '0s, 2.5s only' }],
      }).passed,
      false,
    );
});

test('learning publication cannot downgrade provenance or evidence errors into warnings', () => {
  for (const kind of ['provenance', 'source_mismatch', 'unsupported_claim'] as const) {
    const review = decideScriptLearningReview(
      { issues: [{ memoryIndex: 0, kind, evidence: 'frame 0', message: 'wrong source' }] },
      1,
    );
    assert.equal(review.passed, false);
    assert.equal(review.issues[0]!.severity, 'blocking');
  }
  assert.equal(
    decideScriptLearningReview(
      { issues: [{ memoryIndex: 0, kind: 'style', evidence: 'line', message: 'shorter wording' }] },
      1,
    ).passed,
    true,
  );
  assert.throws(
    () =>
      decideScriptLearningReview(
        { issues: [{ memoryIndex: 1, kind: 'style', evidence: 'line', message: 'invalid index' }] },
        1,
      ),
    /existing memory/,
  );
});

test('cancelled learning resumes the same task, permissions, budget and checkpoint after a worker restart', async (t) => {
  const { store, root } = await fixture();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const learning = new LearningService(store);
  const experiment = learning.enqueue({ kind: 'technique', query: '匹配剪辑' });
  const stop = new AbortController();
  stop.abort(new Error('worker stopped'));
  await assert.rejects(learning.run(experiment, stop.signal), /worker stopped/);
  const first = learning.list()[0]!;
  const task = store.task(first.result.taskId);
  store.saveArtifact(
    task.id,
    'learning.checkpoint',
    { nextAttempt: 3, feedback: { distance: 0.2 }, best: 0.2, stagnant: 1 },
    true,
  );
  store.db.prepare('UPDATE tasks SET cost=5 WHERE id=?').run(task.id);
  store.db.prepare("UPDATE experiments SET state='running' WHERE id=?").run(experiment);
  await assert.rejects(new LearningService(store).run(experiment, stop.signal), /worker stopped/);
  assert.equal(store.tasks().length, 0);
  assert.equal(store.tasks('learning').length, 1);
  assert.equal(learning.list()[0]!.state, 'paused');
  assert.equal(learning.list()[0]!.workspace?.cost, 5);
  assert.equal(learning.list()[0]!.result.error, undefined);
  assert.ok(learning.list()[0]!.error);
  assert.equal(learning.list()[0]!.result.taskId, task.id);
  assert.equal(store.task(task.id).cost, 5);
  assert.equal((store.artifact(task.id, 'learning.checkpoint')!.data as any).nextAttempt, 3);
  assert.deepEqual(store.task(task.id).policy, task.policy);
  assert.deepEqual(task.spec.materials.paths, []);
});
