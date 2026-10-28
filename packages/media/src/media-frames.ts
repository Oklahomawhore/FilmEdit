import path from 'node:path';
import { mkdir, rm, stat } from 'node:fs/promises';
import { ProcessRunner } from '../../infrastructure/src/process.js';
import { FilmError, invariant } from '../../core/src/util.js';

/** Convert pixel values as well as metadata: JPEG requires full-range YUV. */
export async function extractJpeg(
  runner: ProcessRunner,
  source: string,
  output: string,
  options: { time?: number; inputArgs?: string[] } = {},
): Promise<void> {
  await runner.policy.check(source, 'read');
  await runner.policy.check(output, 'write');
  await mkdir(path.dirname(output), { recursive: true });
  // A successful FFmpeg exit can still produce no frame when seeking past the last PTS.
  // Remove previous output so it cannot mask an empty extraction on a retry.
  await rm(output, { force: true });
  await runner.run('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    ...(options.inputArgs ?? []),
    ...(options.time === undefined ? [] : ['-ss', String(Math.max(0, options.time - 0.000001))]),
    '-i',
    source,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(960,iw)':-2:out_range=full,format=yuvj420p",
    '-c:v',
    'mjpeg',
    '-color_range',
    'pc',
    output,
  ]);
  const info = await stat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info?.isFile() || info.size === 0)
    throw new FilmError('FRAME_EMPTY', 'FFmpeg produced no image at the requested time', {
      time: options.time,
    });
}

/** Sample the actual encoded CFR timeline, including the final available frame. */
export function reviewFrameTimes(requested: number[], duration: number, frameRate: string): number[] {
  const [numerator, denominator = '1'] = frameRate.split('/');
  const fps = Number(numerator) / Number(denominator);
  invariant(Number.isFinite(fps) && fps > 0, 'MEDIA_FRAME_RATE', 'Video has no valid frame rate');
  invariant(Number.isFinite(duration) && duration > 0, 'MEDIA_DURATION', 'Video has no valid duration');
  const last = Math.max(0, Math.ceil(duration * fps - 0.000001) - 1);
  return [...new Set(requested.map((time) => Math.max(0, Math.min(last, Math.floor(time * fps + 0.000001)))))]
    .sort((a, b) => a - b)
    .map((index) => index / fps);
}
