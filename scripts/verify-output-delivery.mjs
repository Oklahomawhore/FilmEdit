// Local-only geometry/audio diagnostic using the saved, unapproved A4b cut.
// It never changes the source task or claims that its creative/material gaps passed.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../dist/packages/infrastructure/src/store.js';
import { loadProjectEnv } from '../dist/packages/infrastructure/src/model-provider.js';
import { createTask, TaskRunner } from '../dist/packages/application/src/workflow.js';
import { Renderer } from '../dist/packages/media/src/render.js';
import { validateEditorial, validateRender } from '../dist/packages/core/src/ir.js';
import { validateComposition, compositionSchema } from '../dist/packages/core/src/presentation.js';
import { hash, errorInfo } from '../dist/packages/core/src/util.js';

await loadProjectEnv();
const verification = path.resolve('.filmedit/verification/product-20261023');
const sourceHome = path.join(verification, 'real-a4b');
const diagnostic = JSON.parse(
  await readFile(path.join(sourceHome, 'diagnostic-preview-review.json'), 'utf8'),
);
const sourceDb = new DatabaseSync(path.join(sourceHome, 'filmedit.sqlite'), { readOnly: true });
const source = sourceDb
  .prepare('SELECT task_id,hash,data FROM artifacts WHERE id=?')
  .get(diagnostic.candidateId);
