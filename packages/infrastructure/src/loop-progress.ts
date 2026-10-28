import type { Store } from './store.js';
import { FilmError, hash } from '../../core/src/util.js';

/** Detect an exact rejected-state cycle, not a limit on the number of useful revisions. */
export function rejectRepeatedState(
  store: Store,
  taskId: string,
  stage: string,
  scope: string,
  candidate: unknown,
  feedback: unknown,
) {
  const task = store.task(taskId);
  const scopeHash = hash({
    scope,
    stage,
    version: task.version,
    policy: task.policy.version,
    epoch: store.epoch(taskId),
    floor: store.artifactFloor(taskId, stage),
  });
  const candidateHash = hash(
    candidate && typeof candidate === 'object' && 'revision' in candidate
      ? { ...candidate, revision: 0 }
      : (candidate ?? null),
  );
  const feedbackHash = hash(feedback ?? null);
  const fingerprint = hash({ candidateHash, feedbackHash });
  const previous = store.db
    .prepare(
      "SELECT seq FROM events WHERE task_id=? AND type='loop.rejected' AND seq>? AND json_extract(data,'$.scopeHash')=? AND json_extract(data,'$.fingerprint')=? ORDER BY seq DESC LIMIT 1",
    )
    .get(taskId, store.stageEventFloor(taskId, stage), scopeHash, fingerprint);
  const state = { stage, scope, scopeHash, fingerprint, candidateHash, feedbackHash };
  store.event(taskId, 'loop.rejected', state);
  if (!previous) return;
  const details = { ...state, previousEvent: Number(previous.seq) };
  const artifact = store.saveArtifact(taskId, `${stage}.no_progress`, { ...details, candidate, feedback });
  const diagnostic = { ...details, artifactId: artifact.id };
  store.event(taskId, 'loop.no_progress', diagnostic);
  throw new FilmError(
    'NO_PROGRESS',
    '同一候选再次得到相同拒绝结果，循环已停止；当前候选和评审已保存。请查看未解决问题，修改方案或补充信息后继续。',
    diagnostic,
  );
}
