import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { type AssetLibrary, modelEnvironment, modelRoots, safeDemuxers, safeProtocols } from './assets.js';
import { projectRoot } from '../../infrastructure/src/process.js';
import { FilmError, hash, invariant } from '../../core/src/util.js';
import type { EditorialIR } from '../../core/src/domain.js';
import { speechAnalysisSchema } from './speech.js';

export const AUDIO_EVIDENCE_VERSION = 'ast-clap-whisper-v4-balanced-windows';
const segment = { start: z.number().nonnegative(), end: z.number().positive() };
export const soundAnalysisSchema = speechAnalysisSchema.extend({
  duration: z.number().positive(),
  windows: z
    .array(
      z
        .object({
          ...segment,
          rmsDb: z.number().finite(),
          peakDb: z.number().finite(),
          contentStatus: z.enum(['analyzed', 'insufficient_duration']),
          tags: z.array(z.object({ label: z.string().min(1), score: z.number().min(0).max(1) })).max(8),
          similarities: z
            .array(
              z.object({
                label: z.string().min(1),
                description: z.string().min(1),
                cosine: z.number().finite().min(-1).max(1),
              }),
            )
            .max(6),
        })
        .refine(
          (window) =>
            window.contentStatus === 'analyzed'
              ? window.tags.length > 0 && window.similarities.length > 0
              : window.tags.length === 0 && window.similarities.length === 0,
          'Insufficient sound context cannot contain invented classification results',
        ),
    )
    .min(1),
});
export type SoundAnalysis = z.infer<typeof soundAnalysisSchema>;
export type AudioEvidence = SoundAnalysis & {
  version: string;
  assetId: string;
  sha256: string;
  sourceStart: number;
  sourceEnd: number;
};

export function timelineAudioEvidence(binding: EditorialIR['audio'][number], evidence: AudioEvidence) {
  const at = <T extends { start: number; end: number }>(item: T) => ({
    ...item,
    start: binding.start + (item.start - binding.sourceStart) / binding.speed,
    end: binding.start + (item.end - binding.sourceStart) / binding.speed,
  });
  return {
    bindingId: binding.id,
    version: evidence.version,
    windows: evidence.windows.map(at),
    transcript: evidence.transcript.map(at),
    unalignedWords: evidence.unalignedWords.map((word) => ({
      ...word,
      time: binding.start + (word.time - evidence.sourceStart) / binding.speed,
    })),
  };
}

/** Evidence comes from an exact source interval, without titles, match claims or target labels. */
export class AudioAnalyzer {
  constructor(readonly library: AssetLibrary) {}

  async analyze(assetId: string, start: number, end: number): Promise<AudioEvidence> {
    const { store, taskId, policy, processes } = this.library;
    const file = await this.library.resolve(assetId);
    const asset = store.asset(taskId, assetId);
    invariant(asset.hasAudio, 'MEDIA_AUDIO', 'Asset has no audio');
    invariant(
      Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end > start &&
        end <= asset.duration + 0.001,
      'AUDIO_RANGE',
      'Audio evidence must stay inside the source interval',
    );
    end = Math.min(end, asset.duration);
    invariant(end > start, 'AUDIO_RANGE', 'Audio evidence interval must not be empty');
    invariant(
      process.env.FILMEDIT_MODEL_DIR,
      'MODEL_REQUIRED',
      '请配置本地声音模型：python/provision_models.py 模型目录 --whisper --audio',
    );
    const manifest = JSON.parse(
      await readFile(path.join(process.env.FILMEDIT_MODEL_DIR, 'manifest.json'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT')
          throw new FilmError(
            'MODEL_REQUIRED',
            '本地声音模型未初始化：python/provision_models.py 模型目录 --whisper --audio',
          );
        throw error;
      }),
    );
    invariant(
      manifest.audio?.revision && manifest.audio_text?.revision && manifest.whisper?.revision,
      'MODEL_REQUIRED',
      '声音检查需要本地 AST、CLAP 和 Whisper：python/provision_models.py 模型目录 --whisper --audio',
    );
    const version = `${AUDIO_EVIDENCE_VERSION}:${hash({ audio: manifest.audio, audioText: manifest.audio_text, whisper: manifest.whisper })}`;
    const key = `audio.evidence.${hash({ assetId, sha256: asset.sha256, start, end, version })}`;
    const cached = store.artifact<AudioEvidence>(taskId, key);
    if (cached) return cached.data;
    const folder = path.join(policy.data.workspace, 'analysis', assetId, hash({ start, end, version }));
    const output = await policy.check(path.join(folder, 'audio.wav'), 'write');
    await mkdir(folder, { recursive: true });
    await processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      ...safeProtocols,
      ...safeDemuxers,
      '-ss',
      String(start),
      '-i',
      file,
      '-t',
      String(end - start),
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      output,
    ]);
    const result = await processes.run(
      process.env.FILMEDIT_PYTHON ?? 'python3',
      [path.join(projectRoot, 'python', 'media_worker.py'), 'sound', output],
      { extraReads: modelRoots(), env: modelEnvironment(), timeoutMs: 600000 },
    );
    const analysis = soundAnalysisSchema.parse(JSON.parse(result.stdout));
    invariant(
      Math.abs(analysis.duration - (end - start)) <= 0.05,
      'AUDIO_EVIDENCE',
      'Decoded audio does not cover the selected interval',
    );
    let cursor = 0;
    for (const window of analysis.windows) {
      invariant(
        Math.abs(window.start - cursor) < 0.001 &&
          window.end > window.start &&
          window.end <= analysis.duration + 0.001,
        'AUDIO_EVIDENCE',
        'Sound evidence must cover consecutive source windows',
      );
      cursor = window.end;
    }
    invariant(
      Math.abs(cursor - analysis.duration) < 0.001 &&
        analysis.unalignedWords.every((word) => word.time <= analysis.duration + 0.05) &&
        analysis.transcript.every(
          (word) =>
            word.end > word.start && word.start < analysis.duration && word.end <= analysis.duration + 0.05,
        ),
      'AUDIO_EVIDENCE',
      'Incomplete sound evidence or out-of-range speech',
    );
    const absolute = <T extends { start: number; end: number }>(item: T): T => ({
      ...item,
      start: start + item.start,
      end: Math.min(end, start + item.end),
    });
    const evidence: AudioEvidence = {
      ...analysis,
      version,
      assetId,
      sha256: asset.sha256,
      sourceStart: start,
      sourceEnd: end,
      windows: analysis.windows.map(absolute),
      transcript: analysis.transcript.map(absolute),
      unalignedWords: analysis.unalignedWords.map((word) => ({
        ...word,
        time: Math.min(end, start + word.time),
      })),
    };
    await this.library.resolve(assetId);
    store.saveArtifact(taskId, key, evidence, true);
    return evidence;
  }
}
