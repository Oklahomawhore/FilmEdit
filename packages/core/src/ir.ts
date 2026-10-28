import {
  audienceSchema,
  editorialSchema,
  renderSchema,
  type Asset,
  type AudienceIR,
  type EditorialIR,
  type RenderIR,
} from './domain.js';
import { FilmError, hash, invariant } from './util.js';

const unique = (items: string[], label: string) =>
  invariant(new Set(items).size === items.length, 'IR_DUPLICATE_ID', `Duplicate ${label} ID`);
export const RENDERED_AUDIO_BINDING = 'rendered_audio';
export function validateEditorial(input: unknown, assets: Asset[]): EditorialIR {
  const ir = editorialSchema.parse(input);
  invariant(
    [...ir.shots, ...ir.audio, ...ir.text].every((item) => item.id !== RENDERED_AUDIO_BINDING),
    'IR_RESERVED_ID',
    'rendered_audio is reserved for evidence of the actual final mix',
  );
  unique(
    [...ir.shots, ...ir.audio, ...ir.text].map((x) => x.id),
    'binding',
  );
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const item of [...ir.shots, ...ir.audio]) {
    const asset = byId.get(item.assetId);
    invariant(asset, 'IR_ASSET', `Unknown asset ${item.assetId}`);
    invariant(item.start + item.duration <= ir.duration + 1e-6, 'IR_TIME', `${item.id} exceeds timeline`);
    const frozen = 'techniques' in item && item.techniques.some((t) => t.id === 'freeze');
    invariant(
      asset.kind === 'image' ||
        (frozen
          ? item.sourceStart < asset.duration
          : item.sourceStart + item.duration * item.speed <= asset.duration + 0.05),
      'IR_SOURCE_RANGE',
      `${item.id} exceeds source duration`,
    );
    if ('role' in item) invariant(asset.hasAudio, 'IR_AUDIO', `${item.assetId} has no audio`);
    else
      invariant(['image', 'video'].includes(asset.kind), 'IR_VISUAL', `${item.assetId} is not visual media`);
  }
  // Track 0 carries the continuous base picture. Other tracks may enter/leave independently.
  const shots = ir.shots
    .filter((s) => s.track === 0)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  let covered = 0;
  for (const shot of shots) {
    invariant(shot.start <= covered + 1e-6, 'IR_GAP', `Uncovered video at ${covered}s`);
    covered = Math.max(covered, shot.start + shot.duration);
  }
  invariant(
    Math.abs(covered - ir.duration) < 0.05,
    'IR_DURATION',
    'Visual timeline must cover the complete duration',
  );
  for (const text of ir.text)
    invariant(text.start + text.duration <= ir.duration + 1e-6, 'IR_TIME', `${text.id} exceeds timeline`);
  const pairs = new Set<string>();
  for (const t of ir.transitions) {
    const a = ir.shots.find((s) => s.id === t.from);
    const b = ir.shots.find((s) => s.id === t.to);
    invariant(
      a && b && a.start < b.start && a.track === b.track,
      'IR_TRANSITION',
      'Transition needs ordered, existing shots on the same track',
    );
    invariant(!pairs.has(`${a.id}:${b.id}`), 'IR_TRANSITION', 'Duplicate transition');
    pairs.add(`${a.id}:${b.id}`);
    const overlap = a.start + a.duration - b.start;
    invariant(
      t.kind === 'cut'
        ? t.duration === 0 && Math.abs(overlap) < 1e-6
        : t.duration > 0 && Math.abs(overlap - t.duration) < 0.05,
      'IR_TRANSITION',
      'Transition duration must equal shot overlap',
    );
  }
  for (const track of new Set(ir.shots.map((s) => s.track))) {
    const clips = ir.shots
      .filter((s) => s.track === track)
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (let i = 0; i < clips.length; i++) {
      const shot = clips[i]!;
      const active = clips.slice(0, i).filter((s) => s.start + s.duration > shot.start + 1e-6);
      invariant(active.length <= 1, 'IR_OVERLAP', `Track ${track} has more than two simultaneous clips`);
      if (active.length)
        invariant(
          pairs.has(`${active[0]!.id}:${shot.id}`),
          'IR_OVERLAP',
          `Overlapping shots on track ${track} need a transition; independent pictures use different tracks`,
        );
    }
  }
  return ir;
}
export function validateRender(input: unknown, editorial: EditorialIR): RenderIR {
  const ir = renderSchema.parse(input);
  invariant(
    ir.editorialHash === hash(editorial),
    'STALE_EDITORIAL',
    'RenderIR references a different EditorialIR',
  );
  unique(
    ir.nodes.map((n) => n.id),
    'node',
  );
  const nodes = new Map(ir.nodes.map((n) => [n.id, n]));
  const bindings = new Map([
    ...editorial.shots.map((s) => [s.id, 'media'] as const),
    ...editorial.text.map((t) => [t.id, 'text'] as const),
  ]);
  for (const node of ir.nodes) {
    if (node.kind !== 'group')
      invariant(
        node.bindingId && bindings.get(node.bindingId) === node.kind,
        'IR_BINDING',
        `Invalid binding for ${node.id}`,
      );
    else invariant(!node.bindingId, 'IR_BINDING', 'Groups cannot change editorial bindings');
    const ancestors = new Set([node.id]);
    let parent = node.parentId;
    while (parent) {
      invariant(!ancestors.has(parent), 'IR_CYCLE', `Cyclic group at ${node.id}`);
      ancestors.add(parent);
      const p = nodes.get(parent);
      invariant(p?.kind === 'group', 'IR_PARENT', `Unknown group ${parent}`);
      parent = p.parentId;
    }
    const binding = [...editorial.shots, ...editorial.text].find((b) => b.id === node.bindingId);
    const duration = ir.animationTimebase === 'binding' && binding ? binding.duration : editorial.duration;
    let time = -1;
    for (const frame of node.keyframes) {
      invariant(
        frame.time > time && frame.time <= duration,
        'IR_KEYFRAME',
        'Keyframes must be unique, sorted and inside their declared timebase',
      );
      time = frame.time;
    }
    if (node.crop)
      invariant(
        node.crop[0] >= 0 &&
          node.crop[1] >= 0 &&
          node.crop[0] + node.crop[2] <= 1.000001 &&
          node.crop[1] + node.crop[3] <= 1.000001,
        'IR_CROP',
        'Crop rectangle must be inside the source',
      );
  }
  for (const bindingId of bindings.keys())
    invariant(
      ir.nodes.some((n) => n.bindingId === bindingId),
      'IR_MISSING_BINDING',
      `Missing visible element ${bindingId}`,
    );
  return ir;
}
export function citedAudienceEvidence(audience: AudienceIR) {
  const cited = new Set(
    [
      ...audience.claims.filter((item) => item.confidence >= 0.7),
      ...audience.events,
      ...audience.relations,
      ...audience.quantities.filter((item) => item.confidence >= 0.7),
      ...audience.emotionTimeline,
    ].flatMap((item) => item.evidenceIds),
  );
  return audience.evidence.filter((item) => cited.has(item.id));
}

