import { z } from 'zod';
import type { AgentDriver } from '../../agent-runtime/src/agents.js';
import type { CreativeBrief } from '../../core/src/creative-domain.js';
import type { Script } from '../../core/src/domain.js';
import type { MaterialResult, MaterialNeed } from '../../core/src/materials.js';
import { hash, invariant } from '../../core/src/util.js';
import type { Store } from '../../infrastructure/src/store.js';
import { rejectRepeatedState } from '../../infrastructure/src/loop-progress.js';
import { SCRIPT_REVIEW_VERSION } from './script-revision.js';
import { invalidateDerivedArtifacts, readUserRevisions } from './revision-context.js';

const decisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('blocked'), reason: z.string().trim().min(1) }).strict(),
  z
    .object({
      action: z.literal('revise_script'),
      scriptHash: z.string().regex(/^[a-f0-9]{64}$/),
      beatIds: z.array(z.string().min(1)).min(1),
      reason: z.string().trim().min(1),
      instructions: z.string().trim().min(1),
    })
    .strict(),
]);
type RepairDecision = Extract<z.infer<typeof decisionSchema>, { action: 'revise_script' }>;
export type ScriptMaterialRepair = { previousScript: Script; decision: RepairDecision };

/** Only declared implementation beats may change; fixed input and creative commitments stay frozen. */
export function validateScriptMaterialRepair(script: Script, repair: ScriptMaterialRepair) {
  const previous = repair.previousScript;
  invariant(hash(previous) === repair.decision.scriptHash, 'SCRIPT_REPAIR_SCOPE', 'Stale script repair');
  const project = (value: Script) => ({
    ...value,
    beats: value.beats.map((beat) => (repair.decision.beatIds.includes(beat.id) ? { id: beat.id } : beat)),
  });
  invariant(
    hash(project(script)) === hash(project(previous)),
    'SCRIPT_REPAIR_SCOPE',
    'Only the declared beat implementation may change. Preserve narration, facts, other beats and their order.',
  );
  invariant(
    hash(script) !== hash(previous),
    'SCRIPT_REPAIR_SCOPE',
    'The material repair must change the affected implementation.',
  );
  return script;
}

/** A source gap is not permission to relax the brief. Ask the writer to repair only its added detail. */
export async function requestScriptMaterialRepair(
  store: Store,
  taskId: string,
  agent: AgentDriver,
  script: Script,
  brief?: CreativeBrief,
): Promise<boolean> {
  // A time-scoped user revision may not trigger an unscoped rewrite.
  if (store.artifact(taskId, 'revision.guard')) return false;
  const result = store.artifact<MaterialResult>(taskId, 'materials.candidate', false)?.data;
  const needs = store.artifact<{ scriptHash: string; requirements: MaterialNeed[] }>(
    taskId,
    'materials.requirements',
  )?.data;
  if (result?.status !== 'missing' || needs?.scriptHash !== hash(script)) return false;
  // No source evidence (e.g. an empty library or corrupt file) cannot justify a supposed executable replacement.
  if (
    !result.matches.some(
      (match) =>
        match.frameTimes.length &&
        needs.requirements.some((need) => need.id === match.needId && need.kind === 'visual'),
    )
  )
    return false;
  const input = {
    prompt: store.task(taskId).spec.prompt,
    userRevisions: readUserRevisions(store, taskId),
    creativeBrief: brief,
    script,
    scriptHash: hash(script),
    requirements: needs.requirements,
    matches: result.matches,
    gaps: result.gaps,
  };
  const validate = (value: z.infer<typeof decisionSchema>) => {
    const decision = decisionSchema.parse(value);
    if (decision.action === 'revise_script') {
      invariant(
        decision.scriptHash === hash(script),
        'SCRIPT_REPAIR_SCOPE',
        'Repair must reference the current script',
      );
      invariant(
        new Set(decision.beatIds).size === decision.beatIds.length &&
          decision.beatIds.every((id) => script.beats.some((beat) => beat.id === id)),
        'SCRIPT_REPAIR_SCOPE',
        'Repair must identify existing, distinct beat IDs',
      );
      invariant(
        result.gaps.some((gap) =>
          needs.requirements.some(
            (need) => need.id === gap.needId && need.beatId && decision.beatIds.includes(need.beatId),
          ),
        ),
        'SCRIPT_REPAIR_SCOPE',
        'Repair must address a reported material gap',
      );
    }
    return decision;
  };
  const key = `materials.repair_decision.${hash(input)}`;
  const cached = store.artifact<z.infer<typeof decisionSchema>>(taskId, key)?.data;
  const decision = validate(
    cached ??
      (await agent.run({
        role: 'production_repair',
        toolAccess: 'none',
        schema: decisionSchema,
        instruction:
          '判断实际素材缺口能否仅通过修订脚本 Agent 自行追加的实现细节解决。用户原始要求、userRevisions 中的当前修改要求、冻结 creativeBrief 的内容/表达/commitments、旁白原文、事实、镜头顺序保持不变；不得修改验收标准。userRevisions 是此前修改的上下文，保留它们已实现的效果，不重复执行“删一镜”等操作。matches 是素材 Agent 的源片段观察，尚非独立验收通过；新方案仍须重新匹配和评审。可建议在已有源区间内改变脚本额外添加的机位、连续镜头长度或分段方式，不得用循环重复、纯字卡或虚构素材冒充缺失动作。如果需要改变用户要求或冻结创意，或者没有可执行替代，返回 blocked 并说明具体缺口；不要为了继续运行而降低要求。可行时返回 revise_script、当前 scriptHash、所有需修改的 beatIds 及具体 instructions：说明哪条细节由脚本追加、如何保留原表达，以及可检查的源片段。你只提出修订请求，不写脚本，不确认素材已匹配，也不改创意。',
        input,
        validateOutput: validate,
      })),
  );
  if (!cached) store.saveArtifact(taskId, key, decision, true);
  if (decision.action === 'blocked') return false;
  rejectRepeatedState(
    store,
    taskId,
    'workflow',
    'materials.script',
    script,
    result.gaps.map((gap) => gap.needId).sort(),
  );
  store.transaction(() => {
    invalidateDerivedArtifacts(store, taskId, [
      'script',
      'narration',
      'materials',
      'editorial',
      'composition',
      'layout',
      'render',
      'quality',
      'final',
      'manifest',
    ]);
    store.saveArtifact(taskId, 'script.candidate', script);
    store.saveArtifact(taskId, 'script.review_policy', { version: SCRIPT_REVIEW_VERSION }, true);
    store.saveArtifact(taskId, 'script.material_repair', { previousScript: script, decision }, true);
    // Search findings survive a scoped script repair as context, never as approval.
    // Keep their old requirements so an unchanged ID cannot imply an unchanged need.
    store.saveArtifact(
      taskId,
      'materials.prior_search',
      { scriptHash: hash(script), requirements: needs.requirements, result },
      true,
    );
    store.saveArtifact(taskId, 'script.feedback', {
      kind: 'material_repair',
      decision,
      gaps: result.gaps,
      matches: result.matches,
    });
    store.event(taskId, 'script.material_repair_requested', { scriptHash: hash(script), decision });
  });
  return true;
}
