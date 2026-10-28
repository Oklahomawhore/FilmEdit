import { semanticFixture } from './helpers.js';
import { intentReviewFixture } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, audience, editorial } from './helpers.js';
import { scoreAcceptance } from '../packages/media/src/acceptance-scoring.js';
import { acceptanceSources } from '../packages/application/src/acceptance.js';
import { acceptancePlanSchema } from '../packages/core/src/acceptance.js';
import { defaultRender } from '../packages/core/src/ir.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import {
  CreativeEngine,
  validateIntent,
  validateIntentReview,
  intentReviewSchema,
  openDimensions,
  availableOperators,
  checkConcept,
  blindConcept,
  chooseConcept,
  validateTechnical,
  validateTechnicalLayout,
  validateOrientation,
  creativeMaterialRequirements,
  CREATIVE_GATE_VERSION,
} from '../packages/application/src/creativity.js';
import { cultureUrl, publicAddress } from '../packages/media/src/culture-web.js';
import { CreativeStore } from '../packages/infrastructure/src/creative-store.js';
import { resampleCreative } from '../packages/application/src/creative-service.js';
import {
  conceptSchema,
  dimensions,
  type IntentSpec,
  type IntentConstraint,
  type CreativeBrief,
} from '../packages/core/src/creative-domain.js';
import { type SemanticModel } from '../packages/media/src/scoring.js';
import type { AgentDriver } from '../packages/agent-runtime/src/agents.js';
import { z } from 'zod';
import { Workbench } from '../packages/application/src/workbench.js';
import { TaskService } from '../packages/application/src/task-service.js';

const model: SemanticModel = {
  version: 'fixture',
  async compare(pairs) {
    return pairs.map((p) => ({
      similarity: 0.98,
      entailment: p.premise.includes('冲突') ? 0.02 : 0.98,
      contradiction: p.premise.includes('冲突') ? 0.98 : 0.01,
      neutral: 0.01,
    }));
  },
};
const semanticAgent: AgentDriver = {
  async run(request) {
    return semanticFixture(request)!;
  },
};
const constraint = (overrides: Partial<IntentConstraint> = {}): IntentConstraint => ({
  id: 'c1',
  dimension: 'theme',
  field: 'subject',
  value: '人物',
  strength: 'fixed',
  match: 'semantic',
  polarity: 'require',
  modality: 'any',
  source: 'prompt',
  quote: '人物',
  confidence: 1,
  ...overrides,
});
const concept = () =>
  conceptSchema.parse({
    id: 'candidate',
    proposal: {
      theme: { subject: '人物', question: '' },
      content: { synopsis: '平凡生活', narration: '原文' },
      expression: {
        angle: '反差',
        persona: '观察者',
        audience: '了解都市生活的人',
        tone: '轻松',
        music: '',
        editing: '动作匹配',
      },
    },
    operators: ['context_transfer'],
    knowledgeIds: [],
    bridge: 'SECRET_BRIDGE',
    surprise: 'SECRET_SURPRISE',
    emotion: 'SECRET_EMOTION',
    beats: [{ id: 'beat1', action: '出门', visual: '人物关门', audio: '', assetIds: ['asset_a'] }],
    commitments: [{ id: 'commit1', text: '画面人物关门', modality: 'visual', stage: 'editorial' }],
    uncertainties: [],
  });

test('all eight fixed/open dimension combinations and quoted field constraints', () => {
  for (let mask = 0; mask < 8; mask++) {
    const constraints = dimensions.flatMap((dimension, i) =>
      mask & (1 << i) ? [constraint({ id: `c${i}`, dimension, field: '*' })] : [],
    );
    const intent = validateIntent({ schemaVersion: 1, constraints, openQuestions: [] }, '人物');
    assert.equal(openDimensions(intent).length, 3 - constraints.length);
    if (mask === 7) assert.equal(availableOperators(intent).length, 0);
  }
  assert.throws(() =>
    validateIntent(
      { schemaVersion: 1, constraints: [constraint({ quote: '伪造原句' })], openQuestions: [] },
      '人物',
    ),
  );
  assert.throws(() =>
    validateIntent(
      { schemaVersion: 1, constraints: [constraint({ source: 'inferred' })], openQuestions: [] },
      '人物',
    ),
  );
  const intent = validateIntent({ schemaVersion: 1, constraints: [], openQuestions: [] }, '自由', [
    constraint({ dimension: 'content', field: 'narration', match: 'exact', value: '原文' }),
  ]);
  assert.ok(!availableOperators(intent).some((o) => o.id === 'semantic_mutation'));
  assert.equal(intent.constraints[0]!.source, 'structured');
});

test('technical restrictions are checked by programs, not confused with exact text or semantic story claims', () => {
  assert.throws(
    () =>
      validateIntent(
        {
          schemaVersion: 1,
          constraints: [constraint({ polarity: 'forbid', value: '不得虚构人物', quote: '不得虚构人物' })],
          openQuestions: [],
        },
        '不得虚构人物',
      ),
    /second negation/,
  );
  assert.throws(() =>
    validateIntent(
      {
        schemaVersion: 1,
        constraints: [constraint({ match: 'exact', value: '使用原素材' })],
        openQuestions: [],
      },
      '人物',
    ),
  );
  assert.throws(() =>
    validateIntent(
      {
        schemaVersion: 1,
        constraints: [constraint({ value: '使用已有测试素材制作小样', quote: '用已有测试素材' })],
        openQuestions: [],
      },
      '用已有测试素材',
    ),
  );
  const intent = validateIntent(
    {
      schemaVersion: 1,
      constraints: [],
      openQuestions: [],
      technical: [
        { kind: 'duration', value: 1, quote: '一秒' },
        { kind: 'silent', value: true, quote: '无声' },
        { kind: 'local_materials', value: true, quote: '已有素材' },
      ],
    },
    '用已有素材做一秒无声小样',
  );
  assert.doesNotThrow(() => validateTechnical(intent, 1));
  assert.throws(() => validateTechnical(intent, 60), /conflicts/);
});

