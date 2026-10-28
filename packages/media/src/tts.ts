import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import { AssetLibrary, modelEnvironment } from './assets.js';
import { projectRoot } from '../../infrastructure/src/process.js';
import { hash, invariant } from '../../core/src/util.js';

export function localTtsConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const model =
    env.FILMEDIT_TTS_MODEL?.trim() ||
    (env.FILMEDIT_MODEL_DIR
      ? path.join(env.FILMEDIT_MODEL_DIR, 'tts', 'zh_CN-huayan-medium.onnx')
      : undefined);
  invariant(
    model && !/^https?:\/\//i.test(model),
    'TTS_MODEL_REQUIRED',
    '本地 TTS 需要 Piper 模型。先运行 python/provision_tts.py，再设置 FILMEDIT_MODEL_DIR 或 FILMEDIT_TTS_MODEL。',
  );
  const speed = z.coerce
    .number()
    .finite()
    .positive()
    .parse(env.FILMEDIT_TTS_SPEED ?? 1);
  return { engine: 'piper' as const, model: path.resolve(model), speed };
}

/** Local CPU inference only. No cloud provider or HTTP fallback. */
export class LocalTts {
  constructor(readonly library: AssetLibrary) {}
  async synthesize(text: string) {
    invariant(text.trim(), 'TTS_TEXT', 'Narration must not be empty');
    const config = localTtsConfiguration();
    for (const file of [config.model, `${config.model}.json`]) {
      invariant(
        await access(file).then(
          () => true,
          () => false,
        ),
        'TTS_MODEL_REQUIRED',
        `缺少本地 TTS 文件：${file}。运行 python/provision_tts.py 初始化；不需要语音 API Key。`,
      );
    }
    const key = randomUUID();
    const output = path.join(this.library.policy.data.workspace, 'speech', `${key}.wav`);
    const input = path.join(this.library.policy.data.workspace, 'speech', `${key}.json`);
    await this.library.policy.write(input, JSON.stringify({ text, speed: config.speed }));
    await this.library.policy.check(output, 'write');
    this.library.store.event(this.library.taskId, 'tts.started', {
      engine: config.engine,
      textHash: hash(text),
    });
    const result = await this.library.processes.run(
      process.env.FILMEDIT_PYTHON ?? 'python3',
      [path.join(projectRoot, 'python/tts_worker.py'), config.model, input, output],
      { extraReads: [config.model, `${config.model}.json`], env: modelEnvironment(), timeoutMs: 600000 },
    );
    const report = z
      .object({ duration: z.number().positive(), rms: z.number().positive() })
      .parse(JSON.parse(result.stdout));
    const asset = await this.library.importFile(output, 'generated', { title: '本地 Piper 旁白' });
    invariant(
      asset.hasAudio && asset.duration > 0,
      'TTS_EMPTY_AUDIO',
      'Local TTS did not generate valid audio',
    );
    // The input is the actual synthesized narration, not an inferred transcript.
    asset.transcript = [{ start: 0, end: asset.duration, text }];
    this.library.store.saveAsset(asset);
    this.library.store.event(this.library.taskId, 'tts.completed', {
      engine: config.engine,
      assetId: asset.id,
      duration: asset.duration,
      rms: report.rms,
    });
    return asset;
  }
}
