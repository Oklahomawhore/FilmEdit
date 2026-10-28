import path from 'node:path';
import {
  resolveComposition,
  resolveExport,
  validateComposition,
  type ExportProfileInput,
} from '../../core/src/presentation.js';
import { CreativeEngine, validateExactContent, validateTechnicalLayout } from './creativity.js';
import type { CreativeBrief } from '../../core/src/creative-domain.js';
import { compileAcceptance, type FrozenAcceptance } from './acceptance.js';
import { reviewAlignment, prepareAlignmentReview } from './semantic-review.js';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import {
  audienceSchema,
  editorialSchema,
  renderSchema,
  reviewSchema,
  scriptSchema,
  taskInputSchema,
  type AudienceIR,
  type EditorialIR,
  type RenderIR,
  type Script,
  type Stage,
  type TaskInput,
  type Review,
} from '../../core/src/domain.js';
import { Store } from '../../infrastructure/src/store.js';
import { rejectRepeatedState } from '../../infrastructure/src/loop-progress.js';
import { PathPolicy } from '../../infrastructure/src/security.js';
import { ProcessRunner } from '../../infrastructure/src/process.js';
import { AssetLibrary } from '../../media/src/assets.js';
import { AudioAnalyzer, timelineAudioEvidence, type AudioEvidence } from '../../media/src/audio-evidence.js';
import { PiAgentDriver, type AgentDriver, type AgentRequest } from '../../agent-runtime/src/agents.js';
import { PythonEmbeddingModel, type SimilarityModel } from '../../media/src/scoring.js';
import {
  blindEditorial,
  defaultRender,
  neutralizeEditorial,
  RENDERED_AUDIO_BINDING,
  transcriptForAudio,
  validateAudience,
  validateEditorial,
  validateRender,
} from '../../core/src/ir.js';
import { LocalTts } from '../../media/src/tts.js';
import { Renderer, RENDERER_VERSION } from '../../media/src/render.js';
import { inspectVideo, QUALITY_VERSION, type QualityReport } from '../../media/src/quality.js';
import { extractJpeg } from '../../media/src/media-frames.js';
import { FilmError, canonical, errorInfo, hash, id, invariant } from '../../core/src/util.js';
import { techniqueCatalog, validateEditingTechniques } from '../../core/src/techniques.js';
import { editorialDraftSchema, RecipeRegistry } from '../../infrastructure/src/recipes.js';
import { MaterialMatcher } from './materials.js';
import { repairCreativeImplementation } from './creative-revision.js';
import {
  requestScriptMaterialRepair,
  validateScriptMaterialRepair,
  type ScriptMaterialRepair,
} from './material-repair.js';
import {
  materialRevisionSchema,
  validateMatchedEdit,
  validateLocalSources,
  type MaterialManifest,
} from '../../core/src/materials.js';
import {
  editorialRevisionSchema,
  validateEditorialRequest,
  validateScopedEditorial,
  validateScopedLayout,
  type RevisionGuard,
} from '../../core/src/revision.js';
import {
  AUDIENCE_REVIEW_VERSION,
  VISUAL_ISSUE_PROTOCOL,
  reviewAudience,
  validateReviewCoverage,
} from './audience-review.js';
import { invalidateDerivedArtifacts } from './revision-context.js';
import {
  scriptInstruction,
  scriptReviewRoles,
  scriptReviewInstructions,
  reviewDecisionInstruction,
  scriptReviewInput,
  scriptRevisionContext,
  scriptReviewCacheKey,
  prepareScriptReview,
  type NamedReview,
} from './script-revision.js';

