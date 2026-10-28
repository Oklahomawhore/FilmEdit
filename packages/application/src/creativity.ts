import { z } from 'zod';
import { rejectRepeatedState } from '../../infrastructure/src/loop-progress.js';
import type { Store } from '../../infrastructure/src/store.js';
import type { AgentDriver } from '../../agent-runtime/src/agents.js';
import type { AssetLibrary } from '../../media/src/assets.js';
import type { Script, EditorialIR, RenderIR } from '../../core/src/domain.js';
import { reviewSchema } from '../../core/src/domain.js';
import { validateComposition } from '../../core/src/presentation.js';
import type { SimilarityModel } from '../../media/src/scoring.js';
import { reviewConceptConstraints } from './semantic-review.js';
import type { Criterion } from '../../core/src/requirements.js';
import { CultureWeb } from '../../media/src/culture-web.js';
import { CreativeStore, features } from '../../infrastructure/src/creative-store.js';
import {
  intentSchema,
  conceptsSchema,
  conceptReviewSchema,
  cultureBundleSchema,
  operators,
  dimensions,
  fields,
  type IntentSpec,
  type IntentConstraint,
  type ConceptIR,
  type ConceptReview,
  type CultureBundle,
  type CreativeBrief,
  type CreativeMaterialRequirements,
} from '../../core/src/creative-domain.js';
import { canonical, hash, id, invariant, FilmError } from '../../core/src/util.js';

export const CREATIVE_VERSION = 'conditional-creativity-v1';
export const conceptAudienceInstruction =
  '你是独立观众，阅读拟创作的视听序列，写出理解到的联系、情绪与疑点，不猜作者预期答案。不要求传统故事完整，反差、隐喻可以成立，随机拼接不算联系。这里只是提案可理解性测试，不能声称已经验证成片效果。understandable 判断描述是否能被理解；feasible 仅判断描述的剪辑/布局手法是否在渲染器能力范围内。画面描述是后续要寻找的素材需求，不是声称已找到的素材证据。素材尚未获取、没有 assetId、未核验实拍内容均不能作为 blocking 或 feasible=false 的理由；素材补充与实际画面验收在后续阶段进行。确实无法理解的联系或不支持的渲染能力才可 blocking。';
export const CREATIVE_GATE_VERSION = 'concept-first-v9-independent-semantics';
export const intentReviewSchema = reviewSchema.extend({
  issues: z.array(
    z
      .object({ severity: z.literal('blocking'), message: z.string().min(1), evidence: z.string().min(1) })
      .strict(),
  ),
  classifications: z.array(
    z
      .object({
        constraintId: z.string().min(1),
        kinds: z
          .array(z.enum(['meaning', 'technical', 'quality', 'context']))
          .min(1)
          .max(4),
        reason: z.string().min(1),
      })
      .strict(),
  ),
});

