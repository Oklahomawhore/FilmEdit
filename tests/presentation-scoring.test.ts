import test from 'node:test';
import assert from 'node:assert/strict';
import { editorialSchema, renderSchema } from '../packages/core/src/domain.js';
import { hash } from '../packages/core/src/util.js';
import { measurePresentation } from '../packages/media/src/presentation-scoring.js';
import { scoreAcceptance } from '../packages/media/src/acceptance-scoring.js';
import { acceptancePlanSchema, type AcceptanceSource } from '../packages/core/src/acceptance.js';
import { audience } from './helpers.js';

const split = { kind: 'layout_mode', mode: 'left_right', interval: null } as const;
const rate = {
  kind: 'playback_rate',
  region: 'left',
  rate: 1.8,
  approximate: false,
  interval: null,
} as const;
function scene() {
  const edit = editorialSchema.parse({
    schemaVersion: 1,
    revision: 0,
    duration: 4,
    shots: [
      { id: 'shot_a', assetId: 'asset_a', sourceStart: 0, start: 0, duration: 4, speed: 1.8, track: 0 },
      { id: 'shot_b', assetId: 'asset_b', sourceStart: 0, start: 0, duration: 4, speed: 0.4, track: 1 },
    ],
  });
  const render = renderSchema.parse({
    schemaVersion: 1,
    editorialHash: hash(edit),
    canvas: { width: 640, height: 360, fps: 12 },
    nodes: [
      {
        id: 'left',
        kind: 'media',
        bindingId: 'shot_a',
        fit: 'contain',
        placement: { mode: 'rect', rect: [0, 0, 0.5, 1] },
      },
      {
        id: 'right',
        kind: 'media',
        bindingId: 'shot_b',
        fit: 'contain',
        placement: { mode: 'rect', rect: [0.5, 0, 0.5, 1] },
      },
    ],
  });
  return { edit, render };
}
const frame = (time: number, props = {}) => ({
  time,
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
  ...props,
});

test('measure playback parameters from the correct visible side, never from natural language', async () => {
  const { edit, render } = scene();
  assert.equal(measurePresentation(split, edit, render).status, 'supported');
  assert.equal(measurePresentation(rate, edit, render).status, 'supported');
  assert.equal(measurePresentation({ ...rate, region: 'right' }, edit, render).status, 'contradicted');
  assert.equal(measurePresentation({ ...rate, region: 'all' }, edit, render).status, 'contradicted');
  const source: AcceptanceSource = {
    id: 'test',
    text: '左窗1.8倍速',
    quote: '左窗1.8倍速',
    group: 'expression',
    modality: 'visual',
    stage: 'editorial',
  };
  const plan = acceptancePlanSchema.parse({
    schemaVersion: 1,
    sources: [{ sourceId: 'test', checks: [rate] }],
  });
  const model = {
    version: 'must-not-call-nli',
    async compare(): Promise<never> {
      throw new Error('Numeric parameters cannot use NLI');
    },
  };
  const deferred = await scoreAcceptance(model, [source], plan, audience(), {
    editorial: edit,
    stage: 'editorial',
  });
  assert.equal(deferred.deferred.length, 1);
  assert.equal(
    (await scoreAcceptance(model, [source], plan, audience(), { editorial: edit, render, stage: 'render' }))
      .passed,
    true,
  );
});

test('layout checks every output frame, detects hidden panels and the wrong arrangement', () => {
  const { edit, render } = scene();
  assert.equal(measurePresentation({ ...split, mode: 'single' }, edit, render).status, 'contradicted');
  render.nodes[1]!.keyframes = [frame(0), frame(2, { opacity: 0 }), frame(3)];
  assert.notEqual(measurePresentation(split, edit, render).status, 'supported');
  render.nodes[1]!.keyframes = [];
  render.nodes[0]!.placement = { mode: 'rect', rect: [0, 0, 1, 0.5] };
  render.nodes[1]!.placement = { mode: 'rect', rect: [0, 0.5, 1, 0.5] };
  assert.equal(measurePresentation(split, edit, render).status, 'contradicted');
  assert.equal(measurePresentation({ ...split, mode: 'top_bottom' }, edit, render).status, 'supported');
  assert.equal(measurePresentation({ ...rate, region: 'top' }, edit, render).status, 'supported');
});

