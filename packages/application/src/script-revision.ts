import type { Script, Review } from '../../core/src/domain.js';
import type { Store } from '../../infrastructure/src/store.js';
import { hash } from '../../core/src/util.js';

export const SCRIPT_REVIEW_VERSION = 7;
export const scriptReviewRoles = ['facts_review', 'audience_review', 'voice_review'] as const;
export type ScriptReviewRole = (typeof scriptReviewRoles)[number];
export type NamedReview = { role: ScriptReviewRole; review: Review };

export const scriptInstruction = `根据需求写可执行的中文短视频脚本。脚本是选题、角度、Persona 的组合。
有 previousScript 时必须在它的完整内容上修订，不是根据评语重新写一篇。先修当前 blocking，再考虑 warning；保留已正确的事实、明确的主语、因果衔接和 beat id，修改须同步到 narration、beats、标题和 facts。
revisionHistory 是旧问题的回归检查清单，不表示它们现在仍未解决。重新检查是否复发，不能为满足所有历史建议而不断增加支线。
用户需求与目标时长决定范围。历史类短片不必罗列所有年份、股权比例、商标诉讼或商业动机。若某支线证据冲突且不是用户必需内容，可删去该支线，同时删除依赖它的标题、设问和结论，保留清楚、可核查的主线。不要把两个矛盾年份并列当作解释。
事实要有可核查来源；复用 previousScript 中仍然成立的来源，只为新增或有争议的断言检索。Persona 用于表达方式，虚构记忆不能变成“我曾经做过”的真实经历。
源内容按需读取，不要求预先导入整个素材库。用户要求根据某段采访、字幕或实拍内容写作时，用 assets 查看已导入的分页摘要，或用 local_materials 浏览已授权来源、import_local_material 导入选中文件，再通过真实 assetId 调用 transcript/asr/frame 获取依据；不能猜 ID、编造源内容或把文件名当事实。只读取当前内容所需来源，不在脚本阶段补齐或匹配成片镜头。先写符合创意的脚本与 visualQuery，visualQuery 是待寻找的画面，不是已验证证据。素材不足、尚未检索或没有 assetId 不能成为改成纯字卡、删除画面/音乐要求的理由。local_only 仅约束后续素材补充的检索范围；不要冒充已获得额外实拍或历史档案。素材补充、真实镜头匹配和缺口报告由后续素材阶段完成。
当前用户要求优先于账号记忆，记忆只补充未确定的部分。
若有 materialRepair，只能在其 previousScript 上修改 decision.beatIds 指定分镜的实现，保留旁白、事实、其它分镜与顺序；按反馈中的实际素材线索解决脚本自行追加的过细要求，不得删除或弱化用户条件、冻结创意与 commitments。修订仍须经过完整独立脚本评审与素材匹配，不能声称实际成片已通过。
visualQuery 中分别说明源镜头需要的主体、动作、位置和制作时的处理；变速、定格、分屏、字幕叠加是制作操作，不要求原素材已做完这些效果。原有要求的范围和否定对象必须保留：“不新增文字/不加字幕”不能写成“原画面没有任何文字/水印”，也不能反向弱化用户明确要求的“素材本身无水印”。需要说明文字处理时，明确写“制作时不新增”，不要留下可被误读为源素材禁令的措辞。
beats.text 的拟呈现动作与 visualQuery 的源需求和制作说明必须一致。后期定格不要求源车原本停着，关闭图层不需要另找黑色或空旷素材，音量淡出和叠层也不要求原声音自带最终混音。若要求解冻后连续离场，源片段仍必须有可验证的离场过程，不能用换镜头冒充连续运动；用户明确要求原始静止机位等源条件时仍须保留。
默认短句、具体细节；控制口播长度。旁白必须与 beats.text 一致（无旁白作品可为空）。返回完整 Script。`;

