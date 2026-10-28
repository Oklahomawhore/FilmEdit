import path from 'node:path';
import type { ExportProfile } from '../../core/src/presentation.js';
import { mkdir } from 'node:fs/promises';
import type { EditorialIR, RenderIR } from '../../core/src/domain.js';
import { ProcessRunner } from '../../infrastructure/src/process.js';
import { extractJpeg, reviewFrameTimes } from './media-frames.js';

export const QUALITY_VERSION = 'media-quality-v2';
type Interval = { start: number; end: number };
type FrozenInterval = Interval & { declaredFreeze: boolean };

/** The detector reports still pixels, not an artistic judgement or the cause of a playback stall. */
export function frozenIntervals(stderr: string, editorial: EditorialIR): FrozenInterval[] {
  const detected: Interval[] = [];
  let start: number | undefined;
  for (const event of stderr.matchAll(/freeze_(start|end):\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi)) {
    const time = Math.max(0, Math.min(editorial.duration, Number(event[2])));
    if (event[1]!.toLowerCase() === 'start') start = time;
    else if (start !== undefined) {
      if (time > start) detected.push({ start, end: time });
      start = undefined;
    }
  }
  // FFmpeg does not emit freeze_end when the interval continues through EOF.
  if (start !== undefined && start < editorial.duration) detected.push({ start, end: editorial.duration });
  const result: FrozenInterval[] = [];
  for (const interval of detected) {
    const boundaries = [
      ...new Set([
        interval.start,
        interval.end,
        ...editorial.shots
          .flatMap((shot) => [shot.start, shot.start + shot.duration])
          .filter((time) => time > interval.start && time < interval.end),
      ]),
    ].sort((a, b) => a - b);
    for (let i = 1; i < boundaries.length; i++) {
      const a = boundaries[i - 1]!,
        b = boundaries[i]!,
        middle = (a + b) / 2;
      const active = editorial.shots.filter(
        (shot) => shot.start <= middle && shot.start + shot.duration > middle,
      );
      const declaredFreeze =
        active.length > 0 && active.every((shot) => shot.techniques.some((t) => t.id === 'freeze'));
      const previous = result.at(-1);
      if (previous && previous.declaredFreeze === declaredFreeze && Math.abs(previous.end - a) < 1e-6)
        previous.end = b;
      else result.push({ start: a, end: b, declaredFreeze });
    }
  }
  return result;
}