test('permissions and source descriptions cannot become fixed story obligations', () => {
  for (const quote of [
    '允许使用原有特写和半车身构图',
    '不要求每镜整车入画',
    '素材主要是车身局部和座舱细节，没有行驶镜头；允许使用原有特写',
  ]) {
    for (const polarity of ['require', 'forbid'] as const) {
      const c = constraint({
        dimension: 'content',
        field: 'synopsis',
        quote,
        value: '每镜整车入画',
        polarity,
      });
      assert.throws(
        () => validateIntent({ schemaVersion: 1, constraints: [c], openQuestions: [] }, quote),
        /Permission or source description/,
      );
      assert.doesNotThrow(() =>
        validateIntent(
          { schemaVersion: 1, constraints: [{ ...c, strength: 'open' }], openQuestions: [] },
          quote,
        ),
      );
    }
  }
  for (const quote of ['每镜必须整车入画', '不要出现行驶镜头', '素材必须能展示刹车过程']) {
    assert.doesNotThrow(() =>
      validateIntent(
        { schemaVersion: 1, constraints: [constraint({ quote, value: quote })], openQuestions: [] },
        quote,
      ),
    );
  }
  // Explicit user constraints still take precedence over inferred extraction.
  assert.doesNotThrow(() =>
    validateIntent({ schemaVersion: 1, constraints: [], openQuestions: [] }, '允许使用特写', [
      constraint({ quote: '允许使用特写', value: '特写' }),
    ]),
  );
});

test('mixed intent classification errors return to extraction, even when the reviewer claims a pass', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const prompt = '人物。用真实画面形成观众能看懂的创意。不要旁白。';
  const task = await createTask(store, { prompt, creative: { knowledge: 'local' } });
  const incorrect: IntentSpec = {
    schemaVersion: 1,
    openQuestions: [],
    technical: [{ kind: 'no_narration', value: true, quote: '不要旁白' }],
    constraints: [
      constraint(),
      constraint({
        id: 'quality',
        dimension: 'content',
        field: 'synopsis',
        value: '观众能看懂的创意',
        quote: '观众能看懂的创意',
      }),
      constraint({
        id: 'voice',
        dimension: 'content',
        field: 'narration',
        value: '旁白',
        quote: '不要旁白',
        polarity: 'forbid',
      }),
    ],
  };
  const corrected = { ...incorrect, constraints: [constraint()] };
  const c = concept();
  c.proposal.content.narration = '';
  c.beats[0]!.assetIds = [];
  let extractions = 0,
    creations = 0;
  const driver: AgentDriver = {
    async run(request) {
      const semantic = semanticFixture(request);
      if (semantic) return semantic;
      if (request.role === 'intent') {
        if (extractions++) assert.equal((request.input as any).feedback.passed, false);
        return request.schema.parse(extractions === 1 ? incorrect : corrected);
      }
      if (request.role === 'intent_review') {
        const current = (request.input as any).intent as IntentSpec;
        const review = request.schema.parse({
          passed: true,
          issues: [],
          classifications: current.constraints.map((item) => ({
            constraintId: item.id,
            kinds:
              item.id === 'quality'
                ? ['meaning', 'quality']
                : item.id === 'voice'
                  ? ['technical']
                  : ['meaning'],
            reason: 'explicit classification fixture',
          })),
        });
        return request.validateOutput!(review);
      }
      if (request.role === 'creative') {
        creations++;
        return request.schema.parse({ candidates: [c] });
      }
      return request.schema.parse({
        understood: '人物关门',
        connection: '日常动作',
        understandable: true,
        feasible: true,
        emotion: '平静',
        issues: [],
      });
    },
  };
  const runner = new TaskRunner(store, task.id);
  const checking: SemanticModel = {
    version: 'classification-control',
    async compare(pairs) {
      assert.ok(pairs.every((p) => !/看懂|旁白/.test(p.hypothesis)));
      return model.compare(pairs);
    },
  };
  const brief = await new CreativeEngine(store, task.id, driver, runner.library, checking).run();
  assert.equal(extractions, 2);
  assert.equal(creations, 1);
  assert.equal(brief!.intent.technical?.[0]?.kind, 'no_narration');
  c.proposal.content.narration = '新增旁白';
  assert.equal((await checkConcept(c, corrected, semanticAgent, new Set(), new Set(), false)).passed, false);
  assert.throws(() => validateIntentReview({ passed: true, issues: [], classifications: [] }, incorrect), {
    code: 'INTENT_REVIEW_FORMAT',
  });
  assert.throws(() =>
    intentReviewSchema.parse({
      passed: true,
      classifications: [],
      issues: [{ severity: 'warning', evidence: 'quality', message: 'quality cannot be a synopsis claim' }],
    }),
  );
  const specific: IntentSpec = {
    ...corrected,
    constraints: [constraint({ value: '刹车通过摩擦减速', quote: '让观众理解刹车通过摩擦减速的原理' })],
  };
  assert.equal(
    validateIntentReview(
      {
        passed: true,
        issues: [],
        classifications: [{ constraintId: 'c1', kinds: ['meaning'], reason: '具体因果关系仍须由画面表达' }],
      },
      specific,
    ).passed,
    true,
  );
});

