import { z } from 'zod';
import { invariant } from './util.js';

const text = z.string().trim().min(1).max(180);
const modality = z.enum(['any', 'visual', 'audio', 'text']);
const interval = z
  .object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() })
  .strict();
export const predicateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('layout_mode'),
      mode: z.enum(['single', 'left_right', 'top_bottom']),
      interval: interval.nullable(),
    })
    .strict()
    .describe(
      'Rendered rectangular media-layer arrangement throughout the interval. Does not prove subject, motion, or emotional meaning.',
    ),
  z
    .object({
      kind: z.literal('playback_rate'),
      region: z.enum(['all', 'left', 'right', 'top', 'bottom']),
      rate: z.number().finite().min(0).max(10),
      approximate: z
        .boolean()
        .default(false)
        .describe(
          'Only for an explicitly approximate source rate: round measured rate to the decimal precision of rate, at least one decimal place. Exact rates are never rounded.',
        ),
      interval: interval.nullable(),
    })
    .strict()
    .describe(
      'Configured source playback multiplier throughout the interval; zero means explicit freeze. Side selectors require the corresponding two-panel arrangement. Does not measure perceived motion.',
    ),
  z
    .object({
      kind: z.literal('at'),
      modality,
      claim: text,
      at: z.number().finite().nonnegative(),
    })
    .strict()
    .describe(
      'Observe the rendered frame at this time, not the remainder of the film. The duration endpoint selects the last frame.',
    ),
  z
    .object({
      kind: z.literal('event_spacing'),
      modality,
      event: text,
      seconds: z.number().finite().positive(),
      interval: interval.nullable(),
    })
    .strict()
    .describe(
      'At least two grounded occurrences; every adjacent event gap equals seconds within one rendered frame. Requires complete interval evidence; simultaneous distinct events fail.',
    ),
  z
    .object({
      kind: z.literal('same_entity'),
      modality,
      facts: z.array(text).min(2).max(12),
      interval: interval.nullable(),
    })
    .strict()
    .describe(
      'One observed entity must independently satisfy every existential fact in this interval. Does not establish order, simultaneity, continuous coverage, or causality.',
    ),
  z
    .object({
      kind: z.literal('observation'),
      modality,
      claim: text,
      coverage: z
        .enum(['some', 'all', 'whole'])
        .describe(
          'some: one supporting observation; all: each observation must support the claim and cover every moment; whole: evaluate the complete interval together, including cross-shot relationships.',
        ),
      interval: interval.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sequence'),
      modality,
      claim: text,
      steps: z.array(text).min(2).max(12),
      interval: interval.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('order'), modality, before: text, after: text }).strict(),
  z
    .object({
      kind: z.literal('state_changes'),
      modality,
      states: z.tuple([text, text]),
      value: z.number().int().nonnegative(),
      interval: interval.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('count'),
      modality,
      subject: text,
      operator: z.enum(['eq', 'gte', 'lte']),
      value: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('program'),
      rule: z.enum([
        'silent',
        'no_music',
        'no_narration',
        'narration_only',
        'no_sfx',
        'no_subtitles',
        'no_added_text',
        'preserve_frame',
        'source_reordered',
      ]),
      value: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('track_count'),
      role: z.enum(['narration', 'music', 'effect', 'ambience', 'dialogue', 'all']),
      value: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type Predicate = z.infer<typeof predicateSchema>;
export type AcceptanceSource = {
  id: string;
  text: string;
  quote: string;
  group: 'fixed' | 'expression';
  modality: 'any' | 'visual' | 'audio' | 'text';
  stage: 'editorial' | 'render';
};
export const acceptancePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(
      z.object({ sourceId: z.string().min(1), checks: z.array(predicateSchema).min(1).max(24) }).strict(),
    ),
  })
  .strict();
export type AcceptancePlan = z.infer<typeof acceptancePlanSchema>;
/** Keep source seconds through compilation; the renderer alone chooses sample indices.
 * Detect the common lossy conversion of an explicit time into a rounded frame timestamp.
 * Relative/derived times are not guessed or rewritten by this check. */
export function validateHardTemporalPrecision(
  plan: AcceptancePlan,
  sources: AcceptanceSource[],
  fps: number,
) {
  for (const item of plan.sources) {
    const text = sources.find((s) => s.id === item.sourceId)!.text;
    const literals = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:[-–—~至到]\s*(\d+(?:\.\d+)?)\s*)?秒/g)].flatMap(
      (m) => [m[1], m[2]].filter((n): n is string => n !== undefined).map(Number),
    );
    for (const check of item.checks) {
      if (!('interval' in check) || !check.interval) continue;
      for (const supplied of [check.interval.start, check.interval.end]) {
        if (literals.some((n) => Math.abs(n - supplied) < 1e-9)) continue;
        for (const original of literals) {
          const frameTimes = [Math.floor(original * fps) / fps, Math.ceil(original * fps) / fps];
          invariant(
            !frameTimes.some((t) => Math.abs(t - original) > 1e-9 && Math.abs(t - supplied) < 0.0001),
            'ACCEPTANCE_TIME_PRECISION',
            `Keep the original ${original} seconds in ${item.sourceId}, not the pre-quantized ${supplied}. Frame sampling happens once in the renderer; repair the plan, not the cut.`,
          );
        }
      }
    }
  }
  return plan;
}
// Production compiles only measurable parameters. Meaning stays in the original sources.
export const hardPredicateSchema = z.union([
  predicateSchema.options[0]!,
  predicateSchema.options[1]!,
  predicateSchema.options[10]!,
  predicateSchema.options[11]!,
]);
export const hardAcceptancePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(
      z.object({ sourceId: z.string().min(1), checks: z.array(hardPredicateSchema).max(24) }).strict(),
    ),
  })
  .strict();
