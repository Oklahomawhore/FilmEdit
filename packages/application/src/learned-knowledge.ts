import { z } from 'zod';
import type { Store } from '../../infrastructure/src/store.js';
import { CreativeStore } from '../../infrastructure/src/creative-store.js';
import { invariant } from '../../core/src/util.js';

const publicationSchema = z.object({
  taskId: z.string(),
  memoryIds: z.array(z.string()).min(1).max(40),
  cultureIds: z.array(z.string()).max(40),
});

function publication(store: Store, experimentId: string) {
  const row = store.db
    .prepare('SELECT kind,state,task_id,result FROM experiments WHERE id=?')
    .get(experimentId);
  invariant(row, 'EXPERIMENT_MISSING', '找不到学习实验');
  invariant(
    row.kind === 'script' && row.state === 'completed',
    'LEARNING_PUBLICATION',
    '只能维护已发布的脚本学习记录；剪辑手法使用版本回滚',
  );
  const result = publicationSchema.parse(JSON.parse(row.result as string));
  invariant(
    row.task_id === result.taskId &&
      store.task(result.taskId).purpose === 'learning' &&
      new Set(result.memoryIds).size === result.memoryIds.length &&
      new Set(result.cultureIds).size === result.cultureIds.length &&
      (!result.cultureIds.length || result.cultureIds.length === result.memoryIds.length),
    'LEARNING_PUBLICATION',
    '学习发布记录的归属或映射不完整',
  );
  return result;
}

function removal(store: Store, taskId: string, experimentId: string, memoryId: string) {
  const row = store.db
    .prepare(
      "SELECT data FROM events WHERE task_id=? AND type='learning.knowledge.retracted' AND json_extract(data,'$.experimentId')=? AND json_extract(data,'$.memoryId')=? ORDER BY seq DESC LIMIT 1",
    )
    .get(taskId, experimentId, memoryId);
  return row ? JSON.parse(row.data as string) : null;
}

function activeMemory(store: Store, memoryId: string) {
  const row = store.db.prepare('SELECT * FROM memories WHERE id=? AND account_id IS NULL').get(memoryId);
  invariant(
    row && ['topic', 'angle', 'persona'].includes(row.kind as string),
    'LEARNING_MEMORY_MISSING',
    '学习记忆缺失或不属于全局选题、角度、Persona 库',
  );
  return { ...row, tags: JSON.parse(row.tags as string) };
}

/** Maintenance reads include retractions; ordinary creative retrieval only sees active rows. */
export function learnedKnowledge(store: Store, experimentId: string, offset: number, limit: number) {
  const result = publication(store, experimentId);
  return {
    experimentId,
    taskId: result.taskId,
    total: result.memoryIds.length,
    items: result.memoryIds.slice(offset, offset + limit).map((memoryId, i) => {
      const retracted = removal(store, result.taskId, experimentId, memoryId);
      return {
        memoryId,
        cultureId: result.cultureIds[offset + i] ?? null,
        state: retracted ? 'retracted' : 'active',
        memory: retracted ? retracted.memory : activeMemory(store, memoryId),
        retraction: retracted ? { reason: retracted.reason, at: retracted.at } : null,
      };
    }),
    nextOffset: offset + limit < result.memoryIds.length ? offset + limit : null,
  };
}

/** Remove all live retrieval representations atomically; immutable task snapshots remain evidence. */
export function retractLearnedKnowledge(
  store: Store,
  experimentId: string,
  memoryId: string,
  reason: string,
) {
  const culture = new CreativeStore(store);
  return store.transaction(() => {
    const result = publication(store, experimentId);
    const index = result.memoryIds.indexOf(memoryId);
    invariant(index >= 0, 'LEARNING_MEMORY_MISSING', '该记忆不属于所选学习实验');
    const previous = removal(store, result.taskId, experimentId, memoryId);
    if (previous) return previous;
    const memory = activeMemory(store, memoryId);
    const cultureId = result.cultureIds[index];
    const removedCulture = cultureId ? culture.removeEntity('global', cultureId) : null;
    store.db.prepare('DELETE FROM memory_fts WHERE memory_id=?').run(memoryId);
    store.db.prepare('DELETE FROM memories WHERE id=? AND account_id IS NULL').run(memoryId);
    const retraction = {
      experimentId,
      memoryId,
      memory,
      culture: removedCulture,
      reason,
      at: new Date().toISOString(),
    };
    store.event(result.taskId, 'learning.knowledge.retracted', retraction);
    return retraction;
  });
}
