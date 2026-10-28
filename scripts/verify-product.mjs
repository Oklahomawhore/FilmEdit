// Explicit real-model acceptance run. Isolated from the user's production task queue.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadProjectEnv } from '../dist/packages/infrastructure/src/model-provider.js';
import { Store } from '../dist/packages/infrastructure/src/store.js';
import { createTask, TaskRunner } from '../dist/packages/application/src/workflow.js';
import { errorInfo } from '../dist/packages/core/src/util.js';
import { hash } from '../dist/packages/core/src/util.js';

await loadProjectEnv();
const scenario = process.argv[2] ?? 'a1';
if (!['a1', 'a4', 'a4b', 'a4c'].includes(scenario))
  throw new Error(
    'Choose a1 (web), a4 (full-car composition), a4b (fixed narration/source-frame preservation), or a4c (same A4b input, independent creative sample)',
  );
const local = scenario !== 'a1';
const home = path.resolve(`.filmedit/verification/product-20261023/real-${scenario}`);
const store = new Store(home);
let task = store.tasks()[0];
const localMaterial = process.argv[3];
if (!task && scenario === 'a4c') {
  const previous = new Store(path.resolve('.filmedit/verification/product-20261023/real-a4b'));
  try {
    const parent = previous.tasks()[0];
    if (!parent) throw new Error('Original A4b sample is required; do not substitute a simpler prompt');
    task = await createTask(store, {
      ...parent.spec,
      creative: { ...parent.spec.creative, seed: 'a4c-independent-sample' },
    });
    store.saveArtifact(
      task.id,
      'verification.origin',
      {
        taskId: parent.id,
        reason:
          'A4/A10: independently sample the same user input after the prior concept had a verified material gap. Preserve the failed sample and all fixed requirements.',
        originalSpecHash: hash(parent.spec),
        originalPrompt: parent.spec.prompt,
        originalStatus: parent.status,
        originalStage: parent.stage,
        changedFields: ['creative.seed'],
        videoAccepted: false,
      },
      true,
    );
  } finally {
    previous.close();
  }
}
if (!task && local && !localMaterial)
  throw new Error('Local acceptance requires the selected video path as the third argument');
if (!task)
  task = await createTask(store, {
    prompt:
      scenario === 'a4b'
        ? '做一条18秒奥迪霍希A8L横屏短片，使用提供的展厅试车视频。素材主要是车身局部和座舱细节，没有行驶镜头；允许使用原有特写和半车身构图，不要求每镜整车入画。布局与导出完整保留所选源画面，不额外裁切。以下旁白必须一字不改：“同一辆车，可以有两种节奏。先看它的线条，再看它留给乘客的空间。让镜头慢下来，细节才会被看见。”画面和剪辑方式自由发挥，用镜头顺序和节奏变化回应旁白，不要纯顺播。只用这段旁白，不要音乐、源视频声音或额外音效，不加字幕。仅用本地素材。'
        : scenario === 'a4'
          ? '做一条18秒的奥迪霍希A8L横屏短片，仅使用我提供的本地视频，保持完整车身与座舱构图，不要裁掉主体。以下旁白必须一字不改：“同一辆车，可以有两种节奏。先看它的线条，再看它留给乘客的空间。让镜头慢下来，细节才会被看见。”画面和剪辑方式自由发挥，要用实际镜头与节奏回应旁白，不要纯顺播。只使用这段旁白，不要背景音乐、原视频人声或另外的音效，不加字幕。'
          : '制作一条关于保时捷的15秒横屏汽车短片。主题已确定，内容和表达你发挥。不要旁白，不要文字解释，用真实汽车画面形成一个观众能看懂的创意。允许网络搜索和下载素材。不要生成画面，不要用纯字卡替代实拍。',
    materials: local
      ? { paths: [path.resolve(localMaterial)], strategy: 'local_only' }
      : { paths: [], strategy: 'web_first' },
    ...(local ? { creative: { knowledge: 'local' } } : {}),
    composition: { aspectRatio: '16:9', width: 640, height: 360, fps: 12 },
    output: { width: 640, height: 360, fps: 12, duration: local ? 18 : 15 },
  });
console.log(JSON.stringify({ taskId: task.id, home, status: task.status, stage: task.stage }));
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
const runner = new TaskRunner(store, task.id, controller.signal);
try {
  const result = await runner.run();
  console.log(
    JSON.stringify({ taskId: result.id, status: result.status, stage: result.stage, cost: result.cost }),
  );
} catch (error) {
  console.log(JSON.stringify({ taskId: task.id, error: errorInfo(error) }));
  process.exitCode = 1;
} finally {
  await runner.flushArtifacts();
  await writeFile(
    path.join(home, 'acceptance-status.json'),
    JSON.stringify(
      {
        task: store.task(task.id),
        artifacts: store.db
          .prepare('SELECT id,stage,revision,accepted,hash FROM artifacts WHERE task_id=? ORDER BY rowid')
          .all(task.id),
      },
      null,
      2,
    ),
  );
  store.close();
}
