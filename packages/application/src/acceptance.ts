import type { AgentDriver } from '../../agent-runtime/src/agents.js';
import type { Store } from '../../infrastructure/src/store.js';
import type { CreativeBrief } from '../../core/src/creative-domain.js';
import {
  hardAcceptancePlanSchema,
  acceptanceReviewSchema,
  validateAcceptancePlan,
  validateHardTemporalPrecision,
  validateAcceptanceReview,
  type AcceptancePlan,
  type AcceptanceSource,
} from '../../core/src/acceptance.js';
import { creativeCriteria } from './creativity.js';
import { FilmError, hash } from '../../core/src/util.js';
import { reassessExistingWork } from './revision-context.js';
import { splitRequirements } from '../../core/src/requirements.js';
import { rejectRepeatedState } from '../../infrastructure/src/loop-progress.js';

export const ACCEPTANCE_VERSION = 'hard-constraints-v2-source-seconds';
const contextInstruction = `只提取能够通过执行参数直接验证的硬条件：layout_mode、playback_rate、program、track_count。每个 sourceId 必须出现；没有这类参数时 checks=[]。原始语义要求保留全文，由独立语义评审判断，不需要改写成 observation、NLI 原子命题或关键词。
context.sources 是完整冻结要求，context.technical 已有专门的程序校验，不重复添加。不得增加审美偏好、强化约束或把对象数量误写为音轨数量。program 作用于全片；局部静音不能编译成全片 silent。只有原文明示源播放倍率才用 playback_rate，感知快慢不等于倍速。approximate 仅用于明确的约数；interval 必须保留原文秒数，严禁提前量化、四舍五入或改写为帧时间；例如 7.7、9.9、12.7 必须原样输出，不能改成 7.6667、9.9167、12.6667。渲染采样程序统一执行一次帧量化，编译器和审查者都不能替它计算。interval=null 表示全片。layout_mode 描述媒体容器，不证明主体或叙事。画中画不等于两个并列分屏。语义关系、同一主体、可辨性、事件顺序与情绪仍由原文完整要求约束。
审查只判断这些硬条件是否完整且忠实于原文的可测参数，不要求 checks 覆盖语义。仅有语义要求时空 checks 是正确的。检查反例和内部冲突；不得读取候选视频、剪辑或旧评分。`;
export function acceptanceSources(brief: CreativeBrief): AcceptanceSource[] {
  const all = creativeCriteria(brief, 'render');
  return [
    ...all.fixed.map((c, i) => ({
      id: `fixed_${i}`,
      text: c.text,
      quote: c.sourceText,
      group: 'fixed' as const,
      modality: c.modality,
      stage: 'editorial' as const,
    })),
    ...all.expression.map((c, i) => ({
      id: `expression_${i}`,
      text: c.text,
      quote: c.sourceText,
      group: 'expression' as const,
      modality: c.modality,
      // A source timeline does not prove the placement, visibility or motion of the composed picture.
      // Visual expression is checked on rendered evidence; it remains mandatory there.
      stage: c.modality === 'visual' ? ('render' as const) : brief.concept.commitments[i]!.stage,
    })),
  ];
}
export type FrozenAcceptance = {
  version: string;
  inputHash: string;
  sources: AcceptanceSource[];
  plan: AcceptancePlan;
};
type AcceptanceReview = ReturnType<typeof acceptanceReviewSchema.parse>;
type ApprovedSource = {
  plan: AcceptancePlan['sources'][number];
  review: AcceptanceReview['sources'][number];
};
type CompilationFeedback = { previous: AcceptancePlan; review: AcceptanceReview };

