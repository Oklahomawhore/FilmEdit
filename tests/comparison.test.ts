import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSignatures } from '../packages/media/src/comparison.js';
import { parseSubtitles } from '../packages/media/src/assets.js';
import { localTtsConfiguration } from '../packages/media/src/tts.js';
test('technique difference converges downwards and mistimed cuts fail', () => {
  const a = {
    duration: 3,
    cuts: [1, 2],
    motion: [0, 0.5, 0],
    layout: [
      [0, 1],
      [1, 0],
    ],
    luminance: [0.5, 0.5],
  };
  assert.equal(compareSignatures(a, a).distance, 0);
  assert.ok(compareSignatures(a, a).passed);
  assert.equal(compareSignatures(a, { ...a, cuts: [1.2, 2] }).passed, false);
});
test('unchanged pixels cannot pass a fade reference through average-score dilution', () => {
  const reference = {
    duration: 5,
    cuts: [],
    motion: [0, 0.05, 0.05, 0, 0, 0.05, 0.05],
    layout: Array.from({ length: 7 }, () => [0, 0]),
    luminance: [0, 0.25, 0.5, 0.5, 0.5, 0.25, 0],
  };
  const noEffect = { ...reference, motion: [0, 0, 0, 0, 0, 0, 0], luminance: Array(7).fill(0.5) };
  assert.equal(compareSignatures(reference, noEffect).passed, false);
  const darkerSource = {
    ...reference,
    motion: reference.motion.map((x) => x / 2),
    luminance: reference.luminance.map((x) => x / 2),
  };
  assert.equal(compareSignatures(reference, darkerSource).metrics.luminanceEnvelope, 0);
  assert.equal(compareSignatures(reference, darkerSource).passed, true);
  assert.throws(() => compareSignatures(reference, { ...reference, motion: [] }), /non-empty/);
});
test('the same fade on different pictures is accepted without accepting a missing or reversed effect', () => {
  const ramp = [0, 0.5, 1, 1, 1, 0.5, 0];
  const reference = {
    duration: 5,
    cuts: [],
    motion: [0, 0.15, 0.15, 0, 0, 0.15, 0.15],
    layout: ramp.map((v) => [-0.15 * v, 0.15 * v]),
    luminance: ramp.map((v) => 0.3 * v),
  };
  const brighterPicture = {
    ...reference,
    motion: [0, 0.45, 0.45, 0, 0, 0.45, 0.45],
    layout: ramp.map((v) => [0.3 * v, -0.3 * v]),
    luminance: ramp.map((v) => 0.9 * v),
  };
  const score = compareSignatures(reference, brighterPicture);
  assert.ok(score.metrics.transition > 0.5, 'absolute brightness really differs');
  assert.equal(score.passed, true);
  assert.equal(
    compareSignatures(reference, {
      ...brighterPicture,
      motion: Array(7).fill(0),
      layout: ramp.map(() => [0.3, -0.3]),
      luminance: Array(7).fill(0.9),
    }).passed,
    false,
  );
  assert.equal(
    compareSignatures(reference, {
      ...brighterPicture,
      luminance: brighterPicture.luminance.map((v) => 0.9 - v),
    }).passed,
    false,
  );
});
test('spatial temporal comparison is invariant to source contrast without ignoring a missing fade', () => {
  const ramp = Array.from({ length: 60 }, (_, i) => Math.min(1, i / 12, (60 - i) / 12));
  const reference = {
    duration: 5,
    cuts: [],
    motion: ramp.map((v, i) => (i ? Math.abs(v - ramp[i - 1]!) * 0.5 : 0)),
    layout: ramp.map((v) => [-0.15 * v, 0.15 * v]),
    luminance: ramp.map((v) => 0.5 * v),
  };
  const lowContrast = { ...reference, layout: ramp.map((v) => [-0.03 * v, 0.03 * v]) };
  assert.equal(compareSignatures(reference, lowContrast).passed, true);
  assert.equal(
    compareSignatures(reference, {
      ...lowContrast,
      layout: ramp.map(() => [-0.03, 0.03]),
    }).passed,
    false,
    'identical average luminance cannot hide a missing spatial effect',
  );
});

test('subtitle parsing preserves intervals and strips markup', () => {
  assert.deepEqual(parseSubtitles('1\n00:00:01,250 --> 00:00:02,500\n<b>你好</b>\n'), [
    { start: 1.25, end: 2.5, text: '你好\n' },
  ]);
});
test('TTS always selects local Piper, validates speed and never uses cloud credentials', () => {
  assert.deepEqual(localTtsConfiguration({ FILMEDIT_MODEL_DIR: '/models', DOUBAO_API_KEY: 'unused' }), {
    engine: 'piper',
    model: '/models/tts/zh_CN-huayan-medium.onnx',
    speed: 1,
  });
  assert.throws(() => localTtsConfiguration({}), { code: 'TTS_MODEL_REQUIRED' });
  assert.throws(() => localTtsConfiguration({ FILMEDIT_TTS_MODEL: 'https://example.com/voice.onnx' }), {
    code: 'TTS_MODEL_REQUIRED',
  });
  for (const speed of ['0', '-1', 'Infinity', 'bad'])
    assert.throws(() => localTtsConfiguration({ FILMEDIT_MODEL_DIR: '/models', FILMEDIT_TTS_SPEED: speed }));
});
