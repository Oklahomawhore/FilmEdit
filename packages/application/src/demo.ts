import path from 'node:path';
import { Store } from '../../infrastructure/src/store.js';
import { createTask } from './workflow.js';
import { PathPolicy } from '../../infrastructure/src/security.js';
import { ProcessRunner } from '../../infrastructure/src/process.js';
import { AssetLibrary } from '../../media/src/assets.js';
import { editorialSchema } from '../../core/src/domain.js';
import { defaultRender, validateEditorial } from '../../core/src/ir.js';
import { Renderer } from '../../media/src/render.js';
import { inspectVideo } from '../../media/src/quality.js';

/** Explicit deterministic render demo, never represented as an AI-reviewed task. */
export async function demo(store: Store) {
  const task = await createTask(store, {
    prompt: '本地渲染演示',
    materials: { strategy: 'local_only' },
    output: { width: 360, height: 640, fps: 12, duration: 4 },
  });
  const policy = new PathPolicy(task.policy);
  const runner = new ProcessRunner(policy);
  const library = new AssetLibrary(store, task.id, policy, runner);
  const video = path.join(policy.data.workspace, 'test-source.mp4');
  await runner.run('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=360x640:rate=12:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    video,
  ]);
  const asset = await library.importFile(video, 'generated');
  const editorial = validateEditorial(
    editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration: 4,
      shots: [
        { id: 'shot_1', assetId: asset.id, sourceStart: 0, start: 0, duration: 2.5 },
        { id: 'shot_2', assetId: asset.id, sourceStart: 2, start: 2, duration: 2 },
      ],
      transitions: [{ from: 'shot_1', to: 'shot_2', kind: 'fade', duration: 0.5 }],
      audio: [
        {
          id: 'sound_1',
          assetId: asset.id,
          role: 'music',
          sourceStart: 0,
          start: 0,
          duration: 4,
          volume: 0.2,
        },
      ],
      text: [{ id: 'title_1', text: '双层 IR · 本地素材', start: 0, duration: 4, role: 'title' }],
    }),
    [asset],
  );
  const render = defaultRender(editorial, task.spec.output);
  for (const node of render.nodes) if (node.style) node.style.fontSize = 24;
  const result = await new Renderer(library, runner).render(editorial, render);
  const quality = await inspectVideo(result.path, editorial, render, runner);
  store.saveArtifact(task.id, 'demo.editorial', editorial, true);
  store.saveArtifact(task.id, 'demo.layout', render, true);
  store.saveArtifact(task.id, 'demo.render', result, quality.passed);
  store.saveArtifact(task.id, 'demo.quality', quality, quality.passed);
  return { taskId: task.id, ...result, quality, aiReviewed: false };
}
