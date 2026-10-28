import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Store } from '../../infrastructure/src/store.js';
import { createTask, TaskRunner } from './workflow.js';
import { PiAgentDriver } from '../../agent-runtime/src/agents.js';
import {
  resolveModelConfiguration,
  modelSummary,
  requireModelCredentials,
} from '../../infrastructure/src/model-provider.js';

/** Exercises the real pi/tool/validation path, independently of ASR, TTS and the scoring models. */
export async function checkModelConnection(signal?: AbortSignal, vision = false) {
  const config = resolveModelConfiguration();
  requireModelCredentials(config);
  const directory = await mkdtemp(path.join(tmpdir(), 'filmedit-model-check-'));
  const store = new Store(directory);
  try {
    const task = await createTask(store, {
      prompt: 'Model connection self-test',
    });
    const runner = new TaskRunner(
      store,
      task.id,
      AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]),
    );
    const driver = new PiAgentDriver(store, task.id, runner.library, runner.processes);
    const picture = path.join(task.policy.workspace, 'vision.jpg');
    if (vision)
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=512x512',
        '-frames:v',
        '1',
        '-vf',
        'scale=out_range=pc',
        '-pix_fmt',
        'yuvj420p',
        picture,
      ]);
    const result = await driver.run({
      role: 'visual_audience',
      instruction:
        '这是连接自检，不是视频评审。不要调用外部网站。返回 status="ok" 和 echoed="filmedit"；必须通过 submit_result 工具提交结果。' +
        (vision ? '观察附图，将实际主要颜色用英文写入 dominantColor。' : ''),
      input: { echo: 'filmedit' },
      schema: z
        .object({
          status: z.literal('ok'),
          echoed: z.literal('filmedit'),
          ...(vision ? { dominantColor: z.string() } : {}),
        })
        .strict(),
      images: vision ? [{ path: picture, label: '视觉自检图片' }] : [],
    });
    if (vision && String(result.dominantColor ?? '').toLowerCase() !== 'red')
      throw new Error('Vision self-test expected red; received ' + JSON.stringify(result));
    return {
      visionVerified: vision,
      ...modelSummary(config),
      connected: true,
      structuredOutput: true,
      result,
      estimatedCostUsd: store.task(task.id).cost,
    };
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