export function validateIntentReview(value: z.infer<typeof intentReviewSchema>, intent: IntentSpec) {
  const expected = intent.constraints.filter((c) => c.source !== 'structured' && c.strength === 'fixed');
  const ids = value.classifications.map((c) => c.constraintId);
  invariant(
    ids.length === expected.length &&
      new Set(ids).size === ids.length &&
      expected.every((c) => ids.includes(c.id)),
    'INTENT_REVIEW_FORMAT',
    'Classify each extracted fixed constraint exactly once; do not classify open, preferred, or structured constraints.',
  );
  // Classification determines routing. A warning cannot approve a technical
  // condition or a general quality goal as a semantic story assertion.
  const misplaced = value.classifications.filter((c) => c.kinds.some((kind) => kind !== 'meaning'));
  return {
    ...value,
    passed: value.passed && misplaced.length === 0 && !value.issues.some((i) => i.severity === 'blocking'),
    issues: [
      ...value.issues,
      ...misplaced
        .filter((c) => !value.issues.some((i) => i.evidence === c.constraintId && i.severity === 'blocking'))
        .map((c) => ({
          severity: 'blocking' as const,
          evidence: c.constraintId,
          message: `Constraint includes ${c.kinds.join(', ')}, not semantic story scoring: ${c.reason}`,
        })),
    ],
  };
}
export const creativeCapabilities = {
  editorial:
    '支持多轨剪辑：track=0 覆盖时间线，不同 track 可同时显示不同素材、不同源时间的画面。每个镜头可独立变速、倒放、定格、抠像；同轨交叠需要转场。声音使用独立音轨。',
  layout:
    '支持分屏、画中画、多轨叠加与文字/分组动画。同一 binding 的多个节点共享片段和时间；不同步播放或只冻结其中一个窗口时，使用不同 track 的独立镜头 binding。不能生成新图片或任意绘图；实拍画面在后续素材补充阶段获取。',
  fit: 'composition.mediaFit=contain 时不允许裁切、遮罩或越界放大。需同时遵守 output.duration 与 composition 规格。',
} as const;
export function requestsLiteralText(prompt: string, value: string): boolean {
  // A verbatim quote is provenance, not permission to turn a meaning into exact equality.
  if (!value) return false;
  for (let i = prompt.indexOf(value); i >= 0; i = prompt.indexOf(value, i + value.length)) {
    // Keep multiline literal passages intact; look for the instruction around, not inside, them.
    const before = prompt.slice(Math.max(0, i - 120), i);
    const after = prompt.slice(i + value.length, i + value.length + 40).split(/[。！？!?；;\n]/)[0]!;
    const instruction = `${before} ${after}`;
    if (
      /(?:逐字|一字不改|一字不差|照抄|原样|不要改写|不得改写|verbatim|exact)/i.test(instruction) &&
      !/(?:不要|不必|无需)(?:逐字|照抄|原样)/.test(instruction)
    )
      return true;
    const context = `${before}${value}${after}`;
    if (
      /(?:写上|写成|标注|字幕|标题|台词|文案|旁白|片尾|屏幕文字)/.test(before) &&
      [`“${value}”`, `「${value}」`, `‘${value}’`, `"${value}"`, `'${value}'`].some((q) =>
        context.includes(q),
      )
    )
      return true;
  }
  return false;
}
export function validateIntent(
  input: unknown,
  prompt: string,
  explicit: IntentConstraint[] = [],
): IntentSpec {
  const intent = intentSchema.parse(input);
  for (const c of intent.constraints) {
    if (
      c.source === 'prompt' &&
      c.strength === 'fixed' &&
      /^(?:允许(?:使用|采用|出现)|不要求|素材(?:主要(?:是|为)|中(?:有|没有)|只有|没有))/.test(c.quote.trim())
    )
      throw new FilmError(
        'CREATIVE_INVALID',
        `Permission or source description ${c.id} is context, not a fixed story requirement or prohibition. “不要求 X” permits X; it does not forbid X. Extract any separate imperative with its own precise quote; keep source context in the original prompt.`,
      );
    if (c.source === 'prompt' && c.strength === 'fixed' && /虚构/.test(c.quote) && /素材|画面/.test(c.quote))
      throw new FilmError(
        'CREATIVE_INVALID',
        'Source-grounding restrictions belong in technical.source_grounded. Verify actual media in material matching and editorial review, not at the concept stage.',
      );
    invariant(
      c.source !== 'structured',
      'CREATIVE_INVALID',
      'Only the user can supply structured constraints',
    );
    if (c.source === 'prompt')
      invariant(
        c.quote.trim() && prompt.includes(c.quote),
        'CREATIVE_INVALID',
        `Constraint ${c.id} needs a verbatim user quote`,
      );
  }
  for (const c of intent.constraints) {
    if (
      c.polarity === 'forbid' &&
      c.match === 'semantic' &&
      /^(?:作品|画面)?(?:中)?(?:不得|不能|不要|禁止|不许|避免)/.test(c.value)
    )
      throw new FilmError(
        'CREATIVE_INVALID',
        `Forbidden condition ${c.id} must name the prohibited positive action, without a second negation. Example: polarity=forbid, value=虚构人物.`,
      );
    if (
      c.source === 'prompt' &&
      c.strength === 'fixed' &&
      /(?:使用|仅用|只用|采用|利用).*(?:已有|本地).*素材/.test(c.value)
    )
      throw new FilmError(
        'CREATIVE_INVALID',
        'Material source restrictions belong in technical.local_materials and are checked using asset IDs, not story semantics',
      );
    if (c.source === 'prompt' && c.match === 'exact' && c.value)
      invariant(
        c.quote.includes(c.value) && requestsLiteralText(prompt, c.value),
        'CREATIVE_INVALID',
        `Exact constraint ${c.id} needs an explicit request to preserve literal wording, not just a quote copied from the prompt. Use semantic for visual/style/meaning requirements; put duration/silence/empty narration in technical.`,
      );
  }
  for (const c of intent.technical ?? []) {
    invariant(
      prompt.includes(c.quote),
      'CREATIVE_INVALID',
      'Technical constraint needs a verbatim user quote',
    );
    invariant(
      c.kind === 'duration' ? typeof c.value === 'number' : c.value === true,
      'CREATIVE_INVALID',
      'Invalid technical constraint value',
    );
  }
  const overrides = explicit.map((c) => ({ ...c, source: 'structured' as const }));
  const result = {
    ...intent,
    constraints: [
      ...intent.constraints.filter(
        (c) =>
          !overrides.some((o) => o.dimension === c.dimension && (o.field === c.field || o.field === '*')),
      ),
      ...overrides,
    ],
  };
  invariant(
    new Set(result.constraints.map((c) => c.id)).size === result.constraints.length,
    'CREATIVE_INVALID',
    'Intent IDs must be unique',
  );
  return intentSchema.parse(result);
}
export function openDimensions(intent: IntentSpec) {
  return dimensions.filter(
    (d) =>
      !intent.constraints.some(
        (c) => c.dimension === d && c.field === '*' && c.strength === 'fixed' && c.polarity === 'require',
      ),
  );
}
export function availableOperators(intent: IntentSpec) {
  const open = new Set<string>(openDimensions(intent));
  return operators.filter(
    (o) =>
      o.changes.some((d) => open.has(d)) &&
      !(
        o.id === 'semantic_mutation' &&
        intent.constraints.some(
          (c) =>
            c.dimension === 'content' &&
            ['*', 'narration'].includes(c.field) &&
            c.strength === 'fixed' &&
            c.match === 'exact',
        )
      ),
  );
}
export function constraintValue(concept: ConceptIR, c: IntentConstraint): string {
  const part = concept.proposal[c.dimension];
  return c.field === '*' ? Object.values(part).join('；') : ((part as Record<string, string>)[c.field] ?? '');
}
export function conceptPremise(concept: ConceptIR, c: IntentConstraint): string {
  if (c.modality === 'visual' && c.dimension === 'content')
    return concept.beats.map((b) => `${b.action}：${b.visual}`).join('；');
  // Expression constraints compare the corresponding planned expression field.
  // Unbound beats cannot prove source order or actual pacing. Those are verified
  // from EditorialIR and independent audience evidence after material matching.
  // Do not append every visual description to the editing field alone.
  return constraintValue(concept, c);
}
export async function checkConcept(
  concept: ConceptIR,
  intent: IntentSpec,
  agent: AgentDriver,
  assetIds: Set<string>,
  knowledgeIds: Set<string>,
  _localOnly: boolean,
) {
  const issues: string[] = [];
  const technical = new Set((intent.technical ?? []).map((c) => c.kind));
  if ((technical.has('silent') || technical.has('no_narration')) && concept.proposal.content.narration !== '')
    issues.push('This concept must have empty narration');
  if (
    (technical.has('silent') || technical.has('no_music') || technical.has('narration_only')) &&
    concept.proposal.expression.music !== ''
  )
    issues.push('This concept must have empty music');
  if (technical.has('silent') && concept.beats.some((b) => b.audio !== ''))
    issues.push('Silent concept must have empty beat audio');
  const fixed = intent.constraints.filter((c) => c.strength === 'fixed');
  for (const c of fixed.filter((c) => c.match === 'exact')) {
    const value = constraintValue(concept, c);
    if (c.polarity === 'require' ? value !== c.value : value.includes(c.value))
      issues.push(`exact ${c.id}: ${c.value}`);
  }
  const semantic = fixed.filter((c) => c.match === 'semantic');
  const results = await reviewConceptConstraints(
    agent,
    semantic.map((c) => ({
      id: c.id,
      polarity: c.polarity,
      premise: conceptPremise(concept, c),
      requirement: c.value,
    })),
  );
  for (const c of semantic) {
    const result = results.find((r) => r.id === c.id)!;
    if (result.status !== 'supported') issues.push(`semantic ${c.id}: ${result.status}: ${result.reason}`);
  }
  const allowed = new Set(availableOperators(intent).map((o) => o.id));
  if (concept.operators.some((o) => !allowed.has(o))) issues.push('Operator changes a locked dimension');
  if (concept.knowledgeIds.some((k) => !knowledgeIds.has(k))) issues.push('Unknown cultural evidence');
  if (concept.beats.some((b) => b.assetIds.some((a) => !assetIds.has(a)))) issues.push('Unknown material ID');
  if (!concept.commitments.some((c) => c.modality === 'visual'))
    issues.push('At least one visual commitment is required; narration alone cannot prove the concept');
  return {
    passed: issues.length === 0,
    issues,
    semantic: semantic.map((c) => ({
      id: c.id,
      polarity: c.polarity,
      ...results.find((r) => r.id === c.id),
    })),
  };
}

