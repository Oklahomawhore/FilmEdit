// Real-media diagnostic only: this does not accept the source cut's failed creative/material review.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../dist/packages/infrastructure/src/store.js';
import { loadProjectEnv } from '../dist/packages/infrastructure/src/model-provider.js';
import { createTask, TaskRunner } from '../dist/packages/application/src/workflow.js';
import { Renderer } from '../dist/packages/media/src/render.js';
import { validateEditorial, validateRender } from '../dist/packages/core/src/ir.js';
import { validateScopedEditorial, validateScopedLayout } from '../dist/packages/core/src/revision.js';
import { hash, errorInfo } from '../dist/packages/core/src/util.js';

await loadProjectEnv();
const base = path.resolve('.filmedit/verification/product-20261023');
const delivery = JSON.parse(await readFile(path.join(base, 'output-delivery-v22/report.json'), 'utf8'));
assert.equal(delivery.videoAccepted, false);
const source = delivery.profiles.find((profile) => profile.label === '16-9');
const original = JSON.parse(await readFile(path.join(source.directory, 'ir.json'), 'utf8'));
assert.equal(hash(original.editorial), source.editorialHash);
assert.equal(hash(original.render), source.renderHash);
const db = new DatabaseSync(path.join(base, 'output-delivery-v22/filmedit.sqlite'), { readOnly: true });
const used = new Set([...original.editorial.shots, ...original.editorial.audio].map((clip) => clip.assetId));
const assets = [...used].map((id) =>
  JSON.parse(db.prepare('SELECT data FROM assets WHERE task_id=? AND id=?').get(delivery.taskId, id).data),
);
db.close();
const home = path.join(base, 'scoped-revision-v25');
await mkdir(home, { recursive: true });
const store = new Store(home);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
const report = {
  diagnosticOnly: true,
  videoAccepted: false,
  remoteModelCalled: false,
  sourceCandidate: delivery.sourceCandidate,
  scope: { start: 0, end: 3 },
  purpose:
    'Change first shot only; verify every decoded frame after 3s and all audio samples. Not a creative, material-match or human-adoption verdict.',
  thresholds: { maxTailFrameMeanAbsoluteDifference: 2, maxTailFrameRmsDifference: 2.55 },
  renders: {},
};
try {
  const task =
    store.tasks()[0] ??
    (await createTask(store, {
      prompt: '隔离验证：只修改保存的诊断剪辑前三秒，保留其余画面与全部声音；不请求创作或审美评审。',
      creative: { enabled: false },
      materials: { paths: assets.map((asset) => asset.source.path), strategy: 'local_only' },
      composition: { ...original.render.canvas, aspectRatio: '16:9', mediaFit: 'contain' },
      output: { ...source.exportProfile, duration: original.editorial.duration },
    }));
  report.taskId = task.id;
  const runner = new TaskRunner(store, task.id, controller.signal);
  const ids = new Map();
  for (const asset of assets) {
    const imported = await runner.library.importFile(asset.source.path, 'local');
    assert.equal(imported.sha256, asset.sha256, 'Source media changed since the diagnostic');
    ids.set(asset.id, imported.id);
  }
  const editorial = validateEditorial(
    {
      ...original.editorial,
      shots: original.editorial.shots.map((clip) => ({ ...clip, assetId: ids.get(clip.assetId) })),
      audio: original.editorial.audio.map((clip) => ({ ...clip, assetId: ids.get(clip.assetId) })),
    },
    store.assets(task.id),
  );
  const render = validateRender({ ...original.render, editorialHash: hash(editorial) }, editorial);
  const guard = { version: 1, scope: report.scope, editorial, layout: render };
  const changed = structuredClone(editorial);
  assert.equal(changed.shots[0].start + changed.shots[0].duration, 3);
  changed.revision++;
  changed.shots[0].sourceStart = changed.shots[1].sourceStart;
  changed.shots[0].techniques = structuredClone(changed.shots[1].techniques);
  const changedRender = { ...structuredClone(render), editorialHash: hash(changed) };
  validateEditorial(changed, store.assets(task.id));
  validateRender(changedRender, changed);
  validateScopedEditorial(changed, guard, store.assets(task.id));
  validateScopedLayout(changedRender, changed, guard);
  const invalid = structuredClone(changed);
  invalid.shots[1].sourceStart = editorial.shots[0].sourceStart;
  invalid.shots[1].techniques = structuredClone(editorial.shots[0].techniques);
  assert.throws(() => validateScopedEditorial(invalid, guard, store.assets(task.id)), {
    code: 'REVISION_SCOPE',
  });
  const invalidLayout = structuredClone(changedRender);
  invalidLayout.nodes.find((node) => node.bindingId === changed.shots[1].id).opacity = 0.5;
  assert.throws(() => validateScopedLayout(invalidLayout, changed, guard), { code: 'REVISION_SCOPE' });
  report.outOfScopeEditorialRejected = true;
  report.outOfScopeLayoutRejected = true;
  await writeFile(
    path.join(home, 'ir.json'),
    JSON.stringify(
      { baseline: { editorial, render }, changed: { editorial: changed, render: changedRender }, guard },
      null,
      2,
    ),
  );
  const pixels = new Map(),
    audio = new Map();
  for (const [name, cut, layout] of [
    ['baseline', editorial, render],
    ['changed', changed, changedRender],
  ]) {
    console.log(JSON.stringify({ step: 'render', name }));
    const output = await new Renderer(runner.library, runner.processes).render(
      cut,
      layout,
      false,
      source.exportProfile,
    );
    const folder = path.join(task.policy.workspace, 'verification', name);
    await mkdir(folder, { recursive: true });
    const rgb = path.join(folder, 'all-frames.rgb'),
      pcm = path.join(folder, 'audio.pcm');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      output.path,
      '-an',
      '-vf',
      'scale=160:90:flags=area',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      rgb,
    ]);
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      output.path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      's16le',
      pcm,
    ]);
    for (const time of [1, 4, 10, 16])
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        String(time),
        '-i',
        output.path,
        '-frames:v',
        '1',
        path.join(folder, `${time}.png`),
      ]);
    pixels.set(name, await readFile(rgb));
    audio.set(name, await readFile(pcm));
    report.renders[name] = { ...output, frames: folder };
  }
  const before = pixels.get('baseline'),
    after = pixels.get('changed');
  const frameBytes = 160 * 90 * 3,
    fps = source.exportProfile.fps;
  assert.equal(before.length, editorial.duration * fps * frameBytes);
  assert.equal(after.length, before.length);
  assert.deepEqual(audio.get('baseline'), audio.get('changed'), 'All decoded audio must remain unchanged');
  report.audioPcmIdentical = true;
  report.frameComparisons = [];
  for (let frame = 0; frame < before.length / frameBytes; frame++) {
    let absolute = 0,
      squared = 0;
    for (let i = frame * frameBytes; i < (frame + 1) * frameBytes; i++) {
      const difference = before[i] - after[i];
      absolute += Math.abs(difference);
      squared += difference * difference;
    }
    report.frameComparisons.push({
      frame,
      time: frame / fps,
      mean: absolute / frameBytes,
      rms: Math.sqrt(squared / frameBytes),
    });
  }
  const opening = report.frameComparisons.filter((frame) => frame.time < 3);
  const tail = report.frameComparisons.filter((frame) => frame.time >= 3);
  assert.ok(
    opening.every((frame) => frame.mean > 8),
    'The requested opening change must actually appear in the video',
  );
  assert.ok(
    tail.every(
      (frame) =>
        frame.mean <= report.thresholds.maxTailFrameMeanAbsoluteDifference &&
        frame.rms <= report.thresholds.maxTailFrameRmsDifference,
    ),
    'Pixels outside the revision scope changed beyond encoding tolerance',
  );
  report.firstThreeSecondsChanged = true;
  report.tailFramesChecked = tail.length;
  report.maxTailMeanDifference = Math.max(...tail.map((frame) => frame.mean));
  report.maxTailRmsDifference = Math.max(...tail.map((frame) => frame.rms));
  report.technicalRevisionPassed = true;
  store.saveArtifact(task.id, 'verification.scoped_revision', report);
  store.updateTask(task.id, 'paused', 'layout');
} catch (error) {
  report.error = errorInfo(error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
  store.close();
}
console.log(
  JSON.stringify({
    home,
    technicalRevisionPassed: report.technicalRevisionPassed ?? false,
    videoAccepted: false,
    error: report.error,
  }),
);
