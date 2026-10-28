import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, asset } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { MaterialMatcher } from '../packages/application/src/materials.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';
import { scriptSchema } from '../packages/core/src/domain.js';
import { taskProgress } from '../packages/application/src/progress.js';

test('wrong source matches are repaired locally; interrupted evidence review resumes without rewriting the match or script', async (t) => {
  const { store, root } = await fixture();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: '展示真实反射', materials: { strategy: 'local_only' } });
  const runner = new TaskRunner(store, task.id);
  store.saveAsset({
    ...asset,
    taskId: task.id,
    frames: [
      { time: 0, path: '/frame0.jpg' },
      { time: 2, path: '/frame2.jpg' },
    ],
  });
  runner.library.resolve = async () => '/source.mp4';
  runner.library.frames = async (_id, times) => times!.map((time) => ({ time, path: `/frame${time}.jpg` }));
  const script = scriptSchema.parse({
    title: '反射',
    topic: '镜面',
    angle: '内外空间',
    personaId: 'observer',
    narration: '',
    beats: [{ id: 'beat', text: '', visualQuery: '镜面中的车辆反射', durationHint: 1 }],
  });
  const original = store.saveArtifact(task.id, 'script', script, true);
  const gap = store.saveArtifact(task.id, 'materials.gaps', [{ needId: 'visual_1', reason: '缺少反射镜头' }]);
  let matches = 0,
    reviews = 0;
  const agent: AgentDriver = {
    async run(request) {
      if (request.role === 'materials') {
        matches++;
        if (matches > 1)
          assert.equal((request.input as any).revisionRequest.checks[0].review.verdict, 'mismatch');
        const start = matches === 1 ? 0 : 2;
        return request.schema.parse({
          status: 'ready',
          gaps: [],
          matches: [
            {
              needId: 'visual_1',
              assetId: asset.id,
              sourceStart: start,
              sourceEnd: start + 1,
              frameTimes: [start],
              observation: 'AUTHOR_CLAIMS_REFLECTION',
            },
          ],
        });
      }
      assert.equal(request.role, 'materials_review');
      assert.equal(request.toolAccess, 'none');
      assert.ok(!JSON.stringify(request.input).includes('AUTHOR_CLAIMS_REFLECTION'));
      assert.equal(request.images?.length, 5);
      reviews++;
      assert.equal(store.artifact(task.id, 'materials'), undefined);
      if (reviews === 2) throw new Error('review interrupted');
      const time = (request.input as any).clips[0].evidenceTimes[0];
      const result = request.schema.parse({
        verdict: reviews === 1 ? 'mismatch' : 'matched',
        observation: reviews === 1 ? '只有外壳' : '反射在镜中可见',
        evidence: [{ matchIndex: 0, time }],
      });
      assert.throws(
        () => request.validateOutput!({ ...(result as any), evidence: [{ matchIndex: 99, time: 0 }] }),
        { code: 'MATERIAL_EVIDENCE' },
      );
      return request.validateOutput!(result);
    },
  };
  const matcher = new MaterialMatcher(store, task.id, runner.library, agent);
  await assert.rejects(matcher.run(script), /review interrupted/);
  assert.equal(matches, 2);
  assert.equal(store.artifact(task.id, 'materials'), undefined);
  assert.ok(store.artifact(task.id, 'materials.pending'));
  const event = store.event.bind(store);
  const interrupted = t.mock.method(store, 'event', (...args: Parameters<typeof store.event>) => {
    if (args[1] === 'materials.completed') throw new Error('publication interrupted');
    return event(...args);
  });
  await assert.rejects(matcher.run(script), /publication interrupted/);
  assert.equal(
    store.artifact(task.id, 'materials'),
    undefined,
    'publication failure rolls back the accepted manifest',
  );
  assert.equal(store.artifact(task.id, 'materials.gaps', false)!.id, gap.id);
  assert.ok(
    store.artifact(task.id, 'materials.pending'),
    'accepted match remains resumable after publication failure',
  );
  interrupted.mock.restore();
  const accepted = await matcher.run(script);
  assert.equal(accepted.matches[0]!.sourceStart, 2);
  assert.equal(accepted.reviewVersion, 4);
  assert.equal(matches, 2, 'resume must review the saved match, not search and create another');
  assert.equal(reviews, 3);
  assert.equal(store.artifact(task.id, 'script')!.hash, original.hash);
  assert.equal(taskProgress(store, task.id).gaps, undefined);
  assert.ok(
    store.db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(gap.id),
    'resolved gap remains in history',
  );
  assert.deepEqual(await matcher.run(script), accepted);
  assert.equal(reviews, 3, 'accepted manifest reuses the verified result');
});