export function blindConcept(concept: ConceptIR) {
  return {
    audienceBackground: concept.proposal.expression.audience,
    sequence: concept.beats.map(({ action, visual, audio }) => ({
      action,
      visual,
      audio,
    })),
  };
}
export function creativeMaterialRequirements(concept: ConceptIR): CreativeMaterialRequirements {
  return {
    schemaVersion: 1,
    conceptId: concept.id,
    beats: concept.beats.map((b) => ({
      beatId: b.id,
      action: b.action,
      visualQuery: b.visual,
      audioQuery: b.audio,
      candidateAssetIds: [...b.assetIds],
    })),
    musicQuery: concept.proposal.expression.music,
  };
}
export function chooseConcept(
  candidates: ConceptIR[],
  seed: string,
  previous: ConceptIR[],
  taste: ReturnType<CreativeStore['taste']>,
) {
  invariant(candidates.length, 'CREATIVE_EMPTY', 'No feasible creative candidate');
  const counts = new Map<string, number>();
  for (const c of previous) for (const op of c.operators) counts.set(op, (counts.get(op) ?? 0) + 1);
  const weights = candidates.map((c) => {
    const preference = features(c).reduce((n, f, i) => n + f * taste.weights[i]!, 0);
    const repeated = c.operators.reduce((n, o) => n + (counts.get(o) ?? 0), 0);
    return {
      id: c.id,
      weight: Math.max(0.1, Math.exp(Math.max(-2, Math.min(2, preference))) / (1 + repeated)),
    };
  });
  const total = weights.reduce((n, r) => n + r.weight, 0);
  const selection = weights.map((w) => ({ ...w, probability: w.weight / total }));
  let draw = parseInt(hash({ seed, candidates: candidates.map((c) => c.id) }).slice(0, 12), 16) / 2 ** 48;
  let chosen = candidates.at(-1)!;
  for (const row of selection) {
    draw -= row.probability;
    if (draw < 0) {
      chosen = candidates.find((c) => c.id === row.id)!;
      break;
    }
  }
  return { chosen, selection };
}

