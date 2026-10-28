import type { AgentDriver } from '../../agent-runtime/src/agents.js';
import type { CreativeBrief } from '../../core/src/creative-domain.js';
import type { Script } from '../../core/src/domain.js';
import {
  materialNeeds,
  materialResultSchema,
  validateMaterialResult,
  soundSources,
  soundPlanSchema,
  validateSoundPlan,
  type SoundPlan,
  type MaterialManifest,
  type MaterialResult,
} from '../../core/src/materials.js';
import type { Store } from '../../infrastructure/src/store.js';
import { FilmError, hash, invariant } from '../../core/src/util.js';
import type { AssetLibrary } from '../../media/src/assets.js';
import { materialCatalog } from '../../media/src/catalog.js';
import { MATERIAL_REVIEW_VERSION, reviewMaterials } from './material-review.js';
import { rejectRepeatedState } from '../../infrastructure/src/loop-progress.js';
import { invalidateDerivedArtifacts } from './revision-context.js';

export class MaterialMatcher {
  constructor(
    readonly store: Store,
    readonly taskId: string,
    readonly library: AssetLibrary,
    readonly agent: AgentDriver,
  ) {}

  async run(script: Script, brief?: CreativeBrief): Promise<MaterialManifest> {
    while (true) {
      this.library.processes.signal?.throwIfAborted();
      try {
        return await this.attempt(script, brief);
      } catch (error) {
        if (!(error instanceof FilmError) || error.code !== 'MATERIALS_MISMATCH') throw error;
        const limit = this.store.task(this.taskId).spec.budgets.stageRounds;
        const attempts = Number(
          this.store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type='materials.attempt' AND seq>?",
            )
            .get(this.taskId, this.store.stageEventFloor(this.taskId, 'materials'))!.n,
        );
        if (limit !== null && attempts >= limit) throw error;
      }
    }
  }

  private async attempt(script: Script, brief?: CreativeBrief): Promise<MaterialManifest> {
    const scriptHash = hash(script);
    const saved = this.store.artifact<MaterialManifest>(this.taskId, 'materials');
    if (saved?.data.scriptHash === scriptHash) {
      for (const match of saved.data.matches) {
        await this.library.resolve(match.assetId);
        invariant(
          this.store.asset(this.taskId, match.assetId).sha256 === match.sha256,
          'MATERIAL_CHANGED',
          'Matched media changed; match it again before editing',
        );
      }
      if (saved.data.reviewVersion === MATERIAL_REVIEW_VERSION) return saved.data;
      this.store.updateTask(this.taskId, 'running', 'materials');
      const review = await reviewMaterials(
        this.store,
        this.taskId,
        this.library,
        this.agent,
        saved.data.requirements,
        saved.data.matches,
      );
      if (review.passed) {
        const updated = { ...saved.data, reviewVersion: MATERIAL_REVIEW_VERSION };
        this.store.saveArtifact(this.taskId, 'materials', updated, true);
        return updated;
      }
      this.store.invalidate(this.taskId, ['materials']);
      invalidateDerivedArtifacts(this.store, this.taskId, ['editorial', 'composition', 'layout', 'render']);
      this.store.saveArtifact(this.taskId, 'materials.feedback', review);
    }
    this.store.updateTask(this.taskId, 'running', 'materials');
    const task = this.store.task(this.taskId);
    const sources = soundSources(brief),
      soundHash = hash({ scriptHash, sources, intent: brief?.intent });
    const savedSound = this.store.artifact<{ hash: string; plan: SoundPlan }>(
      this.taskId,
      'materials.sound_plan',
    )?.data;
    const soundPlan =
      savedSound?.hash === soundHash
        ? savedSound.plan
        : sources.length
          ? await this.agent.run({
              role: 'materials',
              toolAccess: 'none',
              schema: soundPlanSchema,
              instruction:
                '把已确定的声音设计拆成原子需求，每个 sourceId 恰好解释一次。每一种声音单独一个 sound 元素（例如引擎与鼓点是两个）；明确静音、无配乐、停止播放用 silence，不能把“无音乐”当素材关键词。保留所有已要求的声音，不受库存或网络可用性影响。不新增声音、不改创意。旁白由本地 TTS 提供。此步骤只拆解需求，不检索素材。',
              input: { phase: 'sound_plan', sources, narration: script.narration, intent: brief?.intent },
              validateOutput: (value) => validateSoundPlan(value, sources, brief),
            })
          : { sources: [] };
    validateSoundPlan(soundPlan, sources, brief);
    this.store.saveArtifact(this.taskId, 'materials.sound_plan', { hash: soundHash, plan: soundPlan }, true);
    const requirements = materialNeeds(script, sources, soundPlan);
    const attempt = Number(
      this.store.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type='materials.attempt' AND seq>?")
        .get(this.taskId, this.store.stageEventFloor(this.taskId, 'materials'))!.n,
    );
    const strategy = brief?.intent.technical?.some((c) => c.kind === 'local_materials')
      ? 'local_only'
      : task.spec.materials.strategy;
    this.store.saveArtifact(
      this.taskId,
      'materials.requirements',
      { scriptHash, requirements, strategy },
      true,
    );
    this.store.event(this.taskId, 'materials.attempt', { attempt, scriptHash, count: requirements.length });
    const pending = this.store.artifact<{ scriptHash: string; result: MaterialResult }>(
      this.taskId,
      'materials.pending',
    )?.data;
    const result = validateMaterialResult(
      pending?.scriptHash === scriptHash
        ? pending.result
        : await this.agent.run({
            role: 'materials',
            schema: materialResultSchema,
            instruction:
              '按冻结脚本与创意补齐每项素材需求。先检索、实际下载或绑定，画面用 frame，声音用 audio_evidence 检查实际区间；ASR 和 beats 分别只辅助语言与节奏，输出可用源片段及观察证据。允许一项需求对应多个片段。图像区间为 [0,0]。不得只凭标题匹配，不编造 assetId 或抽帧记录。不要改创意或脚本、不要编排时间线。priorSearch 是修订前的需求与搜索结果，只是线索，不是当前通过结论。对比完整需求而非仅 needId，优先复核仍适用的已找到区间，避免因修改某项声音而丢掉其它画面；不适用的片段仍须更换。local_first 先查任务、授权目录和共享库再网络，web_first 优先网络，local_only 不访问网络素材。local_materials 分页列出授权来源和目录，import_local_material 把选中文件导入任务；不能因任务素材列表为空就说本地没有素材。声音需求若由已生成旁白满足，可以引用该音频。无法满足的需求放入 gaps 并如实报告实际尝试，不能用纯字卡替代实拍需求。提交格式或证据不合法时修正自己的匹配报告。',
            input: {
              script,
              creativeBrief: brief,
              requirements,
              soundPlan,
              strategy,
              attempt,
              previousGaps: this.store.artifact(this.taskId, 'materials.gaps', false)?.data,
              revisionRequest: this.store.artifact(this.taskId, 'materials.feedback', false)?.data,
              previousMatches: this.store.artifact<MaterialResult>(this.taskId, 'materials.candidate', false)
                ?.data.matches,
              priorSearch: this.store.artifact(this.taskId, 'materials.prior_search')?.data,
              assets: await materialCatalog(this.library),
              narration: this.store.artifact(this.taskId, 'narration')?.data,
            },
            validateOutput: (value) =>
              validateMaterialResult(value, requirements, this.store.assets(this.taskId)),
          }),
      requirements,
      this.store.assets(this.taskId),
    );
    this.store.saveArtifact(this.taskId, 'materials.candidate', result);
    this.store.saveArtifact(this.taskId, 'materials.pending', { scriptHash, result }, true);
    for (const match of result.matches) await this.library.resolve(match.assetId);
    if (result.status === 'missing') {
      this.store.invalidate(this.taskId, ['materials.pending']);
      this.store.saveArtifact(this.taskId, 'materials.gaps', result.gaps);
      throw new FilmError(
        'MATERIALS_MISSING',
        '素材补充未完成；创意与脚本已保留。请查看具体素材缺口并补充来源后继续。',
        result.gaps,
      );
    }
    const review = await reviewMaterials(
      this.store,
      this.taskId,
      this.library,
      this.agent,
      requirements,
      result.matches,
    );
    if (!review.passed) {
      this.store.invalidate(this.taskId, ['materials.pending']);
      this.store.saveArtifact(this.taskId, 'materials.feedback', review);
      this.store.event(this.taskId, 'materials.review_failed', review);
      rejectRepeatedState(
        this.store,
        this.taskId,
        'materials',
        hash({ scriptHash, requirements, strategy, version: MATERIAL_REVIEW_VERSION }),
        result.matches.map(({ needId, assetId, sourceStart, sourceEnd }) => ({
          needId,
          assetId,
          sourceStart,
          sourceEnd,
          sha256: this.store.asset(this.taskId, assetId).sha256,
        })),
        review,
      );
      throw new FilmError(
        'MATERIALS_MISMATCH',
        '实际画面或声音尚未满足素材需求，正在修正匹配；创意与脚本保持不变。',
        review,
      );
    }
    const manifest: MaterialManifest = {
      schemaVersion: 1,
      reviewVersion: MATERIAL_REVIEW_VERSION,
      scriptHash,
      requirements,
      matches: result.matches.map((match) => ({
        ...match,
        sha256: this.store.asset(this.taskId, match.assetId).sha256,
      })),
    };
    this.store.transaction(() => {
      this.store.saveArtifact(this.taskId, 'materials', manifest, true);
      // Gap reports are unaccepted by definition; toggling accepted cannot retire them.
      this.store.invalidateFrom(this.taskId, ['materials.gaps']);
      this.store.invalidate(this.taskId, ['materials.pending']);
      this.store.event(this.taskId, 'materials.completed', {
        requirements: requirements.length,
        matches: result.matches.length,
      });
    });
    return manifest;
  }
}
