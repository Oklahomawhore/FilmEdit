import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compositionSchema,
  resolveComposition,
  resolveExport,
  projectCanvas,
  validateComposition,
} from '../packages/core/src/presentation.js';
import { taskInputSchema } from '../packages/core/src/domain.js';
import { defaultRender, validateRender } from '../packages/core/src/ir.js';
import { compileHtml } from '../packages/media/src/compositor.js';
import { asset, editorial } from './helpers.js';
import { hash } from '../packages/core/src/util.js';
import { evenlySample } from '../packages/application/src/workflow.js';

test('export ratios resolve independently of composition; conflicting and odd sizes fail', () => {
  assert.deepEqual(resolveExport({ aspectRatio: '16:9' }), {
    width: 1920,
    height: 1080,
    fps: 30,
    fit: 'contain',
    background: '#000000',
  });
  assert.equal(resolveExport({ aspectRatio: '4:3', height: 720 }).width, 960);
  assert.equal(resolveExport({ aspectRatio: '9:16', width: 1080 }).height, 1920);
  assert.throws(() => resolveExport({ aspectRatio: '16:9', width: 1080, height: 1920 }));
  assert.throws(() => resolveExport({ width: 1279, height: 720 }));
  assert.throws(() => resolveExport({ width: 1920 }));
  const spec = taskInputSchema.parse({ prompt: 'test', output: { aspectRatio: '4:3', height: 720 } });
  assert.equal(spec.output.width, 960);
  assert.equal(spec.composition.aspectRatio, 'auto');
  assert.equal(spec.composition.mediaFit, 'contain');
  assert.equal(spec.creative.enabled, true);
  assert.equal(spec.budgets.stageRounds, null);
});

test('landscape sources choose a landscape reference; output policy never mutates the layout', () => {
  const policy = compositionSchema.parse({});
  const canvas = resolveComposition(policy, [{ ...asset, width: 1280, height: 720 }]);
  assert.equal(canvas.width / canvas.height, 16 / 9);
  const cut = editorial(),
    ir = defaultRender(cut, canvas),
    before = hash(ir);
  validateComposition(ir, canvas, policy);
  for (const aspectRatio of ['16:9', '4:3', '9:16'] as const) {
    const projection = projectCanvas(canvas, resolveExport({ aspectRatio }));
    assert.equal(projection.retainedArea, 1);
    assert.ok(projection.x >= 0 && projection.y >= 0);
  }
  assert.equal(hash(ir), before);
  assert.ok(projectCanvas(canvas, resolveExport({ aspectRatio: '9:16', fit: 'cover' })).retainedArea < 0.32);
  const cropped = structuredClone(ir);
  cropped.nodes[0]!.fit = 'cover';
  assert.throws(() => validateComposition(cropped, canvas, policy), /preserve/);
  cropped.nodes[0]!.fit = 'contain';
  cropped.nodes[0]!.keyframes = [{ time: 0, x: 0, y: 0, scale: 1.1, rotation: 0, opacity: 1 }];
  assert.throws(() => validateComposition(cropped, canvas, policy), /crop content/);
});

test('binding animation uses shot start; explicit timeline animations use global time', () => {
  const cut = editorial();
  const ir = defaultRender(cut, { width: 320, height: 180, fps: 30 });
  ir.nodes[1]!.keyframes = [
    { time: 0, x: 0, y: 0, scale: 0.8, rotation: 0, opacity: 1 },
    { time: 2, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  ];
  const prepared = new Map(cut.shots.map((s) => [s.id, './video.mp4']));
  const html = compileHtml(cut, ir, prepared);
  assert.match(html, /"offset":2/);
  ir.nodes[1]!.keyframes[1]!.time = 3;
  assert.throws(() => validateRender(ir, cut), /Keyframes/);
  ir.animationTimebase = 'timeline';
  assert.doesNotThrow(() => validateRender(ir, cut));
  assert.ok(!compileHtml(cut, ir, prepared).includes('"offset":2'));
});

test('review frame sampling reaches the end of a long film', () => {
  const result = evenlySample(
    Array.from({ length: 120 }, (_, i) => i),
    32,
  );
  assert.equal(result[0], 0);
  assert.equal(result.at(-1), 119);
  assert.equal(new Set(result).size, 32);
});
