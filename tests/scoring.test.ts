import test from 'node:test';
import assert from 'node:assert/strict';
import type { SemanticModel } from '../packages/media/src/scoring.js';
import { scoreAcceptance } from '../packages/media/src/acceptance-scoring.js';
import { splitRequirements } from '../packages/core/src/requirements.js';
import type { Predicate } from '../packages/core/src/acceptance.js';
import { audience, editorial } from './helpers.js';

const supported: SemanticModel = {
  version: 'fixture-only-not-production',
  async compare(pairs) {
    return pairs.map(() => ({ similarity: 0.95, entailment: 0.96, contradiction: 0.01, neutral: 0.03 }));
  },
};
const visual = (claim: string): Predicate => ({
  kind: 'observation',
  modality: 'visual',
  claim,
  coverage: 'some',
  interval: null,
});
const score = async (checks: Predicate[], report = audience(), model = supported) => {
  const result = await scoreAcceptance(
    model,
    [
      {
        id: 'fixed',
        text: 'Frozen requirement',
        quote: 'Original user requirement',
        group: 'fixed',
        modality: 'visual',
        stage: 'editorial',
      },
    ],
    { schemaVersion: 1, sources: [{ sourceId: 'fixed', checks }] },
    report,
    { editorial: editorial(), stage: 'editorial' },
  );
  return { ...result.fixed!, passed: result.passed };
};

test('score is deterministic, deduplicated, and lower distance passes', async () => {
  const a = audience(),
    checks = [visual('画面展示关门后离开')];
  const first = await score(checks, a);
  assert.equal(first.passed, true);
  assert.ok(first.distance < 0.15);
  assert.deepEqual(first, await score(checks, a));
  a.claims.push(a.claims[0]!, a.claims[0]!);
  assert.equal(first.similarity, (await score(checks, a)).similarity);
});

test('negation, causal reversal and entity contradictions cannot be overridden by similarity', async () => {
  const contradictory: SemanticModel = {
    version: 'fixture-nli',
    async compare(pairs) {
      return pairs.map(() => ({ similarity: 0.99, entailment: 0.02, contradiction: 0.95, neutral: 0.03 }));
    },
  };
  for (const claim of ['不能出现汽车', '先离开房间，然后关门', '画面中必须是小李']) {
    const report = await score([visual(claim)], audience(), contradictory);
    assert.equal(report.passed, false);
    assert.ok(report.blockingIssues.length);
  }
});

test('missing visual evidence and unknown observations cannot pass', async () => {
  const a = audience();
  a.evidence[0]!.modality = 'audio';
  const result = await score([visual('画面展示关门')], a);
  assert.equal(result.passed, false);
  assert.equal(result.scorable, false);
  a.evidence[0]!.modality = 'visual';
  a.claims[0]!.confidence = 0.1;
  assert.equal((await score([visual('关门')], a)).passed, false);
});

test('evidence cannot be invented and requirements retain explicit priority', async () => {
  const a = audience();
  a.claims[0]!.evidenceIds = ['fake'];
  await assert.rejects(score([visual('关门')], a), { code: 'EVIDENCE_MISSING' });
  assert.equal(splitRequirements('必须看见门。轻松表达。必须看见门')[0]!.weight, 2);
  assert.equal(splitRequirements('必须看见门。轻松表达。必须看见门').length, 2);
});

test('event timestamps veto a semantically plausible but reversed sequence', async () => {
  const observation = audience('关门');
  observation.evidence[0]!.end = 1;
  observation.evidence.push({
    ...observation.evidence[0]!,
    id: 'leave',
    start: 2,
    end: 3,
    observation: '离开',
  });
  observation.events = [
    { text: '关门', at: 0.5, evidenceIds: ['evidence_a'] },
    { text: '离开', at: 2.5, evidenceIds: ['leave'] },
  ];
  const model: SemanticModel = {
    version: 'fixture-event-match',
    async compare(pairs) {
      return pairs.map(({ premise, hypothesis }) => ({
        similarity: 0.99,
        entailment: premise === hypothesis ? 0.98 : 0.01,
        contradiction: 0,
        neutral: premise === hypothesis ? 0.02 : 0.99,
      }));
    },
  };
  const check: Predicate = { kind: 'order', modality: 'visual', before: '关门', after: '离开' };
  assert.equal((await score([check], observation, model)).passed, true);
  observation.events[0]!.at = 3.5;
  observation.evidence[0]!.start = 3;
  observation.evidence[0]!.end = 4;
  assert.equal((await score([check], observation, model)).passed, false);
});