test('semantic execution errors abort assessment without converting them into creative rejection', async () => {
  const c = concept();
  for (const polarity of ['require', 'forbid'] as const) {
    const intent: IntentSpec = {
      schemaVersion: 1,
      constraints: [constraint({ polarity })],
      openQuestions: [],
    };
    const offline: AgentDriver = {
      async run() {
        throw new Error('model unavailable');
      },
    };
    await assert.rejects(
      checkConcept(c, intent, offline, new Set(['asset_a']), new Set(), true),
      /model unavailable/,
    );
  }
});

test('expression preflight evaluates its declared plan; visual content still requires the proposed sequence', async () => {
  const c = concept();
  c.proposal.expression.editing = '冲突：整段保持原始顺序与速度';
  c.beats[0]!.visual = '许诺重排素材，快切后转为长镜头。'.repeat(120);
  const intent: IntentSpec = {
    schemaVersion: 1,
    openQuestions: [],
    constraints: [
      constraint({
        dimension: 'expression',
        field: 'editing',
        modality: 'visual',
        value: '重排并改变节奏',
      }),
    ],
  };
  const checking: AgentDriver = {
    async run(request) {
      assert.equal((request.input as any).constraints[0].premise, c.proposal.expression.editing);
      return semanticFixture(request)!;
    },
  };
  assert.equal(
    (await checkConcept(c, intent, checking, new Set(['asset_a']), new Set(), true)).passed,
    false,
    'irrelevant visual prose cannot rescue a conflicting editing plan',
  );
});

test('culture sources reject local URLs, credentials and private addresses', () => {
  for (const url of [
    'http://example.com',
    'https://127.0.0.1',
    'https://localhost',
    'https://x.internal',
    'https://user:pass@example.com',
    'https://example.com:8000',
  ])
    assert.throws(() => cultureUrl(url));
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.169.254',
    '100.64.1.1',
    '::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('8.8.8.8'), true);
});

test('narration, subtitle and framing requirements are enforced on tracks and geometry', async () => {
  const intent: IntentSpec = {
    schemaVersion: 1,
    constraints: [],
    openQuestions: [],
    technical: [
      { kind: 'narration_only', value: true, quote: '只保留旁白' },
      { kind: 'no_subtitles', value: true, quote: '不加字幕' },
      { kind: 'preserve_frame', value: true, quote: '不要裁切' },
      { kind: 'landscape', value: true, quote: '横屏' },
    ],
  };
  const c = concept();
  c.beats[0]!.assetIds = [];
  // No semantic model is asked whether an empty music field "contains" effects or source voices.
  const noSemantic: SemanticModel = {
    version: 'not-needed',
    async compare(pairs) {
      assert.deepEqual(pairs, []);
      return [];
    },
  };
  assert.equal((await checkConcept(c, intent, noSemantic, new Set(), new Set(), true)).passed, true);
  c.proposal.expression.music = '配乐';
  assert.equal((await checkConcept(c, intent, noSemantic, new Set(), new Set(), true)).passed, false);
  const cut = editorial();
  assert.throws(() => validateTechnical(intent, 4, undefined, cut), /subtitles/);
  cut.text[0]!.role = 'title'; // No subtitles does not ban a title or text already present in source footage.
  assert.doesNotThrow(() => validateTechnical(intent, 4, undefined, cut));
  cut.audio.push({
    id: 'sound',
    assetId: 'source',
    role: 'ambience',
    start: 0,
    sourceStart: 0,
    duration: 4,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    duck: false,
  });
  assert.throws(() => validateTechnical(intent, 4, undefined, cut), /Only the approved narration/);
  const render = defaultRender(cut, { width: 640, height: 360, fps: 12 }, 'contain');
  assert.doesNotThrow(() => validateTechnicalLayout(intent, render));
  const node = render.nodes.find((n) => n.kind === 'media')!;
  node.fit = 'cover';
  assert.throws(() => validateTechnicalLayout(intent, render), /preserve/);
  assert.throws(() => validateOrientation(intent, { width: 360, height: 640 }), /landscape/);
});

test('fixed text, semantic contradictions, invented assets and absent visual commitments cannot pass', async () => {
  const c = concept();
  const intent: IntentSpec = {
    schemaVersion: 1,
    constraints: [constraint({ dimension: 'content', field: 'narration', match: 'exact', value: '不许改' })],
    openQuestions: [],
  };
  assert.equal(
    (await checkConcept(c, intent, semanticAgent, new Set(['asset_a']), new Set(), true)).passed,
    false,
  );
  intent.constraints = [constraint()];
  c.proposal.theme.subject = '冲突';
  assert.equal(
    (await checkConcept(c, intent, semanticAgent, new Set(['asset_a']), new Set(), true)).passed,
    false,
  );
  intent.constraints = [];
  c.beats[0]!.assetIds = ['invented'];
  assert.equal(
    (await checkConcept(c, intent, semanticAgent, new Set(['asset_a']), new Set(), true)).passed,
    false,
  );
  c.beats[0]!.assetIds = ['asset_a'];
  c.commitments[0]!.modality = 'audio';
  assert.equal(
    (await checkConcept(c, intent, semanticAgent, new Set(['asset_a']), new Set(), true)).passed,
    false,
  );
});

