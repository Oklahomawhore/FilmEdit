import { createRenderJob, executeRenderJob } from '@hyperframes/producer';
import { preflight } from '../../../packages/media/src/render-preflight.js';
const [directory, output, fps, mode] = process.argv.slice(2);
if (!directory || !output || !fps) throw new Error('render-worker requires project, output and fps');
await preflight(directory);
const job = createRenderJob({
  fps: Number(fps),
  quality: mode === 'preview' ? 'draft' : 'standard',
  format: 'mp4',
  entryFile: 'index.html',
});
await executeRenderJob(job, directory, output, (_job, message) => {
  process.stderr.write(`${message}\n`);
});
process.stdout.write(JSON.stringify({ output }));
