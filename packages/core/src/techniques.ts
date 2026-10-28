import type { Asset, EditorialIR, RenderIR } from './domain.js';
import { invariant } from './util.js';

export const techniqueDefinitions = [
  { id: 'hard_cut', layer: 'editorial', description: '相邻镜头直接切换' },
  { id: 'jump_cut', layer: 'editorial', description: '同源素材的不连续片段拼接，删除停顿' },
  { id: 'match_cut', layer: 'editorial', description: '按形状、动作或构图匹配镜头切点' },
  { id: 'montage', layer: 'editorial', description: '选择多个短镜头形成叙事关系' },
  { id: 'b_roll', layer: 'editorial', description: '旁白继续时插入说明性画面' },
  { id: 'j_cut', layer: 'editorial', description: '下一镜头声音先于画面进入，通过 audio.start 表达' },
  { id: 'l_cut', layer: 'editorial', description: '上一镜头声音延续到下一画面，通过 audio.duration 表达' },
  { id: 'beat_cut', layer: 'editorial', description: '将切点对齐已分析的节拍时间' },
  { id: 'speed', layer: 'editorial', description: '恒定变速；分段变速通过拆分镜头实现' },
  { id: 'reverse', layer: 'editorial', description: '在选定源区间倒放画面' },
  { id: 'freeze', layer: 'editorial', description: '固定 sourceStart 对应的一帧，持续 duration 秒' },
  { id: 'chromakey', layer: 'editorial', description: '色度抠像，参数 color、similarity、blend' },
  { id: 'portrait_matte', layer: 'editorial', description: '逐帧运行本地分割模型生成透明前景' },
  { id: 'split_screen', layer: 'presentation', description: '多个节点通过 rect 并排布局' },
  { id: 'picture_in_picture', layer: 'presentation', description: '通过 rect、z 和 mask 表达画中画' },
  { id: 'text_reveal', layer: 'presentation', description: '用关键帧表达文字淡入和位移' },
  { id: 'zoom', layer: 'presentation', description: '用关键帧 scale 表达推拉镜头' },
  { id: 'grade', layer: 'editorial', description: 'FFmpeg eq 调整 brightness、contrast、saturation' },
] as const;
export const techniqueCatalog = techniqueDefinitions.map((t) => ({ ...t, version: 1 }));
export function validateTechniques(editorial: EditorialIR, render?: RenderIR) {
  for (const [references, layer] of [
    [editorial.shots.flatMap((s) => s.techniques), 'editorial'],
    [render?.nodes.flatMap((n) => n.techniques) ?? [], 'presentation'],
  ] as const) {
    for (const ref of references)
      invariant(
        techniqueCatalog.some((t) => t.id === ref.id && t.version === ref.version && t.layer === layer),
        'TECHNIQUE_UNSUPPORTED',
        `Unknown ${layer} technique ${ref.id}@${ref.version}`,
      );
  }
}

/** Technique labels are assertions about timing, never substitutes for executable edits. */
export function validateEditingTechniques(editorial: EditorialIR, assets: Asset[], fps = 30) {
  validateTechniques(editorial);
  const epsilon = 1 / fps + 0.001;
  const end = (clip: { start: number; duration: number }) => clip.start + clip.duration;
  const speech = editorial.audio.filter((a) => ['dialogue', 'narration'].includes(a.role));
  for (const shot of editorial.shots) {
    const clips = editorial.shots.filter((s) => s.track === shot.track).sort((a, b) => a.start - b.start);
    const previous = clips[clips.indexOf(shot) - 1];
    const has = (id: string) => shot.techniques.some((t) => t.id === id);
    const ensure = (passed: unknown, detail: string) =>
      invariant(passed, 'TECHNIQUE_UNREALIZED', `${shot.id}: ${detail}`);
    ensure(!(has('freeze') && has('reverse')), 'freeze and reverse are mutually exclusive');
    for (const ref of shot.techniques) {
      if (['hard_cut', 'jump_cut', 'match_cut', 'beat_cut'].includes(ref.id))
        ensure(
          previous && Math.abs(end(previous) - shot.start) <= epsilon,
          `${ref.id} belongs on an incoming clip at a direct cut`,
        );
      if (ref.id === 'jump_cut')
        ensure(
          previous?.assetId === shot.assetId &&
            Math.abs(previous.sourceStart + previous.duration * previous.speed - shot.sourceStart) > epsilon,
          'jump_cut needs a discontinuous interval from the same source',
        );
      if (ref.id === 'montage')
        ensure(clips.length >= 3, 'montage needs at least three shots; the audience reviews their relation');
      if (ref.id === 'b_roll')
        ensure(
          speech.some((a) => a.start <= shot.start && end(a) >= end(shot)),
          'b_roll needs speech continuing under the shot',
        );
      if (ref.id === 'speed') ensure(Math.abs(shot.speed - 1) > 0.001, 'speed must change playback speed');
      if (ref.id === 'j_cut' || ref.id === 'l_cut') {
        const linked = editorial.audio.filter(
          (a) =>
            a.assetId === shot.assetId &&
            Math.abs(a.speed - shot.speed) < 0.001 &&
            Math.abs((shot.sourceStart - a.sourceStart) / a.speed - (shot.start - a.start)) <= epsilon,
        );
        ensure(
          linked.some((a) =>
            ref.id === 'j_cut'
              ? a.start < shot.start - epsilon && end(a) > shot.start
              : a.start < end(shot) && end(a) > end(shot) + epsilon,
          ),
          `${ref.id} needs synchronized source sound that starts before / continues after its picture`,
        );
      }
      if (ref.id === 'beat_cut')
        ensure(
          editorial.audio
            .filter((a) => a.role === 'music')
            .some((music) =>
              assets
                .find((a) => a.id === music.assetId)
                ?.beats.some(
                  (beat) =>
                    beat >= music.sourceStart &&
                    beat <= music.sourceStart + music.duration * music.speed &&
                    Math.abs(music.start + (beat - music.sourceStart) / music.speed - shot.start) <= epsilon,
                ),
            ),
          'beat_cut must coincide with an analyzed beat of music that is actually on the timeline',
        );
    }
  }
  return editorial;
}

export function tempoFilters(speed: number): string[] {
  const values: number[] = [];
  let rest = speed;
  while (rest > 2) {
    values.push(2);
    rest /= 2;
  }
  while (rest < 0.5) {
    values.push(0.5);
    rest /= 0.5;
  }
  values.push(rest);
  return values.map((n) => `atempo=${n}`);
}