test('blind concept reader cannot see explanations, expected emotions or locked intent', () => {
  const input = JSON.stringify(blindConcept(concept()));
  assert.ok(!input.includes('SECRET'));
  assert.ok(!input.includes('commitments'));
  assert.ok(!input.includes('assetIds'));
  assert.ok(input.includes('人物关门'));
});

test('style and visual instructions are semantic; explicit literal text remains exact', () => {
  const prompt = '展示跑车外观，节奏明快、画面精致';
  assert.throws(
    () =>
      validateIntent(
        {
          schemaVersion: 1,
          constraints: [
            constraint({
              dimension: 'expression',
              field: 'tone',
              match: 'exact',
              value: '节奏明快、画面精致',
              quote: '节奏明快、画面精致',
            }),
          ],
          openQuestions: [],
        },
        prompt,
      ),
    /explicit request/,
  );
  for (const prompt of ['旁白原样保留：你好', '片尾写上“你好”'])
    assert.doesNotThrow(() =>
      validateIntent(
        {
          schemaVersion: 1,
          constraints: [
            constraint({
              dimension: 'content',
              field: 'narration',
              match: 'exact',
              value: '你好',
              quote: prompt,
            }),
          ],
          openQuestions: [],
        },
        prompt,
      ),
    );
  assert.doesNotThrow(() =>
    validateIntent(
      {
        schemaVersion: 1,
        constraints: [
          constraint({
            dimension: 'content',
            field: 'narration',
            match: 'exact',
            value: '你好。\n再见。',
            quote: '你好。\n再见。',
          }),
        ],
        openQuestions: [],
      },
      '旁白逐字保留如下：\n你好。\n再见。',
    ),
  );
});

test('concepts need planned visuals, not acquired assets, even with local/source-grounding restrictions', async () => {
  const c = concept();
  c.beats[0]!.assetIds = [];
  const intent: IntentSpec = {
    schemaVersion: 1,
    constraints: [],
    openQuestions: [],
    technical: [
      { kind: 'local_materials', value: true, quote: '只用本地' },
      { kind: 'source_grounded', value: true, quote: '真实素材' },
    ],
  };
  assert.equal((await checkConcept(c, intent, semanticAgent, new Set(), new Set(), true)).passed, true);
  assert.deepEqual(creativeMaterialRequirements(c).beats[0], {
    beatId: 'beat1',
    action: '出门',
    visualQuery: '人物关门',
    audioQuery: '',
    candidateAssetIds: [],
  });
  intent.constraints = [constraint({ dimension: 'content', field: 'synopsis', modality: 'visual' })];
  const checking: AgentDriver = {
    async run(request) {
      const premise = (request.input as any).constraints[0].premise;
      assert.ok(premise.includes('人物关门'));
      assert.ok(!premise.includes('平凡生活'));
      return semanticFixture(request)!;
    },
  };
  assert.equal((await checkConcept(c, intent, checking, new Set(), new Set(), true)).passed, true);
});

test('concept roles cannot inspect/bind materials; source-grounding still permits later web sourcing', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '真实素材', materials: { strategy: 'local_first' } });
  const runner = new TaskRunner(store, task.id);
  const toolsFor = (role: string) =>
    (runner.agent as any).createTools({ role, instruction: '', input: {}, schema: z.any() }, false);
  assert.deepEqual(toolsFor('creative'), []);
  assert.deepEqual(toolsFor('concept_audience'), []);
  assert.deepEqual(toolsFor('acceptance'), []);
  assert.deepEqual(toolsFor('acceptance_review'), []);
  assert.deepEqual((runner.agent as any).createTools({ role: 'materials', toolAccess: 'none' }, false), []);
  assert.ok(
    !toolsFor('editor').some((t: any) =>
      [
        'search_material',
        'download_material',
        'film_cli',
        'local_materials',
        'import_local_material',
      ].includes(t.name),
    ),
  );
  for (const role of ['layout', 'learner', 'materials_review'])
    assert.ok(
      !toolsFor(role).some((t: any) => ['local_materials', 'import_local_material'].includes(t.name)),
    );
  assert.ok(toolsFor('materials').some((t: any) => t.name === 'local_materials'));
  assert.ok(toolsFor('materials').some((t: any) => t.name === 'import_local_material'));
  for (const role of ['script', 'facts_review']) {
    assert.ok(toolsFor(role).some((t: any) => t.name === 'local_materials'));
    assert.ok(toolsFor(role).some((t: any) => t.name === 'import_local_material'));
    assert.ok(
      !toolsFor(role).some((t: any) => ['search_material', 'download_material', 'film_cli'].includes(t.name)),
    );
  }
  let searches = 0;
  runner.library.searchWeb = async () => {
    searches++;
    return [];
  };
  store.saveArtifact(task.id, 'creative.intent', { technical: [{ kind: 'source_grounded' }] }, true);
  const search = toolsFor('materials').find((t: any) => t.name === 'search_material');
  await search.execute({ query: '实拍', limit: 1, provider: 'bilibili' });
  assert.equal(searches, 1);
  store.saveArtifact(task.id, 'creative.intent', { technical: [{ kind: 'local_materials' }] }, true);
  await assert.rejects(
    search.execute({ query: '实拍', limit: 1, provider: 'bilibili' }),
    (e: any) => e.code === 'LOCAL_ONLY',
  );
  assert.equal(searches, 1);
});

