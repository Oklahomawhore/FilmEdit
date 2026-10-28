import { semanticFixture } from '../helpers.js';
import { intentReviewFixture } from '../helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../helpers.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import type { Asset } from '../../packages/core/src/domain.js';
import type { FilmTool } from '../../packages/agent-runtime/src/pi-runtime.js';
import { fileHash } from '../../packages/infrastructure/src/files.js';
import type { AgentDriver } from '../../packages/agent-runtime/src/agents.js';

import { TaskService } from '../../packages/application/src/task-service.js';
import { Store } from '../../packages/infrastructure/src/store.js';
import { taskProgress } from '../../packages/application/src/progress.js';
import { hash } from '../../packages/core/src/util.js';

test(
  'missing local media resumes from persisted creative/script after new files arrive, then renders and exports without recutting',
  { timeout: 180000 },
  async (t) => {
    const f = await fixture();
    let store = f.store;
    const materials = f.materials;
    t.after(() => store.close());
    const generator = await createTask(store, {
      prompt: '生成技术测试素材',
      access: { writePaths: [materials] },
    });
    const task = await createTask(store, {
      prompt: 'SECRET_USER_留白自由发挥。仅用本地素材。',
      creative: { knowledge: 'local', seed: 'regression' },
      budgets: { stageRounds: 2 },
      composition: { width: 320, height: 180, fps: 12 },
      materials: { paths: [materials], strategy: 'local_only' },
      access: { readPaths: [materials] },
      output: { aspectRatio: '4:3', height: 180, fps: 12, duration: 1 },
    });
    const layoutInstruction = { instruction: 'SECRET_LAYOUT_USER：完整保留源画面，允许留边。' };
    store.saveArtifact(task.id, 'layout.user_revision', layoutInstruction, true);
    const setup = new TaskRunner(store, generator.id),
      source = path.join(
        generator.policy.writes.find((grant) => grant.path.endsWith('/materials'))!.path,
        'source.mp4',
      );
    const generateSource = () =>
      setup.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=12:duration=1',
        '-c:v',
        'libx264',
        source,
      ]);
    await writeFile(path.join(materials, 'broken.mp4'), 'invalid unrelated media');
    let sourceRunner = new TaskRunner(store, task.id);
    let tools: FilmTool[] = (sourceRunner.agent as any).createTools({ role: 'materials' }, false);
    const call = async (name: string, args: unknown) => {
      const tool = tools.find((tool) => tool.name === name)!;
      return tool.execute(tool.schema.parse(args), `fixture-${name}`);
    };
    const readJson = (result: Awaited<ReturnType<typeof call>>) =>
      JSON.parse((result.content[0] as { text: string }).text);
    let asset: Asset;
    const roles: string[] = [];
    const driver: AgentDriver = {
      async run(req) {
        const semantic = semanticFixture(req);
        if (semantic) return semantic;
        roles.push(req.role);
        const input = req.input as any;
        if (req.role === 'acceptance')
          return req.schema.parse({
            schemaVersion: 1,
            sources: input.sources.map((s: any) => ({
              sourceId: s.id,
              checks: [],
            })),
          });
        if (req.role === 'acceptance_review')
          return req.schema.parse({
            sources: input.sources.map((s: any) => ({
              sourceId: s.id,
              verdict: 'equivalent',
              counterexamples: [],
              reason: 'fixture equivalence',
            })),
          });
        if (req.role === 'intent')
          return req.schema.parse({
            schemaVersion: 1,
            constraints: [],
            openQuestions: ['视觉表达'],
            technical: [{ kind: 'local_materials', value: true, quote: '仅用本地素材。' }],
          });
        if (req.role === 'intent_review') return intentReviewFixture(req);
        if (req.role === 'creative') {
          assert.equal(
            store.assets(task.id).length,
            0,
            'creative generation must not depend on importing the authorized directory',
          );
          return req.schema.parse({
            candidates: [
              {
                id: 'c1',
                proposal: {
                  theme: { subject: '色块', question: '' },
                  content: { synopsis: '图形运动', narration: '' },
                  expression: {
                    angle: '视觉',
                    persona: '观察者',
                    audience: '一般观众',
                    tone: '活泼',
                    music: '',
                    editing: '直接呈现',
                  },
                },
                operators: ['visual_analogy'],
                knowledgeIds: [],
                bridge: 'SECRET_BRIDGE',
                surprise: '反差',
                emotion: '好奇',
                beats: [{ id: 'b1', action: '移动', visual: '画面图形移动', audio: '', assetIds: [] }],
                commitments: [{ id: 'v1', text: '画面图形移动', modality: 'visual', stage: 'editorial' }],
                uncertainties: [],
              },
            ],
          });
        }
        if (req.role === 'concept_audience') {
          assert.ok(!JSON.stringify(input).includes('SECRET'));
          return req.schema.parse({
            understood: '图形运动',
            connection: '视觉对比',
            understandable: true,
            feasible: true,
            emotion: '活泼',
            issues: [],
          });
        }
        if (req.role === 'script') {
          assert.equal(store.assets(task.id).length, 0);
          assert.equal(input.creativeBrief.concept.bridge, 'SECRET_BRIDGE');
          return req.schema.parse({
            title: '运动',
            topic: '色块',
            angle: '视觉',
            personaId: 'persona_maker',
            narration: '',
            beats: [{ id: 'b1', text: '图形移动', visualQuery: '测试素材', durationHint: 1 }],
            facts: [],
          });
        }
        if (['facts_review', 'audience_review', 'voice_review'].includes(req.role)) {
          if (req.role === 'audience_review') assert.equal(input.creativeBrief, undefined);
          else assert.ok(input.creativeBrief);
          return req.schema.parse({ passed: true, issues: [] });
        }
        if (req.role === 'materials') {
          const roots = readJson(await call('local_materials', {}));
          const sourceId = roots.items[0].sourceId;
          const files = readJson(await call('local_materials', { sourceId }));
          assert.ok(files.items.some((file: any) => file.relativePath === 'broken.mp4'));
          const selected = files.items.find((file: any) => file.relativePath === 'source.mp4');
          if (!selected) {
            await assert.rejects(call('import_local_material', { sourceId, relativePath: 'broken.mp4' }), {
              code: 'PROCESS_FAILED',
            });
            return req.schema.parse({
              status: 'missing',
              matches: [],
              gaps: input.requirements.map((need: any) => ({
                needId: need.id,
                attemptedQueries: ['local:broken.mp4'],
                reason: 'Actual decoder rejected the only supplied video',
              })),
            });
          }
          assert.equal(input.previousGaps.length, 1);
          assert.equal(input.attempt, 1);
          const imported = readJson(
            await call('import_local_material', { sourceId, relativePath: selected.relativePath }),
          );
          asset = store.asset(task.id, imported.id);
          const frames = await call('frame', { assetId: asset.id, times: [0] });
          assert.ok(frames.content.some((item) => item.type === 'image'));
          assert.equal(input.creativeBrief.concept.beats[0].visual, '画面图形移动');
          assert.equal(input.requirements[0].query, '测试素材');
          return req.schema.parse({
            status: 'ready',
            matches: [
              {
                needId: input.requirements[0].id,
                assetId: asset.id,
                sourceStart: 0,
                sourceEnd: 1,
                observation: '画面图形移动',
                frameTimes: [0],
              },
            ],
            gaps: [],
          });
        }
        if (req.role === 'materials_review') {
          assert.equal(req.toolAccess, 'none');
          assert.ok(!JSON.stringify(input).includes('SECRET'));
          return req.schema.parse({
            verdict: 'matched',
            observation: '画面图形移动',
            evidence: [{ matchIndex: input.clips[0].matchIndex, time: input.clips[0].evidenceTimes[0] }],
          });
        }
        if (req.role === 'editor') {
          assert.ok(input.creativeBrief);
          assert.equal(input.materialManifest.matches[0].assetId, asset.id);
          return req.schema.parse(
            editorialSchema.parse({
              schemaVersion: 1,
              revision: 0,
              duration: 1,
              shots: [{ id: 's1', assetId: asset.id, sourceStart: 0, start: 0, duration: 1 }],
            }),
          );
        }
        if (req.role === 'layout') {
          assert.ok(input.creativeBrief);
          assert.deepEqual(input.userRevision, layoutInstruction);
          return req.schema.parse(input.template);
        }
        assert.ok(['editorial_audience', 'visual_audience'].includes(req.role));
        assert.ok(!JSON.stringify(input).includes('SECRET'));
        return req.schema.parse({
          summary: '图形移动',
          claims: [{ text: '画面图形移动', evidenceIds: ['e1'], confidence: 1 }],
          events: [],
          relations: [],
          emotionTimeline: [],
          pacing: '平稳',
          ambiguities: [],
          issues: [],
          evidence: [
            {
              id: 'e1',
              bindingId: 'element_0001',
              start: 0,
              end: 1,
              modality: 'visual',
              observation: '画面图形移动',
            },
          ],
        });
      },
    };
    const model: import('../../packages/media/src/scoring.js').SemanticModel = {
      version: 'fixture',
      async compare(pairs) {
        return pairs.map((p) => {
          assert.ok(!p.hypothesis.includes('SECRET_USER'), 'open user prompt is not an acceptance target');
          return { similarity: 0.98, entailment: 0.98, contradiction: 0.01, neutral: 0.01 };
        });
      },
    };
    const runner = new TaskRunner(store, task.id, undefined, { agent: driver, model });
    await assert.rejects(runner.run(), { code: 'MATERIALS_MISSING' });
    assert.equal(store.task(task.id).status, 'blocked');
    assert.equal(store.task(task.id).stage, 'materials');
    assert.equal(store.artifact(task.id, 'render'), undefined);
    const savedBrief = store.artifact(task.id, 'creative.brief')!,
      savedScript = store.artifact(task.id, 'script')!;
    assert.ok(savedBrief);
    assert.ok(savedScript);
    const savedGap = store.artifact(task.id, 'materials.gaps', false)!;
    assert.ok(savedGap);
    assert.ok(taskProgress(store, task.id).gaps);
    await generateSource();
    const originalHash = await fileHash(source);
    const home = store.home;
    store.close();
    store = new Store(home);
    sourceRunner = new TaskRunner(store, task.id);
    tools = (sourceRunner.agent as any).createTools({ role: 'materials' }, false);
    const resumed = new TaskRunner(store, task.id, undefined, { agent: driver, model });
    const result = await resumed.run();
    assert.equal(result.status, 'completed');
    assert.deepEqual(store.artifact(task.id, 'layout.user_revision')!.data, layoutInstruction);
    assert.deepEqual(
      store
        .assets(task.id)
        .filter((a) => a.source.kind === 'local')
        .map((a) => a.source.path),
      [source],
      'only the selected local source is imported; registered render previews are separate generated assets',
    );
    assert.equal(await fileHash(source), originalHash);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM library_assets').get()!.n, 0);
    await assert.rejects(
      sourceRunner.processes.run('/bin/sh', ['-c', 'printf changed > "$1"', 'write-check', source]),
    );
    assert.equal(
      await fileHash(source),
      originalHash,
      'the actual child process cannot overwrite the original',
    );
    assert.equal(store.artifact(task.id, 'creative.brief')!.id, savedBrief.id);
    assert.equal(store.artifact(task.id, 'creative.brief')!.hash, savedBrief.hash);
    assert.equal(store.artifact(task.id, 'script')!.id, savedScript.id);
    assert.equal(store.artifact(task.id, 'script')!.hash, savedScript.hash);
    assert.equal(store.artifact(task.id, 'materials.gaps', false), undefined);
    assert.equal(taskProgress(store, task.id).gaps, undefined);
    assert.ok(store.db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(savedGap.id));
    assert.equal(roles.filter((role) => role === 'materials').length, 2);
    for (const role of [
      'intent',
      'creative',
      'script',
      'facts_review',
      'audience_review',
      'voice_review',
      'editor',
      'layout',
    ])
      assert.equal(roles.filter((r) => r === role).length, 1);
    const accepted = store.artifact(task.id, 'layout')!,
      cut = store.artifact(task.id, 'editorial')!;
    const output = store.artifact<any>(task.id, 'render')!.data;
    assert.equal(output.exportProfile.width, 240);
    const exported = await new TaskService(store).export(task.id, {
      aspectRatio: '16:9',
      height: 180,
      fps: 15,
    });
    assert.equal(exported.exportProfile.width, 320);
    assert.equal(exported.aiReviewed, false);
    assert.equal(hash(store.artifact(task.id, 'layout')!.data), hash(accepted.data));
    assert.equal(hash(store.artifact(task.id, 'editorial')!.data), hash(cut.data));
    assert.equal(store.artifact<any>(task.id, 'render')!.data.path, output.path);
  },
);
