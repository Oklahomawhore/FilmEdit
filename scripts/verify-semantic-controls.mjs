// Actual pinned local-model controls, independent of remote compilation and API balance.
// These observations are controlled fixtures, never evidence that a real video passed.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadProjectEnv } from '../packages/infrastructure/src/model-provider.ts';
import { PathPolicy } from '../packages/infrastructure/src/security.ts';
import { ProcessRunner } from '../packages/infrastructure/src/process.ts';
import { PythonSemanticModel } from '../packages/media/src/scoring.ts';
import { scoreAcceptance } from '../packages/media/src/acceptance-scoring.ts';
import { audienceSchema, editorialSchema } from '../packages/core/src/domain.ts';
import { errorInfo } from '../packages/core/src/util.ts';

await loadProjectEnv();
const home = path.resolve(process.argv[2] ?? '.filmedit/verification/product-20261023/semantic-controls-v21');
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
const policy = await PathPolicy.create(home, {
  materials: { paths: [], strategy: 'local_only' },
  access: { readPaths: [], writePaths: [], denyPaths: [] },
});
const runner = new ProcessRunner(policy, controller.signal);
const output = {
  diagnosticOnly: true,
  videoAccepted: false,
  evidence: 'controlled observations; real local model',
};
try {
  const model = await PythonSemanticModel.create(runner);
  const edit = editorialSchema.parse({
    schemaVersion: 1,
    revision: 0,
    duration: 6,
    shots: [{ id: 'first', assetId: 'fixture', sourceStart: 0, start: 0, duration: 6 }],
  });
  const observed = audienceSchema.parse({
    summary: '一个人关门后离开',
    claims: [],
    events: [
      { text: '一个人关上了门', at: 1, evidenceIds: ['close'] },
      { text: '这个人离开了房间', at: 4, evidenceIds: ['leave'] },
    ],
    relations: [],
    emotionTimeline: [],
    pacing: '平稳',
    ambiguities: [],
    evidence: [
      {
        id: 'close',
        bindingId: 'first',
        start: 0,
        end: 2,
        modality: 'visual',
        observation: '一个人关上了门。',
      },
      {
        id: 'leave',
        bindingId: 'first',
        start: 3,
        end: 5,
        modality: 'visual',
        observation: '这个人离开了房间。',
      },
    ],
  });
  const sources = [
    {
      id: 'sequence',
      text: '先关门再离开',
      quote: '受控测试，不是实际视频证据',
      group: 'fixed',
      modality: 'visual',
      stage: 'editorial',
    },
  ];
  const plan = {
    schemaVersion: 1,
    sources: [
      {
        sourceId: 'sequence',
        checks: [{ kind: 'order', modality: 'visual', before: '一个人关上了门', after: '这个人离开了房间' }],
      },
    ],
  };
  const controls = [{ name: 'ordered', sources, plan, observed: structuredClone(observed), expected: true }];
  observed.events[0].at = 4;
  observed.events[1].at = 1;
  observed.evidence[0].start = 3;
  observed.evidence[0].end = 5;
  observed.evidence[1].start = 0;
  observed.evidence[1].end = 2;
  controls.push({ name: 'reversed', sources, plan, observed: structuredClone(observed), expected: false });
  const appearance = (observation, modality = 'visual') =>
    audienceSchema.parse({
      summary: observation,
      claims: [{ text: observation, evidenceIds: ['object'], confidence: 1 }],
      events: [],
      relations: [],
      emotionTimeline: [],
      pacing: 'stable',
      ambiguities: [],
      evidence: [{ id: 'object', bindingId: 'first', start: 0, end: 6, modality, observation }],
    });
  const objectPlan = {
    schemaVersion: 1,
    sources: [
      {
        sourceId: 'object',
        checks: [
          {
            kind: 'observation',
            modality: 'visual',
            claim: '画面里有一辆红色汽车',
            coverage: 'some',
            interval: null,
          },
        ],
      },
    ],
  };
  const objectSources = [{ ...sources[0], id: 'object', text: '画面出现一辆红色汽车' }];
  for (const [name, observation, expected, modality] of [
    ['entity_supported', '画面里有一辆红色汽车停在车库。', true, 'visual'],
    ['entity_mismatch', '画面里有一辆红色自行车停在车库，没有汽车。', false, 'visual'],
    ['negation', '画面里没有汽车，只有一棵树。', false, 'visual'],
    [
      'keyword_repetition',
      '汽车、汽车、汽车。'.repeat(20) + '这些只是无关词语，画面没有任何汽车，只有一棵树。',
      false,
      'visual',
    ],
    ['narration_is_not_visual', '画面里有一辆红色汽车', false, 'audio'],
  ])
    controls.push({
      name,
      sources: objectSources,
      plan: objectPlan,
      observed: appearance(observation, modality),
      expected,
    });

  const motion = appearance('画面完全静止');
  motion.evidence[0].end = 2;
  motion.evidence.push({
    ...motion.evidence[0],
    id: 'motion',
    start: 2,
    end: 4,
    observation: '画面内部有明显运动',
  });
  motion.evidence.push({ ...motion.evidence[0], id: 'still', start: 4, end: 6 });
  motion.claims[0].evidenceIds = motion.evidence.map((e) => e.id);
  const states = {
    schemaVersion: 1,
    sources: [
      {
        sourceId: 'motion',
        checks: [
          {
            kind: 'state_changes',
            modality: 'visual',
            states: ['画面完全静止', '画面内部有明显运动'],
            value: 2,
            interval: null,
          },
        ],
      },
    ],
  };
  const motionSources = [{ ...sources[0], id: 'motion', text: '全片静止与运动之间切换两次' }];
  controls.push({
    name: 'two_state_changes',
    sources: motionSources,
    plan: states,
    observed: motion,
    expected: true,
  });
  controls.push({
    name: 'wrong_state_count',
    sources: motionSources,
    plan: {
      schemaVersion: 1,
      sources: [{ sourceId: 'motion', checks: [{ ...states.sources[0].checks[0], value: 3 }] }],
    },
    observed: motion,
    expected: false,
  });
  controls.push({
    name: 'wrong_time_interval',
    sources: motionSources,
    plan: {
      schemaVersion: 1,
      sources: [
        {
          sourceId: 'motion',
          checks: [
            {
              kind: 'observation',
              modality: 'visual',
              claim: '画面完全静止',
              coverage: 'all',
              interval: { start: 0, end: 3 },
            },
          ],
        },
      ],
    },
    observed: motion,
    expected: false,
  });

  const arc = appearance('这个人紧张地握紧拳头，身体僵硬。');
  arc.evidence[0].end = 3;
  arc.evidence.push({
    ...arc.evidence[0],
    id: 'relaxed',
    start: 3,
    end: 6,
    observation: '这个人松开拳头，微笑着放松身体。',
  });
  arc.claims[0].evidenceIds = arc.evidence.map((e) => e.id);
  const arcSources = [{ ...sources[0], id: 'arc', text: '这个人的情绪从紧张转向放松' }];
  const arcPlan = {
    schemaVersion: 1,
    sources: [
      {
        sourceId: 'arc',
        checks: [
          {
            kind: 'sequence',
            modality: 'visual',
            claim: '这个人从紧张变得放松',
            steps: ['这个人很紧张', '这个人很放松'],
            interval: null,
          },
        ],
      },
    ],
  };
  controls.push({
    name: 'emotional_sequence',
    sources: arcSources,
    plan: arcPlan,
    observed: structuredClone(arc),
    expected: true,
  });
  const reversedArc = structuredClone(arc);
  [reversedArc.evidence[0].observation, reversedArc.evidence[1].observation] = [
    reversedArc.evidence[1].observation,
    reversedArc.evidence[0].observation,
  ];
  controls.push({
    name: 'reversed_emotional_sequence',
    sources: arcSources,
    plan: arcPlan,
    observed: reversedArc,
    expected: false,
  });
  const missingArc = structuredClone(arc);
  missingArc.evidence[1].start = 4;
  controls.push({
    name: 'incomplete_sequence',
    sources: arcSources,
    plan: arcPlan,
    observed: missingArc,
    expected: false,
  });
  const narratedArc = structuredClone(arc);
  narratedArc.evidence.forEach((e) => {
    e.modality = 'audio';
  });
  controls.push({
    name: 'narrated_sequence_is_not_visual',
    sources: arcSources,
    plan: arcPlan,
    observed: narratedArc,
    expected: false,
  });

  const wholeSources = [{ ...sources[0], id: 'whole', text: '这个人表现出紧张和放松两种情绪' }];
  const wholeCheck = {
    kind: 'observation',
    modality: 'visual',
    claim: wholeSources[0].text,
    coverage: 'whole',
    interval: null,
  };
  const wholePlan = { schemaVersion: 1, sources: [{ sourceId: 'whole', checks: [wholeCheck] }] };
  for (const [name, observation, expected] of [
    ['whole_two_emotions', arc, true],
    ['whole_does_not_impose_unrequested_order', reversedArc, true],
    ['incomplete_whole_interval', missingArc, false],
    ['narration_cannot_prove_visual_whole', narratedArc, false],
  ])
    controls.push({ name, sources: wholeSources, plan: wholePlan, observed: observation, expected });
  controls.push({
    name: 'whole_is_not_every_individual_shot',
    sources: wholeSources,
    plan: {
      schemaVersion: 1,
      sources: [{ sourceId: 'whole', checks: [{ ...wholeCheck, coverage: 'all' }] }],
    },
    observed: arc,
    expected: false,
  });

  // Collect all required comparisons first, then run the actual pinned local NLI once.
  // The neutral collector only enumerates inputs; it is never used as acceptance evidence.
  const inputs = new Map();
  const pairKey = (pair) => JSON.stringify([pair.premise, pair.hypothesis]);
  const collector = {
    version: 'input-collector-only',
    async compare(pairs) {
      pairs.forEach((pair) => inputs.set(pairKey(pair), pair));
      return pairs.map(() => ({ similarity: 0, entailment: 0, contradiction: 0, neutral: 1 }));
    },
  };
  for (const c of controls)
    await scoreAcceptance(collector, c.sources, c.plan, c.observed, { editorial: edit, stage: 'editorial' });
  const longPair = { premise: '这是背景描述。'.repeat(600), hypothesis: '这里有一辆汽车。' };
  inputs.set(pairKey(longPair), longPair);
  const entries = [...inputs.entries()];
  const measured = await model.compare(entries.map(([, pair]) => pair));
  const measurements = new Map(entries.map(([key], i) => [key, measured[i]]));
  const measuredModel = {
    version: model.version,
    async compare(pairs) {
      return pairs.map((pair) => {
        const value = measurements.get(pairKey(pair));
        if (!value) throw new Error('Unmeasured semantic input');
        return value;
      });
    },
  };
  output.controls = [];
  for (const c of controls) {
    const result = await scoreAcceptance(measuredModel, c.sources, c.plan, c.observed, {
      editorial: edit,
      stage: 'editorial',
    });
    output.controls.push({
      name: c.name,
      expected: c.expected,
      matchesExpectation: result.passed === c.expected,
      result,
    });
  }
  output.longInput = [measurements.get(pairKey(longPair))];
  output.controlsPassed =
    output.controls.every((c) => c.matchesExpectation) && output.longInput[0].inputTooLong === true;
  if (!output.controlsPassed)
    throw new Error('Frozen NLI controls failed; inspect report without relaxing the threshold');
  console.log(JSON.stringify({ controls: output.controls.length, controlsPassed: output.controlsPassed }));
} catch (error) {
  output.error = errorInfo(error);
  console.log(JSON.stringify(output.error));
  process.exitCode = 1;
} finally {
  await writeFile(path.join(home, 'report.json'), JSON.stringify(output, null, 2));
}
