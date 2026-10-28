import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PathPolicy } from './security.js';
import { ProcessRunner, versionOf } from './process.js';
import { errorInfo } from '../../core/src/util.js';
import { resolveModelConfiguration, modelSummary } from './model-provider.js';
import { localTtsConfiguration } from '../../media/src/tts.js';
import { browserConfiguration } from '../../media/src/render.js';

export async function doctor() {
  const directory = await mkdtemp(path.join(tmpdir(), 'filmedit-doctor-'));
  const policy = await PathPolicy.create(directory, {
    materials: { paths: [], strategy: 'local_only' },
    access: { readPaths: [], writePaths: [], denyPaths: [] },
  });
  const runner = new ProcessRunner(policy);
  const dependencies = {
    node: process.version,
    ffmpeg: await versionOf('ffmpeg'),
    ffprobe: await versionOf('ffprobe'),
    ytDlp: await versionOf('yt-dlp'),
    python: await versionOf(process.env.FILMEDIT_PYTHON ?? 'python3'),
  };
  let sandbox: { available: boolean; blocksOutsideRead?: boolean; error?: unknown },
    filters: Record<string, boolean> = {};
  let filterError: unknown;
  let pythonModules: { ready: boolean; error?: unknown } = { ready: false };
  const outside = path.join(path.dirname(directory), `${path.basename(directory)}-secret`);
  try {
    const good = await runner.run(process.execPath, ['-e', 'console.log("sandbox-ok")']);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outside, 'denied probe');
    const denied = await runner.run(process.execPath, [
      '-e',
      'const fs=require("fs");try{fs.readFileSync(process.argv[1]);process.exit(9)}catch(e){if(e.code!=="EACCES"&&e.code!=="EPERM")throw e;console.log("denied");}',
      outside,
    ]);
    sandbox = {
      available: good.stdout.includes('sandbox-ok'),
      blocksOutsideRead: denied.stdout.includes('denied'),
    };
  } catch (error) {
    sandbox = { available: false, error: errorInfo(error) };
  }
  try {
    try {
      const result = await runner.run('ffmpeg', ['-hide_banner', '-filters']);
      const names = [
        'overlay',
        'xfade',
        'chromakey',
        'colorkey',
        'loudnorm',
        'amix',
        'alphamerge',
        'atempo',
        'astats',
        'alimiter',
      ];
      filters = Object.fromEntries(names.map((n) => [n, new RegExp(`\\s${n}\\s`).test(result.stdout)]));
    } catch (error) {
      filterError = errorInfo(error);
    }
    if (dependencies.python.available) {
      try {
        await runner.run(
          process.env.FILMEDIT_PYTHON ?? 'python3',
          [
            '-I',
            '-c',
            'import faster_whisper, librosa, transformers, torch, piper; print("media-imports-ok")',
          ],
          { timeoutMs: 120000 },
        );
        pythonModules = { ready: true };
      } catch (error) {
        pythonModules = { ready: false, error: errorInfo(error) };
      }
    }
  } finally {
    await rm(outside, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
  const modelDirectory = process.env.FILMEDIT_MODEL_DIR;
  const fileExists = async (file: string) => {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  };
  const report = {
    dependencies,
    pythonModules,
    sandbox,
    filters,
    filterError,
    agent: modelSummary(resolveModelConfiguration()),
    credentials: {
      deepseek: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    },
    models: {
      directory: modelDirectory ?? null,
      manifest: modelDirectory ? await fileExists(path.join(modelDirectory, 'manifest.json')) : false,
      embedding: modelDirectory
        ? await fileExists(path.join(modelDirectory, 'embedding/config.json'))
        : false,
      nli: modelDirectory ? await fileExists(path.join(modelDirectory, 'nli/config.json')) : false,
      whisper: modelDirectory ? await fileExists(path.join(modelDirectory, 'whisper')) : false,
      audio: modelDirectory
        ? (await fileExists(path.join(modelDirectory, 'audio/model.safetensors'))) &&
          (await fileExists(path.join(modelDirectory, 'audio/preprocessor_config.json')))
        : false,
      audioText: modelDirectory
        ? (await fileExists(path.join(modelDirectory, 'audio_text/config.json'))) &&
          (await fileExists(path.join(modelDirectory, 'audio_text/preprocessor_config.json'))) &&
          ((await fileExists(path.join(modelDirectory, 'audio_text/model.safetensors'))) ||
            (await fileExists(path.join(modelDirectory, 'audio_text/pytorch_model.bin'))))
        : false,
      matte: modelDirectory ? await fileExists(path.join(modelDirectory, 'matte/u2net.onnx')) : false,
    },
    tts: await (async () => {
      try {
        const config = localTtsConfiguration();
        return {
          ...config,
          local: true,
          requiresApiKey: false,
          modelReady: (await fileExists(config.model)) && (await fileExists(`${config.model}.json`)),
        };
      } catch (error) {
        return {
          engine: 'piper',
          local: true,
          requiresApiKey: false,
          modelReady: false,
          error: errorInfo(error),
        };
      }
    })(),
    browser: await browserConfiguration().then(
      (value) => ({ ready: true, ...value }),
      (error) => ({ ready: false, error: errorInfo(error) }),
    ),
  };
  const checks = [
    {
      id: 'model',
      label: '大模型 Key 已配置（连接尚需 model-test）',
      ready: report.agent.credentialConfigured,
      required: true,
      action: '在项目 .env 填入所选模型的 API Key，然后运行 filmedit model-test --vision',
    },
    {
      id: 'media',
      label: 'FFmpeg 与 ffprobe',
      ready: dependencies.ffmpeg.available && dependencies.ffprobe.available,
      required: true,
      action: '安装 FFmpeg，并确认 ffmpeg、ffprobe 在 PATH 中',
    },
    {
      id: 'filters',
      label: 'FFmpeg 剪辑与音频处理滤镜',
      ready: !filterError && Object.keys(filters).length > 0 && Object.values(filters).every(Boolean),
      required: true,
      action: '安装包含 chromakey、amix、atempo、astats 等标准滤镜的 FFmpeg，详见 doctor --json',
    },
    {
      id: 'sandbox',
      label: '文件访问沙箱',
      ready: sandbox.available && sandbox.blocksOutsideRead === true,
      required: true,
      action: '运行 npm ci；检查系统是否支持 Sandbox Runtime，不能用关闭沙箱代替修复',
    },
    {
      id: 'browser',
      label: '本地浏览器渲染',
      ready: report.browser.ready,
      required: true,
      action: '运行 npx puppeteer browsers install chrome-headless-shell',
    },
    {
      id: 'python',
      label: 'Python 媒体依赖',
      ready: pythonModules.ready,
      required: true,
      action: '创建 Python 虚拟环境，安装 python/requirements.txt；在 .env 设置 FILMEDIT_PYTHON',
    },
    {
      id: 'embedding',
      label: '本地知识检索模型（内容评审使用远程模型）',
      ready: report.models.manifest && report.models.embedding,
      required: true,
      action: '设置 FILMEDIT_MODEL_DIR；用配置的 Python 运行 python/provision_models.py 模型目录 --whisper',
    },
    {
      id: 'asr',
      label: '本地语音转录',
      ready: report.models.whisper,
      required: true,
      action: '用配置的 Python 运行 python/provision_models.py 模型目录 --whisper',
    },
    {
      id: 'tts',
      label: '本地中文旁白',
      ready: report.tts.modelReady,
      required: true,
      action: '按 README 安装 Piper 中文模型，设置 FILMEDIT_TTS_MODEL',
    },
    {
      id: 'sound',
      label: '本地声音内容检查',
      ready: report.models.audio && report.models.audioText && report.models.whisper,
      required: true,
      action: '用配置的 Python 运行 python/provision_models.py 模型目录 --whisper --audio',
    },
    {
      id: 'web',
      label: '网络素材下载',
      ready: dependencies.ytDlp.available,
      required: false,
      action: '安装 yt-dlp；仅本地素材任务不需要此项',
    },
    {
      id: 'matte',
      label: '人像分割模型',
      ready: report.models.matte,
      required: false,
      action: '用配置的 Python 运行 python/provision_matte.py 模型目录；普通剪辑和绿幕抠像不需要此项',
    },
  ];
  return { ...report, checks, ready: checks.filter((check) => check.required).every((check) => check.ready) };
}

export function formatDoctor(report: Awaited<ReturnType<typeof doctor>>) {
  return [
    'FilmEdit 环境自检',
    '模型连接与本地剪辑环境分别检查；此命令不调用付费模型。',
    '',
    ...report.checks.map(
      (check) =>
        `${check.ready ? '✓' : '○'} ${check.label}${check.required ? '' : '（按需）'}${check.ready ? '' : `\n  下一步：${check.action}`}`,
    ),
    '',
    report.ready
      ? '基础依赖已就绪。用 filmedit model-test --vision 检查真实模型调用；再通过短片任务验证整条制作链路。'
      : '仍有基础依赖未就绪。完成上面的初始化后重跑 doctor；已有任务和产物会保留。',
    '详细诊断：filmedit doctor --json',
    '',
  ].join('\n');
}