assert.ok(source, 'Saved diagnostic candidate must exist; do not replace it with a simpler edit');
const originalCut = JSON.parse(source.data);
const used = [...new Set([...originalCut.shots, ...originalCut.audio].map((clip) => clip.assetId))];
const sources = used.map((id) =>
  JSON.parse(
    sourceDb.prepare('SELECT data FROM assets WHERE task_id=? AND id=?').get(source.task_id, id).data,
  ),
);
sourceDb.close();
const home = path.join(verification, 'output-delivery-v22');
await mkdir(home, { recursive: true });
const store = new Store(home);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
const report = {
  diagnosticOnly: true,
  videoAccepted: false,
  remoteModelCalled: false,
  sourceCandidate: {
    taskId: source.task_id,
    artifactId: diagnostic.candidateId,
    hash: source.hash,
    accepted: false,
  },
  scope:
    'Same saved shot/audio arrangement, three contain exports and one explicit cover counterexample. No narrative, source-match or human-acceptance verdict.',
  profiles: [],
};
try {
  const task =
    store.tasks()[0] ??
    (await createTask(store, {
      prompt: '隔离技术验证：复用已保存的 A4b 诊断剪辑，检查多比例导出与音轨；不进行创作或模型评审。',
      materials: { paths: sources.map((a) => a.source.path), strategy: 'local_only' },
      creative: { enabled: false },
      composition: { width: 640, height: 360, aspectRatio: '16:9', fps: 12, mediaFit: 'contain' },
      output: { width: 640, height: 360, fps: 12, duration: originalCut.duration },
    }));
  report.taskId = task.id;
  const runner = new TaskRunner(store, task.id, controller.signal);
  const ids = new Map();
  for (const original of sources) {
    const asset = await runner.library.importFile(original.source.path, 'local');
    assert.equal(asset.sha256, original.sha256, 'Source changed since the saved diagnostic');
    ids.set(original.id, asset.id);
  }
  const cut = validateEditorial(
    {
      ...originalCut,
      shots: originalCut.shots.map((clip) => ({ ...clip, assetId: ids.get(clip.assetId) })),
      audio: originalCut.audio.map((clip) => ({ ...clip, assetId: ids.get(clip.assetId) })),
    },
    store.assets(task.id),
  );
  const layout = validateRender({ ...diagnostic.render, editorialHash: hash(cut) }, cut);
  validateComposition(layout, layout.canvas, compositionSchema.parse(task.spec.composition));
  const originalHashes = { editorial: hash(cut), render: hash(layout) };
  const times = [1, 4.5, 7.5, 10.5, 13.5, 16.5];
  const baseline = new Map();
  let originalAudio;
  for (const [label, profile] of [
    ['16-9', { width: 640, height: 360, fps: 12, fit: 'contain' }],
    ['4-3', { width: 640, height: 480, fps: 12, fit: 'contain' }],
    ['9-16', { width: 360, height: 640, fps: 12, fit: 'contain' }],
    ['9-16-cover-counterexample', { width: 360, height: 640, fps: 12, fit: 'cover' }],
  ]) {
    console.log(JSON.stringify({ step: 'render', profile: label }));
    const rendered = await new Renderer(runner.library, runner.processes).render(cut, layout, false, profile);
    assert.equal(hash(cut), originalHashes.editorial);
    assert.equal(hash(layout), originalHashes.render);
    const probe = JSON.parse(
      (
        await runner.processes.run('ffprobe', [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          rendered.path,
        ])
      ).stdout,
    );
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.deepEqual([video.width, video.height], [profile.width, profile.height]);
    assert.ok(Math.abs(Number(probe.format.duration) - cut.duration) <= 1 / profile.fps);
    const [numerator, denominator] = video.avg_frame_rate.split('/').map(Number);
    assert.equal(numerator / denominator, profile.fps);
    const directory = path.join(task.policy.workspace, 'verification', label);
    await mkdir(directory, { recursive: true });
    const pcm = path.join(directory, 'audio.pcm');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      rendered.path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      's16le',
      pcm,
    ]);
    const audio = await readFile(pcm);
    if (originalAudio) assert.deepEqual(audio, originalAudio, 'Export ratio must not alter audio samples');
    else originalAudio = audio;
    const scale = Math.min(profile.width / layout.canvas.width, profile.height / layout.canvas.height);
    const width = Math.floor((layout.canvas.width * scale) / 2) * 2;
    const height = Math.floor((layout.canvas.height * scale) / 2) * 2;
    const x = Math.floor((profile.width - width) / 2);
    const y = Math.floor((profile.height - height) / 2);
    const frames = [];
    for (const time of times) {
      const png = path.join(directory, `${time}.png`),
        rgb = path.join(directory, `${time}.rgb`);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        String(time),
        '-i',
        rendered.path,
        '-frames:v',
        '1',
        png,
      ]);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        String(time),
        '-i',
        rendered.path,
        '-vf',
        `crop=${width}:${height}:${x}:${y},scale=160:90:flags=area`,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        rgb,
      ]);
      const pixels = await readFile(rgb);
      if (label === '16-9') baseline.set(time, pixels);
      const reference = baseline.get(time);
      const difference = (edge) => {
        let total = 0,
          count = 0;
        for (let index = 0; index < pixels.length; index++) {
          const column = Math.floor(index / 3) % 160;
          if (edge && column >= 16 && column < 144) continue;
          total += Math.abs(pixels[index] - reference[index]);
          count++;
        }
        return total / count;
      };
      frames.push({
        time,
        path: png,
        meanPixelDifference: difference(false),
        edgePixelDifference: difference(true),
      });
    }
    if (profile.fit === 'contain') {
      assert.equal(rendered.projection.retainedArea, 1);
      assert.ok(
        frames.every((f) => f.meanPixelDifference < 12 && f.edgePixelDifference < 12),
        'Contain changed sampled picture geometry beyond resampling tolerance',
      );
    } else {
      assert.ok(rendered.projection.retainedArea < 0.32);
      assert.ok(
        frames.some((f) => f.edgePixelDifference >= 12),
        'The explicit crop counterexample must be detected',
      );
    }
    report.profiles.push({ label, ...rendered, audioIdentical: true, frames });
    await writeFile(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
  }
  report.geometryAndAudioPassed = true;
  report.irHashes = originalHashes;
  store.saveArtifact(task.id, 'verification.output_delivery', report);
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
    geometryAndAudioPassed: report.geometryAndAudioPassed ?? false,
    videoAccepted: false,
    error: report.error,
  }),
);
