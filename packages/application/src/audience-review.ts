import { z } from 'zod';
import type { AgentDriver, AgentRequest } from '../../agent-runtime/src/agents.js';
import type { AudienceIR, EditorialIR } from '../../core/src/domain.js';
import { citedAudienceEvidence, RENDERED_AUDIO_BINDING, validateAudience } from '../../core/src/ir.js';
import type { Store } from '../../infrastructure/src/store.js';
import { FilmError, errorInfo, hash } from '../../core/src/util.js';
import { rejectRepeatedState } from '../../infrastructure/src/loop-progress.js';

export const AUDIENCE_REVIEW_VERSION = 8;

export const VISUAL_ISSUE_PROTOCOL = `问题等级依据实际故障，不依据你猜测的创作意图。blocking 必须指出已观察到的具体损坏及证据，例如语音在词句中间实际截断、新增字幕关键文字被遮住、解码坏帧使内容无法辨认。只说“建议核查”“可能遗漏”“需确认是否有意”属于 warning，不能作为已确认故障阻塞制作。
长静音、静止镜头、定格、黑边、硬切、源素材水印和较小画面并不自动意味着故障。音轨短于视频不证明被截断；完整句子结束后的静音可记录其时长与观感，但不能自行添加“全片必须铺声音”的要求。不能仅凭没有配乐、没有解说或动作很少判成片损坏。
保留所有实际观察、不确定性和审美问题。确证语音截断、字幕裁切等仍应 blocking；无法确认原因或意图时说明限制、使用 warning。需求是否满足由独立对齐评分判断，观众不猜目标或代替用户追加条件。`;

export function evidenceBindings(cut: EditorialIR, renderedAudio = false) {
  return [
    ...cut.shots.map((s) => ({ ...s, modalities: ['visual', 'text'] })),
    ...cut.audio.map((s) => ({ ...s, modalities: ['audio'] })),
    ...cut.text.map((s) => ({ ...s, modalities: ['text'] })),
    ...(renderedAudio
      ? [{ id: RENDERED_AUDIO_BINDING, start: 0, duration: cut.duration, modalities: ['audio'] }]
      : []),
  ].map((s) => ({ bindingId: s.id, start: s.start, end: s.start + s.duration, modalities: s.modalities }));
}

export const AUDIENCE_REPORT_PROTOCOL = `证据使用成片时间线秒数，不是素材源时间。每条 evidence 必须完全落在它引用的 binding 的 start/end 内；跨镜头观察拆为多条 evidence。
逐段观察每个镜头及音轨的完整区间，报告不能漏掉中间、开头或结尾。需要更多证据时先调用观察工具；无法辨认、被遮挡、静音、尚未观察的区间也明确记录未知，不得补造事实或把抽样帧冒充连续观察。通过 events 或其他叙述引用这些 evidence，不能只保留在未引用的列表中。
每条 observation 不超过 300 字，描述一个明确观察；多项观察拆为不同 evidence，不能删去必要细节、否定或限定词。events.at 必须落在其引用的至少一条 evidence 时间范围内。
events 逐次记录实际观察到的画面或声音状态变化及其时刻；同类动作重复发生时分别记录，不把一串变化合成一个“逐个发生”事件，也不复制一条观察冒充多次发生。只在实际连续帧或音频证据能定位时填写，不能根据预期节奏等距编造事件。无法定位时保留疑点。
visual 引用镜头；audio 引用音轨；text 引用新增文字，或引用实际帧中存在烧录字幕/标牌的镜头。不能把旁白当作可见文字，也不能用文字证明画面中真的出现某物。
claims、events、relations、quantities、emotionTimeline 引用 evidence.id，不是 bindingId。每个 evidence.id 唯一。
entityId 标记这条 observation 的单一主体，在整份报告内稳定：同一可确认的人、车或物体跨镜头复用 ID，不同对象用不同 ID。ID 不能取自镜头、轨道或素材文件；同一文件可以有多个对象，不同镜头也可能是同一对象。观察主体的属性或动作时单独写一条 evidence，用具体可辨特征描述主体。多个人的各自动作必须拆开，不能给包含“男子紧张、女子放松”的整句指定一个 entityId。全景、空间关系、多个主体、无法确认身份或跨镜头身份不确定时为 null；只有可靠可见的连续性或身份特征才能复用 ID，不能因车型相同、说话内容或故事合理就猜是同一个。不得为了填 ID 杜撰身份。此标记只说明你实际辨认到的主体，不读取用户目标。
若提供 previousReview 和 validationErrors，只修复自己的报告并返回完整报告；执行时间线不变。不要要求剪辑师为修复报告格式重新剪辑。不要从技术校验信息猜测用户目标。`;

