import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Store } from '../dist/packages/infrastructure/src/store.js';
import { createTask, TaskRunner } from '../dist/packages/application/src/workflow.js';
import { editorialSchema } from '../dist/packages/core/src/domain.js';
import { defaultRender } from '../dist/packages/core/src/ir.js';
import { inspectVideo } from '../dist/packages/media/src/quality.js';
import assert from 'node:assert/strict';

const home = path.resolve(process.argv[2] ?? '.filmedit/verification/product-20261023/quality-v29');
await mkdir(home, { recursive: true });
const store = new Store(home);
try {
  const task = await createTask(store, {
    prompt: '技术验证：首段定格、正常运动、非计划的片尾冻结；不是创作成片',
    creative: { enabled: false },
    materials: { strategy: 'local_only' },
    output: { width: 320, height: 180, fps: 8, duration: 9 },
  });
  const runner = new TaskRunner(store, task.id);
  const source = path.join(task.policy.workspace, 'freeze-control.mp4');
  await runner.processes.run('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=8:duration=3',
    '-vf',
    'tpad=start_mode=clone:start_duration=3:stop_mode=clone:stop_duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    source,
  ]);
  const asset = await runner.library.importFile(source, 'generated');
  const editorial = editorialSchema.parse({
    schemaVersion: 1,
    revision: 0,
    duration: 9,
    shots: [
      {
        id: 'intentional',
        assetId: asset.id,
        start: 0,
        duration: 3.125,
        sourceStart: 0,
        techniques: [{ id: 'freeze', version: 1 }],
      },
      { id: 'should_play', assetId: asset.id, start: 3.125, duration: 5.875, sourceStart: 3.125 },
    ],
  });
  const quality = await inspectVideo(
    source,
    editorial,
    defaultRender(editorial, task.spec.output),
    runner.processes,
  );
  assert.ok(quality.visualAnalysis.frozenIntervals.some((r) => r.start === 0 && r.declaredFreeze));
  assert.ok(
    quality.visualAnalysis.frozenIntervals.some((r) => r.start > 5 && r.end === 9 && !r.declaredFreeze),
  );
  assert.ok(quality.issues.some((i) => i.message.startsWith('Frozen interval')));
  assert.equal(quality.passed, true);
  store.saveArtifact(task.id, 'verification.quality', quality, false);
  store.updateTask(task.id, 'paused', 'render');
  const report = {
    taskId: task.id,
    home,
    passed: true,
    quality,
    videoAccepted: false,
    aiReviewed: false,
    remoteModelCalled: false,
    purpose:
      'Controlled real-FFmpeg diagnostic of freeze detection and evidence delivery, not an authored video.',
  };
  await writeFile(path.join(home, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      taskId: task.id,
      report: path.join(home, 'report.json'),
      frozenIntervals: quality.visualAnalysis.frozenIntervals,
      videoAccepted: false,
    }),
  );
} finally {
  store.close();
}