export class CreativeEngine {
  readonly knowledge: CreativeStore;
  constructor(
    readonly store: Store,
    readonly taskId: string,
    readonly agent: AgentDriver,
    readonly library: AssetLibrary,
    readonly model: SimilarityModel,
    readonly signal?: AbortSignal,
  ) {
    this.knowledge = new CreativeStore(store);
  }
  private save(stage: string, data: unknown, accepted = true) {
    const a = this.store.saveArtifact(this.taskId, stage, data, accepted);
    this.store.event(this.taskId, 'artifact', { stage, revision: a.revision, hash: a.hash, accepted });
    return a;
  }
  async run(): Promise<CreativeBrief | undefined> {
    const task = this.store.task(this.taskId);
    if (!task.spec.creative.enabled) return undefined;
    const accepted = this.store.artifact<CreativeBrief>(task.id, 'creative.brief');
    if (accepted) {
      if (!this.store.artifact(task.id, 'creative.material_requirements'))
        this.save('creative.material_requirements', creativeMaterialRequirements(accepted.data.concept));
      return accepted.data;
    }
    this.store.updateTask(task.id, 'running', 'creative');
    const config = task.spec.creative;
    const checkpoint =
      this.store.artifact<{ seed: string; taste: ReturnType<CreativeStore['taste']>; version: string }>(
        task.id,
        'creative.sampling',
      )?.data ??
      (this.save('creative.sampling', {
        seed: config.seed ?? id('sample'),
        taste: this.knowledge.taste(this.knowledge.scope(task.id)),
        version: CREATIVE_VERSION,
      }).data as { seed: string; taste: ReturnType<CreativeStore['taste']>; version: string });
    invariant(
      checkpoint.version === CREATIVE_VERSION,
      'CREATIVE_VERSION',
      'Resume requires the frozen creative engine version',
    );
    // Keep the seed and accepted upstream work, but never reuse the old source-availability gate.
    const gate = this.store.artifact<{ version: string; migrated: boolean }>(task.id, 'creative.gate')?.data;
    const migrated = gate?.migrated ?? Boolean(this.store.artifact(task.id, 'creative.search', false));
    if (gate?.version !== CREATIVE_GATE_VERSION) {
      this.store.invalidateFrom(task.id, [
        'creative.intent',
        'creative.batch',
        'creative.review',
        'creative.reviews',
        'creative.feedback',
        'creative.search',
        'creative.recheck_candidates',
      ]);
      this.save('creative.gate', { version: CREATIVE_GATE_VERSION, migrated });
      if (gate && !migrated)
        this.save('creative.recheck_candidates', {
          reason: 'Re-evaluate saved candidates under corrected intent and scoring',
        });
    }
    let intent = this.store.artifact<IntentSpec>(task.id, 'creative.intent')?.data;
    let intentFeedback: unknown = this.store.artifact(task.id, 'creative.intent.feedback', false)?.data;
    if (intent) {
      try {
        validateIntent(
          { ...intent, constraints: intent.constraints.filter((c) => c.source !== 'structured') },
          task.spec.prompt,
          config.constraints,
        );
      } catch (error) {
        if (!(error instanceof FilmError) && !(error instanceof z.ZodError)) throw error;
        intentFeedback = {
          message: error.message,
          previousIntent: intent,
          action: 'Repair intent representation against the original prompt; preserve user meaning.',
        };
        this.save('creative.intent.feedback', intentFeedback, false);
        this.store.invalidate(task.id, ['creative.intent']);
        this.save('creative.recheck_candidates', { reason: 'intent format repaired' });
        intent = undefined;
      }
    }
    for (let attempt = 0; !intent; attempt++) {
      this.signal?.throwIfAborted();
      if (task.spec.budgets.stageRounds !== null && attempt >= task.spec.budgets.stageRounds)
        throw new FilmError('STAGE_EXHAUSTED', 'Intent review needs revision', intentFeedback);
      const draft = await this.agent.run({
        role: 'intent',
        schema: intentSchema,
        instruction:
          '识别用户已确定的主题 theme、内容 content、表达 expression。逐字段提取 fixed/preferred/open，field=* 仅表示整个维度已确定，必须附逐字 quote。source 只可 prompt/inferred，不把推断或偏好提升为 fixed。subject 只写主体身份，不混入构图、时长、声音规则。默认 match=semantic；exact 仅用于用户明确要求原样保留的台词、标题、旁白等文字。“展示外观线条、节奏明快”是语义要求，不是逐字要求。禁止项 polarity=forbid，value 写被禁止的正向内容。可执行的技术限制必须放 technical，不得重复放进语义约束：duration 秒数；silent 全片无声；no_narration 无旁白；no_music 无音乐；narration_only 只保留旁白（包括禁止源音和音效）；no_sfx 无音效；no_subtitles 不加字幕（允许源画面已有文字和非字幕标题）；no_added_text 不添加任何文字；preserve_frame 不裁原画面/主体；landscape/portrait 横/竖屏；local_materials 仅本地；source_grounded 不虚构源画面。除 duration 外 value=true。只保留旁白就不存在是否保留环境音的留白。“车身与座舱主体完整”指对应镜头不裁主体，不要求每个镜头同时出现整车和内饰。“允许使用特写、不要求每镜整车”只是许可，不是必须特写或禁止整车；素材有什么/缺什么属于背景描述，不要编成叙事义务，原提示词会继续传给创作阶段。每个约束只引用直接支持该条件的原句，不要合并素材描述与制作要求。泛泛“观众能看懂、有创意、好看”是作品质量目标，由独立观众评审判断，不是 content.synopsis 的剧情事实；不要锁死原本开放的内容。若明确要求“观众理解某个原理/事件关系”，其中具体原理或关系仍是必须保留的语义条件。用户明确命令（如不要纯顺播、用节奏变化回应旁白）必须 fixed，不能降为 preferred。留白不要补全，openQuestions 仅列必须由用户补充才能继续的缺失信息，已提供的输出参数不是疑问。',
        input: {
          prompt: task.spec.prompt,
          output: task.spec.output,
          materials: task.spec.materials.strategy,
          fields,
          explicit: config.constraints,
          feedback: intentFeedback,
        },
        validateOutput: (v) => {
          validateIntent(v, task.spec.prompt, config.constraints);
          return v;
        },
      });
      const parsed = validateIntent(draft, task.spec.prompt, config.constraints);
      this.save('creative.intent.candidate', parsed, false);
      const review = validateIntentReview(
        await this.agent.run({
          role: 'intent_review',
          schema: intentReviewSchema,
          instruction:
            '独立核对原始需求和提取条件：遗漏明确要求、把留白锁死、引用不支持条件、否定方向错误、遗漏精确保留原文属于 blocking。exact 只用于用户要求保留的原文。时长/声音轨道限制/字幕限制/横竖屏/不裁原画面/素材来源必须放 technical，不得重复放进语义字段；主题身份不包含这些执行规则。只保留旁白意味着没有其它声音，不加字幕不等于删除素材中的文字。不要将“完整车身与座舱构图”夸大成每个镜头必须同时展示整车和座舱。把许可变成义务、把“不要求 X”变成“禁止 X”、把素材库存描述变成画面必须证明的事实，均属于 blocking。将明确命令弱化成 preferred 也属于 blocking，不得只记 warning；只有原文表达偏好或建议时才用 preferred。逐条给非 structured 的 fixed 约束填写 classifications.kinds 数组，检查约束的所有部分，混合条件可以有多个类别，不能只取主类别：meaning 是作品应表达的具体主体、事件、关系或风格；technical 是轨道/时长/来源等执行条件；quality 是泛泛可理解、有创意、好看等质量目标；context 是背景或许可。后三类的任何片段误放进语义约束都必须退回，由原 Agent 拆开修正。此评审只报告必须修正的提取错误，issues 的 severity 只能 blocking；不提供可忽略的建议。泛泛“观众能看懂的创意”交给后续独立观众评审，不能锁死 content.synopsis；“让观众理解刹车的工作原理”中的具体原理则仍是 meaning，不能丢弃。只分类已提取的 fixed 约束，遗漏用户要求仍写 blocking issue。原始 prompt 一直传给创作 Agent；背景、许可无需重复写入 IntentSpec，不得要求添加 schema 不支持的 technical 种类（如允许联网）。只审用户意图，不建议新创意。structured 用户显式配置优先；无 blocking 时 passed=true。',
          input: { prompt: task.spec.prompt, intent: parsed, explicit: config.constraints },
          validateOutput: (v) => validateIntentReview(v, parsed),
        }),
        parsed,
      );
      this.save('creative.intent.review', review);
      if (review.passed && !review.issues.some((i) => i.severity === 'blocking')) {
        intent = parsed;
        this.save('creative.intent', intent);
      } else {
        intentFeedback = review;
        this.save('creative.intent.feedback', review, false);
        rejectRepeatedState(
          this.store,
          task.id,
          'creative.intent',
          hash({ prompt: task.spec.prompt, explicit: config.constraints }),
          parsed,
          review,
        );
      }
    }
    validateTechnical(intent, task.spec.output.duration);
    validateOrientation(intent, task.spec.output);
    let knowledge = this.store.artifact<CultureBundle>(task.id, 'creative.knowledge')?.data;
    if (!knowledge) {
      const existing = this.knowledge.search(this.knowledge.scope(task.id), task.spec.prompt);
      if (config.knowledge === 'web' && openDimensions(intent).length > 0) {
        const research = await this.agent.run({
          role: 'culture_research',
          schema: cultureBundleSchema,
          instruction:
            '检索文化背景、人物、meme、热词、音乐风格与跨领域联系。优先 Wikipedia/Wikidata 和可核查原始网页；调用 culture_search/web_fetch 读取来源后记录 HTTPS URL、短摘录和观察时间。不能将模型猜测称为已核实事实；关联推断标 inferred，创意假设标 creative_hypothesis。不能把本地素材中的私人叙述发布到共享知识库。不下载素材，不引入付费服务。没有可靠结果返回空数组。',
          input: { prompt: task.spec.prompt, intent, existing, observedAt: new Date().toISOString() },
          validateOutput: (v) => new CultureWeb(this.store, this.taskId, this.library.processes).verify(v),
        });
        this.save('creative.research', research);
        this.knowledge.ingest(this.knowledge.scope(task.id), research);
      }
      knowledge = await this.knowledge.retrieve(this.knowledge.scope(task.id), task.spec.prompt, this.model);
      this.save('creative.knowledge', knowledge);
    }
    const knowledgeIds = new Set(knowledge.entities.map((e) => e.id));
    let round = this.store.artifact<{ round: number }>(task.id, 'creative.search', false)?.data.round ?? 0;
    let feedback: unknown = this.store.artifact(task.id, 'creative.feedback', false)?.data;
    for (; ; round++) {
      this.signal?.throwIfAborted();
      if (task.spec.budgets.stageRounds !== null && round >= task.spec.budgets.stageRounds)
        throw new FilmError('STAGE_EXHAUSTED', 'Creative search needs revision', feedback);
      const batchKey = `creative.batch.${hash({ seed: checkpoint.seed, round, intent, knowledge, version: CREATIVE_VERSION, gate: CREATIVE_GATE_VERSION })}`;
      const reused =
        !migrated && this.store.artifact(task.id, 'creative.recheck_candidates')
          ? this.knowledge.candidates(task.id).slice(-config.batchSize)
          : [];
      const batch =
        this.store.artifact<z.infer<typeof conceptsSchema>>(task.id, batchKey)?.data ??
        (reused.length ? { candidates: reused } : undefined) ??
        (await this.agent.run({
          role: 'creative',
          schema: conceptsSchema,
          instruction:
            '一次运行是在用户确定条件下采样创意。用不同算子寻找可理解的意义连接，不只改标题。固定的语义必须满足，exact 原文不得修改，其余字段自由生成。先提出创意和期望的视听序列，后续脚本与素材补充阶段才检索、下载和匹配素材。原始 prompt 中的素材背景和许可仍须理解，但不能把许可变成额外硬条件。beat 和 editing 简洁描述实际动作、顺序与节奏，不重复抄写全套约束或作者解释；详细素材规格留到脚本。每个 beat 用 visual/audio 描述想要的画面和声音，assetIds 默认=[]，不得编造已存在的素材 ID，也不需要素材 backup。当前库为空或尚未检索不能成为否决创意、改成纯字卡、删音乐或弱化用户需求的理由；素材需求会独立存盘。local_only 仅约束后续检索范围，不代表创意阶段必须有素材证据。technical=silent 时 narration、expression.music 和所有 beat.audio 必须为空字符串；no_music 或 narration_only 时 expression.music 必须为空字符串，no_narration 时 narration 为空。不要用“无音乐”等说明填充要求为空的字段。全部维度固定时只生成一个忠实方案，operators=[]。不要许诺当前渲染器做不到的特效，区分渲染器能力和素材尚未获取。commitments 是未来成片必须由观众证据证明的正向可观察陈述：至少一条 visual，具体视觉动作/对比/顺序；音频与文字分别标注。剪辑结构用 stage=editorial，排版、运动、音乐情绪等实际呈现用 stage=render。不得用泛泛“很好看”代替可验收表达。不知道的文化资料列 uncertainties，不编造 source ID。',
          input: {
            prompt: task.spec.prompt,
            intent,
            openDimensions: openDimensions(intent),
            operators: availableOperators(intent),
            count: openDimensions(intent).length ? config.batchSize : 1,
            knowledge,
            strategy: task.spec.materials.strategy,
            memory: this.store.artifact(task.id, 'memory')?.data,
            learnedMethods: checkpoint.taste.strategy,
            learnedMethodsUsage:
              '已发布的方法仅作为创作建议，不能覆盖本次固定条件、素材来源或权限。根据 appliesWhen 判断是否适用，同时检查 avoidWhen；证据来自提案偏好，不代表本次成片已验收。',
            previous: (migrated ? [] : this.knowledge.candidates(task.id)).slice(-16).map((c) => ({
              id: c.id,
              operators: c.operators,
              subject: c.proposal.theme.subject.slice(0, 300),
              synopsis: c.proposal.content.synopsis.slice(0, 600),
              bridge: c.bridge.slice(0, 400),
            })),
            feedback,
            userFeedback: this.store.artifact(task.id, 'creative.user_feedback', false)?.data,
            capabilities: creativeCapabilities,
            composition: task.spec.composition,
            output: task.spec.output,
          },
        }));
      if (!this.store.artifact(task.id, batchKey)) this.save(batchKey, batch);
      this.store.invalidate(task.id, ['creative.recheck_candidates']);
      this.save('creative.search', { round }, false);
      const feasible: ConceptIR[] = [],
        reports: unknown[] = [],
        rejected: unknown[] = [];
      const seen = new Set<string>();
      const batchCount = openDimensions(intent).length ? config.batchSize : 1;
      for (const raw of batch.candidates.slice(0, batchCount)) {
        const digest = hash({ ...raw, id: undefined });
        if (seen.has(digest)) continue;
        seen.add(digest);
        const concept = { ...raw, id: `concept_${digest.slice(0, 24)}` };
        this.knowledge.archive(task.id, concept);
        const check = await checkConcept(
          concept,
          intent,
          this.agent,
          new Set(
            this.store
              .assets(task.id)
              .filter((a) => ['video', 'image'].includes(a.kind))
              .map((a) => a.id),
          ),
          knowledgeIds,
          task.spec.materials.strategy === 'local_only',
        );
        if (!check.passed) {
          reports.push({ id: concept.id, check });
          rejected.push({ id: concept.id, check });
          continue;
        }
        const key = `creative.review.${hash({ concept, version: CREATIVE_GATE_VERSION })}`;
        let review = this.store.artifact<ConceptReview>(task.id, key)?.data;
        if (!review) {
          review = await this.agent.run({
            role: 'concept_audience',
            schema: conceptReviewSchema,
            instruction: conceptAudienceInstruction,
            input: {
              ...blindConcept(concept),
              capabilities: creativeCapabilities,
              composition: task.spec.composition,
              output: task.spec.output,
            },
          });
          this.save(key, review);
        }
        reports.push({ id: concept.id, check, review });
        if (review.understandable && review.feasible && !review.issues.some((i) => i.severity === 'blocking'))
          feasible.push(concept);
        else rejected.push({ id: concept.id, check, review });
      }
      this.save('creative.reviews', reports, false);
      if (!feasible.length) {
        feedback = rejected;
        this.save('creative.feedback', rejected, false);
        this.save('creative.search', { round: round + 1 }, false);
        rejectRepeatedState(
          this.store,
          task.id,
          'creative',
          hash({ intent, knowledge, version: CREATIVE_GATE_VERSION }),
          [...seen].sort(),
          rejected,
        );
        continue;
      }
      const previous = this.knowledge.candidates(task.id).filter((c) => !feasible.some((f) => f.id === c.id));
      const selected = chooseConcept(feasible, `${checkpoint.seed}:${round}`, previous, checkpoint.taste);
      const brief: CreativeBrief = {
        schemaVersion: 1,
        intent,
        concept: selected.chosen,
        seed: checkpoint.seed,
        round,
        knowledgeHash: hash(knowledge),
        materialIds: this.store.assets(task.id).map((a) => a.id),
        operatorVersion: CREATIVE_VERSION,
        tasteVersion: checkpoint.taste.version,
        selection: selected.selection,
      };
      this.save('creative.brief', brief);
      this.save('creative.material_requirements', creativeMaterialRequirements(selected.chosen));
      return brief;
    }
  }
}