/** Compile once before editing. Neither compiler nor audit may see a candidate cut or its score. */
export async function compileAcceptance(
  store: Store,
  taskId: string,
  agent: AgentDriver,
  brief: CreativeBrief | undefined,
  signal?: AbortSignal,
): Promise<FrozenAcceptance> {
  const task = store.task(taskId);
  const sources: AcceptanceSource[] = brief
    ? acceptanceSources(brief)
    : splitRequirements(task.spec.prompt).map((c, i) => ({
        id: `fixed_${i}`,
        text: c.text,
        quote: c.sourceText,
        group: 'fixed',
        modality: c.modality,
        stage: 'editorial',
      }));
  const duration = task.spec.output.duration;
  const validatePlan = (plan: AcceptancePlan, items: AcceptanceSource[], duration: number) => {
    validateAcceptancePlan(plan, items, duration);
    return validateHardTemporalPrecision(plan, items, task.spec.output.fps);
  };
  // Provenance quotes may contain unrelated obligations already checked elsewhere.
  // Only the extracted requirement is in scope for this compilation.
  const compilerSources = sources.map(({ quote, ...source }) => source);
  const context = {
    sources: compilerSources,
    technical: brief?.intent.technical ?? [],
    outputFps: task.spec.output.fps,
  };
  const inputHash = hash({
    sources,
    technical: context.technical,
    outputFps: context.outputFps,
    duration,
    version: ACCEPTANCE_VERSION,
  });
  const saved = store.artifact<FrozenAcceptance>(taskId, 'acceptance.plan')?.data;
  if (saved?.inputHash === inputHash) return saved;
  const key = `acceptance.compile.${inputHash}`;
  const checkpoint = store.artifact<{
    attempt: number;
    candidate?: AcceptancePlan;
    feedback?: CompilationFeedback;
    approved?: ApprovedSource[];
  }>(taskId, key)?.data;
  let candidate = checkpoint?.candidate,
    feedback = checkpoint?.feedback;
  let approved = checkpoint?.approved ?? [];
  // Protocol changes invalidate approval, not the useful candidate. Audit it in the new
  // frozen context before regenerating only the rejected sources. Never reuse old verdicts.
  if (!checkpoint && saved && saved.version !== ACCEPTANCE_VERSION && hash(saved.sources) === hash(sources)) {
    const parsed = hardAcceptancePlanSchema.safeParse(saved.plan);
    if (parsed.success) {
      try {
        validatePlan(parsed.data, sources, duration);
        candidate = parsed.data;
        store.event(taskId, 'acceptance.candidate_reused', {
          fromVersion: saved.version,
          version: ACCEPTANCE_VERSION,
        });
      } catch (error) {
        if (!(error instanceof FilmError)) throw error;
        store.event(taskId, 'acceptance.candidate_invalid', { fromVersion: saved.version, code: error.code });
      }
    }
  }
  const limit = store.task(taskId).spec.budgets.stageRounds;
  for (let attempt = checkpoint?.attempt ?? 0; limit === null || attempt < limit; attempt++) {
    signal?.throwIfAborted();
    const pendingSources = sources.filter((s) => !approved.some((a) => a.plan.sourceId === s.id));
    const pendingIds = new Set(pendingSources.map((s) => s.id));
    const pendingCompilerSources = compilerSources.filter((s) => pendingIds.has(s.id));
    if (!candidate) {
      const partial = await agent.run({
        role: 'acceptance',
        toolAccess: 'none',
        schema: hardAcceptancePlanSchema,
        instruction: '从冻结要求提取程序硬校验参数。' + contextInstruction,
        input: {
          sources: pendingCompilerSources,
          duration,
          context,
          feedback: feedback && {
            previous: {
              ...feedback.previous,
              sources: feedback.previous.sources.filter((s) => pendingIds.has(s.sourceId)),
            },
            review: { sources: feedback.review.sources.filter((s) => pendingIds.has(s.sourceId)) },
          },
        },
        validateOutput: (value) => {
          validatePlan(value, pendingSources, duration);
          validatePlan(
            { schemaVersion: 1, sources: [...approved.map((a) => a.plan), ...value.sources] },
            sources,
            duration,
          );
          return value;
        },
      });
      validatePlan(partial, pendingSources, duration);
      const checks = [...approved.map((a) => a.plan), ...partial.sources];
      candidate = { schemaVersion: 1, sources: sources.map((s) => checks.find((p) => p.sourceId === s.id)!) };
    }
    validatePlan(candidate, sources, duration);
    store.saveArtifact(taskId, key, { attempt, candidate, feedback, approved }, true);
    const partialReview = validateAcceptanceReview(
      await agent.run({
        role: 'acceptance_review',
        toolAccess: 'none',
        schema: acceptanceReviewSchema,
        instruction: '独立核对硬条件提取；保留所有语义要求供后续语义评审。' + contextInstruction,
        input: {
          sources: pendingCompilerSources,
          duration,
          context,
          plan: { ...candidate, sources: candidate.sources.filter((s) => pendingIds.has(s.sourceId)) },
        },
        validateOutput: (value) => validateAcceptanceReview(value, pendingSources),
      }),
      pendingSources,
    );
    const reviews = [...approved.map((a) => a.review), ...partialReview.sources];
    const review = validateAcceptanceReview(
      { sources: sources.map((s) => reviews.find((r) => r.sourceId === s.id)!) },
      sources,
    );
    store.saveArtifact(
      taskId,
      'acceptance.review',
      { inputHash, candidateHash: hash(candidate), review },
      true,
    );
    if (review.sources.every((s) => s.verdict === 'equivalent' && s.counterexamples.length === 0)) {
      const result = { version: ACCEPTANCE_VERSION, inputHash, sources, plan: candidate };
      reassessExistingWork(store, taskId);
      store.saveArtifact(taskId, 'acceptance.plan', result, true);
      store.event(taskId, 'acceptance.compiled', {
        inputHash,
        checks: candidate.sources.reduce((n, s) => n + s.checks.length, 0),
      });
      return result;
    }
    feedback = { previous: candidate, review };
    approved = candidate.sources.flatMap((plan) => {
      const audit = review.sources.find((r) => r.sourceId === plan.sourceId)!;
      return audit.verdict === 'equivalent' && audit.counterexamples.length === 0
        ? [{ plan, review: audit }]
        : [];
    });
    const rejected = candidate;
    candidate = undefined;
    store.saveArtifact(taskId, key, { attempt: attempt + 1, feedback, approved }, true);
    rejectRepeatedState(store, taskId, 'acceptance', inputHash, rejected, review);
  }
  throw new FilmError(
    'ACCEPTANCE_UNRESOLVED',
    '验收条件拆解尚未通过等价性审查；保留原始要求，不开始重剪。',
    feedback,
  );
}
