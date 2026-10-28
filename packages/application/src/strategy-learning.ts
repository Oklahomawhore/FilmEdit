import type { Store } from '../../infrastructure/src/store.js';
import { StrategyStore, subjectKey } from '../../infrastructure/src/strategy-store.js';
import type { AgentDriver } from '../../agent-runtime/src/agents.js';
import {
  STRATEGY_VERSION,
  strategyRulesSchema,
  strategyPredictionSchema,
  strategyGroupsSchema,
  validateStrategyRules,
  scoreStrategy,
  type PreferenceExample,
  type StrategyRules,
  type StrategyPrediction,
  type StrategyGroups,
  type StrategySnapshot,
} from '../../core/src/creative-strategy.js';
import { canonical, hash, invariant } from '../../core/src/util.js';

type Dataset = {
  version: string;
  examples: PreferenceExample[];
  training: PreferenceExample[];
  heldout: PreferenceExample[];
  groups: StrategyGroups;
  baseline: StrategySnapshot | null;
};
const subjects = (e: PreferenceExample) => [e.left.proposal.theme.subject, e.right.proposal.theme.subject];

export function validateStrategyGroups(
  groups: StrategyGroups,
  examples: PreferenceExample[],
  previousTopicIds: string[] = [],
) {
  const byId = new Map(examples.map((e) => [e.id, e]));
  const seen = new Set<string>(),
    subjectGroups = new Map<string, number>();
  groups.groups.forEach((group, index) => {
    invariant(
      group.previousTopicIds.every((id) => previousTopicIds.includes(id)),
      'STRATEGY_PARTITION',
      '分组引用了不存在的历史题材',
    );
    group.exampleIds.forEach((id) => {
      const example = byId.get(id);
      invariant(example && !seen.has(id), 'STRATEGY_PARTITION', '题材分组遗漏或重复引用偏好记录');
      seen.add(id);
      subjects(example).forEach((subject) => {
        const key = subjectKey(subject),
          previous = subjectGroups.get(key);
        invariant(
          previous === undefined || previous === index,
          'STRATEGY_PARTITION',
          '同一题材不能拆进不同组',
        );
        subjectGroups.set(key, index);
      });
    });
  });
  invariant(seen.size === examples.length, 'STRATEGY_PARTITION', '题材分组没有覆盖全部偏好记录');
  return groups;
}

