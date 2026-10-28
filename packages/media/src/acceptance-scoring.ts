import type { AudienceIR, EditorialIR, RenderIR } from '../../core/src/domain.js';
import { audienceSchema } from '../../core/src/domain.js';
import type { AcceptancePlan, AcceptanceSource, Predicate } from '../../core/src/acceptance.js';
import { validateAcceptancePlan } from '../../core/src/acceptance.js';
import { validateComposition } from '../../core/src/presentation.js';
import { citedAudienceEvidence, validateAudienceEntities } from '../../core/src/ir.js';
import { FilmError, hash, invariant } from '../../core/src/util.js';
import type { SemanticModel, SemanticResult } from './scoring.js';
import { measurePresentation } from './presentation-scoring.js';

type CheckResult = {
  predicate: Predicate;
  support: number;
  status: 'supported' | 'contradicted' | 'unknown';
  evidenceIds: string[];
  basis: 'audience' | 'ir';
  diagnostic?: string;
  failure?: 'input_too_long';
  capacity?: { inputTokens: number; maxInputTokens: number; evidenceIds: string[] };
};
const unknown = (predicate: Predicate, diagnostic?: string): CheckResult => ({
  predicate,
  support: 0,
  status: 'unknown',
  evidenceIds: [],
  basis: 'audience',
  diagnostic,
});
const covers = (intervals: { start: number; end: number }[], start: number, end: number) => {
  let cursor = start;
  for (const span of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (span.start > cursor + 1e-6) return false;
    cursor = Math.max(cursor, span.end);
    if (cursor >= end - 1e-6) return true;
  }
  return false;
};

