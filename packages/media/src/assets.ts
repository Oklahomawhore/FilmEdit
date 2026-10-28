import { speechAnalysisSchema } from './speech.js';
import { readdir, stat, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { assetSchema, type Asset } from '../../core/src/domain.js';
import { PathPolicy } from '../../infrastructure/src/security.js';
import { ProcessRunner, projectRoot } from '../../infrastructure/src/process.js';
import { Store } from '../../infrastructure/src/store.js';
import { id, invariant, FilmError } from '../../core/src/util.js';
import { fileHash } from '../../infrastructure/src/files.js';
import { extractJpeg, reviewFrameTimes } from './media-frames.js';

const extensions = new Map<string, Asset['kind']>([
  ...['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.gif'].map((e) => [e, 'video'] as const),
  ...['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.aac'].map((e) => [e, 'audio'] as const),
  ...['.jpg', '.jpeg', '.png', '.webp', '.bmp'].map((e) => [e, 'image'] as const),
  ...['.srt', '.vtt'].map((e) => [e, 'subtitle'] as const),
]);
export const mediaKind = (file: string) => extensions.get(path.extname(file).toLowerCase());
export const safeProtocols = ['-protocol_whitelist', 'file,pipe'];
// Restrict demuxers as well as protocols: a local playlist must not read a second file.
export const safeDemuxers = [
  '-format_whitelist',
  'mov,matroska,webm,gif,wav,mp3,flac,ogg,aac,image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,webp',
];
// Extensions discover supported files; actual streams determine their indexed kind.
export async function probeMedia(input: string, runner: ProcessRunner) {
  const file = await runner.policy.check(input, 'read');
  const hint = mediaKind(file);
  invariant(hint && hint !== 'subtitle', 'MEDIA_FORMAT', `Unsupported media: ${file}`);
  const result = await runner.run('ffprobe', [
    '-v',
    'error',
    ...safeProtocols,
    ...safeDemuxers,
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    file,
  ]);
  type Stream = {
    codec_type: string;
    width?: number;
    height?: number;
    duration?: string;
    avg_frame_rate?: string;
    disposition?: { attached_pic?: number };
  };
  const probe = JSON.parse(result.stdout) as { streams: Stream[]; format: { duration?: string } };
  const video = probe.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  invariant(video || audio, 'MEDIA_STREAMS', `No usable video or audio stream: ${file}`);
  const duration = Number(probe.format.duration ?? video?.duration ?? audio?.duration ?? 0);
  const still = hint === 'image' && !(path.extname(file).toLowerCase() === '.webp' && duration > 0);
  const kind: Asset['kind'] = video ? (still ? 'image' : 'video') : 'audio';
  invariant(
    kind === 'image' || (Number.isFinite(duration) && duration > 0),
    'MEDIA_DURATION',
    `Cannot determine duration: ${file}`,
  );
  return {
    kind,
    duration: kind === 'image' ? 0 : duration,
    width: video?.width,
    height: video?.height,
    hasAudio: !!audio,
    frameRate: video?.avg_frame_rate,
  };
}
export class AssetLibrary {
  constructor(
    readonly store: Store,
    readonly taskId: string,
    readonly policy: PathPolicy,
    readonly processes: ProcessRunner,
  ) {}
  async importPaths(paths: string[]): Promise<Asset[]> {
    const files: string[] = [];
    const visit = async (file: string) => {
      await this.policy.check(file, 'read');
      if (await this.policy.isSymlink(file)) return;
      const info = await stat(file);
      if (info.isDirectory()) {
        for (const child of (await readdir(file)).sort()) {
          try {
            await visit(path.join(file, child));
          } catch (e) {
            if (!(e instanceof FilmError && e.code === 'PATH_DENIED')) throw e;
          }
        }
      } else if (info.isFile() && mediaKind(file)) files.push(file);
      invariant(files.length <= 1000, 'MATERIAL_LIMIT', 'Select at most 1000 material files per task');
    };
    for (const file of paths) await visit(file);
    const result = [];
    for (const file of files) result.push(await this.importFile(file, 'local'));
    return result;
  }
  async importFile(
    input: string,
    source: Asset['source']['kind'],
    metadata: Partial<Asset['source']> = {},
    expectedKind?: 'video' | 'audio',
  ): Promise<Asset> {
    const file = await this.policy.check(input, 'read');
    let kind = mediaKind(file);
    invariant(kind, 'MEDIA_FORMAT', `Unsupported media: ${file}`);
    const sha256 = await fileHash(file);
    const size = (await stat(file)).size;
    const existing = this.store
      .assets(this.taskId)
      .find((a) => a.source.path === file && a.sha256 === sha256);
    if (existing) {
      await this.resolve(existing.id);
      invariant(
        !expectedKind || existing.kind === expectedKind,
        'MEDIA_KIND',
        `Expected ${expectedKind}, got ${existing.kind}`,
      );
      return existing;
    }
    let duration = 0,
      width: number | undefined,
      height: number | undefined,
      hasAudio = false;
    let transcript: Asset['transcript'] = [];
    if (kind === 'subtitle') {
      transcript = parseSubtitles((await this.policy.read(file)).toString());
      duration = transcript.at(-1)?.end ?? 0;
    } else {
      ({ kind, duration, width, height, hasAudio } = await probeMedia(file, this.processes));
    }
    invariant(!expectedKind || kind === expectedKind, 'MEDIA_KIND', `Expected ${expectedKind}, got ${kind}`);
    const asset = assetSchema.parse({
      id: id('asset'),
      taskId: this.taskId,
      source: { ...metadata, kind: source, path: file },
      sha256,
      size,
      kind,
      duration,
      width,
      height,
      hasAudio,
      transcript,
      policyVersion: this.policy.data.version,
    });
    this.store.saveAsset(asset);
    this.store.event(this.taskId, 'asset.imported', { id: asset.id, kind, sha256 });
    return asset;
  }
  async resolve(assetId: string): Promise<string> {
    const seen = new Set<string>();
    const resolve = async (value: string): Promise<string> => {
      invariant(!seen.has(value), 'ASSET_CYCLE', 'Cyclic source lineage');
      seen.add(value);
      const asset = this.store.asset(this.taskId, value);
      if (asset.source.parentAssetId) await resolve(asset.source.parentAssetId);
      const file = await this.policy.check(asset.source.path, 'read');
      invariant(
        (await fileHash(file)) === asset.sha256,
        'ASSET_CHANGED',
        `Material changed since indexing: ${asset.source.path}`,
      );
      return file;
    };
    return resolve(assetId);
  }
  async snapshot(assetId: string, destination: string): Promise<string> {
    const source = await this.resolve(assetId);
    const output = await this.policy.check(destination, 'write');
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(source, output);
    invariant(
      (await fileHash(output)) === this.store.asset(this.taskId, assetId).sha256,
      'ASSET_CHANGED',
      'Material changed during snapshot',
    );
    return output;
  }
  async frames(assetId: string, times?: number[]) {
    const asset = this.store.asset(this.taskId, assetId);
    const file = await this.resolve(assetId);
    invariant(asset.kind === 'video' || asset.kind === 'image', 'MEDIA_KIND', 'Frames require visual media');
    let requested =
      times ??
      (asset.kind === 'image'
        ? [0]
        : [
            0,
            asset.duration / 4,
            asset.duration / 2,
            (3 * asset.duration) / 4,
            Math.max(0, asset.duration - 0.1),
          ]);
    invariant(
      requested.every(
        (time) => Number.isFinite(time) && time >= 0 && (asset.kind === 'image' || time < asset.duration),
      ),
      'FRAME_RANGE',
      'Frame time is outside source',
    );
    if (asset.kind === 'video') {
      const metadata = JSON.parse(
        (
          await this.processes.run('ffprobe', [
            '-v',
            'error',
            ...safeProtocols,
            ...safeDemuxers,
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=avg_frame_rate,duration',
            '-of',
            'json',
            file,
          ])
        ).stdout,
      ).streams[0];
      requested = reviewFrameTimes(
        requested,
        Number(metadata.duration ?? asset.duration),
        metadata.avg_frame_rate,
      );
    }
    const frames = [];
    for (const time of requested) {
      invariant(
        time >= 0 && (asset.kind === 'image' || time < asset.duration),
        'FRAME_RANGE',
        'Frame time is outside source',
      );
      const output = path.join(this.policy.data.workspace, 'analysis', assetId, `${time.toFixed(3)}.jpg`);
      await extractJpeg(this.processes, file, output, {
        inputArgs: [...safeProtocols, ...safeDemuxers],
        time: asset.kind === 'video' ? time : undefined,
      });
      frames.push({ time, path: output });
    }
    asset.frames = [
      ...asset.frames.filter((f) => !requested.some((t) => Math.abs(t - f.time) < 0.001)),
      ...frames,
    ].sort((a, b) => a.time - b.time);
    this.store.saveAsset(asset);
    return frames;
  }
  async analyzeAudio(assetId: string, kind: 'asr' | 'beats') {
    const asset = this.store.asset(this.taskId, assetId);
    const source = await this.resolve(assetId);
    invariant(asset.hasAudio, 'MEDIA_AUDIO', 'Asset has no audio');
    const cached = kind === 'asr' ? asset.transcript : asset.beats;
    // Re-reading ASR pages must not decode and transcribe an entire source again.
    // Empty results also count as completed analysis; source hash is checked above.
    if (cached.length || asset.analyzed?.[kind]) return cached;
    const audio = path.join(this.policy.data.workspace, 'analysis', assetId, 'audio.wav');
    await this.policy.check(audio, 'write');
    await mkdir(path.dirname(audio), { recursive: true });
    await this.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      ...safeProtocols,
      ...safeDemuxers,
      '-i',
      source,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      audio,
    ]);
    const result = await this.processes.run(
      process.env.FILMEDIT_PYTHON ?? 'python3',
      [path.join(projectRoot, 'python', 'media_worker.py'), kind, audio],
      { extraReads: modelRoots(), env: modelEnvironment(), timeoutMs: 600000 },
    );
    if (kind === 'asr') {
      const analysis = speechAnalysisSchema.parse(JSON.parse(result.stdout));
      this.store.saveArtifact(
        this.taskId,
        `analysis.asr.${asset.id}`,
        { sha256: asset.sha256, ...analysis },
        true,
      );
      asset.transcript = analysis.transcript;
    } else asset.beats = JSON.parse(result.stdout);
    asset.analyzed = { ...asset.analyzed, [kind]: true };
    this.store.saveAsset(asset);
    return kind === 'asr' ? asset.transcript : asset.beats;
  }
  async searchWeb(query: string, limit = 5, provider: 'youtube' | 'bilibili' = 'youtube') {
    invariant(
      this.store.task(this.taskId).spec.materials.strategy !== 'local_only',
      'SOURCE_POLICY',
      'Network material search is disabled for local_only tasks',
    );
    const result = await this.processes.run(
      'yt-dlp',
      [
        '--ignore-config',
        '--no-cache-dir',
        '--flat-playlist',
        '--dump-json',
        '--skip-download',
        '--socket-timeout',
        '20',
        '--extractor-retries',
        '1',
        '--retries',
        '1',
        `${provider === 'youtube' ? 'ytsearch' : 'bilisearch'}${Math.min(limit, 10)}:${query}`,
      ],
      { domains: ['*'] },
    );
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const item = JSON.parse(line);
        const url = new URL(item.webpage_url ?? item.url);
        // yt-dlp's Bilibili search emits HTTP links, while the platform supports HTTPS.
        if (
          url.protocol === 'http:' &&
          (url.hostname === 'www.bilibili.com' || url.hostname === 'www.youtube.com')
        )
          url.protocol = 'https:';
        invariant(url.protocol === 'https:', 'URL_PROTOCOL', 'Search result must use HTTPS');
        return { provider, url: url.href, title: item.title, duration: item.duration, id: item.id };
      });
  }
  async download(url: string, kind: 'video' | 'audio'): Promise<Asset> {
    invariant(kind === 'video' || kind === 'audio', 'MEDIA_KIND', 'Choose video or audio for download');
    invariant(
      this.store.task(this.taskId).spec.materials.strategy !== 'local_only',
      'SOURCE_POLICY',
      'Network download is disabled for local_only tasks',
    );
    const parsed = new URL(url);
    invariant(parsed.protocol === 'https:', 'URL_PROTOCOL', 'Material URLs must use HTTPS');
    const folder = path.join(this.policy.data.workspace, 'downloads', id('download'));
    await this.policy.check(folder, 'write');
    await mkdir(folder, { recursive: true });
    const result = await this.processes.run(
      'yt-dlp',
      [
        '--ignore-config',
        '--no-cache-dir',
        '--no-playlist',
        '--restrict-filenames',
        '--max-filesize',
        '1G',
        ...(kind === 'audio'
          ? ['-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'best']
          : // Generic HTTPS files often have no resolution metadata before download.
            // Keep known formats <=1080p; probe actual streams before indexing unknown ones.
            [
              '--merge-output-format',
              'mp4',
              '-f',
              'bv*[height<=?1080]+ba/b[height<=?1080]/bv[height<=?1080]',
            ]),
        '-o',
        path.join(folder, 'source.%(ext)s'),
        '--print',
        'after_move:filepath',
        '--',
        url,
      ],
      { domains: ['*'], timeoutMs: 900000 },
    );
    const output = result.stdout.trim().split('\n').at(-1)!;
    invariant(
      output,
      'DOWNLOAD_EMPTY',
      '下载器没有产出媒体文件，可能因大小限制或源站条件被跳过；尚未导入素材，请检查下载记录或选择其它公开版本。',
    );
    return this.importFile(output, 'web', { url }, kind);
  }
}
export function parseSubtitles(text: string): Asset['transcript'] {
  const result: Asset['transcript'] = [];
  const clock = (value: string) =>
    value
      .replace(',', '.')
      .split(':')
      .reduce((acc, n) => acc * 60 + Number(n), 0);
  for (const block of text.replaceAll('\r', '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const index = lines.findIndex((l) => l.includes('-->'));
    if (index < 0) continue;
    const match = lines[index]!.match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!match) continue;
    const start = clock(match[1]!);
    const end = clock(match[2]!);
    invariant(Number.isFinite(start) && end > start, 'SUBTITLE_TIME', 'Invalid subtitle timestamp');
    result.push({
      start,
      end,
      text: lines
        .slice(index + 1)
        .join('\n')
        .replace(/<[^>]*>/g, ''),
    });
  }
  return result.sort((a, b) => a.start - b.start);
}
export function modelRoots() {
  return process.env.FILMEDIT_MODEL_DIR ? [path.resolve(process.env.FILMEDIT_MODEL_DIR)] : [];
}
export function modelEnvironment() {
  return {
    FILMEDIT_MODEL_DIR: process.env.FILMEDIT_MODEL_DIR,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    TOKENIZERS_PARALLELISM: 'false',
    PYTHONHASHSEED: '0',
  };
}