/** Completeness is a report contract, independent of the creator's goals or acceptance score. */
export function validateReviewCoverage(audience: AudienceIR, cut: EditorialIR, renderedAudio = false) {
  const observed = citedAudienceEvidence(audience);
  const missing: { bindingId: string; modality: string; start: number; end: number }[] = [];
  const bindings = [
    ...cut.shots.map((item) => ({ ...item, modality: 'visual' })),
    ...(renderedAudio
      ? [{ id: RENDERED_AUDIO_BINDING, start: 0, duration: cut.duration, modality: 'audio' }]
      : cut.audio.filter((item) => item.volume > 0).map((item) => ({ ...item, modality: 'audio' }))),
  ];
  for (const binding of bindings) {
    let cursor = binding.start;
    const end = binding.start + binding.duration;
    for (const span of observed
      .filter((item) => item.bindingId === binding.id && item.modality === binding.modality)
      .sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (span.start > cursor + 1e-6)
        missing.push({ bindingId: binding.id, modality: binding.modality, start: cursor, end: span.start });
      cursor = Math.max(cursor, span.end);
    }
    if (cursor < end - 1e-6)
      missing.push({ bindingId: binding.id, modality: binding.modality, start: cursor, end });
  }
  if (missing.length)
    throw new FilmError(
      'EVIDENCE_COVERAGE',
      '观察报告有未被有效引用的镜头或音轨区间。missing 中若有 uncitedEvidenceIds，表示这些已有 evidence 在该区间内，但未被 events、relations、emotionTimeline 或 confidence>=0.7 的 claims/quantities 引用。先检查已有观察是否准确，再在相应叙述中引用；不要仅提高置信度或复制观察来通过校验。确实缺少观察时补看缺段，无法观察或确认时明确记录未知并引用该记录。只修复报告，不得凭空延长事实区间、改变剪辑或猜测目标。',
      {
        missing: missing.map((gap) => ({
          ...gap,
          uncitedEvidenceIds: audience.evidence
            .filter(
              (item) =>
                item.bindingId === gap.bindingId &&
                item.modality === gap.modality &&
                item.start < gap.end &&
                item.end > gap.start &&
                !observed.some((cited) => cited.id === item.id),
            )
            .map((item) => item.id),
        })),
      },
    );
}

/** Owns report repair and its checkpoint. It never regenerates a cut or a layout. */
export async function reviewAudience(options: {
  store: Store;
  taskId: string;
  agent: AgentDriver;
  request: AgentRequest<AudienceIR>;
  key: string;
  signal?: AbortSignal;
  validateEvaluation?: (report: AudienceIR) => Promise<void>;
}): Promise<AudienceIR> {
  const { store, taskId, agent, request, key, signal, validateEvaluation } = options;
  const cut = request.editorial!;
  const renderedAudio = Boolean(request.renderedVideo && request.renderedAudio);
  const cached = store.artifact<AudienceIR>(taskId, key);
  let previous = cached?.data ?? store.artifact<AudienceIR>(taskId, `${key}.candidate`, false)?.data;
  let feedback: unknown = store.artifact(taskId, `${key}.repair`, false)?.data;
  let previousHash = previous && hash(previous);
  let attempted: AudienceIR | undefined;
  const diagnostic = (error: unknown) =>
    error instanceof z.ZodError
      ? { code: 'REVIEW_SCHEMA', message: 'Audience report schema is invalid', issues: error.issues }
      : errorInfo(error);
  const recordError = (error: unknown) => {
    feedback = diagnostic(error);
    store.saveArtifact(taskId, `${key}.repair`, feedback);
    store.event(taskId, 'review.repair_requested', { role: request.role, key, error: feedback });
  };
  const validate = (value: AudienceIR) => {
    attempted = value;
    const fingerprint = hash(value);
    if (fingerprint !== previousHash) store.saveArtifact(taskId, `${key}.candidate`, value);
    previous = value;
    previousHash = fingerprint;
    try {
      const valid = validateAudience(value, cut, renderedAudio);
      validateReviewCoverage(valid, cut, renderedAudio);
      return valid;
    } catch (error) {
      recordError(error);
      throw error;
    }
  };
  if (previous) {
    try {
      const valid = validateAudience(previous, cut, renderedAudio);
      validateReviewCoverage(valid, cut, renderedAudio);
      await validateEvaluation?.(valid);
      store.saveArtifact(taskId, key, valid, true);
      return valid;
    } catch (error) {
      if (
        !(error instanceof z.ZodError) &&
        !(error instanceof FilmError && error.code.startsWith('EVIDENCE_'))
      )
        throw error;
      store.saveArtifact(taskId, `${key}.candidate`, previous);
      recordError(error);
    }
  }
  const budget = store.task(taskId).spec.budgets.stageRounds;
  const used = Number(
    store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type='review.attempt' AND json_extract(data,'$.key')=?",
      )
      .get(taskId, key)!.n,
  );
  for (let round = used; budget === null || round < budget; round++) {
    signal?.throwIfAborted();
    attempted = undefined;
    store.event(taskId, 'review.attempt', { role: request.role, key, round });
    try {
      const report = await agent.run({
        ...request,
        instruction: `${request.instruction}\n${AUDIENCE_REPORT_PROTOCOL}`,
        input: {
          observation: request.input,
          evidenceBindings: evidenceBindings(cut, renderedAudio),
          ...(feedback ? { previousReview: previous, validationErrors: feedback } : {}),
        },
        validateOutput: validate,
      });
      // Fixture/custom drivers must obey the same contract as the SDK driver.
      const valid = validate(report);
      await validateEvaluation?.(valid);
      store.saveArtifact(taskId, key, valid, true);
      store.invalidate(taskId, [`${key}.repair`]);
      store.event(taskId, 'review.validated', { role: request.role, key, reportHash: hash(valid) });
      return valid;
    } catch (error) {
      if (
        !(error instanceof z.ZodError) &&
        !(error instanceof FilmError && error.code.startsWith('EVIDENCE_'))
      )
        throw error;
      // Schema failures may be thrown before validateOutput gets a report.
      if (feedback === undefined || hash(feedback) !== hash(diagnostic(error))) recordError(error);
      if (attempted)
        rejectRepeatedState(
          store,
          taskId,
          store.task(taskId).stage,
          `review:${key}`,
          attempted,
          diagnostic(error),
        );
    }
  }
  throw new FilmError(
    'REVIEW_EXHAUSTED',
    'Audience report repair budget exhausted; the timeline is preserved',
    feedback,
  );
}
