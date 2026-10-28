import { acceptanceFixture, semanticFixture, audience } from '../helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../packages/infrastructure/src/store.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { AgentDriver, AgentRequest } from '../../packages/agent-runtime/src/agents.js';
import { type SemanticModel } from '../../packages/media/src/scoring.js';
import { defaultRender } from '../../packages/core/src/ir.js';
import { audienceSchema, editorialSchema, type EditorialIR } from '../../packages/core/src/domain.js';
import { createApi } from '../../apps/server/src/service.js';
import { Renderer } from '../../packages/media/src/render.js';

test(
  'workflow resumes approved script, isolates observer context and completes real render with fixture agents',
  { timeout: 180000 },
  async (t) => {
    const store = new Store(await mkdtemp(path.join(tmpdir(), 'filmedit-workflow-')));
    t.after(() => store.close());
    const task = await createTask(store, {
      prompt: 'SECRET_REQUIREMENT_不会提供给观众',
      creative: { enabled: false },
      composition: { width: 320, height: 480, fps: 8 },
      materials: { strategy: 'local_only' },
      output: { width: 320, height: 480, fps: 8, duration: 2 },
    });
    const initial = new TaskRunner(store, task.id);
    const source = path.join(task.policy.workspace, 'source.mp4');
    await initial.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x480:rate=8:duration=2',
      '-c:v',
      'libx264',
      source,
    ]);
    // The generated test pattern is the local input fixture, not an untraced Agent output.
    const asset = await initial.library.importFile(source, 'local');
    // A resumed unlimited task must continue past both former three-round limits.
    for (let round = 0; round < 4; round++) {
      store.event(task.id, 'render.attempt', { round });
      store.event(task.id, 'stage.attempt', { stage: 'editorial', round });
    }
    const calls: string[] = [];
    const reviewCounts = new Map<string, number>();
    let interruptOnce = true;
    let replaceMaterialOnce = true;
    let interruptScoringOnce = true;
    const driver: AgentDriver = {
      async run<T>(request: AgentRequest<T>): Promise<T> {
        const compiled = acceptanceFixture(request);
        if (compiled !== undefined) return compiled;
        calls.push(request.role);
        if (request.role === 'semantic_review') {
          if (interruptScoringOnce) {
            interruptScoringOnce = false;
            throw new Error('simulated scoring restart');
          }
          return semanticFixture(request)!;
        }
        if (request.role === 'script')
          return request.schema.parse({
            title: 'Fixture',
            topic: 'fixture',
            angle: 'fixture',
            personaId: 'persona_maker',
            narration: '',
            beats: [
              {
                id: 'beat_a',
                text: `可见图形，第 ${calls.filter((role) => role === 'script').length} 版内容`,
                visualQuery: 'test',
                durationHint: 2,
              },
            ],
            facts: [],
          });
        if (['facts_review', 'audience_review', 'voice_review'].includes(request.role))
          return request.schema.parse({
            passed: calls.filter((role) => role === 'script').length >= 5,
            issues: [],
          });
        if (request.role === 'materials') {
          await initial.library.frames(asset.id, [0]);
          return request.schema.parse({
            status: 'ready',
            matches: [
              {
                needId: 'visual_1',
                assetId: asset.id,
                sourceStart: 0,
                sourceEnd: 2,
                observation: '移动图形',
                frameTimes: [0],
              },
            ],
            gaps: [],
          });
        }
        if (request.role === 'materials_review') {
          const clip = (request.input as any).clips[0];
          return request.schema.parse({
            verdict: 'matched',
            observation: '移动图形',
            evidence: [{ matchIndex: clip.matchIndex, time: clip.evidenceTimes[0] }],
          });
        }
        if (request.role === 'editor') {
          if (interruptOnce) {
            interruptOnce = false;
            throw new Error('simulated restart');
          }
          if (replaceMaterialOnce) {
            replaceMaterialOnce = false;
            return request.schema.parse({
              kind: 'material_request',
              needIds: ['visual_1'],
              reason: '核对运动片段是否覆盖整个两秒',
            });
          }
          return request.schema.parse(
            editorialSchema.parse({
              schemaVersion: 1,
              revision: 0,
              duration: 2,
              shots: [
                { id: 'secret_creator_intent', assetId: asset.id, sourceStart: 0, start: 0, duration: 2 },
              ],
            }),
          );
        }
        if (request.role === 'layout')
          return request.schema.parse(
            defaultRender((request.input as { editorial: EditorialIR }).editorial, {
              width: 320,
              height: 480,
              fps: 8,
            }),
          );
        assert.ok(!JSON.stringify(request.input).includes('SECRET_REQUIREMENT'));
        assert.ok(!JSON.stringify(request.input).includes('secret_creator_intent'));
        assert.ok(request.images?.length);
        if (request.role === 'visual_audience') {
          const observation = (request.input as any).observation;
          assert.equal(observation.visualAnalysis.version, 'media-quality-v2');
          assert.ok(Array.isArray(observation.visualAnalysis.frozenIntervals));
        }
        const count = (reviewCounts.get(request.role) ?? 0) + 1;
        reviewCounts.set(request.role, count);
        return request.schema.parse({
          summary: '画面是移动的图形',
          claims: [{ text: '画面是移动的图形', confidence: 1, evidenceIds: ['evidence_a'] }],
          events: [],
          relations: [],
          emotionTimeline: [],
          pacing: '平稳',
          ambiguities: [],
          evidence: [
            {
              id: 'evidence_a',
              bindingId: 'element_0001',
              start: 0,
              end:
                (request.role === 'editorial_audience' && count === 1) ||
                (request.role === 'visual_audience' && count === 1)
                  ? 3
                  : 2,
              modality: request.role === 'editorial_audience' && count === 2 ? 'audio' : 'visual',
              observation: '图形在移动',
            },
          ],
          issues: [],
        });
      },
    };
    const model = {
      version: 'unused-retrieval',
      async compare(): Promise<{ similarity: number }[]> {
        throw new Error('A noncreative workflow must not require a local semantic model');
      },
    };
    await assert.rejects(
      new TaskRunner(store, task.id, undefined, { agent: driver, model }).run(),
      /simulated restart/,
    );
    assert.ok(store.artifact(task.id, 'script'));
    assert.equal(store.task(task.id).status, 'failed');
    const resumed = new TaskRunner(store, task.id, undefined, {
      agent: driver,
      model,
    });
    await assert.rejects(resumed.run(), /simulated scoring restart/);
    assert.equal(store.task(task.id).status, 'failed');
    const pending = store.artifact<any>(task.id, 'editorial.pending_assessment')!;
    assert.equal(pending.data.candidateHash, store.artifact(task.id, 'editorial.candidate', false)!.hash);
    const cutsBeforeRecovery = calls.filter((c) => c === 'editor').length;
    const result = await resumed.run();
    assert.equal(
      calls.filter((c) => c === 'editor').length,
      cutsBeforeRecovery,
      'Scoring recovery must reassess the existing cut',
    );
    await resumed.flushArtifacts();
    assert.equal(result.status, 'completed');
    assert.equal(calls.filter((c) => c === 'script').length, 5);
    assert.equal(
      calls.filter((c) => c === 'editor').length,
      3,
      'one interruption, one material request and one actual cut; report repairs must not recut',
    );
    assert.equal(
      calls.filter((c) => c === 'materials').length,
      2,
      'material request returns to matching without rewriting the script',
    );
    assert.equal(
      calls.filter((c) => c === 'layout').length,
      1,
      'visual report repair must not regenerate or rerender the layout',
    );
    assert.equal(store.events(task.id).filter((e) => e.type === 'review.repair_requested').length, 3);
    assert.ok(store.artifact(task.id, 'render'));
    assert.ok(store.artifact(task.id, 'final.alignment'));
    // A controlled final-review defect exercises the actual render repair loop,
    // including new media paths on each iteration.
    const approvedScript = store.artifact(task.id, 'script')!;
    const approvedCut = store.artifact<EditorialIR>(task.id, 'editorial')!;
    const savedPreview = store.artifact<any>(task.id, 'layout.preview', false)!.data;
    const renderCall = t.mock.method(Renderer.prototype, 'render', async () => {
      throw new Error('Registered preview must survive a runner restart');
    });
    const recoveredPreview = await (
      new TaskRunner(store, task.id, undefined, { agent: driver, model }) as any
    ).preview(approvedCut.data, store.artifact(task.id, 'layout')!.data);
    assert.equal(recoveredPreview.path, savedPreview.path);
    assert.equal(renderCall.mock.callCount(), 0);
    renderCall.mock.restore();
    store.invalidateFrom(task.id, ['layout', 'render']);
    store.updateTask(task.id, 'paused', 'layout');
    const repeated = new TaskRunner(store, task.id, undefined, { agent: driver, model });
    let renderReviews = 0;
    (repeated as any).layout = async (cut: EditorialIR) => {
      const layout = defaultRender(cut, { width: 320, height: 480, fps: 8 });
      return layout;
    };
    (repeated as any).visualReview = async () => {
      assert.ok(++renderReviews < 4, 'external test guard: unchanged rejected renders must stop');
      const report = audience();
      report.evidence[0]!.bindingId = approvedCut.data.shots[0]!.id;
      report.issues = [
        {
          kind: 'layout',
          severity: 'blocking',
          message: '同一测试布局缺陷',
          bindingId: approvedCut.data.shots[0]!.id,
          time: 0,
        },
      ];
      return audienceSchema.parse(report);
    };
    await assert.rejects(repeated.run(), { code: 'NO_PROGRESS' });
    assert.equal(renderReviews, 2);
    assert.equal(store.task(task.id).status, 'blocked');
    assert.ok(store.artifact(task.id, 'workflow.no_progress', false));
    assert.equal(store.artifact(task.id, 'script')!.hash, approvedScript.hash);
    assert.equal(store.artifact(task.id, 'editorial')!.hash, approvedCut.hash);
  },
);

