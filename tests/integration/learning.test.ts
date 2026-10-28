import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { fixture } from '../helpers.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { LearningService } from '../../packages/application/src/learning.js';
import type { AgentDriver } from '../../packages/agent-runtime/src/agents.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import { defaultRender } from '../../packages/core/src/ir.js';
import { Renderer } from '../../packages/media/src/render.js';
import { FilmError, hash } from '../../packages/core/src/util.js';
import { createApi } from '../../apps/server/src/service.js';
import { projectRoot } from '../../packages/infrastructure/src/process.js';

test(
  'script learning checkpoints OCR and provenance, resumes review, and publishes memories exactly once',
  { timeout: 60000 },
  async (t) => {
    const { store } = await fixture();
    t.after(() => store.close());
    const preparation = await createTask(store, {
      prompt: 'generate a text reference',
      materials: { strategy: 'local_only' },
    });
    const runner = new TaskRunner(store, preparation.id),
      source = path.join(preparation.policy.workspace, 'reference.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=320x180:r=8:d=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      source,
    ]);
    const background = await runner.library.importFile(source, 'generated');
    const edit = editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration: 3,
      shots: [{ id: 'base', assetId: background.id, sourceStart: 0, start: 0, duration: 3 }],
      text: [{ id: 'title', text: 'Day one', role: 'title', start: 0, duration: 3 }],
    });
    const layout = defaultRender(edit, { width: 320, height: 180, fps: 8 });
    layout.nodes[1]!.placement = { mode: 'rect', rect: [0.1, 0.1, 0.8, 0.6] };
    layout.nodes[1]!.style!.fontSize = 30;
    const reference = await new Renderer(runner.library, runner.processes).render(edit, layout);
    const calls: string[] = [];
    const agent: AgentDriver = {
      async run(request) {
        calls.push(request.role);
        if (request.role === 'ocr') return request.schema.parse({ items: [{ time: 0, text: 'Day one' }] });
        if (request.role === 'learner') {
          assert.equal((request.input as any).ocr.items[0].text, 'Day one');
          const revised = calls.filter((role) => role === 'learner').length > 1;
          if (revised) {
            assert.equal((request.input as any).previous.memories[0].provenance, 'source_narrative');
            assert.equal((request.input as any).feedback.issues[0].evidence, 'Day one');
          }
          return request.schema.parse({
            memories: [
              {
                kind: 'angle',
                content: '从第一天切入生活记录',
                tags: ['生活记录'],
                provenance: revised ? 'inferred' : 'source_narrative',
                confidence: 0.8,
                start: 0,
                end: 3,
              },
            ],
          });
        }
        if (calls.filter((r) => r === 'facts_review').length === 1) throw new Error('review interrupted');
        if (calls.filter((r) => r === 'facts_review').length === 2)
          return request.schema.parse({
            issues: [
              {
                evidence: 'Day one',
                memoryIndex: 0,
                kind: 'provenance',
                message: '这是一种推断角度，不能标为来源人物的叙述',
              },
            ],
          });
        return request.schema.parse({ issues: [] });
      },
    };
    const service = new LearningService(store, () => agent);
    const experiment = service.enqueue({ kind: 'script', query: '生活记录', localPaths: [reference.path] });
    await assert.rejects(service.run(experiment), /review interrupted/);
    const interrupted = service.list().find((e) => e.id === experiment)!;
    const taskId = interrupted.result.taskId;
    assert.equal(store.artifact(taskId, 'learning.ocr')!.accepted, true);
    assert.equal(
      store.artifact(taskId, 'learning.script'),
      undefined,
      'unreviewed records cannot be accepted',
    );
    const result: any = await service.run(experiment);
    assert.equal(result.taskId, taskId);
    assert.equal(calls.filter((r) => r === 'ocr').length, 1);
    assert.equal(calls.filter((r) => r === 'learner').length, 2);
    assert.equal(calls.filter((r) => r === 'facts_review').length, 3);
    assert.equal(result.memoryIds.length, 1);
    const record = store.db
      .prepare('SELECT account_id,provenance,source FROM memories WHERE id=?')
      .get(result.memoryIds[0])!;
    assert.equal(record.account_id, null);
    assert.equal(record.provenance, 'inferred');
    assert.ok(String(record.source).includes('#t=0,3&experiment='));
    assert.deepEqual(await service.run(experiment), result);
    assert.equal(calls.length, 6, 'completed experiment must not publish again');
    // Actual native CLI -> authenticated local API -> the same application command service.
    const api = createApi(store);
    await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve));
    const address = api.server.address();
    assert.ok(address && typeof address !== 'string');
    const descriptor = path.join(store.home, 'daemon.json');
    try {
      await writeFile(
        descriptor,
        JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${address.port}`, token: api.token }),
        { mode: 0o600 },
      );
      const invoke = async (name: string, args: unknown) => {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [path.join(projectRoot, 'dist/cli.js'), 'command', name, '--json', JSON.stringify(args)],
          { env: { ...process.env, FILMEDIT_HOME: store.home }, timeout: 10000 },
        );
        return JSON.parse(stdout);
      };
      const before = await invoke('learning.knowledge', { experimentId: experiment });
      assert.equal(before.items[0].state, 'active');
      assert.equal(before.items[0].memory.provenance, 'inferred');
      await invoke('learning.retract', {
        experimentId: experiment,
        memoryId: result.memoryIds[0],
        reason: '本地流程验证：撤回测试学习记录',
      });
      const after = await invoke('learning.knowledge', { experimentId: experiment });
      assert.equal(after.items[0].state, 'retracted');
      assert.equal(after.items[0].memory.source, record.source);
      assert.equal(
        store.memories(null, '生活记录').some((m) => m.id === result.memoryIds[0]),
        false,
      );
      assert.deepEqual(await service.run(experiment), result);
      assert.equal(calls.length, 6, 'inspection/retraction must not call the model or republish');
    } finally {
      await api.workbench.close();
      api.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        api.server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(descriptor, { force: true });
    }
    let repeated = 0;
    const stuck = new LearningService(store, () => ({
      async run(request) {
        if (request.role === 'ocr') return request.schema.parse({ items: [{ time: 0, text: 'Day one' }] });
        if (request.role === 'learner') {
          assert.ok(++repeated < 4, 'unchanged rejected learning records must not be regenerated forever');
          return request.schema.parse({
            memories: [
              {
                kind: 'angle',
                content: '从第一天切入生活记录',
                tags: ['生活记录'],
                provenance: 'source_narrative',
                confidence: 0.8,
                start: 0,
                end: 3,
              },
            ],
          });
        }
        return request.schema.parse({
          issues: [
            {
              evidence: 'Day one',
              memoryIndex: 0,
              kind: 'provenance',
              message: '推断不能冒充来源叙述',
            },
          ],
        });
      },
    }));
    const blockedId = stuck.enqueue({
      kind: 'script',
      query: 'repeated rejection',
      localPaths: [reference.path],
    });
    await assert.rejects(stuck.run(blockedId), { code: 'NO_PROGRESS' });
    assert.equal(repeated, 2);
    const blocked = stuck.list().find((item) => item.id === blockedId)!;
    assert.equal(blocked.state, 'blocked');
    assert.ok(store.artifact(blocked.result.taskId, 'learning.script.no_progress', false));
    assert.equal(store.artifact(blocked.result.taskId, 'learning.script'), undefined);
  },
);

test(
  'technique learner sees failed renders and stops an identical rejected implementation without publishing',
  { timeout: 90000 },
  async (t) => {
    const { store } = await fixture();
    t.after(() => store.close());
    const preparation = await createTask(store, { prompt: 'prepare comparison samples' });
    const runner = new TaskRunner(store, preparation.id);
    const inputs: string[] = [];
    for (const [index, color] of ['yellow', 'red', 'green', 'blue', 'white'].entries()) {
      const file = path.join(preparation.policy.workspace, `reference-${index}.mp4`);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=${color}:s=128x128:r=12:d=3`,
        ...(index === 0 ? ['-vf', 'fade=t=in:st=0:d=0.5,fade=t=out:st=2.5:d=0.5'] : []),
        '-an',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        file,
      ]);
      inputs.push(file);
    }
    let attempts = 0;
    const service = new LearningService(store, () => ({
      async run(request) {
        assert.equal(request.role, 'learner');
        assert.equal(request.toolAccess, 'none', 'the learner cannot browse evaluation materials');
        const input = request.input as any;
        assert.equal(input.reference.measurements.samples.length, 13);
        assert.ok(request.images!.some((frame) => frame.label.startsWith('重建素材 ')));
        const selected = store.artifact<{ assetId: string }[]>(
          store.tasks('learning')[0]!.id,
          'learning.materials',
        )!.data;
        const context = JSON.stringify({ input, images: request.images });
        for (const hidden of selected.slice(1)) assert.ok(!context.includes(hidden.assetId));
        assert.ok(++attempts < 4, 'external test guard: identical implementation must stop');
        if (attempts === 2) {
          assert.equal(input.feedback.comparison.passed, false);
          assert.equal(input.previousRender.attempt, 0);
          assert.equal(input.previousRender.measurements.samples.length, 13);
          assert.ok(request.images!.some((frame) => frame.label.includes('上次实际重建')));
          assert.ok(request.images!.some((frame) => frame.label.includes('参考时间')));
        }
        const editorial = editorialSchema.parse({
          schemaVersion: 1,
          revision: 0,
          duration: 3,
          shots: [
            { id: 'base', assetId: input.reconstructionMaterial.id, sourceStart: 0, start: 0, duration: 3 },
          ],
        });
        return request.schema.parse({
          hypothesis: `cosmetic hypothesis revision ${attempts}`,
          technique: { id: 'unchanged_picture', description: 'negative control', layer: 'presentation' },
          editorial,
          render: defaultRender(editorial, { width: 128, height: 128, fps: 12 }),
          code: { files: [] },
        });
      },
    }));
    const experiment = service.enqueue({
      kind: 'technique',
      query: 'observe the change',
      duration: 3,
      localPaths: inputs,
    });
    await assert.rejects(service.run(experiment), { code: 'NO_PROGRESS' });
    assert.equal(attempts, 2);
    const taskId = service.list()[0]!.result.taskId;
    assert.equal((store.artifact(taskId, 'learning.preview')!.data as any).frames.length, 13);
    assert.equal((store.artifact(taskId, 'learning.checkpoint')!.data as any).nextAttempt, 2);
    assert.ok(store.artifact(taskId, 'learning.no_progress', false));
    assert.equal(service.list()[0]!.state, 'blocked');
    assert.equal(store.activeRelease(), 'builtin_v1');
  },
);

