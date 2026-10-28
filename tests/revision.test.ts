import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { editorialSchema } from '../packages/core/src/domain.js';
import { defaultRender, validateEditorial, validateRender } from '../packages/core/src/ir.js';
import {
  validateScopedEditorial,
  validateScopedLayout,
  type RevisionGuard,
} from '../packages/core/src/revision.js';
import { hash } from '../packages/core/src/util.js';
import { Workbench } from '../packages/application/src/workbench.js';
import { TaskService } from '../packages/application/src/task-service.js';
import { createTask } from '../packages/application/src/workflow.js';
import { asset, fixture } from './helpers.js';

function baseline() {
  const editorial = editorialSchema.parse({
    schemaVersion: 1,
    revision: 0,
    duration: 8,
    shots: [{ id: 'scene', assetId: asset.id, sourceStart: 0, start: 0, duration: 8 }],
    audio: [
      {
        id: 'music',
        assetId: asset.id,
        role: 'music',
        sourceStart: 0,
        start: 0,
        duration: 8,
        fadeIn: 1,
        fadeOut: 1,
      },
    ],
    text: [{ id: 'caption', text: '后段文字', start: 4, duration: 3, role: 'subtitle' }],
  });
  const layout = defaultRender(editorial, { width: 640, height: 360, fps: 30 });
  layout.nodes[0]!.keyframes = [
    { time: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    { time: 8, x: 80, y: 0, scale: 1, rotation: 0, opacity: 1 },
  ];
  const guard: RevisionGuard = { version: 2, scope: { start: 0, end: 3 }, editorial, layout };
  const next = structuredClone(editorial);
  next.revision++;
  next.shots[0] = { ...next.shots[0]!, start: 3, sourceStart: 3, duration: 5 };
  next.shots.unshift({ ...next.shots[0]!, id: 'new_opening', start: 0, sourceStart: 6, duration: 3 });
  const render = structuredClone(layout);
  render.editorialHash = hash(next);
  render.nodes[0]!.keyframes = [
    { time: 0, x: 30, y: 0, scale: 1, rotation: 0, opacity: 1 },
    { time: 5, x: 80, y: 0, scale: 1, rotation: 0, opacity: 1 },
  ];
  render.nodes.push({ ...render.nodes[0]!, id: 'new_node', bindingId: 'new_opening', keyframes: [], z: 2 });
  return { guard, next, render };
}

test('changing the first three seconds permits a split but preserves remaining source, sound and text', () => {
  const { guard, next } = baseline();
  validateEditorial(next, [asset]);
  assert.doesNotThrow(() => validateScopedEditorial(next, guard, [asset]));
  for (const mutate of [
    (edit: typeof next) => {
      edit.shots[1]!.sourceStart = 4;
    },
    (edit: typeof next) => {
      edit.audio[0]!.volume = 0.5;
    },
    (edit: typeof next) => {
      edit.text[0]!.text = '擅自改写';
    },
    (edit: typeof next) => {
      edit.duration = 7;
    },
    (edit: typeof next) => {
      edit.shots[1]!.id = 'lost_binding';
    },
  ]) {
    const changed = structuredClone(next);
    mutate(changed);
    assert.throws(() => validateScopedEditorial(changed, guard, [asset]), { code: 'REVISION_SCOPE' });
  }
  // A fade wholly inside the editable interval can change; the ending cannot.
  next.audio[0]!.fadeIn = 2;
  assert.doesNotThrow(() => validateScopedEditorial(next, guard, [asset]));
  next.audio[0]!.fadeOut = 2;
  assert.throws(() => validateScopedEditorial(next, guard, [asset]), { code: 'REVISION_SCOPE' });
});

test('scoped layout validates actual animation after splitting, including changes between existing keyframes', () => {
  const { guard, next, render } = baseline();
  validateRender(render, next);
  assert.doesNotThrow(() => validateScopedLayout(render, next, guard));
  const motion = structuredClone(render);
  motion.nodes[0]!.keyframes.splice(1, 0, { time: 2, x: 150, y: 0, scale: 1, rotation: 0, opacity: 1 });
  assert.throws(() => validateScopedLayout(motion, next, guard), { code: 'REVISION_SCOPE' });
  const crop = structuredClone(render);
  crop.nodes[0]!.fit = 'cover';
  assert.throws(() => validateScopedLayout(crop, next, guard), { code: 'REVISION_SCOPE' });
  const shifted = structuredClone(render);
  shifted.nodes[0]!.keyframes[0]!.x = 0;
  assert.throws(() => validateScopedLayout(shifted, next, guard), { code: 'REVISION_SCOPE' });
});

test('time-scoped revision is persisted before invalidation; later full revision removes the restriction', async (t) => {
  const f = await fixture();
  t.after(async () => {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const w = new Workbench(f.store, new TaskService(f.store), { autoStart: false });
  const task = await createTask(f.store, { prompt: '局部修改' });
  const { guard } = baseline();
  f.store.saveArtifact(task.id, 'editorial', guard.editorial, true);
  f.store.saveArtifact(task.id, 'layout', guard.layout, true);
  const command = {
    requestId: 'local-revision',
    command: 'task.revise',
    taskId: task.id,
    args: { expectedVersion: 1, kind: 'editorial', instruction: '只改前三秒', scope: { start: 0, end: 3 } },
  };
  await assert.rejects(
    w.command({
      ...command,
      requestId: 'out-of-range',
      args: { ...command.args, scope: { start: 0, end: 9 } },
    }),
    { code: 'REVISION_SCOPE' },
  );
  await w.command(command);
  assert.deepEqual(f.store.artifact(task.id, 'revision.guard')!.data, guard);
  assert.equal(f.store.artifact(task.id, 'editorial'), undefined);
  assert.equal(f.store.artifact(task.id, 'layout'), undefined);
  await w.command({
    ...command,
    requestId: 'full-revision',
    args: { expectedVersion: 2, kind: 'editorial', instruction: '重新设计整片' },
  });
  assert.equal(f.store.artifact(task.id, 'revision.guard'), undefined);
});