test('localhost API requires token, validates input and exposes scoped artifacts', async (t) => {
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'filmedit-api-')));
  const api = createApi(store, 'test-token');
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    store.close();
  });
  const address = api.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/tasks`)).status, 401);
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  assert.equal(
    (await fetch(`${base}/tasks`, { method: 'POST', headers, body: JSON.stringify({ prompt: '' }) })).status,
    400,
  );
  const response = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: 'test', materials: { strategy: 'local_only' } }),
  });
  assert.equal(response.status, 201);
  const task = (await response.json()) as { id: string };
  assert.equal((await fetch(`${base}/tasks/${task.id}`, { headers })).status, 200);
  const budgetUpdate = await fetch(`${base}/tasks/${task.id}/budgets`, {
    method: 'PUT',
    headers,
    body: '{}',
  });
  assert.equal(budgetUpdate.status, 200);
  assert.deepEqual(((await budgetUpdate.json()) as any).spec.budgets, {
    stageRounds: null,
    renderRounds: null,
    agentTurns: null,
    usd: null,
  });
  assert.equal(store.task(task.id).status, 'queued');
  assert.equal(
    (await fetch(`${base}/tasks`, { headers: { ...headers, Origin: 'https://example.com' } })).status,
    400,
  );
  assert.equal((await fetch(`${base}/tasks/${task.id}/video`, { headers })).status, 404);
});