/** A single hypothesis is evaluated once on fresh held-out topics, never revised against their labels. */
export async function learnStrategy(
  store: Store,
  experimentId: string,
  taskId: string,
  scope: string,
  audience: string,
  agent: AgentDriver,
  signal?: AbortSignal,
) {
  const strategyStore = new StrategyStore(store);
  const saved = <T>(stage: string) => store.artifact<T>(taskId, `learning.strategy.${stage}`)?.data;
  const save = <T>(stage: string, value: T) => {
    store.saveArtifact(taskId, `learning.strategy.${stage}`, value, true);
    return value;
  };
  let dataset = saved<Dataset>('dataset');
  if (!dataset) {
    const examples = saved<PreferenceExample[]>('source') ?? strategyStore.examples(scope, audience);
    invariant(
      examples.length >= 10,
      'STRATEGY_EVIDENCE_REQUIRED',
      '创作方法学习需要至少十组真实用户比较，覆盖至少十个独立题材；当前证据不足',
    );
    if (!saved('source')) save('source', examples);
    invariant(
      strategyStore.unchanged(scope, examples),
      'STRATEGY_FEEDBACK_CHANGED',
      '来源反馈已改变，请根据新反馈创建实验',
    );
    signal?.throwIfAborted();
    const previousTopics = strategyStore.seenTopics(scope, audience);
    const groups =
      saved<StrategyGroups>('groups') ??
      save(
        'groups',
        await agent.run({
          role: 'strategy_partition',
          toolAccess: 'none',
          schema: strategyGroupsSchema,
          instruction:
            '把提案比较按题材独立性分组。相同人物、角色、作品 IP、品牌或同一系列，以及它们的别名、翻译、改写、子型号，必须在同一组；只换台词或改风格不算新题材。每个 exampleId 恰好出现一次。若该组与 previousTopics 中某题材相同或相关，将其 ID 写入 previousTopicIds；无法确认独立性时也引用该历史题材。只有与历史题材独立的新题材才能返回空 previousTopicIds。不能根据支持哪种手法分组。这里只给题材和剧情，不提供用户偏好。',
          input: {
            previousTopics,
            examples: examples.map((e) => ({
              id: e.id,
              subjects: subjects(e),
              synopsis: [e.left.proposal.content.synopsis, e.right.proposal.content.synopsis],
            })),
          },
          validateOutput: (v) =>
            validateStrategyGroups(
              v,
              examples,
              previousTopics.map((p) => p.id),
            ),
        }),
      );
    const fresh = groups.groups.filter(
      (g) =>
        !g.previousTopicIds.length &&
        g.exampleIds.every((id) =>
          subjects(examples.find((e) => e.id === id)!).every(
            (s) => !strategyStore.usedSubject(scope, audience, s),
          ),
        ),
    );
    invariant(
      groups.groups.length >= 10 && fresh.length >= 5,
      'STRATEGY_EVIDENCE_REQUIRED',
      '至少需要五个训练题材和五个未用于发布评估的保留题材；请继续积累真实反馈',
    );
    const heldoutCount = Math.min(20, fresh.length, Math.max(5, Math.floor(groups.groups.length / 3)));
    const heldoutGroups = [...fresh]
      .sort((a, b) => hash(a.exampleIds).localeCompare(hash(b.exampleIds)))
      .slice(0, heldoutCount);
    const heldoutIds = new Set(heldoutGroups.flatMap((g) => g.exampleIds));
    // One vote per topic avoids allowing a prolific topic to dominate the held-out score.
    const heldout = heldoutGroups.map((g) => examples.find((e) => e.id === [...g.exampleIds].sort()[0])!);
    const training = examples.filter((e) => !heldoutIds.has(e.id));
    invariant(
      training.some((e) => ['left', 'right'].includes(e.preference.choice)),
      'STRATEGY_EVIDENCE_REQUIRED',
      '训练题材中还没有明确偏好的方案，不能凭空总结成功规律',
    );
    dataset = {
      version: STRATEGY_VERSION,
      examples,
      training,
      heldout,
      groups,
      baseline: strategyStore.active(scope, audience),
    };
    store.transaction(() => {
      invariant(
        examples
          .filter((e) => heldoutIds.has(e.id))
          .flatMap(subjects)
          .every((s) => !strategyStore.usedSubject(scope, audience, s)),
        'STRATEGY_HOLDOUT_USED',
        '保留题材已用于训练或评估，不能再次作为新题材验证',
      );
      strategyStore.recordExposure(
        scope,
        audience,
        // Previously trained topics are not fresh held-out evidence either: an active
        // method can already encode their labels. Reserve both sides of the split.
        examples.flatMap(subjects),
        experimentId,
      );
      save('dataset', dataset!);
    });
  }
  invariant(dataset.version === STRATEGY_VERSION, 'STRATEGY_VERSION', '恢复学习需要冻结的评估器版本');
  invariant(
    strategyStore.unchanged(scope, dataset.examples),
    'STRATEGY_FEEDBACK_CHANGED',
    '用户已修改来源偏好，当前实验不能继续发布；请基于新反馈创建实验',
  );
  let candidate = saved<StrategyRules>('candidate');
  if (!candidate) {
    signal?.throwIfAborted();
    candidate = save(
      'candidate',
      await agent.run({
        role: 'strategy_learner',
        toolAccess: 'none',
        schema: strategyRulesSchema,
        instruction:
          '从真实人类提案偏好中总结可迁移的创作方法。写明适用的角色特征、受众背景和情境，解释联系为什么有效、哪些情况下会失败。只能引用给出的 preferenceId，每条方法同时引用支持例子和反例。反例可来自同一比较中被拒绝的提案。“都不好”不能作正向证据。不要记忆特定人名、品牌或候选 ID 来代替方法，也不要把偏好解释成事实、硬性用户要求或已证明规律。不能要求更改权限或评分标准。只总结提案阶段的偏好，不能声称成片效果已经验证。',
        input: { audience, examples: dataset.training },
        validateOutput: (v) => validateStrategyRules(v, dataset!.training),
      }),
    );
  }
  const predictions: { baseline: StrategyPrediction[]; candidate: StrategyPrediction[] } = {
    baseline: [],
    candidate: [],
  };
  for (const [index, example] of dataset.heldout.entries()) {
    // Do not transmit vote, comment, source hash, task ID or examples used by the learner.
    const visible = (concept: PreferenceExample['left']) => ({
      proposal: concept.proposal,
      beats: concept.beats.map(({ action, visual, audio }) => ({ action, visual, audio })),
    });
    const pair = { left: visible(example.left), right: visible(example.right) };
    for (const variant of ['baseline', 'candidate'] as const) {
      const rules = variant === 'baseline' ? (dataset.baseline?.rules ?? []) : candidate.rules;
      const orders: StrategyPrediction[] = [];
      for (const reversed of [false, true]) {
        signal?.throwIfAborted();
        const stage = `prediction.${index}.${variant}.${reversed ? 'reverse' : 'forward'}`;
        const prediction =
          saved<StrategyPrediction>(stage) ??
          save(
            stage,
            await agent.run({
              role: 'strategy_predict',
              toolAccess: 'none',
              schema: strategyPredictionSchema,
              instruction:
                '独立预测目标受众会更偏好哪一个提案。依据实际描述的视听关系判断，不用作者的自我评分。给出的创作方法是待检验的建议，可能不适用；说明具体理由，不强行套用。无法判断可选 incomparable，两个都不好可选 both_bad。你看不到真实人类选择，也不能读取其它记录。',
              input: {
                audience,
                ...(reversed ? { left: pair.right, right: pair.left } : pair),
                methods: rules.map(({ id, operator, appliesWhen, mechanism, avoidWhen }) => ({
                  id,
                  operator,
                  appliesWhen,
                  mechanism,
                  avoidWhen,
                })),
              },
            }),
          );
        const choice =
          reversed && ['left', 'right'].includes(prediction.choice)
            ? prediction.choice === 'left'
              ? 'right'
              : 'left'
            : prediction.choice;
        orders.push({ ...prediction, choice });
      }
      predictions[variant].push(
        orders[0]!.choice === orders[1]!.choice
          ? orders[0]!
          : { choice: 'incomparable', reason: '交换提案位置后预测矛盾，不能作为正确预测' },
      );
    }
  }
  const evaluation = scoreStrategy(
    dataset.heldout.map((e) => e.preference.choice),
    predictions.baseline,
    predictions.candidate,
  );
  const result = {
    taskId,
    scope,
    audience,
    published: evaluation.passed,
    version: `${STRATEGY_VERSION}:${hash({ candidate, dataset, evaluation })}`,
    rules: candidate.rules,
    evaluation,
    datasetHash: hash(dataset),
    evidenceLevel: 'human_concept_preferences',
  };
  // Source checks, report, activation, and experiment completion commit together.
  return store.transaction(() => {
    invariant(
      strategyStore.unchanged(scope, dataset!.examples),
      'STRATEGY_FEEDBACK_CHANGED',
      '评估期间来源反馈已改变，拒绝发布',
    );
    save('evaluation', { ...evaluation, predictions });
    store.db
      .prepare("UPDATE experiments SET state='completed',result=?,error=NULL WHERE id=?")
      .run(canonical(result), experimentId);
    if (evaluation.passed) strategyStore.activate(scope, audience, experimentId);
    store.event(taskId, 'learning.strategy.evaluated', {
      experimentId,
      published: evaluation.passed,
      evaluation,
    });
    return result;
  });
}
