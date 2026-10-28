// Real local-model controls. Download fixtures separately; no remote generation or production writes.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../dist/packages/infrastructure/src/store.js';
import { loadProjectEnv } from '../dist/packages/infrastructure/src/model-provider.js';
import { createTask, TaskRunner } from '../dist/packages/application/src/workflow.js';
import { AudioAnalyzer } from '../dist/packages/media/src/audio-evidence.js';
import { errorInfo, hash } from '../dist/packages/core/src/util.js';

assert.equal(
  process.argv.length,
  4,
  'Usage: node scripts/verify-sound-evidence.mjs FIXTURE_MANIFEST OUTPUT_DIRECTORY',
);
await loadProjectEnv();
const fixtures = JSON.parse(await readFile(path.resolve(process.argv[2]), 'utf8')).fixtures;
assert.deepEqual(fixtures.map((item) => item.category).sort(), ['chirping_birds', 'engine', 'speech']);
const home = path.resolve(process.argv[3]);
await mkdir(home, { recursive: true });
const store = new Store(home);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
const report = {
  scope:
    'Three labeled source controls through actual sandboxed FFmpeg, AST and Whisper; not an accuracy benchmark or a creative acceptance result',
  remoteModelCalled: false,
  videoAccepted: false,
  controls: [],
  deterministicRerun: false,
};
try {
  const task = await createTask(store, {
    prompt: 'Isolated sound evidence controls',
    creative: { enabled: false },
    materials: { paths: fixtures.map((item) => item.path), strategy: 'local_only' },
  });
  report.taskId = task.id;
  const runner = new TaskRunner(store, task.id, controller.signal);
  const analyzer = new AudioAnalyzer(runner.library);
  for (const fixture of fixtures) {
    const asset = await runner.library.importFile(fixture.path, 'local', {
      title: 'Misleading fixture title: Music, birds, engine, speech',
    });
    const evidence = await analyzer.analyze(asset.id, 0, asset.duration);
    const labels = evidence.windows.flatMap((window) => window.tags.map((tag) => tag.label));
    const expected = { engine: 'Engine', chirping_birds: 'Bird', speech: 'Speech' }[fixture.category];
    assert.ok(labels.includes(expected), `${fixture.category}: ${labels.join(', ')}`);
    if (fixture.category === 'speech')
      assert.match(evidence.transcript.map((word) => word.text).join(' '), /country/i);
    report.controls.push({
      category: fixture.category,
      source: fixture.source,
      path: fixture.path,
      sha256: asset.sha256,
      evidence,
    });
    await writeFile(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        category: fixture.category,
        labels: labels.slice(0, 8),
        words: evidence.transcript.length,
      }),
    );
    if (fixture.category === 'engine') {
      const key = `audio.evidence.${hash({ assetId: asset.id, sha256: asset.sha256, start: 0, end: asset.duration, version: evidence.version })}`;
      store.invalidate(task.id, [key]);
      assert.equal(store.artifact(task.id, key), undefined);
      assert.deepEqual(
        await analyzer.analyze(asset.id, 0, asset.duration),
        evidence,
        'Fresh local inference must reproduce evidence with fixed inputs and models',
      );
      report.deterministicRerun = true;
    }
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = errorInfo(error);
  process.exitCode = 1;
} finally {
  store.close();
  await writeFile(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: path.join(home, 'report.json') }));
}
