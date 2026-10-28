import type { Store } from '../../infrastructure/src/store.js';
import {
  workFeedbackSchema,
  feedbackLabels,
  type FeedbackOrigin,
  type WorkFeedback,
} from '../../core/src/feedback.js';
import { id, invariant } from '../../core/src/util.js';

const isOutput = (stage: string) =>
  stage === 'render' || stage === 'output.current' || stage.startsWith('export.');

export function feedbackHistory(store: Store, taskId: string, before = 0, limit = 20) {
  store.productionTask(taskId);
  const rows = store.db
    .prepare(
      "SELECT seq,data,created FROM events WHERE task_id=? AND type='task.feedback' AND (?=0 OR seq<?) ORDER BY seq DESC LIMIT ?",
    )
    .all(taskId, before, before, limit + 1);
  return {
    items: rows.slice(0, limit).map((row) => {
      const value = JSON.parse(row.data as string) as WorkFeedback;
      return {
        ...value,
        label: feedbackLabels[value.decision],
        seq: Number(row.seq),
        created: row.created as string,
      };
    }),
    nextBefore: rows.length > limit ? Number(rows[limit - 1]!.seq) : null,
  };
}

/** Select the actual current output; a new task version never inherits an earlier verdict. */
export function feedbackSummary(store: Store, taskId: string) {
  const task = store.productionTask(taskId);
  const output =
    task.status === 'completed'
      ? store.db
          .prepare(
            "SELECT id,stage,hash FROM artifacts WHERE task_id=? AND accepted=1 AND (stage IN ('render','output.current') OR stage LIKE 'export.%') ORDER BY rowid DESC",
          )
          .all(taskId)
          .find((row) => store.artifact(taskId, row.stage as string)?.id === row.id)
      : undefined;
  const row = output
    ? store.db
        .prepare(
          "SELECT data FROM events WHERE task_id=? AND type='task.feedback' AND json_extract(data,'$.taskVersion')=? AND json_extract(data,'$.artifact.hash')=? AND json_extract(data,'$.decision')!='comment' ORDER BY seq DESC LIMIT 1",
        )
        .get(taskId, task.version, output.hash!)
    : undefined;
  const latest = row ? (JSON.parse(row.data as string) as WorkFeedback) : null;
  const decision = latest?.decision ?? 'unreviewed';
  return {
    taskVersion: task.version,
    output: output ?? null,
    decision,
    label: feedbackLabels[decision],
    latest,
  };
}

/** Append human feedback separately from automatic artifact acceptance and account memory. */
export function recordWorkFeedback(
  store: Store,
  taskId: string,
  requestId: string,
  raw: unknown,
  origin: FeedbackOrigin,
) {
  const input = workFeedbackSchema.parse(raw);
  return store.transaction(() => {
    const prior = store.db
      .prepare(
        "SELECT data FROM events WHERE task_id=? AND type='task.feedback' AND json_extract(data,'$.requestId')=?",
      )
      .get(taskId, requestId);
    if (prior) return JSON.parse(prior.data as string) as WorkFeedback;
    const task = store.productionTask(taskId);
    invariant(
      task.version === input.expectedVersion,
      'VERSION_CONFLICT',
      '任务版本已变化，请审阅对应版本后再提交反馈',
    );
    if (origin.kind === 'conversation') {
      const message = store.db
        .prepare("SELECT task_id,content FROM messages WHERE id=? AND role='user'")
        .get(origin.messageId);
      invariant(
        message && message.task_id === taskId,
        'FEEDBACK_SOURCE',
        '反馈必须来自当前任务关联的用户消息',
      );
      invariant(
        input.decision === 'comment',
        'HUMAN_VERDICT_REQUIRED',
        '模型只能记录用户原话；接受、拒绝或要求修改的正式结论请由用户在反馈入口直接提交',
      );
      invariant(
        input.content === JSON.parse(message.content as string).text.trim(),
        'FEEDBACK_SOURCE',
        '对话反馈必须原样保留本轮用户消息，不能改写为模型评价',
      );
    }
    const row = input.artifactId
      ? store.db
          .prepare('SELECT id,stage,revision,hash,data,accepted FROM artifacts WHERE id=? AND task_id=?')
          .get(input.artifactId, taskId)
      : undefined;
    invariant(!input.artifactId || row, 'ARTIFACT_MISSING', '反馈引用的产物不属于当前任务');
    if (input.decision !== 'comment') {
      invariant(
        row &&
          isOutput(row.stage as string) &&
          row.accepted &&
          typeof JSON.parse(row.data as string).path === 'string',
        'FEEDBACK_OUTPUT',
        '正式结论必须指向一个已导出的成片版本',
      );
      invariant(task.status === 'completed', 'FEEDBACK_NOT_READY', '当前制作尚未完成，可以先记录意见');
      invariant(
        feedbackSummary(store, taskId).output?.hash === row.hash,
        'FEEDBACK_STALE_OUTPUT',
        '成片已更新，请审阅新成片后提交结论',
      );
    }
    const feedback: WorkFeedback = {
      id: id('feedback'),
      requestId,
      taskVersion: task.version,
      artifact: row
        ? {
            id: row.id as string,
            stage: row.stage as string,
            revision: Number(row.revision),
            hash: row.hash as string,
          }
        : null,
      decision: input.decision,
      dimensions: [...new Set(input.dimensions)],
      content: input.content,
      origin,
    };
    store.event(taskId, 'task.feedback', feedback);
    if (task.spec.accountId)
      store.addMemory(task.spec.accountId, {
        kind: 'feedback',
        content: input.content,
        tags: input.dimensions,
        provenance: 'user',
        confidence: 1,
        source: `${taskId}#v=${task.version}&feedback=${feedback.id}${row ? `&artifact=${row.id}` : ''}`,
      });
    return feedback;
  });
}
