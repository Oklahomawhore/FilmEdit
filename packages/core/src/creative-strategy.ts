import { z } from 'zod';
import { conceptSchema, preferenceSchema, type ConceptIR } from './creative-domain.js';
import { invariant } from './util.js';

export const STRATEGY_VERSION = 'creative-strategy-v1';
const text = z.string().trim().min(1).max(2000);
export const strategyConfigSchema = z
  .object({
    kind: z.literal('strategy'),
    scope: z.string().min(1),
    audience: z.string().min(1).max(200).default('default'),
    usd: z.number().finite().positive().nullable().default(null),
  })
  .strict();
export const strategyRulesSchema = z
  .object({
    rules: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_]{0,60}$/),
            operator: conceptSchema.shape.operators.element,
            appliesWhen: text,
            mechanism: text,
            avoidWhen: z.array(text).min(1).max(8),
            evidence: z
              .array(
                z
                  .object({
                    preferenceId: z.string().min(1),
                    lesson: text,
                    kind: z.enum(['support', 'counterexample']),
                  })
                  .strict(),
              )
              .min(2)
              .max(20),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export type StrategyRules = z.infer<typeof strategyRulesSchema>;
export type PreferenceExample = {
  id: string;
  taskId: string;
  sourceHash: string;
  preference: z.infer<typeof preferenceSchema>;
  left: ConceptIR;
  right: ConceptIR;
};
export type StrategySnapshot = StrategyRules & {
  version: string;
  experimentId: string;
};
export const strategyPredictionSchema = z
  .object({
    choice: z.enum(['left', 'right', 'both_bad', 'incomparable']),
    reason: text,
  })
  .strict();
export type StrategyPrediction = z.infer<typeof strategyPredictionSchema>;
export const strategyGroupsSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            topic: text,
            exampleIds: z.array(z.string()).min(1),
            previousTopicIds: z.array(z.string()),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type StrategyGroups = z.infer<typeof strategyGroupsSchema>;

export function validateStrategyRules(rules: StrategyRules, training: PreferenceExample[]) {
  const examples = new Map(training.map((e) => [e.id, e]));
  invariant(
    new Set(rules.rules.map((r) => r.id)).size === rules.rules.length,
    'STRATEGY_INVALID',
    '创作方法 ID 重复',
  );
  for (const rule of rules.rules) {
    invariant(
      ['support', 'counterexample'].every((kind) => rule.evidence.some((e) => e.kind === kind)),
      'STRATEGY_INVALID',
      '每条方法必须同时记录支持例子与反例',
    );
    for (const evidence of rule.evidence) {
      const example = examples.get(evidence.preferenceId);
      invariant(example, 'STRATEGY_INVALID', '方法引用了训练集之外的偏好记录');
      invariant(
        evidence.kind !== 'support' || ['left', 'right'].includes(example.preference.choice),
        'STRATEGY_INVALID',
        '都不好或无法比较不能作为正向支持',
      );
    }
  }
  return rules;
}

/** Labels are held by the controller; the predictor cannot choose its acceptance threshold. */
export function scoreStrategy(
  expected: string[],
  baseline: StrategyPrediction[],
  candidate: StrategyPrediction[],
) {
  invariant(
    expected.length >= 5 && expected.length === baseline.length && expected.length === candidate.length,
    'STRATEGY_EVIDENCE_REQUIRED',
    '至少需要五个独立题材的完整保留集预测',
  );
  let wins = 0,
    losses = 0,
    correct = 0,
    baselineCorrect = 0;
  expected.forEach((label, i) => {
    const old = baseline[i]!.choice === label,
      next = candidate[i]!.choice === label;
    baselineCorrect += Number(old);
    correct += Number(next);
    wins += Number(next && !old);
    losses += Number(old && !next);
  });
  // One-sided exact paired sign test under equal prediction performance.
  const n = wins + losses;
  let term = 2 ** -n,
    p = wins === 0 ? term : 0;
  for (let k = 1; k <= n; k++) {
    term *= (n - k + 1) / k;
    if (k >= wins) p += term;
  }
  const accuracy = correct / expected.length;
  return {
    passed: wins >= 5 && accuracy >= 0.75 && p <= 0.05,
    samples: expected.length,
    correct,
    baselineCorrect,
    wins,
    losses,
    accuracy,
    p,
    version: STRATEGY_VERSION,
  };
}