test('numeric constraints require observed counts even when NLI returns high support', async () => {
  const observation = audience('画面中有人');
  const check: Predicate = { kind: 'count', modality: 'visual', subject: '人', operator: 'eq', value: 3 };
  assert.equal((await score([check], observation)).passed, false);
  observation.quantities = [{ subject: '人', count: 2, confidence: 1, evidenceIds: ['evidence_a'] }];
  assert.equal((await score([check], observation)).passed, false);
  observation.quantities[0]!.count = 3;
  assert.equal((await score([check], observation)).passed, true);
  assert.equal((await score([{ ...check, operator: 'gte', value: 2 }], observation)).passed, true);
  assert.equal((await score([{ ...check, operator: 'lte', value: 2 }], observation)).passed, false);
});

test('request normalization preserves constraints, quoted text and order while separating obligations', () => {
  const parsed = splitRequirements(
    '帮我剪一条解释奥迪霍希 A8L 品牌历史的片子，必须看到汽车；不能出现飞机\n先关门，然后离开',
  );
  assert.equal(parsed[0]!.text, '视频解释了奥迪霍希 A8L 品牌历史');
  assert.equal(parsed[0]!.sourceText, '帮我剪一条解释奥迪霍希 A8L 品牌历史的片子');
  assert.equal(parsed[1]!.modality, 'visual');
  assert.equal(parsed[1]!.required, true);
  assert.equal(parsed[2]!.text, '不能出现飞机');
  assert.equal(parsed[3]!.text, '先关门,然后离开');
  const quoted = splitRequirements('旁白必须原样说“请关门，不要离开。然后等待！”；画面必须有三个人');
  assert.equal(quoted.length, 2);
  assert.match(quoted[0]!.text, /请关门/);
  assert.match(quoted[1]!.text, /三个人/);
});

test('required visible text cannot be satisfied by narration, and negative requests remain negative', async () => {
  const report = audience('你好');
  const check: Predicate = {
    kind: 'observation',
    modality: 'text',
    claim: '你好',
    coverage: 'some',
    interval: null,
  };
  report.evidence[0]!.modality = 'audio';
  assert.equal((await score([check], report)).passed, false);
  report.evidence[0]!.modality = 'text';
  assert.equal((await score([check], report)).passed, true);
  assert.equal(splitRequirements('请剪一条不解释品牌历史的片子')[0]!.text, '剪一条不解释品牌历史的片子');
});

test('programmed intervals distinguish identical observations at different times', async () => {
  const observation = audience('车门关闭');
  observation.evidence[0]!.end = 1;
  observation.evidence.push({ ...observation.evidence[0]!, id: 'last', start: 3, end: 4 });
  observation.claims[0]!.evidenceIds.push('last');
  const check: Predicate = {
    kind: 'observation',
    modality: 'visual',
    claim: '车门关闭',
    coverage: 'all',
    interval: { start: 3, end: 4 },
  };
  assert.equal((await score([check], observation)).passed, true);
  observation.evidence[1]!.start = 0;
  observation.evidence[1]!.end = 1;
  assert.equal((await score([check], observation)).passed, false);
});

test('unsupported claims and mixed-modality references cannot supply their own proof', async () => {
  const observation = audience('CLAIM_WITHOUT_EVIDENCE');
  observation.evidence[0]!.observation = '一张白纸';
  observation.evidence.push({
    id: 'speech',
    bindingId: 'audio',
    start: 0,
    end: 2,
    modality: 'audio',
    observation: 'AUDIO_ONLY_FACT',
  });
  observation.claims[0]!.evidenceIds.push('speech');
  const pairsSeen: { premise: string; hypothesis: string }[] = [];
  const model: SemanticModel = {
    version: 'inspection',
    async compare(pairs) {
      pairsSeen.push(...pairs);
      return pairs.map(() => ({ similarity: 0.1, entailment: 0.1, contradiction: 0.1, neutral: 0.8 }));
    },
  };
  assert.equal((await score([visual('画面有汽车')], observation, model)).passed, false);
  assert.ok(pairsSeen.length);
  assert.ok(
    pairsSeen.every(
      (p) => !p.premise.includes('CLAIM_WITHOUT_EVIDENCE') && !p.premise.includes('AUDIO_ONLY_FACT'),
    ),
  );
});