export function creativeCriteria(
  brief: CreativeBrief,
  stage: 'editorial' | 'render',
): { fixed: Criterion[]; expression: Criterion[] } {
  const fixed = brief.intent.constraints
    .filter(
      (c) =>
        c.strength === 'fixed' &&
        !(c.dimension === 'content' && c.field === 'narration' && c.match === 'exact'),
    )
    .map((c) => ({
      text: c.polarity === 'forbid' ? `作品没有${c.value}` : c.value,
      sourceText: c.quote || c.value,
      weight: 2,
      required: true,
      modality: c.modality,
    }));
  const expression = brief.concept.commitments
    .filter((c) => stage === 'render' || c.stage === 'editorial')
    .map((c) => ({
      text: c.text,
      sourceText: `CreativeBrief ${brief.concept.id}/${c.id}`,
      weight: 1,
      required: true,
      modality: c.modality,
    }));
  return { fixed, expression };
}
export function validateExactContent(
  brief: CreativeBrief | undefined,
  script: Script,
  editorial?: EditorialIR,
) {
  if (!brief) return;
  const declaredDuration = Number(brief.intent.technical?.find((c) => c.kind === 'duration')?.value ?? 1);
  validateTechnical(brief.intent, editorial?.duration ?? declaredDuration, script, editorial);
  for (const c of brief.intent.constraints.filter((c) => c.strength === 'fixed' && c.match === 'exact')) {
    if (c.dimension === 'content' && c.field === 'narration')
      invariant(
        c.polarity === 'require' ? script.narration === c.value : !script.narration.includes(c.value),
        'CREATIVE_EXACT',
        `Narration violates ${c.id}`,
      );
    if (
      editorial &&
      c.dimension === 'content' &&
      c.field === 'narration' &&
      c.polarity === 'require' &&
      c.value === ''
    )
      invariant(
        !editorial.audio.some((a) => a.role === 'narration'),
        'CREATIVE_EXACT',
        'Exact empty narration cannot include a narration track',
      );
    if (editorial && c.modality === 'text' && !(c.dimension === 'content' && c.field === 'narration'))
      invariant(
        c.polarity === 'require'
          ? editorial.text.some((t) => t.text === c.value)
          : editorial.text.every((t) => !t.text.includes(c.value)),
        'CREATIVE_EXACT',
        `Visible text violates ${c.id}`,
      );
  }
}