test('seeded selection is reproducible but retains exploration; visual commitments need visual evidence', async () => {
  const a = concept(),
    b = { ...concept(), id: 'other', operators: ['visual_analogy'] as const };
  const candidates = [a, conceptSchema.parse(b)],
    taste = { weights: [0, 0, 0, 0, 0, 0], version: 'empty', samples: 0, trained: false };
  const choose = (seed: string) => chooseConcept(candidates, seed, [], taste);
  assert.deepEqual(choose('fixed'), choose('fixed'));
  assert.equal(new Set(Array.from({ length: 30 }, (_, i) => choose(String(i)).chosen.id)).size, 2);
  const brief: CreativeBrief = {
    schemaVersion: 1,
    intent: { schemaVersion: 1, constraints: [], openQuestions: [] },
    concept: a,
    seed: 's',
    round: 0,
    knowledgeHash: 'k',
    operatorVersion: 'v',
    tasteVersion: 't',
    selection: [],
  };
  const output = audience();
  output.evidence[0]!.modality = 'audio';
  const sources = acceptanceSources(brief);
  const plan = acceptancePlanSchema.parse({
    schemaVersion: 1,
    sources: sources.map((s) => ({
      sourceId: s.id,
      checks: [{ kind: 'observation', modality: 'visual', claim: s.text, coverage: 'some', interval: null }],
    })),
  });
  const assess = () =>
    scoreAcceptance(model, sources, plan, output, { editorial: editorial(), stage: 'render' });
  const report = await assess();
  assert.equal(report.fixed, null);
  assert.equal(report.passed, false);
  output.evidence[0]!.modality = 'visual';
  assert.equal((await assess()).passed, true);
});

test('creative checkpoint resumes the same batch, freezes selection, and resampling invalidates downstream without losing history', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    prompt: '自由',
    creative: { knowledge: 'local', seed: 'fixed' },
    materials: { strategy: 'local_only' },
  });
  const calls: string[] = [];
  let interrupt = true;
  const driver: AgentDriver = {
    async run(req) {
      const semantic = semanticFixture(req);
      if (semantic) return semantic;
      calls.push(req.role);
      if (req.role === 'intent')
        return req.schema.parse({ schemaVersion: 1, constraints: [], openQuestions: [] });
      if (req.role === 'intent_review') return intentReviewFixture(req);
      if (req.role === 'creative') {
        assert.equal((req.input as any).materials, undefined);
        assert.equal(req.images, undefined);
        const c = concept();
        c.beats[0]!.assetIds = [];
        return req.schema.parse({ candidates: [c] });
      }
      if (req.role === 'concept_audience') {
        assert.equal(req.images, undefined);
        if (interrupt) {
          interrupt = false;
          throw new Error('interrupted');
        }
        assert.ok(!JSON.stringify(req.input).includes('SECRET'));
        return req.schema.parse({
          understood: '人物出门',
          connection: '日常动作',
          understandable: true,
          feasible: true,
          emotion: '平静',
          issues: [],
        });
      }
      throw new Error(`unexpected ${req.role}`);
    },
  };
  const runner = new TaskRunner(store, task.id);
  const engine = () => new CreativeEngine(store, task.id, driver, runner.library, model);
  await assert.rejects(engine().run(), /interrupted/);
  const brief = await engine().run();
  assert.equal(calls.filter((r) => r === 'creative').length, 1);
  assert.deepEqual(await engine().run(), brief);
  assert.deepEqual(
    store.artifact(task.id, 'creative.material_requirements')!.data,
    creativeMaterialRequirements(brief!.concept),
  );
  store.saveArtifact(task.id, 'script', { old: true }, true);
  store.saveArtifact(task.id, 'script.candidate', { stale: true }, false);
  store.saveArtifact(task.id, 'assets.imported', { keep: true }, true);
  store.updateTask(task.id, 'blocked', 'script');
  await resampleCreative(store, task.id, 'another');
  assert.equal(store.artifact(task.id, 'creative.brief'), undefined);
  assert.equal(store.artifact(task.id, 'script.candidate', false), undefined);
  assert.ok(store.artifact(task.id, 'assets.imported'));
  assert.ok(store.db.prepare("SELECT 1 FROM artifacts WHERE task_id=? AND stage='script'").get(task.id));
  assert.equal((await engine().run())!.seed, 'another');
});