test(
  'technique review service failures preserve the same implementation and attempt on resume',
  { timeout: 120000 },
  async (t) => {
    const { store } = await fixture();
    t.after(() => store.close());
    const preparation = await createTask(store, { prompt: 'prepare review interruption samples' });
    const runner = new TaskRunner(store, preparation.id);
    const inputs: string[] = [];
    for (const [index, color] of ['yellow', 'red', 'green', 'blue', 'white'].entries()) {
      const file = path.join(preparation.policy.workspace, `material-${index}.mp4`);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=${color}:s=128x128:r=12:d=3`,
        ...(index === 0 ? ['-vf', 'fade=t=in:st=0:d=0.5,fade=t=out:st=2.5:d=0.5'] : []),
        '-an',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        file,
      ]);
      inputs.push(file);
    }
    let candidates = 0,
      reviews = 0;
    const service = new LearningService(store, () => ({
      async run(request) {
        if (request.role === 'visual_audience') {
          assert.equal(request.toolAccess, 'none');
          assert.ok(request.images!.some((frame) => frame.label.startsWith('原始素材（未应用手法）')));
          const observations = request.input as any;
          assert.equal(observations.measurements.reference.samples.length, 13);
          assert.equal(observations.measurements.reconstruction.samples.length, 13);
          assert.equal(observations.hypothesis, undefined, 'independent review cannot read the proposal');
          reviews++;
          throw new FilmError(reviews === 1 ? 'MODEL_BALANCE' : 'AGENT_FAILED', 'provider unavailable');
        }
        assert.equal(request.role, 'learner');
        assert.equal(++candidates, 1, 'an interrupted review must not request a new implementation');
        const input = request.input as any;
        const editorial = editorialSchema.parse({
          schemaVersion: 1,
          revision: 0,
          duration: 3,
          shots: [
            { id: 'base', assetId: input.reconstructionMaterial.id, sourceStart: 0, start: 0, duration: 3 },
          ],
        });
        const render = defaultRender(editorial, { width: 128, height: 128, fps: 12 });
        render.nodes[0]!.keyframes = [
          { time: 0, opacity: 0 },
          { time: 0.5, opacity: 1 },
          { time: 2.5, opacity: 1 },
          { time: 3, opacity: 0 },
        ];
        return request.schema.parse({
          hypothesis: 'fade in and out',
          technique: { id: 'fixture_fade', description: 'fade', layer: 'presentation' },
          editorial,
          render,
          code: { files: [] },
        });
      },
    }));
    const experiment = service.enqueue({
      kind: 'technique',
      query: 'review interruption',
      duration: 3,
      localPaths: inputs,
      maxAttempts: 1,
    });
    await assert.rejects(service.run(experiment), { code: 'MODEL_BALANCE' });
    const taskId = service.list()[0]!.result.taskId;
    const candidateHash = hash(store.artifact(taskId, 'learning.candidate.0')!.data);
    assert.equal(
      store.artifact(taskId, 'learning.checkpoint'),
      undefined,
      'failure does not consume an attempt',
    );
    assert.equal(store.artifact(taskId, 'learning.failure'), undefined, 'outage is not candidate feedback');
    await assert.rejects(service.run(experiment), { code: 'AGENT_FAILED' });
    assert.equal(reviews, 2);
    assert.equal(candidates, 1);
    assert.equal(hash(store.artifact(taskId, 'learning.candidate.0')!.data), candidateHash);
    assert.equal(store.artifact(taskId, 'learning.candidate.1'), undefined);
    assert.equal(service.list()[0]!.state, 'blocked');
    assert.equal(store.activeRelease(), 'builtin_v1');
  },
);