export async function createTask(
  store: Store,
  input: TaskInput,
  taskId = id('task'),
  purpose: 'production' | 'learning' = 'production',
) {
  const spec = taskInputSchema.parse(input);
  const policy = await PathPolicy.create(path.join(store.home, 'tasks', taskId), spec);
  const task = store.createTask(taskId, spec, policy.data, purpose);
  await policy.write(path.join(policy.data.workspace, 'task.json'), JSON.stringify(task, null, 2));
  return task;
}
const repairable = new Set([
  'IR_ASSET',
  'IR_TIME',
  'IR_SOURCE_RANGE',
  'IR_AUDIO',
  'IR_VISUAL',
  'IR_GAP',
  'IR_DURATION',
  'IR_TRANSITION',
  'IR_OVERLAP',
  'IR_BINDING',
  'IR_MISSING_BINDING',
  'IR_PARENT',
  'IR_CYCLE',
  'IR_CROP',
  'IR_KEYFRAME',
  'IR_SIZE',
  'IR_TEXT_STYLE',
  'STALE_EDITORIAL',
  'TECHNIQUE_UNSUPPORTED',
  'TECHNIQUE_UNREALIZED',
  'NARRATION_TOO_LONG',
  'LAYOUT_OVERFLOW',
  'IR_COMPOSITION',
  'CREATIVE_EXACT',
  'MATERIAL_MATCH',
  'REVISION_SCOPE',
  'SCRIPT_REPAIR_SCOPE',
]);
export class TaskRunner {
  readonly policy: PathPolicy;
  readonly processes: ProcessRunner;
  readonly library: AssetLibrary;
  readonly agent: AgentDriver;
  private stage: Stage = 'script';
  readonly signal: AbortSignal;
  private readonly cancellation = new AbortController();
  constructor(
    readonly store: Store,
    readonly taskId: string,
    signal?: AbortSignal,
    dependencies: { agent?: AgentDriver; model?: SimilarityModel } = {},
  ) {
    this.signal = signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal;
    this.policy = new PathPolicy(store.productionTask(taskId).policy);
    this.processes = new ProcessRunner(this.policy, this.signal);
    this.library = new AssetLibrary(store, taskId, this.policy, this.processes);
    this.agent = dependencies.agent ?? new PiAgentDriver(store, taskId, this.library, this.processes);
    this.model = dependencies.model ?? new PythonEmbeddingModel(this.processes);
  }
  private model: SimilarityModel;
  private brief?: CreativeBrief;
  private acceptance?: FrozenAcceptance;
  private exportProfile(): ExportProfileInput {
    const { duration, ...profile } = this.store.task(this.taskId).spec.output;
    return profile;
  }
  private async alignment(
    audience: AudienceIR,
    stage: 'editorial' | 'render',
    editorial: EditorialIR,
    render?: RenderIR,
    renderedFps?: number,
  ) {
    invariant(this.acceptance, 'ACCEPTANCE_REQUIRED', 'Compile requirements before assessing a cut');
    return reviewAlignment(this.store, this.taskId, this.agent, this.acceptance, audience, {
      editorial,
      render,
      renderedFps,
      stage,
      technical: this.brief?.intent.technical,
    });
  }
  async run() {
    const owner = id('worker');
    invariant(
      this.store.acquireLease(`task:${this.taskId}`, owner),
      'TASK_BUSY',
      'This task is already running',
    );
    const heartbeat = setInterval(() => this.store.acquireLease(`task:${this.taskId}`, owner), 30000);
    heartbeat.unref();
    const cancellations = setInterval(() => {
      const task = this.store.task(this.taskId);
      if (task.status === 'cancelled' || task.policy.version !== this.policy.data.version)
        this.cancellation.abort();
    }, 1000);
    cancellations.unref();
    try {
      const task = this.store.task(this.taskId);
      if (task.status === 'completed') return task;
      this.stage = task.stage;
      this.store.updateTask(this.taskId, 'running', this.stage);
      // Eager directory import would turn inventory errors into a prerequisite for creative work.
      if (!this.store.artifact(this.taskId, 'memory')) {
        const accountId = task.spec.accountId ?? null;
        const matches = this.store.memories(accountId, task.spec.prompt);
        // Explicit settings must not compete with the global knowledge corpus for retrieval slots.
        // Recent feedback and Persona candidates have separate bounded context windows; the full store remains searchable.
        const defaults = [
          ...(accountId
            ? this.store.memories(accountId, '', null, {
                includeGlobal: false,
                kinds: ['setting'],
                provenance: 'user',
              })
            : []),
          ...(accountId
            ? this.store.memories(accountId, '', 20, {
                includeGlobal: false,
                kinds: ['feedback'],
                provenance: 'user',
              })
            : []),
          ...this.store.memories(accountId, '', 8, { kinds: ['persona'] }),
        ];
        this.save('memory', [...new Map([...defaults, ...matches].map((m) => [m.id, m])).values()], true);
      }
      if (task.spec.creative.enabled) {
        this.stage = 'creative';
        this.brief = await new CreativeEngine(
          this.store,
          this.taskId,
          this.agent,
          this.library,
          this.model,
          this.signal,
        ).run();
        await this.flushArtifacts();
      }
      // Recovered Agent contexts can already contain source evidence. Validate previously
      // indexed sources before reusing them; a read grant alone never triggers media import.
      this.stage = 'script';
      this.store.updateTask(this.taskId, 'running', this.stage);
      for (const asset of this.store.assets(this.taskId)) await this.library.resolve(asset.id);
      this.acceptance = await compileAcceptance(this.store, this.taskId, this.agent, this.brief, this.signal);
      prepareAlignmentReview(this.store, this.taskId);
      let script = await this.script();
      const priorRenders = Number(
        this.store.db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type='render.attempt' AND seq>?")
          .get(this.taskId, this.store.stageEventFloor(this.taskId, 'render'))!.n,
      );
      for (
        let round = priorRenders;
        task.spec.budgets.renderRounds === null || round < task.spec.budgets.renderRounds;
        round++
      ) {
        this.signal?.throwIfAborted();
        let editorial: EditorialIR;
        while (true) {
          this.signal?.throwIfAborted();
          // Restore the verified manifest even when an edit already exists. A policy change
          // rechecks source evidence; only a failed recheck invalidates downstream work.
          this.stage = 'materials';
          let materials: MaterialManifest;
          try {
            materials = await new MaterialMatcher(this.store, this.taskId, this.library, this.agent).run(
              script,
              this.brief,
            );
          } catch (error) {
            if (!(error instanceof FilmError) || error.code !== 'MATERIALS_MISSING') throw error;
            if (
              !(await requestScriptMaterialRepair(this.store, this.taskId, this.agent, script, this.brief))
            ) {
              if (!this.brief) throw error;
              this.stage = 'creative';
              this.store.updateTask(this.taskId, 'running', this.stage);
              const revised = await repairCreativeImplementation(
                this.store,
                this.taskId,
                this.agent,
                script,
                this.brief,
                this.signal,
              );
              if (!revised) {
                this.stage = 'materials';
                throw error;
              }
              this.brief = revised;
              this.acceptance = await compileAcceptance(
                this.store,
                this.taskId,
                this.agent,
                this.brief,
                this.signal,
              );
            }
            script = await this.script();
            continue;
          }
          await this.flushArtifacts();
          try {
            editorial = await this.edit(script, materials);
            break;
          } catch (error) {
            if (!(error instanceof FilmError) || error.code !== 'MATERIAL_REPAIR') throw error;
            rejectRepeatedState(
              this.store,
              this.taskId,
              'workflow',
              'editorial.materials',
              materials,
              error.details,
            );
            invalidateDerivedArtifacts(this.store, this.taskId, [
              'materials',
              'editorial',
              'composition',
              'layout',
              'render',
            ]);
            this.save('materials.feedback', error.details);
            this.store.event(this.taskId, 'materials.repair_requested', error.details);
          }
        }
        let layout: RenderIR;
        try {
          layout = await this.layout(editorial);
        } catch (error) {
          if (!(error instanceof FilmError) || error.code !== 'NARRATIVE_REPAIR') throw error;
          this.save('editorial.feedback', error.details);
          rejectRepeatedState(
            this.store,
            this.taskId,
            'workflow',
            'layout.editorial',
            { ...editorial, revision: 0 },
            error.details,
          );
          this.store.invalidate(this.taskId, [
            'editorial',
            'editorial.audience',
            'editorial.alignment',
            'layout',
            'layout.audience',
            'layout.alignment',
            'render',
          ]);
          continue;
        }
        this.stage = 'render';
        this.store.updateTask(this.taskId, 'running', this.stage);
        this.store.event(this.taskId, 'render.attempt', { round });
        const result = await new Renderer(this.library, this.processes).render(
          editorial,
          layout,
          false,
          this.exportProfile(),
        );
        this.save('render.candidate_media', result);
        const quality = await inspectVideo(
          result.path,
          editorial,
          layout,
          this.processes,
          false,
          result.exportProfile,
        );
        this.save('quality', quality, quality.passed);
        const review = await this.visualReview(editorial, quality, 'final', layout);
        const alignment = await this.alignment(review, 'render', editorial, layout, quality.source.fps);
        this.save('final.alignment', alignment, alignment.passed);
        if (quality.passed && alignment.passed && !review.issues.some((i) => i.severity === 'blocking')) {
          this.save('render', result, true);
          this.save(
            'manifest',
            {
              ...result,
              assets: this.store.assets(this.taskId),
              releaseId: task.releaseId,
              policyVersion: this.policy.data.version,
              scorerVersion: alignment.scorerVersion,
              acceptancePlanHash: alignment.planHash,
              creativeBriefHash: this.brief ? hash(this.brief) : null,
              composition: layout.canvas,
            },
            true,
          );
          this.store.updateTask(this.taskId, 'completed', 'complete');
          if (task.spec.accountId)
            this.store.addMemory(task.spec.accountId, {
              kind: 'history',
              content: canonical({
                taskId: task.id,
                prompt: task.spec.prompt,
                script: script.title,
                video: result.path,
              }),
              tags: [script.topic],
              provenance: 'system',
              source: task.id,
              confidence: 1,
            });
          return this.store.task(this.taskId);
        }
        const narrative = review.issues.some((i) => i.kind === 'narrative' && i.severity === 'blocking');
        this.save(narrative ? 'editorial.feedback' : 'layout.feedback', { quality, review, alignment });
        const cut = { ...editorial, revision: 0 };
        rejectRepeatedState(
          this.store,
          this.taskId,
          'workflow',
          'render',
          { editorial: cut, layout: { ...layout, editorialHash: hash(cut) } },
          {
            quality: {
              passed: quality.passed,
              issues: quality.issues,
              audioAnalysis: quality.audioAnalysis,
              visualAnalysis: quality.visualAnalysis,
            },
            review,
            alignment,
          },
        );
        this.store.invalidate(
          this.taskId,
          narrative
            ? [
                'editorial',
                'editorial.audience',
                'editorial.alignment',
                'layout',
                'layout.audience',
                'layout.alignment',
                'render',
              ]
            : ['layout', 'layout.audience', 'layout.alignment', 'render'],
        );
      }
      throw new FilmError(
        'REPAIR_EXHAUSTED',
        'Full render repair budget exhausted; checkpoints and review evidence are saved',
      );
    } catch (error) {
      const info = errorInfo(error);
      const status =
        this.signal?.aborted || info.code === 'CANCELLED'
          ? 'cancelled'
          : error instanceof FilmError || error instanceof z.ZodError
            ? 'blocked'
            : 'failed';
      this.store.updateTask(this.taskId, status, this.stage, info);
      throw error;
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancellations);
      this.store.releaseLease(`task:${this.taskId}`, owner);
    }
  }
  private save(stage: string, data: unknown, accepted = false) {
    const artifact = this.store.saveArtifact(this.taskId, stage, data, accepted);
    // SQLite is the checkpoint authority. Export is performed by flushArtifacts below.
    this.store.event(this.taskId, 'artifact', {
      stage,
      revision: artifact.revision,
      hash: artifact.hash,
      accepted,
    });
    return artifact;
  }
  async flushArtifacts() {
    const rows = this.store.db
      .prepare('SELECT stage,revision,data FROM artifacts WHERE task_id=? ORDER BY stage,revision')
      .all(this.taskId);
    for (const row of rows)
      await this.policy.write(
        path.join(this.policy.data.workspace, 'artifacts', `${row.stage}.${row.revision}.json`),
        `${row.data}\n`,
      );
  }
  private async loop<T>(
    stage: 'script' | 'editorial' | 'layout',
    generate: (feedback: unknown, round: number) => Promise<T>,
    assess: (value: T) => Promise<{ passed: boolean; feedback: unknown }>,
  ): Promise<T> {
    const accepted = this.store.artifact<T>(this.taskId, stage);
    if (accepted) return accepted.data;
    this.stage = stage;
    this.store.updateTask(this.taskId, 'running', stage);
    const budget = this.store.task(this.taskId).spec.budgets.stageRounds;
    let feedback: unknown = this.store.artifact(this.taskId, `${stage}.feedback`, false)?.data;
    const prior = this.store.artifact(this.taskId, `${stage}.candidate`, false);
    const pending = this.store.artifact<{ candidateHash: string }>(
      this.taskId,
      `${stage}.pending_assessment`,
    );
    let resumeAssessment = prior && pending?.data.candidateHash === prior.hash ? prior : undefined;
    const used = Number(
      (
        this.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type='stage.attempt' AND json_extract(data,'$.stage')=? AND seq>?",
          )
          .get(this.taskId, stage, this.store.stageEventFloor(this.taskId, stage)) as { n: number }
      ).n,
    );
    for (let round = used; budget === null || round < budget; round++) {
      this.signal?.throwIfAborted();
      let candidate: T | undefined;
      this.store.event(this.taskId, 'stage.attempt', { stage, round });
      try {
        if (resumeAssessment) {
          candidate = resumeAssessment.data as T;
          this.store.event(this.taskId, 'stage.review_resumed', {
            stage,
            candidateHash: resumeAssessment.hash,
          });
          resumeAssessment = undefined;
        } else {
          candidate = await generate(feedback, round);
          this.save(`${stage}.candidate`, candidate);
          this.save(`${stage}.pending_assessment`, { candidateHash: hash(candidate) }, true);
        }
        const result = await assess(candidate);
        if (result.passed) {
          this.save(stage, candidate, true);
          this.store.invalidate(this.taskId, [`${stage}.pending_assessment`]);
          await this.flushArtifacts();
          return candidate;
        }
        feedback = result.feedback;
      } catch (error) {
        if (!(error instanceof z.ZodError) && !(error instanceof FilmError && repairable.has(error.code)))
          throw error;
        feedback = errorInfo(error);
      }
      this.save(`${stage}.feedback`, feedback);
      this.store.invalidate(this.taskId, [`${stage}.pending_assessment`]);
      if (candidate !== undefined)
        rejectRepeatedState(this.store, this.taskId, stage, stage, candidate, feedback);
    }
    await this.flushArtifacts();
    throw new FilmError('STAGE_EXHAUSTED', `${stage} failed after ${budget} revisions`, feedback);
  }
  private async script(): Promise<Script> {
    const task = this.store.task(this.taskId);
    prepareScriptReview(this.store, this.taskId);
    return this.loop(
      'script',
      async (feedback) =>
        this.agent.run({
          role: 'script',
          schema: scriptSchema,
          instruction:
            scriptInstruction +
            (this.brief
              ? '\n以 creativeBrief 为冻结创作方案，严格保留用户 fixed/exact/forbid 条件；不要把用户留白误当作必须复述的主题。兑现已选择的主题、内容、表达和视听连接，不能弱化 commitments 来通过审查。'
              : ''),
          input: {
            prompt: task.spec.prompt,
            creativeBrief: this.brief,
            output: task.spec.output,
            memory: this.store.artifact(this.taskId, 'memory')?.data,
            strategy: task.spec.materials.strategy,
            userRevision: this.store.artifact(this.taskId, 'script.user_revision')?.data,
            ...scriptRevisionContext(this.store, this.taskId, feedback),
            materialRepair: this.store.artifact(this.taskId, 'script.material_repair')?.data,
          },
          validateOutput: (value) => {
            validateExactContent(this.brief, value);
            const repair = this.store.artifact<ScriptMaterialRepair>(
              this.taskId,
              'script.material_repair',
            )?.data;
            return repair ? validateScriptMaterialRepair(value, repair) : value;
          },
        }),
      async (script) => {
        validateExactContent(this.brief, script);
        const repair = this.store.artifact<ScriptMaterialRepair>(this.taskId, 'script.material_repair')?.data;
        if (repair) validateScriptMaterialRepair(script, repair);
        const reviews: NamedReview[] = [];
        for (const role of scriptReviewRoles) {
          this.signal.throwIfAborted();
          const baseInput = scriptReviewInput(
            role,
            script,
            task.spec.prompt,
            task.spec.output,
            this.store.artifact(this.taskId, 'memory')?.data,
          );
          const input =
            this.brief && role !== 'audience_review'
              ? { ...baseInput, creativeBrief: this.brief }
              : baseInput;
          const cacheKey = scriptReviewCacheKey(
            role,
            input,
            this.policy.data.version,
            this.store.assets(this.taskId).map((a) => ({ id: a.id, sha256: a.sha256 })),
          );
          const cached = this.store.artifact<Review>(this.taskId, cacheKey);
          const review =
            cached?.data ??
            (await this.agent.run({
              role,
              ...(role === 'audience_review' ? { toolAccess: 'none' as const } : {}),
              instruction:
                scriptReviewInstructions[role] +
                '\n' +
                reviewDecisionInstruction +
                (this.brief && role !== 'audience_review'
                  ? '\n同时核对 CreativeBrief：用户 fixed 条件必须保留，留白不强制追随原提示词措辞。脚本需要表达选定概念及 commitments。区分事实来源与画面素材：事实断言仍需核查，但 visualQuery 是后续素材补充的需求，素材未到位不能作为脚本退稿理由；最终画面由剪辑和渲染评审核验。源镜头要求与制作操作应分别明确，不能把后期不新增字幕、图形的条件扩大为源画面不得有文字或水印；反之也不能弱化明确要求的无水印素材。改变既有条件的作用范围属于 blocking，并引用发生偏差的 beat 和对应原条件。'
                  : ''),
              schema: reviewSchema,
              input,
            }));
          if (!cached)
            this.save(
              cacheKey,
              review,
              review.passed && !review.issues.some((i) => i.severity === 'blocking'),
            );
          else this.store.event(this.taskId, 'script.review_reused', { role, scriptHash: hash(script) });
          reviews.push({ role, review });
          this.save('script.review.progress', { scriptHash: hash(script), reviews });
        }
        // Keep the existing artifact shape for readers; feedback additionally records role + draft hash.
        this.save(
          'script.reviews',
          reviews.map((r) => r.review),
        );
        const feedback = {
          scriptHash: hash(script),
          reviews,
          blocking: reviews.flatMap(({ role, review }) =>
            review.issues.filter((i) => i.severity === 'blocking').map((i) => ({ role, ...i })),
          ),
        };
        if (
          reviews.some(({ review }) => !review.passed || review.issues.some((i) => i.severity === 'blocking'))
        )
          return { passed: false, feedback };
        if (script.narration.trim()) {
          const audio = await new LocalTts(this.library).synthesize(script.narration);
          invariant(
            audio.duration <= task.spec.output.duration,
            'NARRATION_TOO_LONG',
            `Narration is ${audio.duration.toFixed(1)} seconds; target is ${task.spec.output.duration}. Shorten the narration.`,
          );
          this.save(
            'narration',
            { assetId: audio.id, duration: audio.duration, scriptHash: hash(script) },
            true,
          );
        } else this.store.invalidate(this.taskId, ['narration']);
        return { passed: true, feedback };
      },
    );
  }
  private async edit(script: Script, materials?: MaterialManifest): Promise<EditorialIR> {
    const task = this.store.task(this.taskId);
    invariant(materials, 'MATERIAL_MATCH', 'Editing requires an accepted material manifest');
    const validateCut = (input: unknown) => {
      const ir = validateEditorial(input, this.store.assets(this.taskId));
      validateEditingTechniques(ir, this.store.assets(this.taskId), task.spec.output.fps);
      const guard = this.store.artifact<RevisionGuard>(this.taskId, 'revision.guard')?.data;
      if (guard) validateScopedEditorial(ir, guard, this.store.assets(this.taskId));
      validateMatchedEdit(
        ir,
        materials,
        this.store.artifact<{ assetId: string }>(this.taskId, 'narration')?.data.assetId,
      );
      validateExactContent(this.brief, script, ir);
      if (
        task.spec.materials.strategy === 'local_only' ||
        this.brief?.intent.technical?.some((c) => c.kind === 'local_materials')
      ) {
        validateLocalSources(
          ir,
          this.store.assets(this.taskId),
          this.store.artifact<{ assetId: string }>(this.taskId, 'narration')?.data.assetId,
        );
      }
      const exactNarration = this.brief?.intent.constraints.some(
        (c) =>
          c.strength === 'fixed' &&
          c.dimension === 'content' &&
          c.field === 'narration' &&
          c.match === 'exact' &&
          c.polarity === 'require',
      );
      const narrationOnly = this.brief?.intent.technical?.some((c) => c.kind === 'narration_only');
      if ((exactNarration || narrationOnly) && script.narration) {
        const narration = this.store.artifact<{ assetId: string; duration: number; scriptHash: string }>(
          this.taskId,
          'narration',
        )?.data;
        const clips = ir.audio.filter((a) => a.role === 'narration');
        invariant(
          narration?.scriptHash === hash(script) &&
            clips.length === 1 &&
            clips[0]!.assetId === narration.assetId &&
            clips[0]!.sourceStart === 0 &&
            clips[0]!.speed === 1 &&
            Math.abs(clips[0]!.duration - narration.duration) < 0.05,
          'CREATIVE_EXACT',
          'Exact narration must use the full, unchanged approved speech asset',
        );
      }
      invariant(
        Math.abs(ir.duration - task.spec.output.duration) <= 1 / task.spec.output.fps,
        'IR_DURATION',
        'EditorialIR must match requested duration',
      );
      return ir;
    };
    return validateCut(
      await this.loop(
        'editorial',
        async (feedback, round) => {
          const manual =
            round === 0 ? this.store.artifact(this.taskId, 'editorial.proposed', false)?.data : undefined;
          const result =
            manual ??
            (await this.agent.run({
              role: 'editor',
              schema: z.union([editorialDraftSchema, materialRevisionSchema]),
              validateOutput: (draft) => {
                if ('kind' in draft) {
                  invariant(
                    draft.needIds.every((needId) =>
                      materials.requirements.some((need) => need.id === needId),
                    ),
                    'MATERIAL_MATCH',
                    'Material revision must reference known requirement IDs',
                  );
                } else {
                  const expanded =
                    'technique' in draft
                      ? new RecipeRegistry(this.store, task.releaseId).expand(this.taskId, draft)
                      : undefined;
                  validateCut(expanded?.editorial ?? draft);
                }
                return draft;
              },
              instruction:
                '根据已通过的素材匹配表 materialManifest 组织剪辑，仅使用已核验的片段，不能新增素材或弱化创意。产物只包含可执行镜头、声音与可见文字，不包含创作意图。track=0 覆盖完整时间线；分屏、画中画和抠像前景等同时出现的画面使用独立 track（1、2…），同轨交叠必须对应转场。将已有旁白作为 narration 音轨使用，时长以实际音频为准。当前固定原文旁白的校验要求使用 narration.assetId 的一个完整片段，sourceStart=0、speed=1、duration=narration.duration，不可自行裁词；用画面节奏回应实际旁白。结合动作、节奏、声音与前后镜头关系应用具体剪辑手法；不能只罗列手法名称。',
              input: {
                prompt: task.spec.prompt,
                creativeBrief: this.brief,
                script,
                materialManifest: materials,
                revisionScope: this.store.artifact(this.taskId, 'revision.guard')?.data,
                previousEditorial:
                  this.store.artifact(this.taskId, 'editorial.candidate', false)?.data ??
                  this.store.artifact<any>(this.taskId, 'editorial.user_revision')?.data.previousArtifact,
                userRevision: this.store.artifact(this.taskId, 'editorial.user_revision')?.data,
                narration: this.store.artifact(this.taskId, 'narration')?.data,
                memory: this.store.artifact(this.taskId, 'memory')?.data,
                output: task.spec.output,
                strategy: task.spec.materials.strategy,
                techniques: techniqueCatalog.filter((t) => t.layer === 'editorial'),
                feedback,
              },
            }));
          const draft = z.union([editorialDraftSchema, materialRevisionSchema]).parse(result);
          if ('kind' in draft) {
            invariant(
              draft.needIds.every((needId) => materials.requirements.some((need) => need.id === needId)),
              'MATERIAL_MATCH',
              'Material revision must reference known requirement IDs',
            );
            throw new FilmError('MATERIAL_REPAIR', 'Verified materials do not support the intended edit', {
              request: draft,
              previousManifest: materials,
              reviewFeedback: feedback,
            });
          }
          const expanded =
            'technique' in draft
              ? new RecipeRegistry(this.store, task.releaseId).expand(this.taskId, draft)
              : undefined;
          const ir = validateCut(expanded?.editorial ?? draft);
          if (expanded) this.save('editorial.recipe', { invocation: result, render: expanded.render }, true);
          return ir;
        },
        async (editorial) => {
          const audience = await this.editorialReview(editorial);
          const alignment = await this.alignment(audience, 'editorial', editorial);
          this.save('editorial.audience', audience, alignment.passed);
          this.save('editorial.alignment', alignment, alignment.passed);
          return { passed: alignment.passed, feedback: { audience, alignment } };
        },
      ),
    );
  }
  private async editorialReview(editorial: EditorialIR): Promise<AudienceIR> {
    const { cut, restore } = neutralizeEditorial(editorial);
    const audioEvidence = [];
    for (const audio of cut.audio.filter((clip) => clip.volume > 0)) {
      const asset = this.store.asset(this.taskId, audio.assetId);
      const evidence = await new AudioAnalyzer(this.library).analyze(
        audio.assetId,
        audio.sourceStart,
        Math.min(asset.duration, audio.sourceStart + audio.duration * audio.speed),
      );
      audioEvidence.push(timelineAudioEvidence(audio, evidence));
    }
    const key = `observer.${hash({ editorial, audioEvidence, version: AUDIENCE_REVIEW_VERSION })}`;
    const cached = this.store.artifact<AudienceIR>(this.taskId, key);
    if (cached) {
      const valid = validateAudience(cached.data, editorial);
      try {
        validateReviewCoverage(valid, editorial);
        return valid;
      } catch (error) {
        if (!(error instanceof FilmError && error.code.startsWith('EVIDENCE_'))) throw error;
      }
    }
    const images: { path: string; label: string }[] = [];
    for (const shot of cut.shots) {
      const asset = this.store.asset(this.taskId, shot.assetId);
      const frames = await this.library.frames(
        asset.id,
        asset.kind === 'image' || shot.techniques.some((t) => t.id === 'freeze')
          ? [asset.kind === 'image' ? 0 : shot.sourceStart]
          : [
              shot.sourceStart,
              Math.min(asset.duration - 0.01, shot.sourceStart + (shot.duration * shot.speed) / 2),
            ],
      );
      for (const f of frames)
        images.push({
          path: f.path,
          label: `素材 ${asset.id} 源时间 ${f.time} 秒；镜头 ${shot.id} 从时间线 ${shot.start} 秒开始。`,
        });
    }
    const audience = validateAudience(
      restore(
        validateAudience(
          await reviewAudience({
            store: this.store,
            taskId: this.taskId,
            agent: this.agent,
            signal: this.signal,
            key: `${key}.review`,
            validateEvaluation: async (report) => {
              validateReviewCoverage(report, cut);
            },
            request: {
              role: 'editorial_audience',
              schema: audienceSchema,
              editorial: cut,
              images: evenlySample(images, 32),
              instruction:
                '你是首次观看这段作品的观众。只根据镜头安排、实际帧、声音分析与可见文字，回答看到了什么、事件顺序、因果关系和情绪如何变化。audioEvidence 是已选源片段的本地声音类别预测、音量与 ASR，已转换为成片时间；它不是最终混音，也不是亲耳听过的音乐质感。contentStatus=insufficient_duration 的窗口仅有音量测量，不能推断声音类别或其不存在。类别分数不是正确率；similarities 是固定描述库的 CLAP 余弦相似度，不是置信度，词表不含用户目标。低分、具体风格和无法确认的声音要写不确定。不要猜创作者目标。证据引用执行时间线的 bindingId 和时间；视觉、音频、文字分别引用，旁白不能证明画面出现了对应东西。需要更多帧时调用 frame；声音时间不明确时用 cut_audio 对指定音轨与时间段细查。',
              input: { ...blindEditorial(cut, this.store.assets(this.taskId)), audioEvidence },
            },
          }),
          cut,
        ),
      ),
      editorial,
    );
    this.save(key, audience, true);
    return audience;
  }
  private async layout(editorial: EditorialIR): Promise<RenderIR> {
    const task = this.store.task(this.taskId);
    const compositionKey = `composition.${hash({ editorial, policy: task.spec.composition })}`;
    let canvas = this.store.artifact<RenderIR['canvas']>(task.id, compositionKey)?.data;
    if (!canvas) {
      const visualAssets = editorial.shots.map((s) => ({
        ...this.store.asset(task.id, s.assetId),
        duration: s.duration,
      }));
      canvas = resolveComposition(task.spec.composition, visualAssets);
      this.save(compositionKey, canvas, true);
      this.save(
        'composition',
        { canvas, editorialHash: hash(editorial), policy: task.spec.composition },
        true,
      );
    }
    const compositionCanvas = canvas;
    return this.loop(
      'layout',
      async (feedback, round) => {
        const manual =
          round === 0 ? this.store.artifact(this.taskId, 'layout.proposed', false)?.data : undefined;
        const ir =
          manual ??
          (await this.agent.run({
            role: 'layout',
            schema: z.union([renderSchema, editorialRevisionSchema]),
            validateOutput: (value) => {
              if ('kind' in value) return validateEditorialRequest(value, editorial);
              const valid = validateRender(value, editorial);
              const guard = this.store.artifact<RevisionGuard>(this.taskId, 'revision.guard')?.data;
              if (guard) validateScopedLayout(valid, editorial, guard);
              if (this.brief) validateTechnicalLayout(this.brief.intent, valid);
              return validateComposition(valid, compositionCanvas, task.spec.composition);
            },
            instruction:
              '把已批准的剪辑转换成固定画布的 RenderIR。不能改镜头、素材、声音、文字内容或时间。使用 rect 或 anchor、group、mask、keyframes；所有坐标为父容器归一化坐标。文字使用显式 style，避免溢出和平台安全区。animationTimebase=binding 时 media/text 的关键帧时间从各自 binding.start 开始，group 从全片开始。严格保持 template.canvas。composition.mediaFit=contain 时媒体必须 contain，不得 crop，也不得放大或出界造成裁切。输出画幅由独立导出层处理。若问题涉及镜头内容、速度、时长、声音或叙事，仅改布局无法修复，返回 editorial_request：引用当前 editorialHash、具体 bindingIds 和原因，由剪辑阶段修改并重新独立评审。不能通过隐藏图层、伪造内容或反复提交相同布局回避问题。正常情况返回 RenderIR。',
            input: {
              editorial,
              editorialHash: hash(editorial),
              learnedTemplate: this.store.artifact(this.taskId, 'editorial.recipe')?.data,
              template: defaultRender(editorial, compositionCanvas, task.spec.composition.mediaFit),
              composition: task.spec.composition,
              previousLayout: this.store.artifact<any>(this.taskId, 'layout.user_revision')?.data
                .previousArtifact,
              userRevision: this.store.artifact(this.taskId, 'layout.user_revision')?.data,
              revisionScope: this.store.artifact(this.taskId, 'revision.guard')?.data,
              creativeBrief: this.brief,
              techniques: techniqueCatalog.filter((t) => t.layer === 'presentation'),
              feedback,
            },
          }));
        const proposed = z.union([renderSchema, editorialRevisionSchema]).parse(ir);
        if ('kind' in proposed) {
          const request = validateEditorialRequest(proposed, editorial);
          this.save('layout.editorial_request', request);
          throw new FilmError('NARRATIVE_REPAIR', 'Layout requires an editorial revision', {
            request,
            reviewFeedback: feedback,
          });
        }
        const validated = validateRender(proposed, editorial);
        const guard = this.store.artifact<RevisionGuard>(this.taskId, 'revision.guard')?.data;
        if (guard) validateScopedLayout(validated, editorial, guard);
        if (this.brief) validateTechnicalLayout(this.brief.intent, validated);
        return validateComposition(validated, compositionCanvas, task.spec.composition);
      },
      async (render) => {
        const preview = await this.preview(editorial, render);
        const quality = await inspectVideo(
          preview.path,
          editorial,
          render,
          this.processes,
          true,
          preview.exportProfile,
        );
        const audience = await this.visualReview(editorial, quality, hash(render), render);
        const alignment = await this.alignment(audience, 'render', editorial, render, quality.source.fps);
        // validateRender preserves the approved edit. Observer descriptions (including source
        // watermarks, unreadable text and uncertain identities) are not new user requirements.
        const passed =
          quality.passed && alignment.passed && !audience.issues.some((i) => i.severity === 'blocking');
        this.save('layout.audience', audience, passed);
        this.save('layout.alignment', { alignment, editorialHash: hash(editorial) }, passed);
        if (audience.issues.some((i) => i.kind === 'narrative' && i.severity === 'blocking'))
          throw new FilmError('NARRATIVE_REPAIR', 'Rendered narrative needs editorial revision', {
            audience,
            alignment,
          });
        return { passed, feedback: { quality, audience, alignment } };
      },
    );
  }
  private async preview(editorial: EditorialIR, render: RenderIR) {
    const saved = this.store.artifact<Awaited<ReturnType<Renderer['render']>>>(
      this.taskId,
      'layout.preview',
      false,
    )?.data;
    const profile = resolveExport(this.exportProfile(), render.canvas);
    if (
      saved?.preview &&
      saved.rendererVersion === RENDERER_VERSION &&
      saved.releaseId === this.store.task(this.taskId).releaseId &&
      saved.editorialHash === hash(editorial) &&
      saved.renderHash === hash(render) &&
      saved.exportHash === hash(profile)
    ) {
      const asset = this.store
        .assets(this.taskId)
        .find((a) => a.source.kind === 'generated' && a.source.path === saved.path);
      if (asset) {
        // Registration fixes the expected file hash. Never silently reuse a changed file.
        await this.library.resolve(asset.id);
        this.store.event(this.taskId, 'layout.preview_reused', { assetId: asset.id, path: saved.path });
        return saved;
      }
    }
    const preview = await new Renderer(this.library, this.processes).render(
      editorial,
      render,
      true,
      this.exportProfile(),
    );
    await this.library.importFile(preview.path, 'generated');
    this.save('layout.preview', { ...preview, layoutHash: hash(render) });
    return preview;
  }
  private async visualReview(
    editorial: EditorialIR,
    quality: QualityReport,
    version: string,
    render: RenderIR,
  ): Promise<AudienceIR> {
    let renderedSound: AudioEvidence | undefined;
    if (quality.audioAnalysis) {
      const outputAsset = await this.library.importFile(quality.source.path, 'generated');
      renderedSound = await new AudioAnalyzer(this.library).analyze(outputAsset.id, 0, outputAsset.duration);
    }
    const hasRenderedAudio = Boolean(renderedSound);
    const cacheKey = `visual.${hash({ editorial, frames: quality.frames, version, visualAnalysis: quality.visualAnalysis, audioAnalysis: quality.audioAnalysis, renderedSound, checks: quality.issues, reviewerVersion: `${AUDIENCE_REVIEW_VERSION}:rendered-evidence-v6:${QUALITY_VERSION}` })}`;
    const cached = this.store.artifact<AudienceIR>(this.taskId, cacheKey);
    if (cached) {
      try {
        validateAudience(cached.data, editorial, hasRenderedAudio);
        validateReviewCoverage(cached.data, editorial, hasRenderedAudio);
        return cached.data;
      } catch (error) {
        if (!(error instanceof FilmError && error.code.startsWith('EVIDENCE_'))) throw error;
      }
    }
    const images = evenlySample(quality.frames, 32).map((f) => ({
      path: f.path,
      label: `成片时间 ${f.time} 秒`,
    }));
    // Continuous intervals are sampled densely so the vision model sees motion, not just shot midpoints.
    for (const clip of evenlySample(quality.continuousClips, 3)) {
      for (let offset = 0; offset < clip.duration; offset += 0.25) {
        const frame = `${clip.path}.${offset.toFixed(2)}.jpg`;
        await extractJpeg(this.processes, clip.path, frame, { time: offset });
        images.push({ path: frame, label: `连续片段时间 ${clip.start + offset} 秒` });
      }
    }
    const { cut, restore } = neutralizeEditorial(editorial);
    const renderedTranscript = renderedSound?.transcript ?? [];
    const audience = validateAudience(
      restore(
        validateAudience(
          await reviewAudience({
            store: this.store,
            taskId: this.taskId,
            agent: this.agent,
            signal: this.signal,
            key: `${cacheKey}.review`,
            validateEvaluation: async (report) => {
              validateReviewCoverage(report, cut, hasRenderedAudio);
            },
            request: {
              role: 'visual_audience',
              schema: audienceSchema,
              editorial: cut,
              renderedVideo: quality.source,
              renderedAudio: hasRenderedAudio,
              images,
              instruction:
                '独立回读实际渲染画面和连续帧。描述看到的事件、观点和情绪。检查文字裁切、遮挡、黑屏、闪烁、异常运动和声音对应关系。visualAnalysis 给出实测静止与黑屏区间，declaredFreeze 仅表示时间线显式定格，不能证明表达成立；静态图片或静止镜头也可能合理。对疑似卡住或遗漏运动的区间调用 rendered_frames 查看起止前后的连续帧，再给出有证据的问题，不能仅凭检测提示判作品不合格。可调用 rendered_frames 补看任意时间或切点前后的连续帧。音频依据 renderedTranscript（最终混音的实际 ASR）、audioAnalysis 与 renderedSound（最终混音各时间窗的本地声音类别预测）。若提供 renderedAudioBinding，以它引用整段真实混音，覆盖有声和静音区间；它不是新增音轨，也不能把混音中的声音归因于未经隔离的某个源音轨。contentStatus=insufficient_duration 的窗口仅有音量测量，不能推断声音类别或其不存在。类别分数不是正确率；similarities 是固定声音描述库的 CLAP 余弦相似度，不是置信度，冲突须保留。单个 Music 或 Vehicle 预测不证明具体曲风或车型；低分和无法确认的声音必须保留疑点。不得把源文件转录或源类别当作成片一定听得见的证据。ASR 可能错字，明确区分无法确认与实际缺失。可用 rendered_audio 对声音变化附近的较短区间复核，工具只读取实际成片。没有原生听音能力，不能声称已经听过音色或音乐质感。把问题区分为 layout、narrative、technical，标记 blocking 或 warning。不得依据素材原图替代实际成片证据。' +
                VISUAL_ISSUE_PROTOCOL,
              input: {
                duration: cut.duration,
                ...(hasRenderedAudio
                  ? { renderedAudioBinding: { id: RENDERED_AUDIO_BINDING, start: 0, end: cut.duration } }
                  : {}),
                bindings: [...cut.shots, ...cut.text, ...cut.audio].map((s) => ({
                  id: s.id,
                  start: s.start,
                  duration: s.duration,
                })),
                audio: cut.audio.map((a) => ({
                  id: a.id,
                  start: a.start,
                  duration: a.duration,
                })),
                renderedTranscript,
                renderedSound,
                audioAnalysis: quality.audioAnalysis,
                visualAnalysis: quality.visualAnalysis,
                checks: quality.issues,
              },
            },
          }),
          cut,
          hasRenderedAudio,
        ),
      ),
      editorial,
      hasRenderedAudio,
    );
    this.save(cacheKey, audience, true);
    return audience;
  }
}

/** Cover the whole timeline even when the evidence budget is smaller than the frame list. */
export function evenlySample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]!);
}
