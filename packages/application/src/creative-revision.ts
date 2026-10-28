import { z } from 'zod';
import type { AgentDriver } from '../../agent-runtime/src/agents.js';
import {
  conceptSchema,
  conceptReviewSchema,
  type ConceptIR,
  type CreativeBrief,
} from '../../core/src/creative-domain.js';
import { reviewSchema, type Script } from '../../core/src/domain.js';
import type { MaterialResult } from '../../core/src/materials.js';
import { FilmError, hash, invariant } from '../../core/src/util.js';
import type { Store } from '../../infrastructure/src/store.js';
import { CreativeStore } from '../../infrastructure/src/creative-store.js';
import { rejectRepeatedState } from '../../infrastructure/src/loop-progress.js';
import {
  blindConcept,
  checkConcept,
  conceptAudienceInstruction,
  creativeCapabilities,
  creativeMaterialRequirements,
} from './creativity.js';
import { SCRIPT_REVIEW_VERSION } from './script-revision.js';
import { invalidateDerivedArtifacts, readUserRevisions } from './revision-context.js';

const proposalSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('blocked'), reason: z.string().trim().min(1) }).strict(),
  z
    .object({
      action: z.literal('revise_implementation'),
      briefHash: z.string().regex(/^[a-f0-9]{64}$/),
      reason: z.string().trim().min(1),
      concept: conceptSchema,
    })
    .strict(),
]);

/** Rescheduling the same idea is not permission to sample a different story or aesthetic. */
export function validateImplementationRevision(next: ConceptIR, previous: ConceptIR) {
  const fixed = (concept: ConceptIR) => ({
    ...concept,
    proposal: {
      ...concept.proposal,
      content: { ...concept.proposal.content, synopsis: undefined },
      expression: { ...concept.proposal.expression, editing: undefined },
    },
    beats: concept.beats.map(({ id }) => ({ id })),
    commitments: concept.commitments.map(({ id, modality, stage }) => ({ id, modality, stage })),
    uncertainties: undefined,
  });
  invariant(
    hash(fixed(next)) === hash(fixed(previous)),
    'CREATIVE_REVISION_SCOPE',
    'Preserve concept identity, theme, narration, angle, persona, audience, tone, music, bridge, emotion, operators, knowledge and beat/commitment IDs. Only implementation descriptions may change.',
  );
  invariant(
    hash(next) !== hash(previous),
    'CREATIVE_REVISION_SCOPE',
    'An implementation repair must change the proposal',
  );
  return next;
}

