import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultRender,
  validateEditorial,
  validateRender,
  validateAudience,
  blindEditorial,
} from '../packages/core/src/ir.js';
import { resolveBoxes, evaluateFrame } from '../packages/core/src/layout.js';
import { compileHtml } from '../packages/media/src/compositor.js';
import { hash } from '../packages/core/src/util.js';
import { asset, editorial, audience } from './helpers.js';
import { editorialSchema } from '../packages/core/src/domain.js';

test('editorial validates source ranges, complete coverage and transition overlaps', () => {
  const ir = editorial();
  assert.doesNotThrow(() => validateEditorial(ir, [asset]));
  const reserved = structuredClone(ir);
  reserved.shots[0]!.id = 'rendered_audio';
  assert.throws(() => validateEditorial(reserved, [asset]), { code: 'IR_RESERVED_ID' });
  const invalid = structuredClone(ir);
  invalid.shots[1]!.sourceStart = 9;
  assert.throws(() => validateEditorial(invalid, [asset]), { code: 'IR_SOURCE_RANGE' });
  invalid.shots[1]!.sourceStart = 0;
  invalid.shots[1]!.start = 2.5;
  assert.throws(() => validateEditorial(invalid, [asset]));
  const overlap = editorial();
  overlap.shots[0]!.duration = 2.5;
  assert.throws(() => validateEditorial(overlap, [asset]), { code: 'IR_OVERLAP' });
  overlap.transitions = [{ from: 'shot_a', to: 'shot_b', kind: 'fade', duration: 0.5 }];
  assert.doesNotThrow(() => validateEditorial(overlap, [asset]));
});
test('render binds approved content, rejects stale edits, cycles and omitted elements', () => {
  const ir = editorial();
  const render = defaultRender(ir, { width: 1080, height: 1920, fps: 30 });
  assert.doesNotThrow(() => validateRender(render, ir));
  const changed = structuredClone(ir);
  changed.text[0]!.text = '内容已改变';
  assert.throws(() => validateRender(render, changed), { code: 'STALE_EDITORIAL' });
  render.nodes.pop();
  assert.throws(() => validateRender(render, ir), { code: 'IR_MISSING_BINDING' });
});

