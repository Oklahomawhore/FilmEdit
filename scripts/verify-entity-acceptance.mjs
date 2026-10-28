// Actual compiler, independent observation structuring, and pinned local semantic model.
// Controlled text observations are fixtures, not proof that an actual video passed.
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { loadProjectEnv } from '../packages/infrastructure/src/model-provider.ts';
import { Store } from '../packages/infrastructure/src/store.ts';
import { createTask, TaskRunner } from '../packages/application/src/workflow.ts';
import { compileAcceptance } from '../packages/application/src/acceptance.ts';
import { AUDIENCE_REPORT_PROTOCOL } from '../packages/application/src/audience-review.ts';
import { audienceSchema, editorialSchema } from '../packages/core/src/domain.ts';
import { validateAudience } from '../packages/core/src/ir.ts';
import { errorInfo } from '../packages/core/src/util.ts';
import { PythonSemanticModel } from '../packages/media/src/scoring.ts';
import { scoreAcceptance } from '../packages/media/src/acceptance-scoring.ts';

await loadProjectEnv();
assert.ok(process.argv[2], 'Pass a fresh isolated verification directory');
const home = path.resolve(process.argv[2]);
assert.notEqual(home, path.resolve(process.env.FILMEDIT_HOME ?? '.filmedit'));
assert.ok(
  !existsSync(path.join(home, 'filmedit.sqlite')),
  'Use a fresh directory; preserve previous evidence',
);
const store = new Store(home);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
const report = { diagnosticOnly: true, videoAccepted: false, controlledTextObservations: true, controls: [] };
try {
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0, 'Use a fresh directory');
  const task = await createTask(store, {
    prompt: '画面中，同一个人表现出紧张和放松两种情绪。',
    creative: { enabled: false },
    output: { duration: 6 },
  });
  report.taskId = task.id;
  const runner = new TaskRunner(store, task.id, controller.signal);
  const frozen = await compileAcceptance(store, task.id, runner.agent, undefined, controller.signal);
  report.compiled = frozen;
  await writeFile(path.join(home, 'compiled.json'), JSON.stringify(frozen, null, 2));
  const tense = '这个人紧张地握紧拳头，身体僵硬。';
  const relaxed = '这个人松开拳头，微笑着放松身体。';
  const cases = [
    [
      'both',
      [
        [0, 3, tense],
        [3, 6, relaxed],
      ],
      true,
    ],
    [
      'reverse',
      [
        [0, 3, relaxed],
        [3, 6, tense],
      ],
      true,
    ],
    ['only_tense', [[0, 6, tense]], false],
    ['only_relaxed', [[0, 6, relaxed]], false],
    ['neither', [[0, 6, '没有人物出现，画面只有空荡的房间。']], false],
    [
      'audio_is_not_visual',
      [
        [0, 3, tense],
        [3, 6, relaxed],
      ],
      false,
      'audio',
    ],
    ['different_people', [[0, 6, '左边的男子始终紧张，右边的女子始终放松，两个人没有情绪变化。']], false],
    [
      'different_people_across_shots',
      [
        [0, 3, '一名男子紧张地握拳。'],
        [3, 6, '另一个人是一名女子，她轻松地微笑。'],
      ],
      false,
    ],
    ['negated_relaxed', [[0, 6, '这个人很紧张，完全没有放松。']], false],
    ['negated_tense', [[0, 6, '这个人很放松，完全没有紧张。']], false],
    [
      'keyword_repetition',
      [[0, 6, '紧张和放松。'.repeat(10) + '这些仅是文字，实际画面没有人物，只有空房间。']],
      false,
    ],
  ].map(([name, parts, expected, modality = 'visual'], id) => ({ id, name, parts, expected, modality }));
  const cut = (item) =>
    editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration: 6,
      shots: [{ id: 'picture', assetId: 'fixture', sourceStart: 0, start: 0, duration: 6 }],
      audio:
        item.modality === 'audio'
          ? [
              {
                id: 'sound',
                assetId: 'audio_fixture',
                sourceStart: 0,
                start: 0,
                duration: 6,
                role: 'dialogue',
              },
            ]
          : [],
    });
  const schema = z
    .object({ reports: z.array(z.object({ id: z.number().int(), report: audienceSchema }).strict()) })
    .strict();
  const observations = await runner.agent.run({
    role: 'editorial_audience',
    toolAccess: 'none',
    schema,
    instruction: `这是观察记录转写的受控实验，没有提供视频，不得声称观看了视频。每个 case 是独立的已有观察记录；仅将 observations 按其时间和模态忠实结构化为 AudienceIR，不添加观察不到的事实、不推断实验目标。每个 case 返回一次，保持给出的 id。拆分不同主体的独立观察，保留否定与未知，所有原观察均须有引用。\n${AUDIENCE_REPORT_PROTOCOL}`,
    input: {
      cases: cases.map(({ id, parts, modality }) => ({
        id,
        duration: 6,
        bindings: [{ bindingId: modality === 'audio' ? 'sound' : 'picture', start: 0, end: 6, modality }],
        observations: parts.map(([start, end, observation]) => ({ start, end, modality, observation })),
      })),
    },
    validateOutput(value) {
      assert.equal(value.reports.length, cases.length);
      assert.equal(new Set(value.reports.map((item) => item.id)).size, cases.length);
      for (const item of value.reports) {
        const original = cases.find((candidate) => candidate.id === item.id);
        assert.ok(original, 'Unknown case');
        validateAudience(item.report, cut(original));
      }
      return value;
    },
  });
  report.observer = observations;
  await writeFile(path.join(home, 'observations.json'), JSON.stringify(observations, null, 2));
  const pairs = new Map();
  const pairKey = (pair) => JSON.stringify([pair.premise, pair.hypothesis]);
  const collect = {
    version: 'pair-collector',
    async compare(values) {
      for (const pair of values) pairs.set(pairKey(pair), pair);
      return values.map(() => ({ similarity: 0, entailment: 0, contradiction: 0, neutral: 1 }));
    },
  };
  const evaluate = (model, item) =>
    scoreAcceptance(
      model,
      frozen.sources,
      frozen.plan,
      observations.reports.find((result) => result.id === item.id).report,
      { editorial: cut(item), stage: 'render' },
    );
  for (const item of cases) await evaluate(collect, item);
  const local = await PythonSemanticModel.create(runner.processes);
  const entries = [...pairs];
  const values = await local.compare(entries.map(([, pair]) => pair));
  const results = new Map(entries.map(([key], i) => [key, values[i]]));
  const measured = {
    version: local.version,
    async compare(values) {
      return values.map((pair) => {
        assert.ok(results.has(pairKey(pair)));
        return results.get(pairKey(pair));
      });
    },
  };
  for (const item of cases) {
    const result = await evaluate(measured, item);
    report.controls.push({
      name: item.name,
      expected: item.expected,
      passed: result.passed,
      matchesExpectation: result.passed === item.expected,
      result,
    });
  }
  report.allPassed = report.controls.every((item) => item.matchesExpectation);
  if (!report.allPassed) process.exitCode = 1;
  console.log(
    JSON.stringify({
      taskId: task.id,
      checks: frozen.plan.sources,
      controls: report.controls.map(({ name, expected, passed }) => ({ name, expected, passed })),
      allPassed: report.allPassed,
    }),
  );
} catch (error) {
  report.error = errorInfo(error);
  process.exitCode = 1;
  console.log(JSON.stringify({ error: report.error }));
} finally {
  await writeFile(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
  store.close();
}