/** Keep the approved work intact until the replacement has passed constraint and independent reviews. */
export async function repairCreativeImplementation(
  store: Store,
  taskId: string,
  agent: AgentDriver,
  script: Script,
  brief: CreativeBrief,
  signal?: AbortSignal,
): Promise<CreativeBrief | undefined> {
  if (store.artifact(taskId, 'revision.guard')) return;
  const material = store.artifact<MaterialResult>(taskId, 'materials.candidate', false)?.data;
  const needs = store.artifact<{ scriptHash: string }>(taskId, 'materials.requirements')?.data;
  if (
    material?.status !== 'missing' ||
    needs?.scriptHash !== hash(script) ||
    !material.matches.some((match) => match.frameTimes.length)
  )
    return;
  const task = store.task(taskId);
  const userRevisions = readUserRevisions(store, taskId);
  const input = {
    prompt: task.spec.prompt,
    userRevisions,
    brief,
    briefHash: hash(brief),
    script,
    materials: material,
    composition: task.spec.composition,
    output: task.spec.output,
    capabilities: creativeCapabilities,
  };
  const key = `creative.implementation.${hash(input)}`;
  const saved = store.artifact<{
    round: number;
    proposal?: z.infer<typeof proposalSchema>;
    feedback?: unknown;
  }>(taskId, key)?.data;
  let round = saved?.round ?? 0,
    pending = saved?.proposal,
    feedback = saved?.feedback;
  const validate = (value: z.infer<typeof proposalSchema>) => {
    const proposal = proposalSchema.parse(value);
    if (proposal.action === 'revise_implementation') {
      invariant(
        proposal.briefHash === hash(brief),
        'CREATIVE_REVISION_SCOPE',
        'Revision must reference the current creative brief',
      );
      validateImplementationRevision(proposal.concept, brief.concept);
    }
    return proposal;
  };
  while (task.spec.budgets.stageRounds === null || round < task.spec.budgets.stageRounds) {
    signal?.throwIfAborted();
    const proposal = validate(
      pending ??
        (await agent.run({
          role: 'creative',
          toolAccess: 'none',
          schema: proposalSchema,
          instruction:
            '这是同一作品的制作实现修订，不是重新采样创意。实际素材补充已报告缺口；仅在保留原主题、旁白、内容联系、角度、情绪与表达手法的前提下，修订由 Agent 自选的时长、倍速、机位或分段细节，让现有源片段有可执行的安排。原用户 fixed/exact/forbid 条件及 userRevisions 中的后续明确修改完全不变，用户明确指定的时长、倍速或构图也不能修改。保留 concept.id、所有 beat 与 commitment 的 ID、顺序、modality、stage，不删除任何表达义务；commitments 只能同步更新自选实现参数，不能改成更弱的可感知结果。不要通过改写 bridge/angle/emotion 来偷换创意，不增删旁白，不编造素材，不用循环重复充时长。synopsis、editing、beats 与 commitments 必须互相一致，按实际声音时长规划视听关系。材料报告只是源观察，新方案仍要重新匹配与检查。返回完整 concept、当前 briefHash 和具体修改原因；如果必须改变用户条件或核心创意才做得到，返回 blocked，保留原方案。不要引用旧评分或以通过率为目标。',
          input: { ...input, feedback },
          validateOutput: validate,
        })),
    );
    store.saveArtifact(taskId, key, { round, proposal, feedback }, true);
    if (proposal.action === 'blocked') {
      store.saveArtifact(taskId, 'creative.implementation_blocked', proposal);
      return;
    }
    const candidate = proposal.concept;
    const check = await checkConcept(
      candidate,
      brief.intent,
      agent,
      new Set(store.assets(taskId).map((asset) => asset.id)),
      new Set(brief.concept.knowledgeIds),
      task.spec.materials.strategy === 'local_only',
    );
    let review, audience;
    if (check.passed) {
      const reviewKey = `${key}.review.${hash(candidate)}`;
      review =
        store.artifact<z.infer<typeof reviewSchema>>(taskId, reviewKey)?.data ??
        (await agent.run({
          role: 'creative_revision_review',
          toolAccess: 'none',
          schema: reviewSchema,
          instruction:
            '独立检查同一创意的实现修订。逐项比较用户原话、后续 userRevisions、固定条件、原概念和新概念：用户要求、旁白、核心联系、情绪与可感知表达必须保留；只可调整 Agent 自选的制作时长、倍速、机位、分段。对每条 commitment 判断表达义务是否仍在，不能用删除视觉/声音特征、改成更弱陈述或解释性文字来绕过。参数变化可接受不等于实际成片已通过。根据已报告源区间检查基本时长和速度算术，不能把尚未下载或尚未独立匹配当成自动通过或拒绝理由。若变化触及用户已指定条件、偷换核心创意、弱化表达义务或仍明显不可执行，给 blocking 并引用具体字段；无 blocking 才 passed=true。不要修改评分器或提出新题材。',
          input: {
            prompt: task.spec.prompt,
            userRevisions,
            intent: brief.intent,
            previous: brief.concept,
            candidate,
            materialEvidence: material,
            output: task.spec.output,
          },
        }));
      store.saveArtifact(taskId, reviewKey, review, true);
      if (review.passed && !review.issues.some((issue) => issue.severity === 'blocking')) {
        const audienceKey = `${key}.audience.${hash(candidate)}`;
        audience =
          store.artifact<z.infer<typeof conceptReviewSchema>>(taskId, audienceKey)?.data ??
          (await agent.run({
            role: 'concept_audience',
            toolAccess: 'none',
            schema: conceptReviewSchema,
            instruction: conceptAudienceInstruction,
            input: {
              ...blindConcept(candidate),
              capabilities: creativeCapabilities,
              composition: task.spec.composition,
              output: task.spec.output,
            },
          }));
        store.saveArtifact(taskId, audienceKey, audience, true);
      }
    }
    if (
      check.passed &&
      review?.passed &&
      !review.issues.some((issue) => issue.severity === 'blocking') &&
      audience?.understandable &&
      audience.feasible &&
      !audience.issues.some((issue) => issue.severity === 'blocking')
    ) {
      const concept = { ...candidate, id: `concept_${hash({ ...candidate, id: undefined }).slice(0, 24)}` };
      const next = { ...brief, concept, selection: [] };
      store.transaction(() => {
        // Preserve intent, memory, sources and sampling history. New implementation needs new downstream approval.
        invalidateDerivedArtifacts(store, taskId, [
          'creative.brief',
          'creative.material_requirements',
          'script',
          'narration',
          'materials',
          'acceptance',
          'editorial',
          'composition',
          'layout',
          'render',
          'quality',
          'final',
          'manifest',
        ]);
        new CreativeStore(store).archive(taskId, concept);
        store.saveArtifact(
          taskId,
          'creative.implementation_revision',
          { previousBrief: brief, nextBrief: next, reason: proposal.reason, check, review, audience },
          true,
        );
        store.saveArtifact(taskId, 'creative.brief', next, true);
        store.saveArtifact(
          taskId,
          'creative.material_requirements',
          creativeMaterialRequirements(concept),
          true,
        );
        store.saveArtifact(taskId, 'script.candidate', script);
        store.saveArtifact(taskId, 'script.review_policy', { version: SCRIPT_REVIEW_VERSION }, true);
        store.saveArtifact(taskId, 'script.feedback', {
          kind: 'creative_implementation_revision',
          reason: proposal.reason,
          previousConcept: brief.concept,
          currentConcept: concept,
          materials: material,
        });
        store.event(taskId, 'creative.implementation_revised', {
          from: brief.concept.id,
          to: concept.id,
          reason: proposal.reason,
        });
      });
      return next;
    }
    feedback = { check, review, audience };
    rejectRepeatedState(store, taskId, 'workflow', key, candidate, feedback);
    pending = undefined;
    round++;
    store.saveArtifact(taskId, key, { round, feedback }, true);
  }
  throw new FilmError('STAGE_EXHAUSTED', '创意实现修订仍需处理评审问题；原方案与检查点已保存。', feedback);
}