test('old material-dependent batches and feedback are not reused by the concept-first gate', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '人物', creative: { knowledge: 'local' } });
  store.saveArtifact(
    task.id,
    'creative.intent',
    { schemaVersion: 1, constraints: [constraint()], openQuestions: [] },
    true,
  );
  const old = concept();
  old.beats[0]!.assetIds = [];
  old.proposal.content.synopsis = 'NO_ASSETS_USE_TEXT_CARDS';
  new CreativeStore(store).archive(task.id, old);
  store.saveArtifact(task.id, 'creative.batch.old', { candidates: [old] }, true);
  store.saveArtifact(task.id, 'creative.search', { round: 12 });
  store.saveArtifact(task.id, 'creative.feedback', [{ issue: 'MISSING_MEDIA_BACKUP' }]);
  const driver: AgentDriver = {
    async run(req) {
      const semantic = semanticFixture(req);
      if (semantic) return semantic;
      if (req.role === 'intent')
        return req.schema.parse({ schemaVersion: 1, constraints: [constraint()], openQuestions: [] });
      if (req.role === 'intent_review') return intentReviewFixture(req);
      if (req.role === 'creative') {
        const input = req.input as any;
        assert.equal(input.feedback, undefined);
        assert.deepEqual(input.previous, []);
        const next = concept();
        next.beats[0]!.assetIds = [];
        return req.schema.parse({ candidates: [next] });
      }
      assert.equal(req.role, 'concept_audience');
      return req.schema.parse({
        understood: '人物出门',
        connection: '日常动作',
        understandable: true,
        feasible: true,
        emotion: '',
        issues: [],
      });
    },
  };
  const runner = new TaskRunner(store, task.id);
  const brief = await new CreativeEngine(store, task.id, driver, runner.library, model).run();
  assert.equal(brief!.round, 0);
  assert.equal(store.artifact<any>(task.id, 'creative.gate')!.data.version, CREATIVE_GATE_VERSION);
  assert.equal(store.artifact(task.id, 'creative.batch.old'), undefined);
  assert.ok(
    store.db.prepare("SELECT id FROM artifacts WHERE task_id=? AND stage='creative.batch.old'").get(task.id),
  );
});

test('semantic request errors preserve the batch and resume evaluation without resampling', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '人物；允许使用特写', creative: { knowledge: 'local' } });
  let creations = 0,
    overflow = true;
  const driver: AgentDriver = {
    async run(req) {
      if (req.role === 'semantic_review' && overflow) throw new Error('semantic service unavailable');
      const semantic = semanticFixture(req);
      if (semantic) return semantic;
      if (req.role === 'intent')
        return req.schema.parse({ schemaVersion: 1, constraints: [constraint()], openQuestions: [] });
      if (req.role === 'intent_review') return intentReviewFixture(req);
      if (req.role === 'creative') {
        creations++;
        assert.equal(
          (req.input as any).prompt,
          task.spec.prompt,
          'non-obligatory context still reaches the creator',
        );
        const c = concept();
        c.beats[0]!.assetIds = [];
        return req.schema.parse({ candidates: [c] });
      }
      assert.equal(req.role, 'concept_audience');
      return req.schema.parse({
        understood: '人物关门',
        connection: '日常动作',
        understandable: true,
        feasible: true,
        emotion: '',
        issues: [],
      });
    },
  };
  const runner = new TaskRunner(store, task.id);
  const run = () => new CreativeEngine(store, task.id, driver, runner.library, model).run();
  await assert.rejects(run(), /semantic service unavailable/);
  assert.equal(store.artifact(task.id, 'creative.feedback', false), undefined);
  assert.equal(store.artifact<any>(task.id, 'creative.search', false)!.data.round, 0);
  overflow = false;
  const brief = await run();
  assert.ok(brief);
  assert.equal(creations, 1);
  assert.equal(brief!.round, 0);
});

test('gate correction re-evaluates saved concepts without importing old rejection feedback', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '人物', creative: { knowledge: 'local' } });
  store.saveArtifact(task.id, 'creative.gate', { version: 'previous-evaluation', migrated: false }, true);
  store.saveArtifact(task.id, 'creative.feedback', [{ error: 'permission incorrectly forbidden' }], false);
  store.saveArtifact(task.id, 'creative.search', { round: 3 }, false);
  const c = concept();
  c.beats[0]!.assetIds = [];
  new CreativeStore(store).archive(task.id, c);
  const driver: AgentDriver = {
    async run(req) {
      const semantic = semanticFixture(req);
      if (semantic) return semantic;
      if (req.role === 'intent')
        return req.schema.parse({ schemaVersion: 1, constraints: [constraint()], openQuestions: [] });
      if (req.role === 'intent_review') return intentReviewFixture(req);
      assert.equal(req.role, 'concept_audience', 'reuse the archived proposal instead of regenerating');
      return req.schema.parse({
        understood: '人物关门',
        connection: '日常动作',
        understandable: true,
        feasible: true,
        emotion: '',
        issues: [],
      });
    },
  };
  const runner = new TaskRunner(store, task.id);
  const result = await new CreativeEngine(store, task.id, driver, runner.library, model).run();
  assert.equal(result!.concept.proposal.content.synopsis, c.proposal.content.synopsis);
  assert.equal(store.artifact(task.id, 'creative.feedback', false), undefined);
  assert.equal(result!.round, 0);
});

