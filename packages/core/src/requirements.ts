/** Deterministic syntax normalization only; no extra facts or model-written acceptance criteria. */
export type Criterion = {
  text: string;
  sourceText: string;
  weight: number;
  modality: 'any' | 'visual' | 'audio' | 'text';
  required: boolean;
};
const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ');

function clauses(prompt: string): string[] {
  const result: string[] = [];
  let part = '',
    closing = '';
  for (const character of prompt.normalize('NFKC').trim()) {
    if (closing) {
      part += character;
      if (character === closing) closing = '';
    } else if ('“「『"'.includes(character)) {
      closing = ({ '“': '”', '「': '」', '『': '』', '"': '"' } as Record<string, string>)[character]!;
      part += character;
    } else if (/[。！？!?；;\n]/.test(character)) {
      if (part.trim()) result.push(part.trim());
      part = '';
    } else part += character;
  }
  if (part.trim()) result.push(part.trim());
  // Split only a comma followed by a new explicit obligation; preserve order clauses and quotes.
  return result.flatMap((s) => {
    const parts: string[] = [];
    let start = 0,
      quote = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (quote) {
        if (c === quote) quote = '';
        continue;
      }
      if ('“「『"'.includes(c)) {
        quote = ({ '“': '”', '「': '」', '『': '』', '"': '"' } as Record<string, string>)[c]!;
        continue;
      }
      if (
        /[，,]/.test(c) &&
        /^(?:并且|而且|同时)?\s*(?:必须|务必|一定要|禁止|不得|不能|不要)/.test(s.slice(i + 1))
      ) {
        parts.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(s.slice(start).trim());
    return parts;
  });
}

export function splitRequirements(prompt: string): Criterion[] {
  return [...new Set(clauses(prompt).map(normalize))]
    .filter((s) => !/^(?:分辨率|帧率|时长|比例)\s*[:：]/.test(s))
    .map((sourceText) => {
      let text = sourceText.replace(/^(?:(?:请|麻烦|帮我|给我|为我|请你|我想要|我想|我希望)\s*)+/, '');
      // Match a complete video request, not substrings inside a negative or a quoted line.
      const request = text.match(
        /^(?:剪辑|剪|制作|做|生成)(?:一(?:条|个|部|段|支))?(?:关于|有关)?\s*(.+?)(?:的)?(?:短视频|视频|片子|短片|影片)$/,
      );
      if (request) {
        let content = request[1]!.replace(/的$/, '').trim();
        const verb = content.match(/^(解释|介绍|讲述|讲解|科普|展示|呈现)(.+)$/);
        if (!/^(?:不|禁止|不得|不要)/.test(content))
          text = verb ? `视频${verb[1]}了${verb[2]!.trim()}` : `视频讲述了${content}`;
      } else {
        const verb = text.match(/^(解释|介绍|讲述|讲解|科普)(.+)$/);
        if (verb) text = `视频${verb[1]}了${verb[2]!.trim()}`;
      }
      const required = /必须|一定要|务必|禁止|不得|不能|不要/.test(sourceText);
      return {
        sourceText,
        text,
        required,
        weight: required ? 2 : 1,
        modality: /字幕|文字|标题|字卡|标牌/.test(text)
          ? 'text'
          : /画面|镜头中|展示|看见|看到|视觉|出现/.test(text)
            ? 'visual'
            : /听到|声音|旁白|配音/.test(text)
              ? 'audio'
              : 'any',
      };
    });
}
