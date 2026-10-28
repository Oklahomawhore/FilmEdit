import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { fixture } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import type { FilmTool } from '../packages/agent-runtime/src/pi-runtime.js';

test('material download requires an explicit media kind and enforces local-only intent before execution', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '补充音乐', materials: { strategy: 'web_first' } });
  const runner = new TaskRunner(store, task.id);
  const tools = (runner.agent as any).createTools(
    { role: 'materials', instruction: '', input: {}, schema: z.any() },
    false,
  ) as FilmTool[];
  const download = tools.find((tool) => tool.name === 'download_material')!;
  const url = 'https://example.invalid/sound.ogg';
  assert.equal(download.schema.safeParse({ url }).success, false);
  assert.equal(download.schema.safeParse({ url, kind: 'audio' }).success, true);
  assert.equal(download.schema.safeParse({ url, kind: 'video' }).success, true);
  assert.equal(download.schema.safeParse({ url, kind: 'image' }).success, false);
  let requests = 0;
  t.mock.method(runner.library, 'download', async () => {
    requests++;
    throw new Error('A local-only intent must prevent this call');
  });
  store.saveArtifact(task.id, 'creative.intent', { technical: [{ kind: 'local_materials' }] }, true);
  await assert.rejects(download.execute({ url, kind: 'audio' }), { code: 'LOCAL_ONLY' });
  assert.equal(requests, 0);
});

test('audio downloading selects audio and extracts it; unexpected streams never enter the task index', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: '下载音效', materials: { strategy: 'web_first' } });
  const runner = new TaskRunner(store, task.id);
  let wrongKind = false;
  const calls: string[][] = [];
  t.mock.method(runner.processes, 'run', async (command: string, args: string[]) => {
    if (command === 'yt-dlp') {
      calls.push(args);
      const file = args[args.indexOf('-o') + 1]!.replace('%(ext)s', 'mp4');
      await writeFile(file, 'fixture stream metadata only');
      return { stdout: file + '\n', stderr: '', code: 0 };
    }
    assert.equal(command, 'ffprobe');
    return {
      stdout: JSON.stringify({
        streams: wrongKind
          ? [{ codec_type: 'video', width: 320, height: 180 }]
          : [{ codec_type: 'audio', duration: '3.5' }],
        format: { duration: '3.5' },
      }),
      stderr: '',
      code: 0,
    };
  });
  const asset = await runner.library.download('https://example.invalid/music', 'audio');
  assert.equal(asset.kind, 'audio');
  assert.equal(asset.hasAudio, true);
  assert.equal(asset.width, undefined);
  const args = calls[0]!;
  assert.equal(args[args.indexOf('-f') + 1], 'bestaudio/best');
  assert.ok(args.includes('--extract-audio'));
  assert.ok(!args.includes('--merge-output-format'));
  assert.ok(!args.some((arg) => arg.includes('height<=')));
  wrongKind = true;
  await assert.rejects(runner.library.download('https://example.invalid/silent', 'audio'), {
    code: 'MEDIA_KIND',
  });
  assert.equal(store.assets(task.id).length, 1);
  await assert.rejects(runner.library.importFile(asset.source.path, 'web', {}, 'video'), {
    code: 'MEDIA_KIND',
  });
});

test('network policy and HTTPS validation apply equally to audio and video without starting a process', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  for (const strategy of ['local_only', 'web_first'] as const) {
    const task = await createTask(store, { prompt: 'source policy', materials: { strategy } });
    const runner = new TaskRunner(store, task.id);
    t.mock.method(runner.processes, 'run', () => {
      throw new Error('Invalid download must not spawn a process');
    });
    for (const kind of ['audio', 'video'] as const)
      await assert.rejects(runner.library.download('http://example.invalid/source', kind), {
        code: strategy === 'local_only' ? 'SOURCE_POLICY' : 'URL_PROTOCOL',
      });
    assert.equal(store.assets(task.id).length, 0);
  }
});

test('a downloader skip with successful exit never becomes a path error or an indexed asset', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'skip control', materials: { strategy: 'web_first' } });
  const runner = new TaskRunner(store, task.id);
  t.mock.method(runner.processes, 'run', async (command) => {
    assert.equal(command, 'yt-dlp', 'no probe runs without a downloaded path');
    return { stdout: '\n', stderr: '[download] File is larger than max-filesize. Aborting.', code: 0 };
  });
  for (const kind of ['audio', 'video'] as const)
    await assert.rejects(runner.library.download('https://example.invalid/media', kind), {
      code: 'DOWNLOAD_EMPTY',
    });
  assert.equal(store.assets(task.id).length, 0);
});