export const scriptReviewInstructions: Record<ScriptReviewRole, string> = {
  facts_review:
    '独立检查本稿实际陈述的事实、逻辑与来源，使用 WebSearch/WebFetch 核对可验证断言；优先官方来源。对来自用户授权素材的事实，按需用 assets/local_materials/import_local_material 与 transcript/asr/frame 读取实际源内容，不要求先核验未来成片的全部素材。不得把上一轮评语当作事实。不要求补充稿件没有承诺的历史支线。对支撑主要结论的错误或缺证据断言给 blocking，明确引用原句和证据。',
  audience_review:
    '作为首次接触这份视频脚本的独立观众，联合阅读旁白 narration、beats.plannedAction（拟呈现动作）与 beats.visualQuery（源需求和制作说明），判断假如这些镜头如描述实现，视听关系能否理解。plannedAction 不是实际旁白，也不是画面已呈现的证明；其中解释性文字不能替代镜头表达。先检查动作与素材/制作说明是否互相矛盾，例如动作要求车仍在而画面说明要求已经无车。画面可以承担动作、对比、指代与节奏，旁白无需把画面逐句解释；不能因为信息只在画面里而给 blocking，更不能要求纯视觉作品补旁白。你不读取作者 angle、Persona、创作解释或旧评分，不添加预期答案。仅当画面和声音合起来仍有具体矛盾或必要因果缺口时给 blocking；旁白独立收听不完整、个人风格或可选解释为 warning。此处只判断脚本提案；实际素材、画面执行、节奏和可读性在后续剪辑/成片评审验证，不能声称已看见成片，也不能因未取得素材退稿。',
  voice_review:
    '独立检查实际旁白的口语表达、人物身份和经历真实性。虚构 Persona 记忆不能冒充用户或叙述者的真实经历；可以只借鉴其讲述方式。事实性身份错误为 blocking，措辞和风格优化为 warning。不要为了展现人设而要求增加未经证实的经历。',
};
export const reviewDecisionInstruction =
  '所有问题必须引用本稿具体句子或 beat。passed=false 必须列出至少一个有证据的 blocking；有 blocking 时不得 passed=true。只有 warning 时应通过并保留建议，不能因为还可以优化而无止境退稿。';

export function scriptReviewInput(
  role: ScriptReviewRole,
  script: Script,
  requirement: string,
  output: unknown,
  personas: unknown,
) {
  if (role === 'audience_review')
    return {
      script: {
        narration: script.narration,
        beats: script.beats.map(({ id, text, visualQuery, durationHint }) => ({
          id,
          plannedAction: text,
          visualQuery,
          durationHint,
        })),
      },
      output,
    };
  return { script, requirement, output, ...(role === 'voice_review' ? { personas } : {}) };
}

export function scriptRevisionContext(store: Store, taskId: string, feedback: unknown) {
  const previous = store.artifact<Script>(taskId, 'script.candidate', false);
  const history = store.db
    .prepare(
      "SELECT revision,data FROM artifacts WHERE task_id=? AND stage='script.reviews' AND rowid>? ORDER BY revision DESC LIMIT 3",
    )
    .all(taskId, store.artifactFloor(taskId, 'script.reviews'))
    .reverse()
    .map((row) => ({
      revision: row.revision,
      blocking: (JSON.parse(row.data as string) as Review[]).flatMap((review, i) =>
        review.issues
          .filter((issue) => issue.severity === 'blocking')
          .map((issue) => ({ role: scriptReviewRoles[i], ...issue })),
      ),
    }));
  return {
    previousScript:
      previous?.data ?? store.artifact<any>(taskId, 'script.user_revision')?.data.previousArtifact,
    previousScriptHash: previous?.hash,
    feedback,
    revisionHistory: history,
  };
}

/** A changed review policy re-evaluates the saved draft before asking the writer to revise it. */
export function prepareScriptReview(store: Store, taskId: string) {
  if (store.artifact(taskId, 'script')) return;
  const previous = store.artifact<{ version: number }>(taskId, 'script.review_policy')?.data;
  if (previous?.version === SCRIPT_REVIEW_VERSION) return;
  const candidate = store.artifact<Script>(taskId, 'script.candidate', false);
  store.transaction(() => {
    store.invalidateFrom(taskId, ['script.review', 'script.reviews', 'script.feedback']);
    store.saveArtifact(taskId, 'script.review_policy', { version: SCRIPT_REVIEW_VERSION }, true);
    if (candidate)
      store.saveArtifact(taskId, 'script.pending_assessment', { candidateHash: candidate.hash }, true);
    store.event(taskId, 'script.review_policy_updated', {
      previous: previous?.version,
      version: SCRIPT_REVIEW_VERSION,
      candidateHash: candidate?.hash,
    });
  });
}

export function scriptReviewCacheKey(
  role: ScriptReviewRole,
  input: unknown,
  policyVersion: string,
  materials: unknown,
) {
  return `script.review.${hash({
    version: SCRIPT_REVIEW_VERSION,
    role,
    input,
    policyVersion,
    materials,
    instruction: scriptReviewInstructions[role] + reviewDecisionInstruction,
  })}`;
}