test('one insufficiently supported candidate does not prevent independent review and selection of another valid candidate', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '人物', creative: { knowledge: 'local' } });
  let reviewed = 0;
  const driver: AgentDriver = {
    async run(req) {
      if (
        req.role === 'semantic_review' &&
        (req.input as any).constraints?.some((c: any) => c.premise === 'TOO_LONG')
      )
        return req.schema.parse({
          constraints: (req.input as any).constraints.map((c: any) => ({
            id: c.id,
            status: 'insufficient',
            reason: 'missing planned evidence',
          })),
        });
      const semantic = semanticFixture(req);
      if (semantic) return semantic;
      if (req.role === 'intent')
        return req.schema.parse({ schemaVersion: 1, constraints: [constraint()], openQuestions: [] });
      if (req.role === 'intent_review') return intentReviewFixture(req);
      if (req.role === 'creative') {
        const a = concept();
        a.proposal.theme.subject = 'TOO_LONG';
        a.beats[0]!.assetIds = [];
        const b = concept();
        b.beats[0]!.assetIds = [];
        return req.schema.parse({ candidates: [a, b] });
      }
      assert.equal(req.role, 'concept_audience');
      reviewed++;
      return req.schema.parse({
        understood: '人物关门',
        connection: '日常动作',
        understandable: true,
        feasible: true,
        emotion: '',
        issues: [],
      });
    },
  };
  const runner = new TaskRunner(store, task.id);
  const result = await new CreativeEngine(store, task.id, driver, runner.library, model).run();
  assert.equal(result!.concept.proposal.theme.subject, '人物');
  assert.equal(result!.selection.length, 1);
  assert.equal(reviewed, 1);
  assert.equal(store.artifact(task.id, 'creative.feedback', false), undefined);
});

test('creative search can repair genuine rejections without treating a model service failure as candidate feedback', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '人物', creative: { knowledge: 'local' } });
  let creations = 0;
  const driver: AgentDriver = {
    async run(req) {
      if (
        req.role === 'semantic_review' &&
        (req.input as any).constraints?.some((c: any) => c.premise === 'TOO_LONG')
      )
        return req.schema.parse({
          constraints: (req.input as any).constraints.map((c: any) => ({
            id: c.id,
            status: 'insufficient',
            reason: 'missing planned evidence',
          })),
        });
      const semantic = semanticFixture(req);
      if (semantic) return semantic;
      if (req.role === 'intent')
        return req.schema.parse({ schemaVersion: 1, constraints: [constraint()], openQuestions: [] });
      if (req.role === 'intent_review') return intentReviewFixture(req);
      if (req.role === 'creative') {
        creations++;
        const c = concept();
        c.beats[0]!.assetIds = [];
        if (creations === 1) {
          const unknown = structuredClone(c);
          unknown.proposal.theme.subject = 'TOO_LONG';
          c.proposal.theme.subject = '冲突';
          return req.schema.parse({ candidates: [unknown, c] });
        }
        assert.equal(creations, 2);
        const feedback = (req.input as any).feedback;
        assert.equal(feedback.length, 2);
        assert.ok(feedback[0].check.issues.length > 0);
        return req.schema.parse({ candidates: [c] });
      }
      assert.equal(req.role, 'concept_audience');
      return req.schema.parse({
        understood: '人物关门',
        connection: '日常动作',
        understandable: true,
        feasible: true,
        emotion: '',
        issues: [],
      });
    },
  };
  const runner = new TaskRunner(store, task.id);
  const result = await new CreativeEngine(store, task.id, driver, runner.library, model).run();
  assert.equal(creations, 2);
  assert.equal(result!.round, 1);
  assert.equal(new CreativeStore(store).candidates(task.id).length, 3);
  assert.ok(
    store.artifact(task.id, 'creative.feedback', false),
    'insufficient evidence remains in candidate rejection feedback',
  );
});

test('missing material blocks at matching after concept/script, preserving upstream work on retry', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    prompt: '人物',
    creative: { knowledge: 'local' },
    materials: { strategy: 'local_only' },
  });
  const calls: string[] = [];
  const driver: AgentDriver = {
    async run(req) {
      const semantic = semanticFixture(req);
      if (semantic) return semantic;
      calls.push(req.role);
      if (req.role === 'acceptance')
        return req.schema.parse({
          schemaVersion: 1,
          sources: (req.input as any).sources.map((s: any) => ({
            sourceId: s.id,
            checks: [],
          })),
        });
      if (req.role === 'acceptance_review')
        return req.schema.parse({
          sources: (req.input as any).sources.map((s: any) => ({
            sourceId: s.id,
            verdict: 'equivalent',
            counterexamples: [],
            reason: 'fixture equivalence',
          })),
        });
      if (req.role === 'intent')
        return req.schema.parse({ schemaVersion: 1, constraints: [], openQuestions: [] });
      if (req.role === 'intent_review') return intentReviewFixture(req);
      if (req.role === 'creative') {
        const c = concept();
        c.beats[0]!.assetIds = [];
        c.proposal.content.narration = '';
        return req.schema.parse({ candidates: [c] });
      }
      if (req.role === 'concept_audience')
        return req.schema.parse({
          understood: '出门',
          connection: '日常动作',
          understandable: true,
          feasible: true,
          emotion: '',
          issues: [],
        });
      if (req.role === 'script')
        return req.schema.parse({
          title: '出门',
          topic: '生活',
          angle: '观察',
          personaId: 'persona_maker',
          narration: '',
          beats: [{ id: 'b1', text: '出门', visualQuery: '人物关门', durationHint: 4 }],
          facts: [],
        });
      if (req.role === 'materials') {
        const input = req.input as any;
        assert.equal(input.creativeBrief.concept.beats[0].visual, '人物关门');
        assert.equal(input.requirements[0].query, '人物关门');
        assert.equal(input.strategy, 'local_only');
        assert.equal(input.attempt, calls.filter((r) => r === 'materials').length - 1);
        return req.schema.parse({
          status: 'missing',
          matches: [],
          gaps: input.requirements.map((n: any) => ({
            needId: n.id,
            attemptedQueries: [n.query],
            reason: '无本地素材',
          })),
        });
      }
      return req.schema.parse({ passed: true, issues: [] });
    },
  };
  const run = () => new TaskRunner(store, task.id, undefined, { agent: driver, model }).run();
  for (let i = 0; i < 2; i++) await assert.rejects(run(), (e: any) => e.code === 'MATERIALS_MISSING');
  assert.equal(calls.filter((r) => r === 'creative').length, 1);
  assert.equal(calls.filter((r) => r === 'script').length, 1);
  assert.equal(calls.filter((r) => r === 'materials').length, 2);
  assert.equal(store.task(task.id).stage, 'materials');
  assert.equal(store.task(task.id).status, 'blocked');
  assert.ok(store.artifact(task.id, 'creative.brief'));
  assert.ok(store.artifact(task.id, 'script'));
  assert.ok(store.artifact(task.id, 'materials.requirements'));
  assert.ok(store.artifact(task.id, 'materials.gaps', false));
  assert.equal(store.artifact(task.id, 'editorial'), undefined);
});

