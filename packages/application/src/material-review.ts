import { z } from 'zod';
import type { AgentDriver } from '../../agent-runtime/src/agents.js';
import type { MaterialNeed, MaterialResult } from '../../core/src/materials.js';
import type { Store } from '../../infrastructure/src/store.js';
import type { AssetLibrary } from '../../media/src/assets.js';
import { hash, invariant } from '../../core/src/util.js';
import { AudioAnalyzer, type AudioEvidence } from '../../media/src/audio-evidence.js';

export const MATERIAL_REVIEW_VERSION = 4;
export const AUDIO_MATERIAL_REVIEW_INSTRUCTION =
  '独立核对实际源片段的声音证据是否满足需求。audio 来自固定本地模型对所选区间的分析，windows 含音量、AudioSet 类别预测与 CLAP 对固定声音描述的 similarities，transcript 是该片段有有效时间区间的 ASR；unalignedWords 是识别器未能定位的词，不能证明该词被说出或未被说出，涉及逐字要求时须保留不确定性；未提供标题或匹配者解释。contentStatus=insufficient_duration 的窗口仅有音量测量，不能推断声音类别或其不存在。类别分数不是正确率，cosine 是相对相似度而不是置信度；词表固定且不含搜索目标。综合两个模型、信号强度和 ASR，冲突、低分和混合声音保留不确定；未列出的类别不等于不存在。不能靠有节拍、空 ASR 或搜索需求本身证明声音存在。实际分类、描述相似度或语音能支持所需声音才判 matched，明确不同判 mismatch，无法确认判 insufficient；尤其不能从 Music 推断 Funk 等具体风格、从 Vehicle 推断特定车型声音，也不能声称亲耳听过。这里只核对源声音，混音和节奏在后续制作。每条证据引用 matchIndex 及对应 evidenceTimes 中窗口的起始源秒数；格式问题修复自己的报告。声音描述类别不互斥：风、沙沙声、宽带噪声、whoosh 等可以描述同一个声源的不同声学特征；同时列出多个相似描述，不证明混入多个独立声源，也不要求其它候选分数为零。要拒绝来源，须指出对所需声音的实际反证或未解决的具体身份歧义；明确的语音、音乐、喇叭等不同事件证据仍须保留，不能因 wind 排第一就忽略混合声音。区分源声音与制作要求：“单层/只剩一层”、不同轨道叠加、渐弱、随窗口关闭、音量变轻描述混音操作，不能要求每个源文件已经包含完成后的混音；原文若明确要求源录音本身无其他事件，则仍检查这项来源限制。不要将音色的多个标签解释为轨道层数。';
export const materialReviewSchema = z
  .object({
    verdict: z.enum(['matched', 'mismatch', 'insufficient']),
    observation: z.string().trim().min(1),
    evidence: z
      .array(
        z
          .object({ matchIndex: z.number().int().nonnegative(), time: z.number().finite().nonnegative() })
          .strict(),
      )
      .min(1),
  })
  .strict();
type Review = z.infer<typeof materialReviewSchema>;
export type MaterialReview = { passed: boolean; checks: { needId: string; review: Review }[] };

/** Judge source evidence before editing. Author observations and titles are withheld. */
export async function reviewMaterials(
  store: Store,
  taskId: string,
  library: AssetLibrary,
  agent: AgentDriver,
  needs: MaterialNeed[],
  matches: MaterialResult['matches'],
): Promise<MaterialReview> {
  const checks: MaterialReview['checks'] = [];
  for (const need of needs) {
    const clips: {
      matchIndex: number;
      assetId: string;
      sha256: string;
      sourceStart: number;
      sourceEnd: number;
      evidenceTimes: number[];
      audio?: AudioEvidence;
    }[] = [];
    const images: { path: string; label: string }[] = [];
    for (const [matchIndex, match] of matches.entries()) {
      if (match.needId !== need.id) continue;
      const asset = store.asset(taskId, match.assetId);
      await library.resolve(asset.id);
      const span = match.sourceEnd - match.sourceStart;
      const frames =
        need.kind === 'audio'
          ? []
          : await library.frames(
              asset.id,
              asset.kind === 'image'
                ? [0]
                : [0, 0.25, 0.5, 0.75, 0.98].map((fraction) => match.sourceStart + span * fraction),
            );
      const audio =
        need.kind === 'audio'
          ? await new AudioAnalyzer(library).analyze(asset.id, match.sourceStart, match.sourceEnd)
          : undefined;
      clips.push({
        matchIndex,
        assetId: asset.id,
        sha256: asset.sha256,
        sourceStart: match.sourceStart,
        sourceEnd: match.sourceEnd,
        evidenceTimes: audio ? audio.windows.map((w) => w.start) : frames.map((f) => f.time),
        ...(audio ? { audio } : {}),
      });
      images.push(
        ...frames.map((frame) => ({ path: frame.path, label: `match ${matchIndex}, source ${frame.time}s` })),
      );
    }
    invariant(clips.length, 'MATERIAL_MATCH', 'Material review needs a source interval');
    const input = { need, clips };
    const key = `materials.review.${hash({ version: MATERIAL_REVIEW_VERSION, input, policy: library.policy.data.version })}`;
    const cached = store.artifact<Review>(taskId, key);
    const validate = (value: Review) => {
      invariant(
        value.evidence.every((e) =>
          clips.some(
            (c) =>
              c.matchIndex === e.matchIndex &&
              c.evidenceTimes.some((time) => Math.abs(time - e.time) < 0.001),
          ),
        ),
        'MATERIAL_EVIDENCE',
        'Cite only the provided match index and source evidence time',
      );
      if (need.kind === 'audio' && value.verdict === 'matched')
        invariant(
          value.evidence.some((e) =>
            clips.some(
              (c) =>
                c.matchIndex === e.matchIndex &&
                c.audio?.windows.some((w) => Math.abs(w.start - e.time) < 0.001 && w.peakDb > -150),
            ),
          ),
          'MATERIAL_EVIDENCE',
          'A silent source window cannot prove an audible sound',
        );
      return value;
    };
    const review = cached
      ? validate(cached.data)
      : validate(
          await agent.run({
            role: 'materials_review',
            toolAccess: 'none',
            schema: materialReviewSchema,
            instruction:
              need.kind === 'audio'
                ? AUDIO_MATERIAL_REVIEW_INSTRUCTION
                : '独立核对原始画面是否能满足这项素材需求。只依据给出的图片序列，不猜测素材名称、前后情节或作者解释。逐项区分可见主体、动作、空间关系与构图，相近对象不能代替所需动作或关系。多段素材可共同满足需求，但缺少核心动作、关系或主体时不能判 matched。明确不符给 mismatch；证据无法确认给 insufficient；matched 只表示所需素材确实存在，不表示已经完成剪辑、慢放或节奏设计。不能要求源素材已经带有后续剪辑效果。引用实际 matchIndex 与源秒数；证据格式错误由你修复报告。',
            input,
            images,
            validateOutput: validate,
          }),
        );
    if (!cached) store.saveArtifact(taskId, key, review, true);
    checks.push({ needId: need.id, review });
  }
  const result = { passed: checks.every((c) => c.review.verdict === 'matched'), checks };
  store.saveArtifact(
    taskId,
    'materials.source_review',
    { version: MATERIAL_REVIEW_VERSION, ...result },
    true,
  );
  return result;
}
