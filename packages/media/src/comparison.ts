import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProcessRunner } from '../../infrastructure/src/process.js';
import { invariant, id } from '../../core/src/util.js';

export type VideoSignature = {
  duration: number;
  cuts: number[];
  motion: number[];
  layout: number[][];
  luminance: number[];
};
export const COMPARISON_VERSION = 'visual-signature-v4-relative-contrast';
export async function videoSignature(file: string, runner: ProcessRunner): Promise<VideoSignature> {
  const source = await runner.policy.check(file, 'read');
  const probe = JSON.parse(
    (await runner.run('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', source])).stdout,
  );
  const duration = Number(probe.format.duration);
  invariant(
    duration > 0 && duration <= 30,
    'REFERENCE_DURATION',
    'Technique references must be 30 seconds or shorter',
  );
  const output = path.join(runner.policy.data.workspace, `${id('signature')}.gray`);
  await runner.run('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-i',
    source,
    '-vf',
    'fps=12,scale=32:32,format=gray',
    '-f',
    'rawvideo',
    output,
  ]);
  const buffer = await readFile(output);
  const frames = Math.floor(buffer.length / 1024);
  const motion: number[] = [],
    layout: number[][] = [],
    luminance: number[] = [],
    cuts: number[] = [];
  for (let f = 0; f < frames; f++) {
    let mean = 0,
      delta = 0;
    const grid = new Array<number>(16).fill(0);
    for (let p = 0; p < 1024; p++) {
      const value = buffer[f * 1024 + p]! / 255;
      mean += value;
      const cell = Math.floor(Math.floor(p / 32) / 8) * 4 + Math.floor((p % 32) / 8);
      grid[cell]! += value / 64;
      if (f) delta += Math.abs(value - buffer[(f - 1) * 1024 + p]! / 255);
    }
    mean /= 1024;
    delta /= 1024;
    luminance.push(mean);
    motion.push(delta);
    layout.push(grid.map((v) => v - mean));
    if (f > 0 && delta > 0.2) cuts.push(f / 12);
  }
  return { duration, cuts, motion, layout, luminance };
}
const sample = <T>(values: T[], t: number) =>
  values[Math.min(values.length - 1, Math.floor(t * values.length))]!;
// Compare temporal shape independently of a source's absolute brightness/contrast.
// Near-constant signals have no temporal effect; do not amplify codec noise into one.
const envelope = (values: number[]) => {
  const low = Math.min(...values),
    high = Math.max(...values);
  return values.map((value) => (high - low > 2 / 255 ? (value - low) / (high - low) : 0));
};
const spatialChange = (frames: number[][]) => {
  const contrast = Math.max(
    ...frames.map((frame) => frame.reduce((sum, value) => sum + Math.abs(value), 0) / frame.length),
  );
  // Grid deltas are proportional to the source image's contrast. Express them in
  // contrast units before noise gating, or the same fade disappears on a flatter image.
  if (contrast <= 2 / 255) return frames.map(() => 0);
  return frames.map((frame, index) =>
    index === 0
      ? 0
      : frame.reduce((sum, value, cell) => sum + Math.abs(value - frames[index - 1]![cell]!), 0) /
        frame.length /
        contrast,
  );
};
/** Bounded observations for an Agent's next hypothesis; no implementation or desired answer. */
export function signatureSummary(value: VideoSignature) {
  return {
    duration: value.duration,
    cuts: value.cuts,
    samples: Array.from({ length: 13 }, (_, i) => {
      const t = Math.min(i / 12, 1 - 1 / value.luminance.length);
      return {
        time: Number((t * value.duration).toFixed(4)),
        luminance: Number(sample(value.luminance, t).toFixed(4)),
        motion: Number(sample(value.motion, t).toFixed(4)),
      };
    }),
  };
}
export function compareSignatures(reference: VideoSignature, candidate: VideoSignature, fps = 30) {
  for (const value of [reference, candidate])
    invariant(
      Number.isFinite(value.duration) &&
        value.duration > 0 &&
        value.motion.length > 0 &&
        value.layout.length > 0 &&
        value.layout[0]!.length > 0 &&
        value.layout.every((frame) => frame.length === value.layout[0]!.length) &&
        value.luminance.length > 0 &&
        [...value.motion, ...value.layout.flat(), ...value.luminance, ...value.cuts].every(Number.isFinite),
      'REFERENCE_SIGNATURE',
      'Comparison requires non-empty finite video measurements',
    );
  const differences: number[] = [],
    spatial: number[] = [],
    light: number[] = [],
    motionEnvelope: number[] = [],
    luminanceEnvelope: number[] = [];
  const layoutEnvelope: number[] = [];
  const rm = envelope(reference.motion),
    cm = envelope(candidate.motion),
    rl = envelope(reference.luminance),
    cl = envelope(candidate.luminance),
    rs = envelope(spatialChange(reference.layout)),
    cs = envelope(spatialChange(candidate.layout));
  invariant(
    reference.layout[0]!.length === candidate.layout[0]!.length,
    'REFERENCE_SIGNATURE',
    'Comparison requires matching spatial grids',
  );
  for (let i = 0; i < 60; i++) {
    const t = i / 60;
    differences.push(Math.abs(sample(reference.motion, t) - sample(candidate.motion, t)));
    const a = sample(reference.layout, t),
      b = sample(candidate.layout, t);
    spatial.push(a.reduce((sum, v, j) => sum + Math.abs(v - b[j]!), 0) / a.length);
    light.push(Math.abs(sample(reference.luminance, t) - sample(candidate.luminance, t)));
    motionEnvelope.push(Math.abs(sample(rm, t) - sample(cm, t)));
    luminanceEnvelope.push(Math.abs(sample(rl, t) - sample(cl, t)));
    layoutEnvelope.push(Math.abs(sample(rs, t) - sample(cs, t)));
  }
  const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const cutErrors = reference.cuts.map((t) =>
    candidate.cuts.length ? Math.min(...candidate.cuts.map((c) => Math.abs(c - t))) : reference.duration,
  );
  const timing = Math.min(
    1,
    Math.abs(reference.duration - candidate.duration) / reference.duration +
      average(cutErrors) / reference.duration +
      Math.abs(reference.cuts.length - candidate.cuts.length) / Math.max(1, reference.cuts.length),
  );
  const metrics = {
    timing,
    motion: Math.min(1, average(differences) * 3),
    layout: Math.min(1, average(spatial) * 2),
    transition: Math.min(1, average(light) * 2),
    motionEnvelope: average(motionEnvelope),
    luminanceEnvelope: average(luminanceEnvelope),
    layoutEnvelope: average(layoutEnvelope),
  };
  // Training and held-out sources have different pixels by design. Absolute spatial/luma
  // differences remain diagnostics; acceptance compares the temporal mechanism only.
  // Independent visual review still checks geometry and meaning this baseline cannot measure.
  const distance = Math.max(
    metrics.timing,
    metrics.motionEnvelope,
    metrics.luminanceEnvelope,
    metrics.layoutEnvelope,
  );
  const hardPassed =
    Math.abs(reference.duration - candidate.duration) <= 2 / fps &&
    cutErrors.every((e) => e <= 2 / fps) &&
    reference.cuts.length === candidate.cuts.length;
  return {
    version: COMPARISON_VERSION,
    distance,
    metrics,
    hardPassed,
    passed: hardPassed && distance < 0.15,
  };
}
