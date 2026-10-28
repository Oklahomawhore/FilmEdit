import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { Renderer, RENDERER_VERSION } from '../packages/media/src/render.js';
import { defaultRender } from '../packages/core/src/ir.js';
import { resolveExport } from '../packages/core/src/presentation.js';
import { hash } from '../packages/core/src/util.js';
import { asset, editorial, fixture } from './helpers.js';

test('preview resume preserves registered media; edit, export, renderer and release changes invalidate it', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, {
    prompt: 'preview recovery',
    creative: { enabled: false },
    output: { duration: 4 },
  });
  const cut = editorial(),
    render = defaultRender(cut, { width: 640, height: 360, fps: 30 });
  const { duration, ...output } = task.spec.output;
  const profile = resolveExport(output, render.canvas);
  const file = path.join(task.policy.workspace, 'saved-preview.mp4');
  const bytes = Buffer.from('registered media fixture');
  await writeFile(file, bytes);
  store.saveAsset({
    ...asset,
    id: 'saved_preview',
    taskId: task.id,
    source: { kind: 'generated', path: file },
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    policyVersion: task.policy.version,
  });
  const saved = {
    rendererVersion: RENDERER_VERSION,
    releaseId: task.releaseId,
    preview: true,
    path: file,
    editorialHash: hash(cut),
    renderHash: hash(render),
    exportHash: hash(profile),
    exportProfile: profile,
  };
  store.saveArtifact(task.id, 'layout.preview', saved);
  const runner = new TaskRunner(store, task.id);
  let renders = 0;
  t.mock.method(Renderer.prototype, 'render', async () => {
    renders++;
    throw new Error('RENDER_REQUIRED');
  });
  assert.deepEqual(await (runner as any).preview(cut, render), saved);
  assert.equal(renders, 0);
  assert.equal(store.events(task.id).filter((e: any) => e.type === 'layout.preview_reused').length, 1);
  for (const patch of [
    { editorialHash: 'different-edit' },
    { renderHash: 'different-layout' },
    { exportHash: 'different-export' },
    { rendererVersion: 'older-renderer' },
    { releaseId: 'older-release' },
  ]) {
    store.saveArtifact(task.id, 'layout.preview', { ...saved, ...patch });
    await assert.rejects((runner as any).preview(cut, render), /RENDER_REQUIRED/);
  }
  assert.equal(renders, 5);
  store.saveArtifact(task.id, 'layout.preview', saved);
  await writeFile(file, 'tampered media');
  await assert.rejects((runner as any).preview(cut, render), { code: 'ASSET_CHANGED' });
  assert.equal(renders, 5, 'tampering must not be silently replaced by a new render');
});
