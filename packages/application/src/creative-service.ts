import { Store } from '../../infrastructure/src/store.js';
import { CreativeStore } from '../../infrastructure/src/creative-store.js';
import { canonical, id, invariant } from '../../core/src/util.js';
import { creativeOptionsSchema } from '../../core/src/creative-domain.js';
import { PathPolicy } from '../../infrastructure/src/security.js';

export function creativeStatus(store: Store, taskId: string) {
  const task = store.task(taskId);
  return {
    enabled: task.spec.creative.enabled,
    stage: task.stage,
    intent: store.artifact(taskId, 'creative.intent')?.data ?? null,
    knowledge: store.artifact(taskId, 'creative.knowledge')?.data ?? null,
    reviews: store.artifact(taskId, 'creative.reviews', false)?.data ?? null,
    brief: store.artifact(taskId, 'creative.brief')?.data ?? null,
    candidates: new CreativeStore(store).candidates(taskId),
  };
}
export async function resampleCreative(store: Store, taskId: string, seed?: string) {
  const task = store.task(taskId);
  const options = creativeOptionsSchema.parse({
    ...task.spec.creative,
    enabled: true,
    seed: seed ?? id('sample'),
  });
  store.transaction(() => {
    invariant(
      task.status !== 'running' &&
        !store.db
          .prepare('SELECT 1 FROM leases WHERE name=? AND expires>?')
          .get(`task:${taskId}`, Date.now()),
      'TASK_BUSY',
      'Stop the task before resampling',
    );
    const artifactFloor = Number(
      store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM artifacts WHERE task_id=?').get(taskId)!.n,
    );
    const eventFloor = Number(
      store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE task_id=?').get(taskId)!.n,
    );
    store.db
      .prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(`epoch:${taskId}`, canonical({ artifactFloor, eventFloor }));
    // Retain history for audit, but no previous-generation candidate/review can satisfy this run.
    store.db
      .prepare('UPDATE tasks SET spec=? WHERE id=?')
      .run(canonical({ ...task.spec, creative: options }), taskId);
    store.updateTask(taskId, 'queued', 'creative');
    store.event(taskId, 'creative.resampled', { seed: options.seed, artifactFloor });
  });
  const updated = store.task(taskId);
  await new PathPolicy(task.policy).write(
    `${task.policy.workspace}/task.json`,
    JSON.stringify(updated, null, 2),
  );
  return updated;
}
