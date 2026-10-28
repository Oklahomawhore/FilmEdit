import type { Store } from '../../infrastructure/src/store.js';
import { taskProgress } from './progress.js';
import { invariant } from '../../core/src/util.js';
import { feedbackHistory, feedbackSummary } from './feedback.js';

export function reviewArtifact(store: Store, taskId: string, artifactId: string) {
  const row = store.db.prepare('SELECT * FROM artifacts WHERE task_id=? AND id=?').get(taskId, artifactId);
  invariant(row, 'ARTIFACT_MISSING', 'Artifact is not in this task');
  const narration = ['script', 'script.candidate'].includes(String(row.stage))
    ? store.db
        .prepare(
          "SELECT data FROM artifacts WHERE task_id=? AND stage='narration' AND json_extract(data,'$.scriptHash')=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(taskId, row.hash!)
    : undefined;
  return {
    ...row,
    data: JSON.parse(row.data as string),
    narration: narration ? JSON.parse(narration.data as string) : undefined,
  };
}

export const reviewNodes = [
  { id: 'input', label: '用户要求', stages: [], x: 24, y: 24 },
  {
    id: 'creative',
    label: '创意方案',
    stages: ['creative.brief', 'creative.batch', 'creative.material_requirements'],
    x: 24,
    y: 144,
  },
  {
    id: 'concept',
    label: '创意独立评审',
    stages: [
      'creative.review',
      'creative.reviews',
      'creative.feedback',
      'acceptance.plan',
      'acceptance.review',
      'creative.no_progress',
      'creative.intent.no_progress',
      'acceptance.no_progress',
    ],
    x: 304,
    y: 144,
  },
  { id: 'script', label: '脚本与旁白', stages: ['script', 'script.candidate', 'narration'], x: 24, y: 264 },
  {
    id: 'script_review',
    label: '脚本独立评审',
    stages: ['script.reviews', 'script.review.progress', 'script.feedback', 'script.no_progress'],
    x: 304,
    y: 264,
  },
  {
    id: 'materials',
    label: '素材补充与匹配',
    stages: [
      'materials',
      'materials.requirements',
      'materials.candidate',
      'materials.gaps',
      'materials.visual_review',
      'materials.source_review',
      'materials.feedback',
      'materials.no_progress',
    ],
    x: 24,
    y: 384,
  },
  {
    id: 'editorial',
    label: '剪辑方案',
    stages: ['editorial', 'editorial.candidate', 'editorial.recipe'],
    x: 24,
    y: 504,
  },
  {
    id: 'audience',
    label: '观众理解与对齐',
    stages: ['editorial.audience', 'editorial.alignment', 'editorial.feedback', 'editorial.no_progress'],
    x: 304,
    y: 504,
  },
  { id: 'layout', label: '画面布局', stages: ['layout', 'layout.candidate', 'composition'], x: 24, y: 624 },
  {
    id: 'visual',
    label: '预览与视觉评审',
    stages: [
      'layout.preview',
      'layout.audience',
      'layout.alignment',
      'layout.feedback',
      'layout.no_progress',
    ],
    x: 304,
    y: 624,
  },
  { id: 'render', label: '完整渲染', stages: ['render.candidate_media', 'render'], x: 24, y: 744 },
  {
    id: 'quality',
    label: '成片检查',
    stages: ['quality', 'final.alignment', 'render.no_progress', 'workflow.no_progress'],
    x: 304,
    y: 744,
  },
  { id: 'output', label: '成片与独立导出', stages: ['render', 'output.current'], x: 24, y: 864 },
] as const;

export function reviewTask(store: Store, taskId: string) {
  const task = store.task(taskId);
  const artifacts = store.db
    .prepare(
      'SELECT id,stage,revision,hash,accepted,created FROM artifacts WHERE task_id=? ORDER BY rowid DESC',
    )
    .all(taskId);
  const nodes = reviewNodes.map((node) => {
    const matches = artifacts.filter(
      (a) =>
        (node.stages as readonly string[]).includes(a.stage as string) ||
        (node.id === 'output' && String(a.stage).startsWith('export.')),
    );
    return {
      ...node,
      count: matches.length,
      artifacts: matches
        .slice(0, 100)
        .map((a) => ({ ...a, current: store.artifact(taskId, a.stage as string)?.id === a.id })),
    };
  });
  return {
    task,
    progress: taskProgress(store, taskId),
    feedback: feedbackSummary(store, taskId),
    feedbackHistory: feedbackHistory(store, taskId),
    nodes,
    assets: store.assets(taskId).map((a) => ({
      id: a.id,
      title: a.source.title ?? a.source.path.split('/').at(-1),
      kind: a.kind,
      width: a.width,
      height: a.height,
      duration: a.duration,
      sha256: a.sha256,
      source: a.source.kind,
      url: a.source.url,
      frames: a.frames.length,
    })),
    capturedAt: new Date().toISOString(),
  };
}
