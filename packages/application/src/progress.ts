import { z } from 'zod';
import type { Store } from '../../infrastructure/src/store.js';

const stageLabels: Record<string, string> = {
  creative: '创意',
  script: '脚本与旁白',
  materials: '素材补充与匹配',
  editorial: '剪辑与观众评审',
  layout: '布局与画面评审',
  render: '完整渲染与检查',
  complete: '完成',
};
const roles: Record<string, string> = {
  intent: '识别固定要求',
  intent_review: '核对要求',
  culture_research: '检索文化知识',
  creative: '发散创意',
  concept_audience: '独立评审创意',
  script: '撰写脚本',
  facts_review: '核查事实',
  audience_review: '审查脚本理解',
  voice_review: '审查人物与表达',
  materials: '寻找并核验素材',
  materials_review: '独立核对素材画面与声音',
  production_repair: '判断素材缺口的修订范围',
  creative_revision_review: '复审创意实现的修改范围',
  acceptance: '提取程序硬校验条件',
  acceptance_review: '核对硬校验条件',
  semantic_review: '独立判断内容与表达',
  editor: '组织剪辑',
  editorial_audience: '独立理解剪辑',
  layout: '编排画面',
  visual_audience: '检查实际画面',
};

/** Read model built from actual jobs, sessions and artifacts; never invent percentage progress. */
export function taskProgress(store: Store, taskId: string) {
  const task = store.task(taskId);
  const job = store.db
    .prepare(
      "SELECT id,kind,state,updated FROM jobs WHERE task_id=? AND kind!='chat' ORDER BY rowid DESC LIMIT 1",
    )
    .get(taskId);
  const session = store.db
    .prepare(
      "SELECT id,role,state,updated FROM agent_sessions WHERE task_id=? AND role!='conversation' ORDER BY rowid DESC LIMIT 1",
    )
    .get(taskId);
  const tool = session
    ? store.db
        .prepare(
          'SELECT name,state,updated FROM tool_executions WHERE session_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(session.id!)
    : undefined;
  const event = store.db
    .prepare('SELECT type,data,created FROM events WHERE task_id=? ORDER BY seq DESC LIMIT 1')
    .get(taskId);
  const lease = store.db.prepare('SELECT expires FROM leases WHERE name=?').get(`task:${taskId}`);
  const live = lease && Number(lease.expires) > Date.now();
  const error = z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .safeParse(task.error).data;
  const interrupted = task.status === 'running' && !live;
  const attempt = store.db
    .prepare(
      "SELECT data FROM events WHERE task_id=? AND seq>? AND ((type='stage.attempt' AND json_extract(data,'$.stage')=?) OR (type='materials.attempt' AND ?='materials') OR (type='render.attempt' AND ?='render')) ORDER BY seq DESC LIMIT 1",
    )
    .get(taskId, store.stageEventFloor(taskId, task.stage), task.stage, task.stage, task.stage);
  const attemptData = attempt ? JSON.parse(attempt.data as string) : undefined;
  const artifacts = store.db
    .prepare(
      'SELECT id,stage,revision,accepted,created FROM artifacts WHERE task_id=? ORDER BY rowid DESC LIMIT 20',
    )
    .all(taskId);
  const current =
    task.status === 'completed'
      ? '成片和项目已保存'
      : interrupted
        ? '没有正在执行的 Worker，请恢复任务'
        : task.status === 'paused'
          ? '已暂停，保留检查点'
          : task.status === 'blocked' || task.status === 'failed'
            ? (error?.message ?? '执行遇到问题')
            : session?.state === 'running'
              ? `${roles[session.role as string] ?? session.role}${tool?.state === 'running' ? ` · ${tool.name}` : ''}`
              : stageLabels[task.stage];
  return {
    stage: task.stage,
    stageLabel: stageLabels[task.stage],
    status: interrupted ? 'interrupted' : task.status,
    current,
    attempt: attemptData ? Number(attemptData.round ?? attemptData.attempt) + 1 : undefined,
    lastActivity: [event?.created, session?.updated, tool?.updated, task.updated]
      .filter((v): v is string => typeof v === 'string')
      .sort()
      .at(-1),
    latestEvent: event ? { type: event.type, data: JSON.parse(event.data as string) } : undefined,
    job,
    session,
    tool,
    artifacts,
    gaps: store.artifact(taskId, 'materials.gaps', false)?.data,
    nextAction:
      error?.code === 'NO_PROGRESS'
        ? '查看重复拒绝的候选与评审；修改方案、补充素材或纠正要求后，从当前检查点继续'
        : error?.code === 'MATERIALS_MISSING'
          ? '补充缺失素材或调整来源范围后恢复'
          : error?.code === 'MODEL_BALANCE'
            ? '模型服务充值后从当前检查点恢复，无需重新创建任务'
            : error?.code === 'SCORING_INPUT_TOO_LONG'
              ? '完整证据超出评分模型容量，保留当前产物，修复评分后继续评审'
              : interrupted || ['blocked', 'failed', 'paused'].includes(task.status)
                ? '查看问题，处理后从检查点恢复'
                : task.status === 'completed'
                  ? '审阅成片，提出修改或导出其他规格'
                  : '可查看当前产物、对话或暂停',
  };
}
