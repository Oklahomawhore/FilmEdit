import test from 'node:test';
import assert from 'node:assert/strict';
import { asset, editorial } from './helpers.js';
import {
  materialResultSchema,
  validateMaterialResult,
  validateMatchedEdit,
  validateLocalSources,
  materialNeeds,
  soundPlanSchema,
  validateSoundPlan,
  type MaterialManifest,
} from '../packages/core/src/materials.js';
import { scriptSchema } from '../packages/core/src/domain.js';

test('silence is not a media request and compound sound instructions require separate matches', () => {
  const script = scriptSchema.parse({
    title: '黎明',
    topic: '汽车',
    angle: '静与动',
    personaId: 'observer',
    narration: '',
    beats: [{ id: 'beat', text: '高速转为安静', visualQuery: '汽车', durationHint: 3 }],
  });
  const sources = [
    { id: 'audio_1', text: '引擎轰鸣与低频鼓点叠加' },
    { id: 'audio_2', text: '瞬间静音' },
    { id: 'music', text: '无背景音乐' },
  ];
  const plan = soundPlanSchema.parse({
    sources: [
      {
        sourceId: 'audio_1',
        elements: [
          { kind: 'sound', role: 'sfx', query: '汽车引擎轰鸣' },
          { kind: 'sound', role: 'sfx', query: '低频鼓点' },
        ],
      },
      { sourceId: 'audio_2', elements: [{ kind: 'silence', description: '短暂静音' }] },
      { sourceId: 'music', elements: [{ kind: 'silence', description: '全片无 BGM' }] },
    ],
  });
  const needs = materialNeeds(script, sources, plan);
  assert.deepEqual(
    needs.filter((need) => need.kind === 'audio').map((need) => need.query),
    ['汽车引擎轰鸣', '低频鼓点'],
  );
  assert.throws(() => validateSoundPlan({ sources: plan.sources.slice(1) }, sources), /exactly once/);
  const result = materialResultSchema.parse({
    status: 'ready',
    gaps: [],
    matches: [
      {
        needId: 'visual_1',
        assetId: asset.id,
        sourceStart: 0,
        sourceEnd: 3,
        frameTimes: [1],
        observation: '汽车',
      },
      {
        needId: 'audio_1_1',
        assetId: asset.id,
        sourceStart: 0,
        sourceEnd: 3,
        frameTimes: [],
        observation: '引擎声',
      },
    ],
  });
  assert.throws(
    () =>
      validateMaterialResult(result, needs, [
        { ...asset, frames: [{ time: 1, path: '/frame.jpg' }], analyzed: { beats: true } },
      ]),
    /Every requirement/,
    'an engine source does not satisfy the separate drum requirement',
  );
});

test('material manifest requires actual inspected frames, complete coverage, and valid source ranges', () => {
  const needs = [{ id: 'visual_1', kind: 'visual' as const, query: '人物关门' }];
  const result = materialResultSchema.parse({
    status: 'ready',
    matches: [
      {
        needId: 'visual_1',
        assetId: asset.id,
        sourceStart: 0,
        sourceEnd: 8,
        frameTimes: [1, 5],
        observation: '人物从门口进入房间',
      },
    ],
    gaps: [],
  });
  const observed = {
    ...asset,
    frames: [
      { time: 1, path: '/one.jpg' },
      { time: 5, path: '/two.jpg' },
    ],
  };
  assert.throws(() => validateMaterialResult(result, needs, [asset]), /Inspect source frames/);
  assert.equal(validateMaterialResult(result, needs, [observed]), result);
  assert.throws(
    () =>
      validateMaterialResult({ ...result, matches: [{ ...result.matches[0]!, sourceEnd: 11 }] }, needs, [
        observed,
      ]),
    /outside the asset/,
  );
  assert.throws(
    () => validateMaterialResult({ ...result, matches: [] }, needs, [observed]),
    /Every requirement/,
  );
  assert.throws(
    () =>
      validateMaterialResult(
        { ...result, gaps: [{ needId: 'visual_1', attemptedQueries: ['door'], reason: 'missing' }] },
        needs,
        [observed],
      ),
    /uncovered/,
  );
  const gap = materialResultSchema.parse({
    status: 'missing',
    matches: [],
    gaps: [{ needId: 'visual_1', attemptedQueries: ['door'], reason: 'No local files' }],
  });
  assert.equal(validateMaterialResult(gap, needs, []), gap);
});

test('editing cannot substitute unseen assets or extend past verified intervals', () => {
  const cut = editorial();
  const manifest: MaterialManifest = {
    schemaVersion: 1,
    reviewVersion: 1,
    scriptHash: 's',
    requirements: [{ id: 'visual_1', kind: 'visual', query: '动作' }],
    matches: [
      {
        needId: 'visual_1',
        assetId: asset.id,
        sha256: asset.sha256,
        sourceStart: 0,
        sourceEnd: 7,
        observation: '可见动作',
        frameTimes: [0],
      },
    ],
  };
  assert.equal(validateMatchedEdit(cut, manifest), cut);
  assert.throws(
    () => validateMatchedEdit({ ...cut, shots: cut.shots.map((s) => ({ ...s, sourceStart: 6 })) }, manifest),
    /unverified source/,
  );
  assert.throws(
    () =>
      validateMatchedEdit({ ...cut, shots: cut.shots.map((s) => ({ ...s, assetId: 'invented' })) }, manifest),
    /unverified source/,
  );
});

test('local sourcing follows provenance after creative selection; cached web media cannot masquerade as local', () => {
  const cut = editorial();
  assert.equal(validateLocalSources(cut, [asset]), cut);
  const derived = {
    ...asset,
    source: { kind: 'generated' as const, path: '/derived.mp4', parentAssetId: 'local_root' },
  };
  const root = { ...asset, id: 'local_root' };
  assert.equal(validateLocalSources(cut, [derived, root]), cut);
  for (const assets of [
    [{ ...asset, source: { ...asset.source, kind: 'web' as const, libraryAssetId: 'forged_library' } }],
    [derived, { ...root, source: { ...root.source, kind: 'web' as const } }],
    [{ ...asset, source: { kind: 'generated' as const, path: '/invented.mp4' } }],
  ])
    assert.throws(() => validateLocalSources(cut, assets), { code: 'LOCAL_ONLY' });
  assert.throws(
    () => validateLocalSources(cut, [{ ...derived, source: { ...derived.source, parentAssetId: asset.id } }]),
    { code: 'ASSET_CYCLE' },
  );
  assert.throws(() => validateLocalSources(cut, [derived]), { code: 'IR_ASSET' });
});

test('local sourcing exempts only approved narration, not arbitrary audio labelled narration', () => {
  const voice = {
    ...asset,
    id: 'voice',
    kind: 'audio' as const,
    source: { kind: 'generated' as const, path: '/voice.wav' },
  };
  const cut = editorial();
  cut.audio = [
    {
      id: 'speech',
      assetId: voice.id,
      role: 'narration',
      sourceStart: 0,
      start: 0,
      duration: 4,
      speed: 1,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      duck: false,
    },
  ];
  assert.equal(validateLocalSources(cut, [asset, voice], voice.id), cut);
  assert.throws(() => validateLocalSources(cut, [asset, voice]), { code: 'LOCAL_ONLY' });
  cut.audio[0]!.role = 'music';
  assert.throws(() => validateLocalSources(cut, [asset, voice], voice.id), { code: 'LOCAL_ONLY' });
});