export const acceptanceReviewSchema = z
  .object({
    sources: z.array(
      z
        .object({
          sourceId: z.string().min(1),
          verdict: z.enum(['equivalent', 'missing', 'changed', 'uncertain']),
          reason: z.string().trim().min(1),
          counterexamples: z.array(
            z
              .object({
                direction: z.enum(['requirement_without_checks', 'checks_without_requirement']),
                scenario: z.string().trim().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

/** Global audio predicates are integer constraints, not a model judgment. */
function validateAudioConstraints(plan: AcceptancePlan) {
  const roles = ['narration', 'music', 'effect', 'ambience', 'dialogue'] as const;
  const bounds = new Map<string, { min: number; max: number }>(
    roles.map((role) => [role, { min: 0, max: Infinity }]),
  );
  let total: number | undefined;
  for (const source of plan.sources)
    for (const check of source.checks) {
      if (check.kind === 'track_count') {
        if (check.role === 'all') {
          invariant(
            total === undefined || total === check.value,
            'ACCEPTANCE_CONFLICT',
            'Contradictory global audio counts',
          );
          total = check.value;
        } else {
          const bound = bounds.get(check.role)!;
          bound.min = Math.max(bound.min, check.value);
          bound.max = Math.min(bound.max, check.value);
        }
      } else if (check.kind === 'program') {
        const silentRoles =
          check.rule === 'silent'
            ? roles
            : check.rule === 'narration_only'
              ? roles.filter((role) => role !== 'narration')
              : check.rule === 'no_music'
                ? ['music']
                : check.rule === 'no_narration'
                  ? ['narration']
                  : check.rule === 'no_sfx'
                    ? ['effect']
                    : [];
        for (const role of silentRoles) bounds.get(role)!.max = 0;
        if (check.rule === 'narration_only')
          bounds.get('narration')!.min = Math.max(bounds.get('narration')!.min, 1);
      }
    }
  for (const [role, bound] of bounds)
    invariant(
      bound.min <= bound.max,
      'ACCEPTANCE_CONFLICT',
      `Contradictory global audio conditions for ${role}: at least ${bound.min}, at most ${bound.max}. Program rules apply to the whole work; not adding sound at a transition does not mean global silence.`,
    );
  const values = [...bounds.values()];
  invariant(
    total === undefined ||
      (values.reduce((n, b) => n + b.min, 0) <= total && values.reduce((n, b) => n + b.max, 0) >= total),
    'ACCEPTANCE_CONFLICT',
    'Global total audio count conflicts with role counts or silence rules',
  );
}

export function validateAcceptancePlan(plan: AcceptancePlan, sources: AcceptanceSource[], duration: number) {
  invariant(
    plan.sources.length === sources.length &&
      new Set(plan.sources.map((s) => s.sourceId)).size === sources.length &&
      plan.sources.every((s) => sources.some((source) => source.id === s.sourceId)),
    'ACCEPTANCE_SOURCE',
    'Cover every original requirement exactly once; do not invent or omit sources',
  );
  for (const source of plan.sources)
    for (const check of source.checks) {
      if (check.kind === 'at')
        invariant(check.at <= duration, 'ACCEPTANCE_TIME', 'Point check must fit the work duration');
      if ('interval' in check && check.interval)
        invariant(
          check.interval.end > check.interval.start && check.interval.end <= duration,
          'ACCEPTANCE_TIME',
          'Acceptance interval must fit the work duration',
        );
      const claims =
        check.kind === 'at'
          ? [check.claim]
          : check.kind === 'event_spacing'
            ? [check.event]
            : check.kind === 'same_entity'
              ? check.facts
              : check.kind === 'sequence'
                ? [check.claim, ...check.steps]
                : check.kind === 'observation'
                  ? [check.claim]
                  : check.kind === 'order'
                    ? [check.before, check.after]
                    : check.kind === 'state_changes'
                      ? check.states
                      : [];
      invariant(
        claims.every((claim) => !/\d+(?:\.\d+)?\s*(?:[–—~\-]|到|至)\s*\d+(?:\.\d+)?\s*秒/.test(claim)),
        'ACCEPTANCE_ATOMIC',
        'Put timeline ranges in interval fields, not semantic claims',
      );
      if (check.kind === 'state_changes')
        invariant(
          check.states[0] !== check.states[1],
          'ACCEPTANCE_STATES',
          'State changes require two distinct states',
        );
      if (check.kind === 'same_entity')
        invariant(
          new Set(check.facts).size === check.facts.length,
          'ACCEPTANCE_ATOMIC',
          'Entity facts must describe distinct necessary observations',
        );
    }
  validateAudioConstraints(plan);
  return plan;
}
export function validateAcceptanceReview(
  review: z.infer<typeof acceptanceReviewSchema>,
  sources: AcceptanceSource[],
) {
  invariant(
    review.sources.length === sources.length &&
      new Set(review.sources.map((s) => s.sourceId)).size === sources.length &&
      review.sources.every((s) => sources.some((source) => source.id === s.sourceId)),
    'ACCEPTANCE_SOURCE',
    'Review each original requirement exactly once',
  );
  return review;
}