export function validateAudienceEntities(audience: AudienceIR, editorial: EditorialIR) {
  const mediaIds = new Set([
    ...[...editorial.shots, ...editorial.audio].flatMap((item) => [item.id, item.assetId]),
    ...editorial.text.map((item) => item.id),
    RENDERED_AUDIO_BINDING,
  ]);
  invariant(
    audience.evidence.every((item) => item.entityId === null || !mediaIds.has(item.entityId)),
    'EVIDENCE_ENTITY',
    'Entity IDs identify observed subjects, not shots, files or tracks. Use null for uncertain identity or multiple subjects.',
  );
}

export function validateAudience(input: unknown, editorial: EditorialIR, renderedAudio = false): AudienceIR {
  const audience = audienceSchema.parse(input);
  validateAudienceEntities(audience, editorial);
  invariant(
    new Set(audience.evidence.map((e) => e.id)).size === audience.evidence.length,
    'EVIDENCE_DUPLICATE',
    'Each evidence.id must be unique',
  );
  const bindings = new Map<string, { start: number; duration: number }>(
    [...editorial.shots, ...editorial.audio, ...editorial.text].map((x) => [x.id, x]),
  );
  if (renderedAudio) bindings.set(RENDERED_AUDIO_BINDING, { start: 0, duration: editorial.duration });
  for (const evidence of audience.evidence) {
    const binding = bindings.get(evidence.bindingId);
    if (!(
      binding &&
      evidence.start >= binding.start - 0.05 &&
      evidence.end >= evidence.start &&
      evidence.end <= binding.start + binding.duration + 0.05
    ))
      throw new FilmError(
        'EVIDENCE_RANGE',
        `Evidence ${evidence.id} references an invalid timeline interval`,
        {
          evidenceId: evidence.id,
          bindingId: evidence.bindingId,
          received: { start: evidence.start, end: evidence.end },
          allowed: binding ? { start: binding.start, end: binding.start + binding.duration } : null,
        },
      );
    if (evidence.modality === 'audio')
      invariant(
        editorial.audio.some((a) => a.id === evidence.bindingId) ||
          (renderedAudio && evidence.bindingId === RENDERED_AUDIO_BINDING),
        'EVIDENCE_MODALITY',
        'Audio evidence must refer to an audio binding',
      );
    if (evidence.modality === 'visual')
      invariant(
        editorial.shots.some((a) => a.id === evidence.bindingId),
        'EVIDENCE_MODALITY',
        'Visual evidence must refer to a shot',
      );
    if (evidence.modality === 'text')
      invariant(
        [...editorial.text, ...editorial.shots].some((a) => a.id === evidence.bindingId),
        'EVIDENCE_MODALITY',
        `Text evidence ${evidence.id} must refer to a text binding or a shot containing visible text, not audio (${evidence.bindingId})`,
      );
  }
  const ids = new Set(audience.evidence.map((e) => e.id));
  for (const item of [
    ...audience.claims,
    ...audience.events,
    ...audience.relations,
    ...audience.quantities,
    ...audience.emotionTimeline,
  ])
    for (const evidenceId of item.evidenceIds)
      invariant(ids.has(evidenceId), 'EVIDENCE_MISSING', `Unknown evidence ${evidenceId}`);
  for (const event of audience.events) {
    invariant(event.at <= editorial.duration, 'EVIDENCE_RANGE', 'Event is outside the timeline');
    invariant(
      audience.evidence.some(
        (e) => event.evidenceIds.includes(e.id) && event.at >= e.start && event.at <= e.end,
      ),
      'EVIDENCE_RANGE',
      'Event timestamp must lie inside its cited evidence',
    );
  }
  for (const issue of audience.issues) {
    if (issue.bindingId)
      invariant(
        bindings.has(issue.bindingId),
        'EVIDENCE_MISSING',
        'Review issue references an unknown binding',
      );
    if (issue.time !== undefined)
      invariant(issue.time <= editorial.duration, 'EVIDENCE_RANGE', 'Review issue is outside the timeline');
  }
  return audience;
}
export function blindEditorial(editorial: EditorialIR, assets: Asset[]) {
  // Do not serialize source titles, filenames, script, account memory, technique names or intent.
  return {
    duration: editorial.duration,
    shots: editorial.shots.map(({ id, assetId, track, start, duration, sourceStart, speed, techniques }) => ({
      id,
      assetId,
      track,
      start,
      duration,
      sourceStart,
      speed,
      playback: {
        reverse: techniques.some((t) => t.id === 'reverse'),
        freeze: techniques.some((t) => t.id === 'freeze'),
      },
    })),
    transitions: editorial.transitions,
    audio: editorial.audio,
    text: editorial.text,
    assets: assets
      .filter((a) => [...editorial.shots, ...editorial.audio].some((s) => s.assetId === a.id))
      .map((a) => ({ id: a.id, kind: a.kind, duration: a.duration })),
    audioEvidence: editorial.audio.map((a) => ({
      bindingId: a.id,
      transcript: transcriptForAudio(
        a,
        assets.find((asset) => asset.id === a.assetId)!,
      ),
    })),
  };
}
export function transcriptForAudio(binding: EditorialIR['audio'][number], asset: Asset) {
  const end = binding.sourceStart + binding.duration * binding.speed;
  // Boundary-straddling ASR segments are omitted: unseen speech cannot support a judgment.
  return asset.transcript
    .filter((s) => s.start >= binding.sourceStart - 0.001 && s.end <= end + 0.001)
    .map((s) => ({
      text: s.text,
      start: binding.start + (s.start - binding.sourceStart) / binding.speed,
      end: binding.start + (s.end - binding.sourceStart) / binding.speed,
    }));
}
export function neutralizeEditorial(editorial: EditorialIR) {
  const forward = new Map(
    [...editorial.shots, ...editorial.audio, ...editorial.text].map((item, index) => [
      item.id,
      `element_${String(index + 1).padStart(4, '0')}`,
    ]),
  );
  const backward = new Map([...forward].map(([a, b]) => [b, a]));
  const cut: EditorialIR = {
    ...editorial,
    shots: editorial.shots.map((s) => ({
      ...s,
      id: forward.get(s.id)!,
      techniques: s.techniques.filter((t) => ['reverse', 'freeze'].includes(t.id)),
    })),
    audio: editorial.audio.map((a) => ({ ...a, id: forward.get(a.id)! })),
    text: editorial.text.map((t) => ({ ...t, id: forward.get(t.id)! })),
    transitions: editorial.transitions.map((t) => ({
      ...t,
      from: forward.get(t.from)!,
      to: forward.get(t.to)!,
    })),
  };
  const restore = (audience: AudienceIR): AudienceIR => ({
    ...audience,
    evidence: audience.evidence.map((e) => ({ ...e, bindingId: backward.get(e.bindingId) ?? e.bindingId })),
    issues: audience.issues.map((i) => ({
      ...i,
      ...(i.bindingId ? { bindingId: backward.get(i.bindingId) ?? i.bindingId } : {}),
    })),
  });
  return { cut, restore };
}
export function defaultRender(
  editorial: EditorialIR,
  canvas: { width: number; height: number; fps: number; background?: string },
  mediaFit: 'contain' | 'cover' = 'contain',
): RenderIR {
  return renderSchema.parse({
    schemaVersion: 1,
    editorialHash: hash(editorial),
    animationTimebase: 'binding',
    canvas: { width: canvas.width, height: canvas.height, fps: canvas.fps, background: canvas.background },
    nodes: [
      ...editorialSchema.parse(editorial).shots.map((s, i) => ({
        id: `node_${s.id}`,
        bindingId: s.id,
        kind: 'media',
        fit: mediaFit,
        placement: { mode: 'rect', rect: [0, 0, 1, 1] },
        z: s.track * (editorial.shots.length + 1) + i,
      })),
      ...editorial.text.map((t) => ({
        id: `node_${t.id}`,
        bindingId: t.id,
        kind: 'text',
        placement: { mode: 'rect', rect: [0.07, t.role === 'title' ? 0.1 : 0.76, 0.86, 0.16] },
        z: 1000,
        style: {
          fontSize: ((t.role === 'title' ? 72 : 48) * Math.min(canvas.width, canvas.height)) / 1080,
          background: '#111111',
        },
      })),
    ],
  });
}