test('independent pictures use separate tracks; overlays cannot hide a base gap or cross-track transitions', () => {
  const ir = editorial();
  ir.shots.push({ ...ir.shots[0]!, id: 'overlay', track: 1, start: 1, duration: 2 });
  assert.doesNotThrow(() => validateEditorial(ir, [asset]));
  ir.shots[0]!.duration = 1.5;
  assert.throws(() => validateEditorial(ir, [asset]), { code: 'IR_GAP' });
  ir.shots[0]!.duration = 2;
  ir.transitions.push({ from: 'shot_a', to: 'overlay', kind: 'fade', duration: 1 });
  assert.throws(() => validateEditorial(ir, [asset]), { code: 'IR_TRANSITION' });
  ir.transitions = [];
  ir.shots.push({ ...ir.shots.at(-1)!, id: 'collision', start: 1.5 });
  assert.throws(() => validateEditorial(ir, [asset]), { code: 'IR_OVERLAP' });
});
test('pixel dimensions cannot be used as normalized placement dimensions', () => {
  const ir = editorial();
  const render = defaultRender(ir, { width: 256, height: 256, fps: 24 });
  render.nodes[0]!.placement = { mode: 'rect', rect: [0, 0, 256, 256] };
  assert.throws(() => validateRender(render, ir));
  render.nodes[0]!.placement = { mode: 'anchor', anchor: 'center', size: [256, 256], offset: [0, 0] };
  assert.throws(() => validateRender(render, ir));
  render.nodes[0]!.placement = { mode: 'rect', rect: [0, 0, 1, 1] };
  assert.deepEqual(resolveBoxes(validateRender(render, ir)).get(render.nodes[0]!.id), {
    x: 0,
    y: 0,
    width: 256,
    height: 256,
  });
});
test('layout is seek independent and anchor placement is deterministic', () => {
  const ir = editorial();
  const render = defaultRender(ir, { width: 1000, height: 1000, fps: 30 });
  const node = render.nodes[0]!;
  node.placement = { mode: 'anchor', anchor: 'bottom-right', size: [0.2, 0.3], offset: [-0.05, -0.05] };
  assert.deepEqual(resolveBoxes(render).get(node.id), {
    x: 750,
    y: 649.9999999999999,
    width: 200,
    height: 300,
  });
  node.keyframes = [
    { time: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    { time: 2, x: 100, y: 0, scale: 2, rotation: 90, opacity: 0.5 },
  ];
  const halfway = evaluateFrame(node, 1);
  evaluateFrame(node, 3);
  assert.deepEqual(evaluateFrame(node, 1), halfway);
  assert.equal(halfway.x, 50);
});
test('HTML escapes user text and uses media offsets, not creator metadata', () => {
  const ir = editorial();
  ir.text[0]!.text = '<script>alert(1)</script>';
  const render = defaultRender(ir, { width: 1080, height: 1920, fps: 30 });
  const html = compileHtml(
    ir,
    render,
    new Map([
      ['shot_a', './assets/a.mp4'],
      ['shot_b', './assets/b.mp4'],
    ]),
  );
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('data-media-start="0"'));
  const secretAsset = {
    ...asset,
    source: { ...asset.source, title: '必须让观众理解孤独', path: '/secret/intent.mp4' },
  };
  const blind = JSON.stringify(blindEditorial(ir, [secretAsset]));
  assert.ok(!blind.includes('孤独'));
  assert.ok(!blind.includes('/secret'));
});
test('audience cannot cite nonexistent shots or use speech as visual evidence', () => {
  const ir = editorial();
  const a = audience();
  assert.doesNotThrow(() => validateAudience(a, ir));
  a.evidence[0]!.bindingId = 'made_up';
  assert.throws(() => validateAudience(a, ir), { code: 'EVIDENCE_RANGE' });
  a.evidence[0]!.bindingId = 'text_a';
  assert.throws(() => validateAudience(a, ir), { code: 'EVIDENCE_MODALITY' });
});
test('blind observer only sees transcripts wholly inside the audible source interval', () => {
  const ir = editorialSchema.parse({
    ...editorial(),
    audio: [
      { id: 'speech', assetId: asset.id, role: 'dialogue', sourceStart: 2, start: 1, duration: 1, speed: 2 },
    ],
  });
  const source = {
    ...asset,
    transcript: [
      { start: 0, end: 1, text: 'hidden before' },
      { start: 2, end: 3, text: 'visible dialogue' },
      { start: 3.9, end: 4.1, text: 'hidden partial' },
      { start: 5, end: 6, text: 'hidden after' },
    ],
  };
  const blind = blindEditorial(ir, [source, { ...asset, id: 'unused_asset' }]);
  assert.deepEqual(blind.audioEvidence[0]!.transcript, [{ text: 'visible dialogue', start: 1, end: 1.5 }]);
  assert.ok(!JSON.stringify(blind).includes('hidden'));
  assert.ok(!JSON.stringify(blind).includes('unused_asset'));
});

test('burned-in text is valid shot evidence but speech is not visible text', () => {
  const ir = editorialSchema.parse({
    ...editorial(),
    audio: [{ id: 'speech', assetId: asset.id, role: 'narration', sourceStart: 0, start: 0, duration: 4 }],
  });
  const report = audience();
  report.evidence[0]!.modality = 'text';
  assert.doesNotThrow(() => validateAudience(report, ir));
  report.evidence[0]!.bindingId = 'speech';
  assert.throws(() => validateAudience(report, ir), { code: 'EVIDENCE_MODALITY' });
  report.evidence[0]!.bindingId = 'shot_a';
  report.evidence[0]!.end = 3;
  assert.throws(
    () => validateAudience(report, ir),
    (error: any) => error.code === 'EVIDENCE_RANGE' && error.details.allowed.end === 2,
  );
});