test('group transforms and binding-relative animation select the actual side', () => {
  const { edit, render } = scene();
  render.nodes.push(
    renderSchema.parse({
      ...render,
      nodes: [{ id: 'group', kind: 'group', placement: { mode: 'rect', rect: [0, 0, 1, 1] } }],
    }).nodes[0]!,
  );
  render.nodes[0]!.parentId = 'group';
  render.nodes[1]!.parentId = 'group';
  assert.equal(measurePresentation(split, edit, render).status, 'supported');
  render.nodes[2]!.opacity = 0;
  assert.equal(measurePresentation(split, edit, render).status, 'contradicted');
  render.nodes[2]!.opacity = 1;
  edit.shots.forEach((s) => {
    s.start = 1;
    s.duration = 3;
  });
  render.editorialHash = hash(edit);
  render.animationTimebase = 'binding';
  render.nodes[0]!.keyframes = [frame(0, { opacity: 0 }), frame(1)];
  assert.equal(
    measurePresentation({ ...split, interval: { start: 1, end: 1.01 } }, edit, render).status,
    'contradicted',
  );
  assert.equal(
    measurePresentation({ ...split, interval: { start: 2, end: 4 } }, edit, render).status,
    'supported',
  );
});

test('overlap, clipping, masks, transitions, and stale edit bindings are not silent passes', () => {
  for (const variant of ['overlap', 'clipping', 'mask', 'transition', 'stale'] as const) {
    const { edit, render } = scene();
    if (variant === 'overlap') render.nodes[1]!.placement = { mode: 'rect', rect: [0.25, 0, 0.5, 1] };
    if (variant === 'clipping') render.nodes[1]!.keyframes = [frame(0, { x: 20 })];
    if (variant === 'mask') render.nodes[0]!.mask = 'circle';
    if (variant === 'transition') {
      edit.transitions.push({ from: 'shot_a', to: 'shot_b', kind: 'fade', duration: 1 });
      render.editorialHash = hash(edit);
    }
    if (variant === 'stale') render.editorialHash = 'a'.repeat(64);
    assert.equal(measurePresentation(split, edit, render).status, 'unknown', variant);
  }
});

test('explicit freeze has zero source rate even when shot.speed is positive', () => {
  const { edit, render } = scene();
  edit.shots[0]!.techniques.push({ id: 'freeze', version: 1, params: {} });
  render.editorialHash = hash(edit);
  assert.equal(measurePresentation(rate, edit, render).status, 'contradicted');
  assert.equal(measurePresentation({ ...rate, rate: 0 }, edit, render).status, 'supported');
});

test('fractional cut times use compositor frame samples; wrong rates on the next frame fail', () => {
  const { edit, render } = scene();
  edit.shots[0]!.duration = 1.7;
  edit.shots.push({ ...edit.shots[0]!, id: 'shot_c', start: 1.7, duration: 2.3, speed: 0.9 });
  render.nodes.push({ ...render.nodes[0]!, id: 'later', bindingId: 'shot_c' });
  render.editorialHash = hash(edit);
  const check = { ...rate, rate: 0.9, interval: { start: 1.7, end: 4 } };
  assert.equal(measurePresentation(check, edit, render).status, 'supported');
  edit.shots[2]!.speed = 1;
  render.editorialHash = hash(edit);
  assert.equal(measurePresentation(check, edit, render).status, 'contradicted');
  assert.equal(
    measurePresentation({ ...rate, interval: { start: 0.01, end: 0.02 } }, edit, render).status,
    'unknown',
  );
});

test('only explicit approximate rates permit rounding to the stated decimal precision', () => {
  const { edit, render } = scene();
  edit.shots[0]!.speed = 1.77;
  render.editorialHash = hash(edit);
  assert.equal(measurePresentation(rate, edit, render).status, 'contradicted');
  assert.equal(measurePresentation({ ...rate, approximate: true }, edit, render).status, 'supported');
  edit.shots[0]!.speed = 1.86;
  render.editorialHash = hash(edit);
  assert.equal(measurePresentation({ ...rate, approximate: true }, edit, render).status, 'contradicted');
  edit.shots[1]!.speed = 0.44;
  render.editorialHash = hash(edit);
  assert.equal(
    measurePresentation({ ...rate, region: 'right', rate: 0.45, approximate: true }, edit, render).status,
    'contradicted',
  );
});

test('presentation measurements use output samples independently of composition FPS', () => {
  const { edit, render } = scene();
  const check = { ...split, interval: { start: 0.02, end: 0.04 } };
  assert.equal(render.canvas.fps, 12);
  assert.equal(measurePresentation(check, edit, render, 12).status, 'unknown');
  assert.equal(measurePresentation(check, edit, render, 30).status, 'supported');
  assert.equal(measurePresentation(check, edit, render, NaN).status, 'unknown');
});
