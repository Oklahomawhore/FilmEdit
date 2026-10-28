import { semanticFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { fixture, conceptFixture, acceptanceFixture, intentReviewFixture } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { PiAgentDriver, type AgentDriver } from '../packages/agent-runtime/src/agents.js';
import type { FilmTool } from '../packages/agent-runtime/src/pi-runtime.js';
import { FilmError } from '../packages/core/src/util.js';

test('a broken supplied clip is handled after accepted creative/script, not during task startup', async (t) => {
  const { store, materials } = await fixture();
  t.after(() => store.close());
  await writeFile(path.join(materials, 'broken.mp4'), 'not a media stream');
  const task = await createTask(store, {
    prompt: '做一条日常动作短片',
    creative: { knowledge: 'local' },
    materials: { paths: [materials], strategy: 'local_only' },
  });
  const roles: string[] = [];
  let runner: TaskRunner;
  const agent: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      roles.push(request.role);
      const accepted = acceptanceFixture(request);
      if (accepted) return accepted;
      if (request.role === 'intent')
        return request.schema.parse({ schemaVersion: 1, constraints: [], openQuestions: [] });
      if (request.role === 'intent_review') return intentReviewFixture(request);
      if (['facts_review', 'audience_review', 'voice_review'].includes(request.role))
        return request.schema.parse({ passed: true, issues: [] });
      if (request.role === 'creative') {
        const concept = conceptFixture('concept', '日常动作');
        concept.proposal.expression.music = '';
        concept.beats[0]!.audio = '';
        return request.schema.parse({ candidates: [concept] });
      }
      if (request.role === 'concept_audience')
        return request.schema.parse({
          understood: '人物开门',
          connection: '日常动作',
          understandable: true,
          feasible: true,
          emotion: '轻松',
          issues: [],
        });
      if (request.role === 'script') {
        assert.equal(
          (request.input as any).materials,
          undefined,
          'inventory is available on demand, not a required script input',
        );
        return request.schema.parse({
          title: '日常',
          topic: '日常动作',
          angle: '观察',
          personaId: 'persona_observer',
          narration: '',
          beats: [{ id: 'opening', text: '人物开门', visualQuery: '人物开门', durationHint: 2 }],
          facts: [],
        });
      }
      assert.equal(request.role, 'materials');
      assert.ok(store.artifact(task.id, 'creative.brief'));
      assert.ok(store.artifact(task.id, 'script'));
      const driver = new PiAgentDriver(store, task.id, runner.library, runner.processes);
      const tools: FilmTool[] = (driver as any).createTools({ role: 'materials', schema: z.any() }, false);
      const call = async (name: string, input: unknown) => {
        const tool = tools.find((tool) => tool.name === name)!;
        const result = await tool.execute(tool.schema.parse(input), name);
        return JSON.parse((result.content[0] as { text: string }).text);
      };
      const roots = await call('local_materials', {});
      const sourceId = roots.items[0].sourceId;
      const files = await call('local_materials', { sourceId });
      assert.equal(files.items[0].relativePath, 'broken.mp4');
      await assert.rejects(call('import_local_material', { sourceId, relativePath: 'broken.mp4' }), {
        code: 'PROCESS_FAILED',
      });
      return request.schema.parse({
        status: 'missing',
        matches: [],
        gaps: (request.input as any).requirements.map((need: any) => ({
          needId: need.id,
          attemptedQueries: ['local:broken.mp4'],
          reason: 'Selected file could not be decoded',
        })),
      });
    },
  };
  runner = new TaskRunner(store, task.id, undefined, {
    agent,
    model: {
      version: 'material-order-fixture',
      async compare(pairs) {
        return pairs.map(() => ({ similarity: 1, entailment: 1, contradiction: 0, neutral: 0 }));
      },
    },
  });
  t.mock.method(runner.processes, 'run', async () => {
    throw new FilmError('PROCESS_FAILED', 'Fixture: corrupt media');
  });
  await assert.rejects(runner.run(), { code: 'MATERIALS_MISSING' });
  assert.equal(store.task(task.id).stage, 'materials');
  assert.equal(store.task(task.id).status, 'blocked');
  assert.equal(roles.filter((role) => role === 'creative').length, 1);
  assert.equal(roles.filter((role) => role === 'script').length, 1);
  assert.ok(store.artifact(task.id, 'script'));
  assert.ok(store.artifact(task.id, 'materials.gaps', false));
  assert.equal(store.assets(task.id).length, 0);
});

test('resume still rejects changed source evidence before a script context can reuse cached analysis', async (t) => {
  const { store, materials } = await fixture();
  t.after(() => store.close());
  const source = path.join(materials, 'interview.srt');
  await writeFile(source, '1\n00:00:00,000 --> 00:00:01,000\n原始采访内容\n');
  const task = await createTask(store, {
    prompt: '根据采访内容写脚本',
    creative: { enabled: false },
    materials: { paths: [source], strategy: 'local_only' },
  });
  const runner = new TaskRunner(store, task.id, undefined, {
    agent: {
      async run() {
        throw new Error('Must not resume with changed evidence');
      },
    },
    model: {
      version: 'unused-fixture',
      async compare() {
        throw new Error('No model needed');
      },
    },
  });
  const asset = await runner.library.importFile(source, 'local');
  assert.equal(asset.transcript[0]!.text.trim(), '原始采访内容');
  await writeFile(source, '1\n00:00:00,000 --> 00:00:01,000\n已经修改的采访内容\n');
  await assert.rejects(runner.run(), { code: 'ASSET_CHANGED' });
  assert.equal(store.task(task.id).status, 'blocked');
  assert.equal(store.task(task.id).stage, 'script');
});
