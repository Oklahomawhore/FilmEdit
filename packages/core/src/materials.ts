import { z } from 'zod';
import type { Asset, EditorialIR, Script } from './domain.js';
import { ID } from './domain.js';
import type { CreativeBrief } from './creative-domain.js';
import { invariant } from './util.js';

export type MaterialNeed = {
  id: string;
  beatId?: string;
  kind: 'visual' | 'audio';
  query: string;
  durationHint?: number;
  audioRole?: 'music' | 'sfx' | 'ambient' | 'dialogue' | 'narration';
};

export type SoundSource = { id: string; beatId?: string; text: string };
export const soundPlanSchema = z
  .object({
    sources: z.array(
      z
        .object({
          sourceId: ID,
          elements: z
            .array(
              z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('silence'), description: z.string().trim().min(1) }).strict(),
                z
                  .object({
                    kind: z.literal('sound'),
                    role: z.enum(['music', 'sfx', 'ambient', 'dialogue', 'narration']),
                    query: z.string().trim().min(1),
                  })
                  .strict(),
              ]),
            )
            .min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type SoundPlan = z.infer<typeof soundPlanSchema>;

export function soundSources(brief?: CreativeBrief): SoundSource[] {
  const sources: SoundSource[] = (brief?.concept.beats ?? []).flatMap((beat, i) =>
    beat.audio.trim() ? [{ id: `audio_${i + 1}`, beatId: beat.id, text: beat.audio }] : [],
  );
  const music = brief?.concept.proposal.expression.music.trim();
  if (music) sources.push({ id: 'music', text: music });
  return sources;
}

export function validateSoundPlan(plan: SoundPlan, sources: SoundSource[], brief?: CreativeBrief) {
  invariant(
    plan.sources.length === sources.length &&
      new Set(plan.sources.map((s) => s.sourceId)).size === sources.length &&
      plan.sources.every((s) => sources.some((source) => source.id === s.sourceId)),
    'SOUND_PLAN',
    'Interpret each original sound instruction exactly once',
  );
  const technical = brief?.intent.technical ?? [];
  for (const source of plan.sources)
    for (const element of source.elements)
      if (element.kind === 'sound') {
        invariant(
          !technical.some((constraint) => constraint.kind === 'silent'),
          'SOUND_PLAN',
          'Silent work must not acquire sound',
        );
        invariant(
          element.role !== 'music' || !technical.some((constraint) => constraint.kind === 'no_music'),
          'SOUND_PLAN',
          'User prohibited music',
        );
        invariant(
          element.role !== 'narration' || !technical.some((constraint) => constraint.kind === 'no_narration'),
          'SOUND_PLAN',
          'User prohibited narration',
        );
        invariant(
          element.role === 'narration' ||
            !technical.some((constraint) => constraint.kind === 'narration_only'),
          'SOUND_PLAN',
          'Only narration may be acquired for this work',
        );
        invariant(
          element.role !== 'sfx' || !technical.some((constraint) => constraint.kind === 'no_sfx'),
          'SOUND_PLAN',
          'User prohibited sound effects',
        );
      }
  return plan;
}

export const materialRevisionSchema = z
  .object({
    kind: z.literal('material_request'),
    needIds: z.array(ID).min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

/** A requirement describes the intended work, independently of inventory availability. */
export function materialNeeds(
  script: Script,
  sources: SoundSource[] = [],
  plan: SoundPlan = { sources: [] },
): MaterialNeed[] {
  validateSoundPlan(plan, sources);
  const needs: MaterialNeed[] = script.beats.map((beat, i) => ({
    id: `visual_${i + 1}`,
    beatId: beat.id,
    kind: 'visual',
    query: beat.visualQuery,
    durationHint: beat.durationHint,
  }));
  for (const source of plan.sources)
    for (const [i, element] of source.elements.entries()) {
      if (element.kind === 'sound')
        needs.push({
          id: `${source.sourceId}_${i + 1}`,
          beatId: sources.find((s) => s.id === source.sourceId)?.beatId,
          kind: 'audio',
          query: element.query,
          audioRole: element.role,
        });
    }
  return needs;
}

export const materialResultSchema = z
  .object({
    status: z.enum(['ready', 'missing']),
    matches: z.array(
      z
        .object({
          needId: ID,
          assetId: ID,
          sourceStart: z.number().finite().nonnegative(),
          sourceEnd: z.number().finite().nonnegative(),
          observation: z.string().trim().min(1),
          frameTimes: z.array(z.number().finite().nonnegative()),
        })
        .strict(),
    ),
    gaps: z.array(
      z
        .object({
          needId: ID,
          attemptedQueries: z.array(z.string().trim().min(1)).min(1),
          reason: z.string().trim().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type MaterialResult = z.infer<typeof materialResultSchema>;
export type MaterialManifest = {
  schemaVersion: 1;
  reviewVersion: number;
  scriptHash: string;
  requirements: MaterialNeed[];
  matches: (MaterialResult['matches'][number] & { sha256: string })[];
};

/** Validate references; source pixels and sound are independently reviewed before acceptance. */
export function validateMaterialResult(result: MaterialResult, needs: MaterialNeed[], assets: Asset[]) {
  const known = new Map(needs.map((n) => [n.id, n]));
  const covered = new Set<string>();
  for (const match of result.matches) {
    const need = known.get(match.needId),
      asset = assets.find((a) => a.id === match.assetId);
    invariant(need && asset, 'MATERIAL_MATCH', 'Match must reference an actual requirement and task asset');
    invariant(match.sourceEnd >= match.sourceStart, 'MATERIAL_MATCH', 'Invalid source interval');
    if (asset.kind === 'image') {
      invariant(
        match.sourceStart === 0 && match.sourceEnd === 0,
        'MATERIAL_MATCH',
        'Image interval is [0,0]',
      );
    } else {
      invariant(
        match.sourceEnd > match.sourceStart && match.sourceEnd <= asset.duration + 0.001,
        'MATERIAL_MATCH',
        'Source interval is outside the asset',
      );
    }
    if (need.kind === 'visual') {
      invariant(
        ['image', 'video'].includes(asset.kind),
        'MATERIAL_MATCH',
        'Visual requirement needs visual media',
      );
      const invalidTimes = match.frameTimes.filter(
        (time) =>
          time < match.sourceStart ||
          time > match.sourceEnd ||
          !asset.frames.some((frame) => Math.abs(frame.time - time) < 0.001),
      );
      invariant(
        match.frameTimes.length > 0 && invalidTimes.length === 0,
        'MATERIAL_EVIDENCE',
        `Inspect source frames before claiming a visual match: ${match.needId}, asset ${match.assetId}, interval [${match.sourceStart}, ${match.sourceEnd}]. ${match.frameTimes.length ? `Invalid or uninspected times: ${invalidTimes.slice(0, 8).join(', ')}` : 'frameTimes is empty'}. Call frame inside this interval and use the exact returned times; do not round them.`,
      );
    } else {
      invariant(
        asset.hasAudio,
        'MATERIAL_EVIDENCE',
        'Audio requirement needs an actual audio stream; independent sound evidence is checked before acceptance',
      );
    }
    covered.add(need.id);
  }
  const gaps = new Set<string>();
  for (const gap of result.gaps) {
    invariant(
      known.has(gap.needId) && !covered.has(gap.needId) && !gaps.has(gap.needId),
      'MATERIAL_MATCH',
      `Gap must reference one uncovered requirement: ${gap.needId} is ${!known.has(gap.needId) ? 'unknown' : covered.has(gap.needId) ? 'also present in matches; remove unverified matches before reporting it as a gap' : 'duplicated in gaps'}`,
    );
    gaps.add(gap.needId);
  }
  invariant(
    needs.every((n) => covered.has(n.id) || gaps.has(n.id)),
    'MATERIAL_MATCH',
    `Every requirement needs a match or explicit gap. Missing: ${needs
      .filter((n) => !covered.has(n.id) && !gaps.has(n.id))
      .map((n) => n.id)
      .join(', ')}`,
  );
  invariant(
    result.status === (gaps.size ? 'missing' : 'ready'),
    'MATERIAL_MATCH',
    'Status must agree with gaps',
  );
  return result;
}

export function validateMatchedEdit(ir: EditorialIR, manifest: MaterialManifest, narrationId?: string) {
  for (const clip of [...ir.shots, ...ir.audio]) {
    if ('role' in clip && clip.role === 'narration' && clip.assetId === narrationId) continue;
    const kind = 'role' in clip ? 'audio' : 'visual';
    const duration =
      'techniques' in clip && clip.techniques.some((t) => t.id === 'freeze') ? 0 : clip.duration * clip.speed;
    const verified = manifest.matches.filter(
      (match) =>
        match.assetId === clip.assetId &&
        (kind === 'audio' || manifest.requirements.find((n) => n.id === match.needId)?.kind === 'visual'),
    );
    invariant(
      verified.some(
        (match) =>
          clip.sourceStart >= match.sourceStart - 0.001 &&
          (match.sourceEnd === 0 || clip.sourceStart + duration <= match.sourceEnd + 0.001),
      ),
      'MATERIAL_MATCH',
      `Clip ${clip.id} uses unverified source interval [${clip.sourceStart}, ${clip.sourceStart + duration}] of ${clip.assetId}. Verified intervals: ${[...new Set(verified.map((match) => `[${match.sourceStart}, ${match.sourceEnd}]`))].join(', ') || 'none'}. Source duration is timeline duration × speed (zero for a freeze). Keep the clip inside one verified interval or request material repair.`,
    );
  }
  return ir;
}

/** Local sourcing is provenance, not membership in the inventory at concept-selection time. */
export function validateLocalSources(ir: EditorialIR, assets: Asset[], narrationId?: string) {
  const indexed = new Map(assets.map((asset) => [asset.id, asset]));
  for (const clip of [...ir.shots, ...ir.audio]) {
    if ('role' in clip && clip.role === 'narration' && clip.assetId === narrationId) continue;
    const seen = new Set<string>();
    let assetId = clip.assetId;
    while (true) {
      invariant(!seen.has(assetId), 'ASSET_CYCLE', 'Cyclic material provenance');
      seen.add(assetId);
      const asset = indexed.get(assetId);
      invariant(asset, 'IR_ASSET', `Unknown source asset ${assetId}`);
      invariant(asset.source.kind !== 'web', 'LOCAL_ONLY', `Clip ${clip.id} uses a network source`);
      if (asset.source.parentAssetId) {
        assetId = asset.source.parentAssetId;
        continue;
      }
      invariant(asset.source.kind === 'local', 'LOCAL_ONLY', `Clip ${clip.id} has no local source`);
      break;
    }
  }
  return ir;
}