test('cultural evidence and human preferences are scoped; self-review cannot train taste', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const a = await createTask(store, { prompt: 'a' }),
    b = await createTask(store, { prompt: 'b' });
  const knowledge = new CreativeStore(store);
  knowledge.ingest(a.id, {
    sources: [],
    entities: [
      {
        id: 'culture_one',
        name: 'private',
        kind: 'situation',
        description: '私人情境',
        audience: '',
        context: '',
        tags: [],
        provenance: 'creative_hypothesis',
        sourceIds: [],
        confidence: 0.5,
      },
    ],
    relations: [],
  });
  assert.equal(knowledge.search(b.id, '').entities.length, 0);
  assert.equal(knowledge.search(a.id, '').entities.length, 1);
  knowledge.archive(a.id, concept());
  knowledge.archive(a.id, { ...concept(), id: 'second', operators: ['visual_analogy'] });
  assert.throws(() =>
    knowledge.feedback(b.id, {
      expectedVersion: 1,
      left: 'candidate',
      right: 'second',
      choice: 'left',
      level: 'concept',
    }),
  );
  assert.equal(knowledge.taste(a.id).trained, false);
  const workbench = new Workbench(store, new TaskService(store), { autoStart: false });
  t.after(() => workbench.close());
  for (let i = 0; i < 5; i++) {
    knowledge.archive(a.id, { ...concept(), id: `second_${i}`, operators: ['visual_analogy'] });
    const command = {
      requestId: `human-preference-${i}`,
      command: 'creative.feedback',
      taskId: a.id,
      args: { expectedVersion: 1, left: 'candidate', right: `second_${i}`, choice: 'left', level: 'concept' },
    };
    await assert.rejects(
      workbench.command(
        { ...command, requestId: `model-preference-${i}` },
        { kind: 'conversation', messageId: 'fixture' },
      ),
      { code: 'HUMAN_VERDICT_REQUIRED' },
    );
    assert.equal(knowledge.taste(a.id).samples, i, 'model ratings never enter preference training');
    await workbench.command(command);
    await assert.rejects(workbench.command(command, { kind: 'conversation', messageId: 'fixture' }), {
      code: 'REQUEST_CONFLICT',
    });
  }
  assert.equal(knowledge.taste(a.id).trained, true);
  assert.equal(knowledge.taste(b.id).trained, false);
  assert.ok(knowledge.taste(a.id).weights[0]! > knowledge.taste(a.id).weights[5]!);
});

test('repairing a malformed intent rechecks the existing concept under the same gate version', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    prompt: '人物',
    creative: { knowledge: 'local' },
    materials: { strategy: 'web_first' },
  });
  store.saveArtifact(task.id, 'creative.gate', { version: CREATIVE_GATE_VERSION, migrated: false }, true);
  store.saveArtifact(
    task.id,
    'creative.intent',
    {
      schemaVersion: 1,
      constraints: [constraint({ match: 'exact', value: '不是逐字原文' })],
      openQuestions: [],
    },
    true,
  );
  const c = concept();
  c.beats[0]!.assetIds = [];
  new CreativeStore(store).archive(task.id, c);
  let creations = 0;
  const driver: AgentDriver = {
    async run(req) {
      const semantic = semanticFixture(req);
      if (semantic) return semantic;
      if (req.role === 'creative') {
        creations++;
        throw new Error('must reuse saved concept');
      }
      if (req.role === 'intent')
        return req.schema.parse({ schemaVersion: 1, constraints: [constraint()], openQuestions: [] });
      if (req.role === 'intent_review') return intentReviewFixture(req);
      return req.schema.parse({
        understood: '出门',
        connection: '日常动作',
        understandable: true,
        feasible: true,
        emotion: '平静',
        issues: [],
      });
    },
  };
  const runner = new TaskRunner(store, task.id);
  const brief = await new CreativeEngine(store, task.id, driver, runner.library, model).run();
  assert.ok(brief);
  assert.equal(creations, 0);
  assert.equal(brief.intent.constraints[0]!.match, 'semantic');
});
