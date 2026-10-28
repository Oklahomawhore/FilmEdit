import { prepareAlignmentReview } from '../packages/application/src/semantic-review.js';
import { semanticFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { acceptanceFixture, asset, editorial, fixture } from './helpers.js';
import { hash } from '../packages/core/src/util.js';
import { validateEditorialRequest } from '../packages/core/src/revision.js';
import { Renderer } from '../packages/media/src/render.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';
import { MATERIAL_REVIEW_VERSION } from '../packages/application/src/material-review.js';
import { scriptSchema } from '../packages/core/src/domain.js';
import { compileAcceptance } from '../packages/application/src/acceptance.js';

test('layout requests an editorial repair without altering or rendering the approved timeline', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'Preserve the narration; change the pace.' });
  store.saveAsset({ ...asset, taskId: task.id });
  const cut = editorial(),
    original = store.saveArtifact(task.id, 'editorial', cut, true);
  const request = {
    kind: 'editorial_request' as const,
    editorialHash: hash(cut),
    bindingIds: ['shot_a'],
    reason: '画面转场时机与声音不对应，布局不能修改镜头时长。',
  };
  assert.throws(() => validateEditorialRequest({ ...request, editorialHash: '0'.repeat(64) }, cut), {
    code: 'STALE_EDITORIAL',
  });
  let calls = 0;
  const agent: AgentDriver = {
    async run(input) {
      calls++;
      assert.equal(input.role, 'layout');
      assert.equal(hash((input.input as any).editorial), original.hash);
      assert.throws(
        () => input.validateOutput!(input.schema.parse({ ...request, bindingIds: ['unknown'] })),
        { code: 'IR_BINDING' },
      );
      return input.validateOutput!(input.schema.parse(request));
    },
  };
  t.mock.method(Renderer.prototype, 'render', async () => {
    throw new Error('A repair request must not become a render');
  });
  const runner = new TaskRunner(store, task.id, undefined, { agent });
  await assert.rejects((runner as any).layout(cut), (error: any) => {
    assert.equal(error.code, 'NARRATIVE_REPAIR');
    assert.deepEqual(error.details.request, request);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(store.artifact(task.id, 'editorial')!.hash, original.hash);
  assert.deepEqual(store.artifact(task.id, 'layout.editorial_request', false)!.data, request);
  assert.equal(store.artifact(task.id, 'layout.candidate', false), undefined);
  assert.equal(store.artifact(task.id, 'layout.preview', false), undefined);
});

test('resuming an approved edit restores its material manifest; successful policy recheck does not recut', async (t) => {
  for (const version of [MATERIAL_REVIEW_VERSION, MATERIAL_REVIEW_VERSION - 1]) {
    await t.test(`material policy ${version}`, async (t) => {
      const { store } = await fixture();
      t.after(() => store.close());
      const task = await createTask(store, {
        prompt: 'Resume',
        creative: { enabled: false },
        output: { duration: 4 },
      });
      store.saveAsset({ ...asset, taskId: task.id });
      const script = scriptSchema.parse({
        title: 'test',
        topic: 'test',
        angle: 'test',
        personaId: 'test',
        narration: '',
        beats: [{ id: 'a', text: '车', visualQuery: '车', durationHint: 4 }],
      });
      store.saveArtifact(task.id, 'script', script, true);
      store.saveArtifact(
        task.id,
        'materials',
        {
          schemaVersion: 1,
          reviewVersion: version,
          scriptHash: hash(script),
          requirements: [{ id: 'visual_1', kind: 'visual', query: '车' }],
          matches: [
            {
              needId: 'visual_1',
              assetId: asset.id,
              sha256: asset.sha256,
              sourceStart: 0,
              sourceEnd: 7,
              frameTimes: [0],
              observation: 'fixture',
            },
          ],
        },
        true,
      );
      let rechecks = 0,
        reached = false;
      const driver: AgentDriver = {
        async run(request) {
          const semantic = semanticFixture(request);
          if (semantic) return semantic;
          const compiled = acceptanceFixture(request);
          if (compiled !== undefined) return compiled;
          assert.equal(
            request.role,
            'materials_review',
            'must reuse the accepted edit instead of regenerating it',
          );
          rechecks++;
          return request.schema.parse({
            verdict: 'matched',
            observation: 'fixture source unchanged',
            evidence: [{ matchIndex: 0, time: 0 }],
          });
        },
      };
      await compileAcceptance(store, task.id, driver);
      prepareAlignmentReview(store, task.id);
      const cut = store.saveArtifact(task.id, 'editorial', editorial(), true);
      const runner = new TaskRunner(store, task.id, undefined, {
        agent: driver,
        model: { version: 'fixture', compare: async () => [] },
      });
      runner.library.resolve = async () => '/fixture/video.mp4';
      runner.library.frames = async (_id, times) =>
        times.map((time) => ({ time, path: '/fixture/frame.jpg' }));
      (runner as any).layout = async (restored: unknown) => {
        reached = true;
        assert.equal(hash(restored), cut.hash);
        throw new Error('Reached restored layout checkpoint');
      };
      await assert.rejects(runner.run(), /Reached restored layout checkpoint/);
      assert.equal(reached, true);
      assert.equal(rechecks, version === MATERIAL_REVIEW_VERSION ? 0 : 1);
      assert.equal(store.artifact(task.id, 'editorial')!.hash, cut.hash);
      assert.equal(store.artifact(task.id, 'editorial.feedback', false), undefined);
    });
  }
});