export type QualityReport = {
  passed: boolean;
  issues: { severity: 'blocking' | 'warning'; message: string }[];
  frames: { time: number; path: string }[];
  continuousClips: { start: number; duration: number; path: string }[];
  visualAnalysis: { version: string; frozenIntervals: FrozenInterval[]; blackIntervals: Interval[] };
  audioAnalysis?: { peakDb: number; rmsDb: number; silentIntervals: { start: number; end: number }[] };
  source: { path: string; duration: number; fps: number };
  metadata: unknown;
};
export async function inspectVideo(
  file: string,
  editorial: EditorialIR,
  render: RenderIR,
  runner: ProcessRunner,
  preview = false,
  output: Pick<ExportProfile, 'width' | 'height' | 'fps'> = render.canvas,
): Promise<QualityReport> {
  await runner.policy.check(file, 'read');
  const probe = await runner.run('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    file,
  ]);
  const metadata = JSON.parse(probe.stdout);
  const video = metadata.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const audio = metadata.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const issues: QualityReport['issues'] = [];
  if (!video) issues.push({ severity: 'blocking', message: 'No video stream' });
  if (Math.abs(Number(metadata.format.duration) - editorial.duration) > 0.15)
    issues.push({ severity: 'blocking', message: 'Rendered duration differs from EditorialIR' });
  if (!preview && video && (video.width !== output.width || video.height !== output.height))
    issues.push({ severity: 'blocking', message: 'Rendered dimensions differ from ExportProfile' });
  if (
    !preview &&
    video &&
    Math.abs(
      Number(video.avg_frame_rate.split('/')[0]) / Number(video.avg_frame_rate.split('/')[1]) - output.fps,
    ) > 0.01
  )
    issues.push({ severity: 'blocking', message: 'Rendered frame rate differs from ExportProfile' });
  if (editorial.audio.length && !audio)
    issues.push({ severity: 'blocking', message: 'Declared audio is missing' });
  if (audio && Math.abs(Number(audio.duration) - editorial.duration) > 0.2)
    issues.push({ severity: 'blocking', message: 'Audio/video duration mismatch' });
  const scan = await runner.run(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'info',
      '-i',
      file,
      '-vf',
      'blackdetect=d=0.2:pix_th=0.1,freezedetect=n=-50dB:d=2',
      '-an',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 900000 },
  );
  const black = [...scan.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)];
  const visualAnalysis: QualityReport['visualAnalysis'] = {
    version: QUALITY_VERSION,
    frozenIntervals: frozenIntervals(scan.stderr, editorial),
    blackIntervals: black.map((b) => ({ start: Number(b[1]), end: Number(b[2]) })),
  };
  for (const b of black)
    issues.push({
      severity: Number(b[3]) > editorial.duration * 0.8 ? 'blocking' : 'warning',
      message: `Black interval ${b[1]}–${b[2]} seconds; review against intended cuts`,
    });
  for (const interval of visualAnalysis.frozenIntervals.filter((range) => !range.declaredFreeze))
    issues.push({
      severity: 'warning',
      message: `Frozen interval ${interval.start}–${interval.end} seconds without a declared full-picture freeze; inspect actual motion. Still images or intentionally static shots may be valid.`,
    });
  let audioAnalysis: QualityReport['audioAnalysis'];
  if (audio) {
    const analysis = await runner.run(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'info',
        '-i',
        file,
        '-vn',
        '-af',
        'astats=metadata=0:reset=0,silencedetect=noise=-50dB:d=0.3',
        '-f',
        'null',
        '-',
      ],
      { timeoutMs: 900000 },
    );
    const readDb = (label: string) => {
      const value = [...analysis.stderr.matchAll(new RegExp(`${label}: ([^\\s]+)`, 'g'))].at(-1)?.[1];
      return value === '-inf' ? -200 : Number(value);
    };
    const silentIntervals: { start: number; end: number }[] = [];
    let start: number | undefined;
    for (const event of analysis.stderr.matchAll(/silence_(start|end): ([\d.]+)/g)) {
      if (event[1] === 'start') start = Number(event[2]);
      else if (start !== undefined) {
        silentIntervals.push({ start, end: Number(event[2]) });
        start = undefined;
      }
    }
    if (start !== undefined) silentIntervals.push({ start, end: editorial.duration });
    audioAnalysis = { peakDb: readDb('Peak level dB'), rmsDb: readDb('RMS level dB'), silentIntervals };
    if (!Number.isFinite(audioAnalysis.peakDb) || !Number.isFinite(audioAnalysis.rmsDb))
      issues.push({ severity: 'blocking', message: 'Could not measure the rendered audio signal' });
    else if (audioAnalysis.peakDb < -60 && editorial.audio.some((a) => a.volume > 0))
      issues.push({
        severity: 'blocking',
        message: 'Rendered audio is effectively silent despite audible tracks',
      });
    for (const interval of silentIntervals) {
      if (
        editorial.audio.some(
          (a) =>
            ['narration', 'dialogue'].includes(a.role) &&
            Math.min(a.start + a.duration, interval.end) - Math.max(a.start, interval.start) > 0.8,
        )
      )
        issues.push({
          severity: 'warning',
          message: `Silence overlaps declared speech at ${interval.start}–${interval.end}s; check the rendered transcript`,
        });
    }
  }
  const directory = path.join(path.dirname(file), preview ? 'preview-qa' : 'final-qa');
  await mkdir(directory, { recursive: true });
  const times = new Set<number>([0, Math.max(0, editorial.duration - 1 / render.canvas.fps)]);
  for (const shot of editorial.shots)
    for (const t of [
      shot.start,
      shot.start + shot.duration / 2,
      shot.start + shot.duration - 1 / render.canvas.fps,
    ])
      times.add(Math.max(0, Math.min(editorial.duration - 0.01, t)));
  for (const t of editorial.transitions) {
    const shot = editorial.shots.find((s) => s.id === t.to)!;
    times.add(shot.start + t.duration / 2);
  }
  for (const interval of visualAnalysis.frozenIntervals) {
    times.add(Math.max(0, interval.start - 0.25));
    times.add((interval.start + interval.end) / 2);
    times.add(Math.min(editorial.duration - 0.01, interval.end));
  }
  const frames: QualityReport['frames'] = [];
  const frameTimes = reviewFrameTimes(
    [...times],
    Number(video?.duration ?? metadata.format.duration),
    video?.avg_frame_rate ?? '',
  );
  for (const time of frameTimes.slice(0, 120)) {
    const output = path.join(directory, `${time.toFixed(3)}.jpg`);
    await extractJpeg(runner, file, output, { time });
    frames.push({ time, path: output });
  }
  const continuousClips: QualityReport['continuousClips'] = [];
  for (const start of [
    ...new Set([
      ...Array.from({ length: Math.ceil(editorial.duration / 3) }, (_, i) => i * 3),
      ...editorial.shots.filter((s) => s.start > 0).map((s) => Math.max(0, s.start - 0.5)),
      ...visualAnalysis.frozenIntervals.flatMap((s) => [
        Math.max(0, s.start - 0.5),
        Math.max(0, s.end - 0.5),
      ]),
    ]),
  ].sort((a, b) => a - b)) {
    const duration = Math.min(3, editorial.duration - start);
    const output = path.join(directory, `clip-${start.toFixed(3)}.mp4`);
    await runner.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-ss',
      String(start),
      '-i',
      file,
      '-t',
      String(duration),
      '-vf',
      'scale=320:-2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      output,
    ]);
    continuousClips.push({ start, duration, path: output });
  }
  return {
    passed: !issues.some((i) => i.severity === 'blocking'),
    issues,
    frames,
    continuousClips,
    visualAnalysis,
    audioAnalysis,
    source: {
      path: file,
      duration: Number(video?.duration ?? metadata.format.duration),
      fps: Number(video?.avg_frame_rate.split('/')[0]) / Number(video?.avg_frame_rate.split('/')[1]),
    },
    metadata,
  };
}