export function validateTechnical(
  intent: IntentSpec,
  duration: number,
  script?: Script,
  editorial?: EditorialIR,
) {
  for (const c of intent.technical ?? []) {
    if (c.kind === 'duration')
      invariant(
        Math.abs(Number(c.value) - duration) < 0.05,
        'CREATIVE_CONFIG',
        `Prompt duration ${c.value}s conflicts with output.duration=${duration}s`,
      );
    if (script && ['silent', 'no_narration'].includes(c.kind))
      invariant(script.narration === '', 'CREATIVE_EXACT', 'User requires empty narration');
    if (editorial) {
      if (c.kind === 'silent')
        invariant(editorial.audio.length === 0, 'CREATIVE_EXACT', 'User requires a silent film');
      if (c.kind === 'no_narration')
        invariant(
          !editorial.audio.some((a) => a.role === 'narration'),
          'CREATIVE_EXACT',
          'User forbids narration',
        );
      if (c.kind === 'no_music')
        invariant(!editorial.audio.some((a) => a.role === 'music'), 'CREATIVE_EXACT', 'User forbids music');
      if (c.kind === 'narration_only')
        invariant(
          editorial.audio.every((a) => a.role === 'narration'),
          'CREATIVE_EXACT',
          'Only the approved narration may be audible; source sound, music and effects are forbidden',
        );
      if (c.kind === 'no_sfx')
        invariant(
          !editorial.audio.some((a) => a.role === 'effect'),
          'CREATIVE_EXACT',
          'User forbids effects',
        );
      if (c.kind === 'no_subtitles')
        invariant(
          !editorial.text.some((t) => t.role === 'subtitle'),
          'CREATIVE_EXACT',
          'User forbids added subtitles',
        );
      if (c.kind === 'no_added_text')
        invariant(editorial.text.length === 0, 'CREATIVE_EXACT', 'User forbids added text');
    }
  }
}

export function validateOrientation(intent: IntentSpec, canvas: { width: number; height: number }) {
  for (const c of intent.technical ?? []) {
    if (c.kind === 'landscape')
      invariant(canvas.width > canvas.height, 'CREATIVE_CONFIG', 'User requires landscape orientation');
    if (c.kind === 'portrait')
      invariant(canvas.height > canvas.width, 'CREATIVE_CONFIG', 'User requires portrait orientation');
  }
}

/** Check measurable presentation constraints on geometry, never through text similarity. */
export function validateTechnicalLayout(intent: IntentSpec, render: RenderIR) {
  validateOrientation(intent, render.canvas);
  if (intent.technical?.some((c) => c.kind === 'preserve_frame'))
    validateComposition(render, render.canvas, {
      aspectRatio: 'auto',
      fps: render.canvas.fps,
      mediaFit: 'contain',
      background: render.canvas.background,
    });
  return render;
}
