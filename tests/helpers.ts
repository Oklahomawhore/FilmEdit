import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../packages/infrastructure/src/store.js';
import { assetSchema, editorialSchema, audienceSchema } from '../packages/core/src/domain.js';
import { conceptSchema } from '../packages/core/src/creative-domain.js';

export function conceptFixture(id: string, subject = id) {
  return conceptSchema.parse({
    id,
    proposal: {
      theme: { subject, question: '熟悉的东西还能怎样看？' },
      content: { synopsis: `${subject}与日常生活形成反差`, narration: '' },
      expression: {
        angle: '反差',
        persona: '观察者',
        audience: '都市生活观众',
        tone: '轻松',
        music: 'Funk',
        editing: '动作匹配',
      },
    },
    operators: ['context_transfer'],
    knowledgeIds: [],
    bridge: '把人物动作与生活中的动作对应',
    surprise: '熟悉角色进入新的日常情境',
    emotion: '好笑',
    beats: [{ id: 'opening', action: '开门', visual: '角色开门的画面', audio: '开门声', assetIds: [] }],
    commitments: [{ id: 'visible', text: '角色开门后出现日常场景', modality: 'visual', stage: 'editorial' }],
    uncertainties: ['素材将在脚本确定后查找'],
  });
}
export async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'filmedit-test-'));
  const materials = path.join(root, 'materials');
  await mkdir(materials);
  await writeFile(path.join(materials, 'one.txt'), 'one');
  await writeFile(path.join(materials, 'two.txt'), 'two');
  const store = new Store(path.join(root, 'state'));
  return { root, materials, store };
}
export const asset = assetSchema.parse({
  id: 'asset_a',
  taskId: 'task_a',
  source: { kind: 'local', path: '/fixture/video.mp4' },
  sha256: 'a'.repeat(64),
  size: 100,
  kind: 'video',
  duration: 10,
  width: 1080,
  height: 1920,
  hasAudio: true,
  policyVersion: 'fixture',
});
export function editorial() {
  return editorialSchema.parse({
    schemaVersion: 1,
    revision: 0,
    duration: 4,
    shots: [
      { id: 'shot_a', assetId: asset.id, sourceStart: 0, start: 0, duration: 2 },
      { id: 'shot_b', assetId: asset.id, sourceStart: 5, start: 2, duration: 2 },
    ],
    text: [{ id: 'text_a', text: '你好', start: 0, duration: 2, role: 'subtitle' }],
  });
}
export function audience(claim = '一个人先关门，然后离开房间') {
  return audienceSchema.parse({
    summary: claim,
    claims: [{ text: claim, evidenceIds: ['evidence_a'], confidence: 1 }],
    events: [],
    relations: [],
    emotionTimeline: [],
    pacing: '平稳',
    ambiguities: [],
    evidence: [
      { id: 'evidence_a', bindingId: 'shot_a', start: 0, end: 2, modality: 'visual', observation: claim },
    ],
  });
}

/** Full report fixture for a two-shot cut; uncertainty counts as observation, not satisfaction. */
export function completeAudience(claim?: string) {
  const report = audience(claim);
  report.evidence.push({
    id: 'evidence_b',
    bindingId: 'shot_b',
    start: 2,
    end: 4,
    modality: 'visual',
    observation: '第二镜头的动作无法确认',
    entityId: null,
  });
  report.events.push({ at: 2, text: '无法确认后续动作', evidenceIds: ['evidence_b'] });
  return report;
}

/** Control-flow fixture only; real compilation is evaluated separately. */
export function acceptanceFixture<T>(
  request: import('../packages/agent-runtime/src/agents.js').AgentRequest<T>,
): T | undefined {
  if (request.role !== 'acceptance' && request.role !== 'acceptance_review') return undefined;
  const sources = (request.input as { sources: { id: string; text: string; modality: string }[] }).sources;
  return request.schema.parse(
    request.role === 'acceptance'
      ? {
          schemaVersion: 1,
          sources: sources.map((s) => ({
            sourceId: s.id,
            checks: [],
          })),
        }
      : {
          sources: sources.map((s) => ({
            sourceId: s.id,
            verdict: 'equivalent',
            counterexamples: [],
            reason: 'test fixture',
          })),
        },
  );
}

/** Intent review protocol fixture; does not establish extraction quality. */
export function intentReviewFixture<T>(
  request: import('../packages/agent-runtime/src/agents.js').AgentRequest<T>,
): T {
  const intent = (request.input as { intent: import('../packages/core/src/creative-domain.js').IntentSpec })
    .intent;
  return request.schema.parse({
    passed: true,
    issues: [],
    classifications: intent.constraints
      .filter((c) => c.source !== 'structured' && c.strength === 'fixed')
      .map((c) => ({ constraintId: c.id, kinds: ['meaning'], reason: 'control-flow fixture' })),
  });
}

/** Only a control-flow double. Semantic correctness is tested with actual model contrast cases. */
export function semanticFixture<T>(
  request: import('../packages/agent-runtime/src/agents.js').AgentRequest<T>,
): T | undefined {
  if (request.role !== 'semantic_review') return undefined;
  const input = request.input as any;
  return request.schema.parse(
    input.constraints
      ? {
          constraints: input.constraints.map((c: any) => ({
            id: c.id,
            status: c.premise.includes('冲突') ? 'contradicted' : 'supported',
            reason: 'control-flow fixture',
          })),
        }
      : {
          sources: input.requirements.map((s: any) => ({
            sourceId: s.id,
            status: 'supported',
            reason: 'control-flow fixture',
            evidenceIds: input.audience.evidence
              .filter((e: any) => s.modality === 'any' || e.modality === s.modality)
              .slice(0, 1)
              .map((e: any) => e.id),
          })),
        },
  );
}
