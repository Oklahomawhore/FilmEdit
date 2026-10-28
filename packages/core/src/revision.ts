import { z } from 'zod';
import type { Asset, EditorialIR, RenderIR } from './domain.js';
import { editorialSchema } from './domain.js';
import { evaluateFrame } from './layout.js';
import { canonical, hash, invariant } from './util.js';

/** A layout agent can request a new edit, but cannot mutate the approved timeline. */
export const editorialRevisionSchema = z
  .object({
    kind: z.literal('editorial_request'),
    editorialHash: z.string().regex(/^[a-f0-9]{64}$/),
    bindingIds: z.array(z.string().min(1)).min(1),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export function validateEditorialRequest(input: unknown, editorial: EditorialIR) {
  const request = editorialRevisionSchema.parse(input);
  invariant(
    request.editorialHash === hash(editorial),
    'STALE_EDITORIAL',
    'Revision request references a different edit',
  );
  const bindings = new Set(
    [...editorial.shots, ...editorial.audio, ...editorial.text].map((item) => item.id),
  );
  invariant(
    request.bindingIds.every((id) => bindings.has(id)),
    'IR_BINDING',
    'Revision request must identify existing timeline bindings',
  );
  return request;
}

export const timeScopeSchema = z
  .object({
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
  })
  .strict()
  .refine((s) => s.end > s.start, 'Scope end must follow start');
export type TimeScope = z.infer<typeof timeScopeSchema>;
export type RevisionGuard = { version: number; scope: TimeScope; editorial: EditorialIR; layout?: RenderIR };
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const windows = (duration: number, scope: TimeScope) =>
  [
    [0, scope.start],
    [scope.end, duration],
  ].filter(([a, b]) => b! > a!);
const intersection = (start: number, duration: number, window: number[]) => {
  const a = Math.max(start, window[0]!),
    b = Math.min(start + duration, window[1]!);
  return b > a + 1e-6 ? [a, b] : undefined;
};
const sampled = (points: number[], begin: number, end: number) => {
  const knots = [...new Set([begin, end, ...points.filter((t) => t > begin && t < end)])].sort(
    (a, b) => a - b,
  );
  return [...knots, ...knots.slice(1).map((t, i) => (t + knots[i]!) / 2)].sort((a, b) => a - b);
};
const gain = (clip: EditorialIR['audio'][number], t: number) =>
  clip.volume *
  (clip.fadeIn ? Math.min(1, Math.max(0, (t - clip.start) / clip.fadeIn)) : 1) *
  (clip.fadeOut ? Math.min(1, Math.max(0, (clip.start + clip.duration - t) / clip.fadeOut)) : 1);

/** Compare the actual timeline outside the permitted interval, including clipped source positions. */
export function validateScopedEditorial(next: EditorialIR, guard: RevisionGuard, assets: Asset[]) {
  const before = editorialSchema.parse(guard.editorial),
    scope = timeScopeSchema.parse(guard.scope);
  invariant(
    scope.end <= before.duration && next.duration === before.duration,
    'REVISION_SCOPE',
    'Local revision must preserve timeline duration',
  );
  const project = (ir: EditorialIR) => {
    const result: unknown[] = [];
    for (const [kind, clips] of [
      ['shots', ir.shots],
      ['audio', ir.audio],
      ['text', ir.text],
    ] as const) {
      for (const c of clips)
        for (const window of windows(ir.duration, scope)) {
          const span = intersection(c.start, c.duration, window);
          if (!span) continue;
          const [start, end] = span as [number, number];
          const { start: originalStart, duration, ...value } = c;
          const item: Record<string, unknown> = {
            ...value,
            kind,
            start: round(start),
            duration: round(end - start),
          };
          if ('assetId' in c) {
            const image = assets.find((a) => a.id === c.assetId)?.kind === 'image';
            const frozen = 'techniques' in c && c.techniques.some((t) => t.id === 'freeze');
            const reverse = 'techniques' in c && c.techniques.some((t) => t.id === 'reverse');
            item.sourceStart = image
              ? 0
              : frozen
                ? c.sourceStart
                : round(
                    c.sourceStart +
                      (reverse ? duration - (start - originalStart) : start - originalStart) * c.speed,
                  );
          }
          if ('fadeIn' in c) {
            delete item.fadeIn;
            delete item.fadeOut;
            delete item.volume;
            const original = before.audio.find((a) => a.id === c.id),
              updated = next.audio.find((a) => a.id === c.id);
            const times = sampled(
              [original, updated].flatMap((a) =>
                a ? [a.start + a.fadeIn, a.start + a.duration - a.fadeOut] : [],
              ),
              start,
              end,
            );
            item.gain = times.map((t) => [round(t), round(gain(c, t))]);
          }
          result.push(item);
        }
    }
    // Non-cut transitions span time; their parameters must remain intact outside the edit interval.
    for (const t of ir.transitions.filter((t) => t.kind !== 'cut')) {
      const start = ir.shots.find((s) => s.id === t.to)!.start;
      if (windows(ir.duration, scope).some((w) => intersection(start, t.duration, w)))
        result.push({ ...t, start, kind: 'transition', transition: t.kind });
    }
    return result.map(canonical).sort();
  };
  invariant(
    canonical(project(before)) === canonical(project(next)),
    'REVISION_SCOPE',
    `Only ${scope.start}–${scope.end}s may change. Preserve binding IDs, source positions, sound, text and transitions outside that interval; split a crossing clip while keeping its unchanged part's ID.`,
  );
  return next;
}

/** Verify spatial and animated appearance of unaffected bindings, not just the editorial cut. */
export function validateScopedLayout(next: RenderIR, editorial: EditorialIR, guard: RevisionGuard) {
  const before = guard.layout;
  invariant(before, 'REVISION_SCOPE', 'A scoped layout revision requires an approved baseline layout');
  invariant(
    canonical(next.canvas) === canonical(before.canvas),
    'REVISION_SCOPE',
    'Local revision cannot change the canvas',
  );
  const project = (render: RenderIR, cut: EditorialIR, other: RenderIR, otherCut: EditorialIR) => {
    const result: unknown[] = [];
    const absoluteFrames = (node: RenderIR['nodes'][number], r: RenderIR, ir: EditorialIR) => {
      const binding = [...ir.shots, ...ir.text].find((c) => c.id === node.bindingId);
      const offset = r.animationTimebase === 'binding' ? (binding?.start ?? 0) : 0;
      return { offset, points: node.keyframes.map((f) => f.time + offset) };
    };
    for (const node of render.nodes.filter((n) => n.kind !== 'group')) {
      const binding = [...cut.shots, ...cut.text].find((c) => c.id === node.bindingId)!;
      for (const window of windows(cut.duration, guard.scope)) {
        const span = intersection(binding.start, binding.duration, window);
        if (!span) continue;
        const chain: unknown[] = [];
        let current: RenderIR['nodes'][number] | undefined = node;
        while (current) {
          const n: RenderIR['nodes'][number] = current;
          const paired = other.nodes.find((x) =>
            n.kind === 'group' ? x.id === n.id : x.bindingId === n.bindingId && x.kind === n.kind,
          );
          const own = absoluteFrames(n, render, cut),
            pair = paired ? absoluteFrames(paired, other, otherCut) : { points: [] };
          const { id, bindingId, parentId, keyframes, ...appearance } = n;
          chain.push({
            appearance,
            motion: sampled([...own.points, ...pair.points], span[0]!, span[1]!).map((t) => ({
              time: round(t),
              ...Object.fromEntries(
                Object.entries(evaluateFrame(n, t - own.offset)).map(([k, v]) => [k, round(v)]),
              ),
            })),
          });
          current = n.parentId ? render.nodes.find((p) => p.id === n.parentId) : undefined;
        }
        result.push({ bindingId: binding.id, span: span.map(round), chain });
      }
    }
    return result.map(canonical).sort();
  };
  invariant(
    canonical(project(before, guard.editorial, next, editorial)) ===
      canonical(project(next, editorial, before, guard.editorial)),
    'REVISION_SCOPE',
    'Layout or animation outside the requested interval changed; preserve the approved appearance there',
  );
  return next;
}
