import { Text, visibleWidth, type Component } from '@earendil-works/pi-tui';
import {
  preferenceLabels,
  type ConceptComparison,
  type ConceptIR,
} from '../../../packages/core/src/creative-domain.js';

const clean = (value: string) => value.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
const proposal = (label: string, concept: ConceptIR) => {
  const { theme, content, expression } = concept.proposal;
  return clean(
    [
      `${label} · ${theme.subject}`,
      concept.id,
      '\n内容',
      content.synopsis,
      '\n表达',
      `角度：${expression.angle}`,
      `口吻：${expression.tone} · Persona：${expression.persona}`,
      `面向：${expression.audience}`,
      `音乐：${expression.music || '未设音乐'}`,
      `剪辑：${expression.editing}`,
      '\n创意联系',
      concept.bridge,
      `希望产生的感受：${concept.emotion}`,
      '\n拟制作的画面与声音（素材待核验）',
      ...concept.beats.map(
        (beat, index) =>
          `${index + 1}. ${beat.action}\n画面：${beat.visual}\n声音：${beat.audio || '未设声音'}`,
      ),
      '\n旁白',
      content.narration || '无旁白',
      '\n尚待验证',
      concept.uncertainties.join('\n') || '提案未列出；不代表成片已通过检查',
    ].join('\n'),
  );
};

/** Responsive text only: this view does not choose candidates, evaluate them, or write feedback. */
export class CreativeComparisonView implements Component {
  comparison?: ConceptComparison;
  currentVersion?: number;
  message = '用 /compare 查看两个已归档候选；不会启动制作。';
  invalidate() {}
  render(width: number): string[] {
    const data = this.comparison;
    if (!data) return new Text(this.message, 1, 1).render(width);
    const prior = data.previous;
    const heading = new Text(
      `创意偏好比较 · 任务 v${data.taskVersion}\n这里只比较提案；包含历史候选，不代表素材已到位或成片已通过。\n/compare a 或 b 换候选 · /prefer 打开选择菜单 · PgUp/PgDn 翻阅\n${
        this.currentVersion !== undefined && this.currentVersion > data.taskVersion
          ? '任务已更新：按 F6 重新读取后再提交。\n'
          : ''
      }${prior ? `此前记录：v${prior.expectedVersion} · ${preferenceLabels[prior.choice]}${prior.comment ? ' · ' + clean(prior.comment) : ''}` : '这组候选尚无用户偏好。'}\n记录偏好不会替换当前方案，也不会启动制作。`,
      1,
      1,
    ).render(width);
    const a = new Text(proposal('A', data.left), 1, 0),
      b = new Text(proposal('B', data.right), 1, 0);
    if (width < 92)
      return [...heading, ...a.render(width), '', '─'.repeat(Math.max(0, width)), '', ...b.render(width)];
    const leftWidth = Math.floor((width - 3) / 2),
      rightWidth = width - leftWidth - 3;
    const left = a.render(leftWidth),
      right = b.render(rightWidth);
    return [
      ...heading,
      ...Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
        const line = left[index] ?? '';
        return line + ' '.repeat(Math.max(0, leftWidth - visibleWidth(line))) + ' │ ' + (right[index] ?? '');
      }),
    ];
  }
}