/** Deterministic execution of a frozen requirement plan. NLI sees only atomic claims and cited observations. */
export async function scoreAcceptance(
  model: SemanticModel,
  sources: AcceptanceSource[],
  plan: AcceptancePlan,
  output: AudienceIR,
  context: { editorial: EditorialIR; render?: RenderIR; renderedFps?: number; stage: 'editorial' | 'render' },
  threshold = 0.15,
) {
  validateAcceptancePlan(plan, sources, context.editorial.duration);
  const audience = audienceSchema.parse(output);
  validateAudienceEntities(audience, context.editorial);
  const evidence = new Map(audience.evidence.map((e) => [e.id, e]));
  invariant(evidence.size === audience.evidence.length, 'EVIDENCE_DUPLICATE', 'Duplicate evidence IDs');
  const cited = new Set(
    [
      ...audience.claims.filter((c) => c.confidence >= 0.7),
      ...audience.events,
      ...audience.relations,
      ...audience.quantities.filter((c) => c.confidence >= 0.7),
      ...audience.emotionTimeline,
    ].flatMap((c) => c.evidenceIds),
  );
  invariant(
    [...cited].every((id) => evidence.has(id)),
    'EVIDENCE_MISSING',
    'Claims cite unknown evidence',
  );
  const observed = citedAudienceEvidence(audience);
  const pairs = new Map<string, { premise: string; hypothesis: string }>();
  const checkPairs = new Map<Predicate, Set<string>>();
  const pairEvidence = new Map<string, Set<string>>();
  const key = (premise: string, hypothesis: string) => JSON.stringify([premise, hypothesis]);
  const collect = (check: Predicate, premise: string, hypothesis: string, evidenceIds?: string[]) => {
    const id = key(premise, hypothesis);
    pairs.set(id, { premise, hypothesis });
    if (!checkPairs.has(check)) checkPairs.set(check, new Set());
    checkPairs.get(check)!.add(id);
    if (!pairEvidence.has(id)) pairEvidence.set(id, new Set());
    for (const evidenceId of evidenceIds ??
      observed.filter((e) => e.observation === premise).map((e) => e.id))
      pairEvidence.get(id)!.add(evidenceId);
  };
  const active = sources.filter((s) => context.stage === 'render' || s.stage === 'editorial');
  const scorerVersion = `atomic-v13-capacity-evidence:${model.version}:d<${threshold}`;
  // Simultaneous source tracks have no visibility or placement until RenderIR exists.
  // Their combined visual meaning must be tested on the composed preview, not guessed here.
  const hasComposite = context.editorial.shots.some((a, index) =>
    context.editorial.shots
      .slice(index + 1)
      .some((b) => a.track !== b.track && a.start < b.start + b.duration && b.start < a.start + a.duration),
  );
  const renderingRequired = (check: Predicate) =>
    context.stage === 'editorial' &&
    (check.kind === 'layout_mode' ||
      check.kind === 'playback_rate' ||
      check.kind === 'at' ||
      check.kind === 'event_spacing' ||
      (check.kind === 'program' && check.rule === 'preserve_frame') ||
      ('modality' in check && check.modality === 'audio') ||
      (hasComposite &&
        ((check.kind === 'observation' && check.coverage === 'whole') || check.kind === 'same_entity') &&
        (check.modality === 'visual' || check.modality === 'any')));
  const eligible = (check: { modality: AcceptanceSource['modality'] }) =>
    observed.filter((e) => check.modality === 'any' || e.modality === check.modality);
  const intervalEvidence = (
    check: Pick<Extract<Predicate, { kind: 'sequence' }>, 'interval' | 'modality'>,
  ) => {
    const range = check.interval ?? { start: 0, end: context.editorial.duration };
    const samples = eligible(check)
      .filter((e) => e.start >= range.start && e.end <= range.end)
      .sort(
        (a, b) =>
          a.start - b.start ||
          a.end - b.end ||
          a.modality.localeCompare(b.modality) ||
          a.observation.localeCompare(b.observation),
      );
    // All cited observations in the interval are retained. Never cherry-pick only supporting clips,
    // substitute the observer's conclusion for evidence, or truncate a long premise.
    const premise = [
      ...new Set(samples.map((e) => `${e.start}–${e.end}秒（${e.modality}）：${e.observation}`)),
    ].join('\n');
    return { range, samples, premise };
  };
  for (const source of active) {
    for (const check of plan.sources.find((s) => s.sourceId === source.id)!.checks) {
      if (renderingRequired(check)) continue;
      const samples = 'modality' in check ? eligible(check) : [];
      if (check.kind === 'at') for (const e of samples) collect(check, e.observation, check.claim);
      if (check.kind === 'event_spacing')
        for (const event of audience.events) {
          collect(check, event.text, check.event);
          for (const e of samples.filter((e) => event.evidenceIds.includes(e.id)))
            collect(check, e.observation, check.event);
        }
      if (check.kind === 'observation') {
        if (check.coverage === 'whole') {
          const { range, samples, premise } = intervalEvidence(check);
          if (covers(samples, range.start, range.end))
            collect(
              check,
              premise,
              check.claim,
              samples.map((e) => e.id),
            );
        } else for (const e of samples) collect(check, e.observation, check.claim);
      }
      if (check.kind === 'sequence') {
        const { range, samples, premise } = intervalEvidence(check);
        if (covers(samples, range.start, range.end))
          collect(
            check,
            premise,
            check.claim,
            samples.map((e) => e.id),
          );
        for (const sample of samples)
          for (const step of check.steps) collect(check, sample.observation, step);
      }
      if (check.kind === 'same_entity') {
        const { samples } = intervalEvidence(check);
        for (const sample of samples.filter((e) => e.entityId !== null))
          for (const fact of check.facts) collect(check, sample.observation, fact);
      }
      if (check.kind === 'state_changes')
        for (const e of samples) for (const state of check.states) collect(check, e.observation, state);
      if (check.kind === 'order')
        for (const event of audience.events)
          for (const claim of [check.before, check.after]) {
            collect(check, event.text, claim);
            for (const e of samples.filter((e) => event.evidenceIds.includes(e.id)))
              collect(check, e.observation, claim);
          }
      if (check.kind === 'count')
        for (const quantity of audience.quantities.filter((q) => q.confidence >= 0.7)) {
          collect(check, quantity.subject, check.subject);
          for (const e of samples.filter((e) => quantity.evidenceIds.includes(e.id)))
            collect(check, e.observation, `${quantity.subject}的数量为${quantity.count}`);
        }
    }
  }
  const pairEntries = [...pairs.entries()];
  const values = pairEntries.length ? await model.compare(pairEntries.map(([, pair]) => pair)) : [];
  invariant(values.length === pairEntries.length, 'MODEL_OUTPUT', 'Missing semantic comparison results');
  const results = new Map(pairEntries.map(([k], i) => [k, values[i]!]));
  const result = (premise: string, hypothesis: string): SemanticResult =>
    results.get(key(premise, hypothesis))!;
  const unresolved = (check: Predicate, diagnostic: string): CheckResult => {
    const oversized = [...(checkPairs.get(check) ?? [])]
      .map((id) => ({ id, result: results.get(id)! }))
      .filter(({ result }) => result.inputTooLong);
    const largest = oversized
      .filter(({ result }) => result.inputTokens && result.maxInputTokens)
      .sort((a, b) => b.result.inputTokens! - a.result.inputTokens!)[0];
    return {
      ...unknown(check, diagnostic),
      ...(oversized.length ? { failure: 'input_too_long' as const } : {}),
      ...(largest
        ? {
            capacity: {
              inputTokens: largest.result.inputTokens!,
              maxInputTokens: largest.result.maxInputTokens!,
              evidenceIds: [...(pairEvidence.get(largest.id) ?? [])].sort(),
            },
          }
        : {}),
    };
  };
  const evaluate = (check: Predicate): CheckResult => {
    if (check.kind === 'layout_mode' || check.kind === 'playback_rate') {
      const measured = measurePresentation(check, context.editorial, context.render, context.renderedFps);
      return {
        predicate: check,
        ...measured,
        support: measured.status === 'supported' ? 1 : 0,
        evidenceIds: [],
        basis: 'ir',
      };
    }
    const samples = 'modality' in check ? eligible(check) : [];
    const supported = (support: number, ids: string[]): CheckResult => ({
      predicate: check,
      support,
      status: 'supported',
      evidenceIds: [...new Set(ids)].sort(),
      basis: 'audience',
    });
    if (check.kind === 'at' || check.kind === 'event_spacing') {
      const fps = context.renderedFps ?? context.render?.canvas.fps;
      if (!fps) return unknown(check, 'Rendered frame rate is required for temporal measurements');
      if (check.kind === 'at') {
        const frame = Math.min(
          Math.floor(check.at * fps + 1e-6),
          Math.ceil(context.editorial.duration * fps) - 1,
        );
        const at = frame / fps;
        const own = samples
          .filter((e) => e.start <= at && at < e.end)
          .map((e) => ({ e, r: result(e.observation, check.claim) }));
        if (own.some(({ r }) => !r.inputTooLong && r.contradiction >= 0.7))
          return {
            ...unknown(check),
            status: 'contradicted',
            evidenceIds: own.filter(({ r }) => r.contradiction >= 0.7).map(({ e }) => e.id),
          };
        const best = own
          .filter(({ r }) => !r.inputTooLong && r.entailment >= 0.7 && r.contradiction < 0.7)
          .sort((a, b) => b.r.entailment - a.r.entailment)[0];
        return best
          ? supported(best.r.entailment, [best.e.id])
          : unresolved(check, 'No grounded state at the requested rendered frame');
      }
      const range = check.interval ?? { start: 0, end: context.editorial.duration };
      if (
        !covers(
          samples.filter((e) => e.end > range.start && e.start < range.end),
          range.start,
          range.end,
        )
      )
        return unknown(check, 'Event spacing requires complete observations over the requested interval');
      const seen = new Set<string>();
      const occurrences: { at: number; support: number; ids: string[] }[] = [];
      for (const event of audience.events.filter((e) => e.at >= range.start && e.at <= range.end)) {
        const identity = hash({ at: event.at, text: event.text, evidenceIds: [...event.evidenceIds].sort() });
        if (seen.has(identity)) continue;
        seen.add(identity);
        const own = result(event.text, check.event);
        if (own.inputTooLong)
          return unresolved(check, 'Event identity exceeds the semantic model input limit');
        if (own.entailment < 0.7 || own.contradiction >= 0.7) continue;
        const grounding = samples
          .filter((e) => event.evidenceIds.includes(e.id) && event.at >= e.start && event.at <= e.end)
          .map((e) => ({ e, r: result(e.observation, check.event) }))
          .filter(({ r }) => !r.inputTooLong && r.entailment >= 0.7 && r.contradiction < 0.7);
        if (!grounding.length)
          return unresolved(check, 'A matching event lacks grounded evidence at its timestamp');
        occurrences.push({
          at: event.at,
          support: Math.min(own.entailment, Math.max(...grounding.map(({ r }) => r.entailment))),
          ids: grounding.map(({ e }) => e.id),
        });
      }
      occurrences.sort((a, b) => a.at - b.at);
      if (occurrences.length < 2)
        return unresolved(check, 'At least two grounded occurrences are required to measure spacing');
      const gaps = occurrences.slice(1).map((event, i) => event.at - occurrences[i]!.at);
      const ids = occurrences.flatMap((e) => e.ids);
      if (gaps.some((gap) => gap <= 0 || Math.abs(gap - check.seconds) > 1 / fps + 1e-6))
        return {
          ...unknown(
            check,
            `Observed event gaps ${gaps.join(', ')} seconds; expected ${check.seconds} within one frame`,
          ),
          status: 'contradicted',
          evidenceIds: [...new Set(ids)].sort(),
        };
      return supported(Math.min(...occurrences.map((e) => e.support)), ids);
    }
    if (check.kind === 'same_entity') {
      const { samples } = intervalEvidence(check);
      const groups = new Map<string, typeof samples>();
      for (const sample of samples) {
        if (sample.entityId === null) continue;
        if (!groups.has(sample.entityId)) groups.set(sample.entityId, []);
        groups.get(sample.entityId)!.push(sample);
      }
      const candidates: CheckResult[] = [];
      for (const own of groups.values()) {
        const matched = check.facts.map(
          (fact) =>
            own
              .map((e) => ({ e, r: result(e.observation, fact) }))
              .filter(({ r }) => !r.inputTooLong && r.entailment >= 0.7 && r.contradiction < 0.7)
              .sort((a, b) => b.r.entailment - a.r.entailment)[0],
        );
        if (matched.every((match) => match !== undefined))
          candidates.push(
            supported(
              Math.min(...matched.map((m) => m.r.entailment)),
              matched.map((m) => m.e.id),
            ),
          );
      }
      return (
        candidates.sort((a, b) => b.support - a.support)[0] ??
        unresolved(check, 'No identified single entity has grounded evidence for every required fact')
      );
    }
    if (check.kind === 'observation') {
      if (check.coverage === 'whole') {
        const { range, samples, premise } = intervalEvidence(check);
        if (!covers(samples, range.start, range.end))
          return unknown(check, 'Whole-interval evidence does not cover the requested interval');
        const r = result(premise, check.claim);
        if (r.inputTooLong)
          return unresolved(check, 'The complete interval exceeds the semantic model input limit');
        const ids = samples.map((e) => e.id);
        if (r.contradiction >= 0.7) return { ...unknown(check), status: 'contradicted', evidenceIds: ids };
        return r.entailment >= 0.7
          ? supported(r.entailment, ids)
          : unknown(check, 'The complete observed interval does not establish this relationship');
      }
      const range = check.interval ?? { start: 0, end: context.editorial.duration };
      const inRange = samples.filter((e) => e.end > range.start && e.start < range.end);
      const scored = inRange.map((e) => ({ e, r: result(e.observation, check.claim) }));
      const positives = scored.filter(
        ({ r }) => !r.inputTooLong && r.entailment >= 0.7 && r.contradiction < 0.7,
      );
      if (check.coverage === 'some') {
        const best = positives.sort((a, b) => b.r.entailment - a.r.entailment)[0];
        return best
          ? supported(best.r.entailment, [best.e.id])
          : unresolved(check, 'No grounded observation supports this claim in the required interval');
      }
      if (scored.some(({ r }) => !r.inputTooLong && r.contradiction >= 0.7))
        return {
          ...unknown(check),
          status: 'contradicted',
          evidenceIds: scored.filter(({ r }) => r.contradiction >= 0.7).map(({ e }) => e.id),
        };
      if (
        !covers(
          positives.map(({ e }) => e),
          range.start,
          range.end,
        )
      )
        return unresolved(check, 'Supported observations do not cover the entire required interval');
      return supported(
        Math.min(...positives.map(({ r }) => r.entailment)),
        positives.map(({ e }) => e.id),
      );
    }
    if (check.kind === 'sequence') {
      const { range, samples, premise } = intervalEvidence(check);
      if (!covers(samples, range.start, range.end))
        return unknown(check, 'Sequence evidence does not cover the requested interval');
      const r = result(premise, check.claim);
      if (r.inputTooLong)
        return unresolved(check, 'The complete evidence sequence exceeds the semantic model input limit');
      const ids = samples.map((e) => e.id);
      if (r.contradiction >= 0.7) return { ...unknown(check), status: 'contradicted', evidenceIds: ids };
      if (r.entailment < 0.7)
        return unknown(check, 'The observed sequence does not establish the whole-sequence claim');
      // NLI does not reliably reason about timestamps. Ground each narrative step separately,
      // then establish first/last placement and non-overlapping chronological order in code.
      let frontier: { end: number; support: number }[] = [{ end: range.start, support: r.entailment }];
      for (const [index, step] of check.steps.entries()) {
        const next: typeof frontier = [];
        for (const sample of samples) {
          if (index === 0 && sample.start !== range.start) continue;
          if (index === check.steps.length - 1 && sample.end !== range.end) continue;
          const semantic = result(sample.observation, step);
          if (semantic.inputTooLong || semantic.entailment < 0.7 || semantic.contradiction >= 0.7) continue;
          const predecessors = frontier.filter((p) => p.end <= sample.start);
          if (predecessors.length)
            next.push({
              end: sample.end,
              support: Math.min(semantic.entailment, Math.max(...predecessors.map((p) => p.support))),
            });
        }
        if (!next.length)
          return unresolved(check, `Narrative step ${index + 1} lacks evidence at its required position`);
        frontier = next;
      }
      return supported(Math.max(...frontier.map((p) => p.support)), ids);
    }
    if (check.kind === 'state_changes') {
      const range = check.interval ?? { start: 0, end: context.editorial.duration };
      const spans = samples
        .filter((e) => e.end > range.start && e.start < range.end)
        .flatMap((e) => {
          const states = check.states
            .map((claim, state) => ({ state, r: result(e.observation, claim) }))
            .filter(({ r }) => !r.inputTooLong && r.entailment >= 0.7 && r.contradiction < 0.7);
          if (states.length !== 1) return [];
          return [
            {
              start: Math.max(range.start, e.start),
              end: Math.min(range.end, e.end),
              state: states[0]!.state,
              support: states[0]!.r.entailment,
              id: e.id,
            },
          ];
        })
        .sort((a, b) => a.start - b.start || a.end - b.end);
      if (!covers(spans, range.start, range.end))
        return unresolved(check, 'State observations must cover the whole interval to count its changes');
      let changes = 0,
        previous = spans[0]!;
      for (const span of spans.slice(1)) {
        if (span.state !== previous.state) {
          if (span.start < previous.end - 1e-6)
            return unknown(check, 'Overlapping evidence assigns different states to the same time');
          changes++;
          previous = span;
        } else if (span.end > previous.end) previous = span;
      }
      const ids = spans.map((s) => s.id);
      return changes === check.value
        ? supported(Math.min(...spans.map((s) => s.support)), ids)
        : {
            ...unknown(check, `Observed ${changes} state changes; required ${check.value}`),
            status: 'contradicted',
            evidenceIds: [...new Set(ids)].sort(),
          };
    }
    if (check.kind === 'order') {
      const events = (claim: string) =>
        audience.events.flatMap((event) => {
          const own = result(event.text, claim);
          if (own.inputTooLong || own.entailment < 0.7 || own.contradiction >= 0.7) return [];
          const grounded = samples
            .filter((e) => event.evidenceIds.includes(e.id) && event.at >= e.start && event.at <= e.end)
            .map((e) => ({ e, r: result(e.observation, claim) }))
            .filter(({ r }) => !r.inputTooLong && r.entailment >= 0.7 && r.contradiction < 0.7);
          return grounded.length
            ? [
                {
                  at: event.at,
                  support: Math.min(own.entailment, Math.max(...grounded.map(({ r }) => r.entailment))),
                  ids: grounded.map(({ e }) => e.id),
                },
              ]
            : [];
        });
      const before = events(check.before),
        after = events(check.after);
      if (!before.length || !after.length)
        return unresolved(check, 'An ordered event lacks grounded evidence at its stated time');
      const candidates = before
        .flatMap((a) =>
          after
            .filter((b) => a.at < b.at)
            .map((b) => ({ support: Math.min(a.support, b.support), ids: [...a.ids, ...b.ids] })),
        )
        .sort((a, b) => b.support - a.support);
      return candidates.length
        ? supported(candidates[0]!.support, candidates[0]!.ids)
        : {
            ...unknown(check),
            status: 'contradicted',
            diagnostic: 'Observed event order is reversed or simultaneous',
          };
    }
    if (check.kind === 'count') {
      const quantities = audience.quantities
        .filter((q) => q.confidence >= 0.7)
        .flatMap((q) => {
          const subject = result(q.subject, check.subject);
          const grounding = samples
            .filter((e) => q.evidenceIds.includes(e.id))
            .map((e) => ({ e, r: result(e.observation, `${q.subject}的数量为${q.count}`) }))
            .filter(({ r }) => !r.inputTooLong && r.entailment >= 0.7 && r.contradiction < 0.7);
          return !subject.inputTooLong &&
            subject.entailment >= 0.7 &&
            subject.contradiction < 0.7 &&
            grounding.length
            ? [
                {
                  q,
                  grounding,
                  support: Math.min(subject.entailment, ...grounding.map(({ r }) => r.entailment)),
                },
              ]
            : [];
        })
        .sort((a, b) => b.support - a.support);
      const selected = quantities[0];
      if (!selected) return unresolved(check, 'No grounded quantity for this subject');
      const ok =
        check.operator === 'eq'
          ? selected.q.count === check.value
          : check.operator === 'gte'
            ? selected.q.count >= check.value
            : selected.q.count <= check.value;
      return ok
        ? supported(
            selected.support,
            selected.grounding.map(({ e }) => e.id),
          )
        : { ...unknown(check), status: 'contradicted', evidenceIds: selected.q.evidenceIds };
    }
    const ir = context.editorial;
    let passed = false;
    if (check.kind === 'track_count')
      passed = ir.audio.filter((a) => check.role === 'all' || a.role === check.role).length === check.value;
    else
      switch (check.rule) {
        case 'silent':
          passed = ir.audio.length === 0;
          break;
        case 'no_music':
          passed = !ir.audio.some((a) => a.role === 'music');
          break;
        case 'no_narration':
          passed = !ir.audio.some((a) => a.role === 'narration');
          break;
        case 'narration_only':
          passed = ir.audio.length > 0 && ir.audio.every((a) => a.role === 'narration');
          break;
        case 'no_sfx':
          passed = !ir.audio.some((a) => a.role === 'effect');
          break;
        case 'no_subtitles':
          passed = !ir.text.some((t) => t.role === 'subtitle');
          break;
        case 'no_added_text':
          passed = ir.text.length === 0;
          break;
        case 'source_reordered': {
          passed = [...new Set(ir.shots.map((s) => s.track))].some((track) => {
            const shots = ir.shots.filter((s) => s.track === track).sort((a, b) => a.start - b.start);
            return shots.some((shot, i) =>
              shots
                .slice(i + 1)
                .some((next) => next.assetId === shot.assetId && next.sourceStart < shot.sourceStart),
            );
          });
          break;
        }
        case 'preserve_frame':
          if (!context.render) return { ...unknown(check, 'Layout is not available yet'), basis: 'ir' };
          try {
            validateComposition(context.render, context.render.canvas, {
              aspectRatio: 'auto',
              fps: context.render.canvas.fps,
              mediaFit: 'contain',
              background: context.render.canvas.background,
            });
            passed = true;
          } catch (error) {
            if (!(error instanceof FilmError)) throw error;
          }
          break;
      }
    return {
      predicate: check,
      support: passed ? 1 : 0,
      status: passed ? 'supported' : 'contradicted',
      evidenceIds: [],
      basis: 'ir',
    };
  };
  const deferred: { sourceId: string; predicate: Predicate }[] = [];
  const rows = active
    .map((source) => {
      const checks = plan.sources
        .find((s) => s.sourceId === source.id)!
        .checks.filter((check) => {
          const pending = renderingRequired(check);
          if (pending) deferred.push({ sourceId: source.id, predicate: check });
          return !pending;
        })
        .map(evaluate);
      return {
        source,
        checks,
        support: checks.length ? Math.min(...checks.map((c) => c.support)) : 1,
        status: checks.some((c) => c.status === 'contradicted')
          ? 'contradicted'
          : checks.some((c) => c.status === 'unknown')
            ? 'unknown'
            : 'supported',
      };
    })
    .filter((row) => row.checks.length > 0);
  const group = (name: 'fixed' | 'expression') => {
    const selected = rows.filter((r) => r.source.group === name);
    if (!selected.length) return null;
    const similarity = selected.reduce((n, r) => n + r.support, 0) / selected.length;
    const blockingIssues = selected
      .filter((r) => r.status !== 'supported')
      .map((r) => `${r.status}: ${r.source.text}`);
    const scorable = selected.every((r) => r.status !== 'unknown');
    return {
      similarity,
      distance: 1 - similarity,
      scorable,
      passed: scorable && 1 - similarity < threshold && !blockingIssues.length,
      criteria: selected.map((r) => ({
        criterion: {
          text: r.source.text,
          sourceText: r.source.quote,
          weight: name === 'fixed' ? 2 : 1,
          required: true,
          modality: r.source.modality,
        },
        support: r.support,
        status: r.status,
        evidenceIds: [...new Set(r.checks.flatMap((c) => c.evidenceIds))],
        checks: r.checks,
      })),
      blockingIssues,
      scorerVersion,
      inputHash: hash({
        sources,
        plan,
        audience,
        editorial: irIdentity(context.editorial),
        render: context.render,
        renderedFps: context.renderedFps,
        stage: context.stage,
      }),
    };
  };
  const fixed = group('fixed'),
    expression = group('expression');
  return {
    passed:
      (!fixed || fixed.passed) &&
      (!expression || expression.passed) &&
      !audience.issues.some((i) => i.severity === 'blocking'),
    fixed,
    expression,
    planHash: hash(plan),
    scorerVersion,
    stage: context.stage,
    deferred,
    evaluationErrors: rows.flatMap((row) =>
      row.checks
        .filter((check) => check.failure)
        .map((check) => ({
          sourceId: row.source.id,
          predicate: check.predicate,
          failure: check.failure!,
          diagnostic: check.diagnostic,
          ...(check.capacity ? { capacity: check.capacity } : {}),
        })),
    ),
  };
}
const irIdentity = (ir: EditorialIR) => hash(ir);
