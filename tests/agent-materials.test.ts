import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { asset, fixture } from './helpers.js';
import {
  assetSummary,
  materialPage,
  materialCatalog,
  transcriptPage,
  MATERIAL_PAGE_BYTES,
} from '../packages/media/src/catalog.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { fileHash } from '../packages/infrastructure/src/files.js';

test('catalog stays bounded with thousands of assets, frames and ASR records; all IDs remain reachable', () => {
  const large = {
    ...asset,
    transcript: Array.from({ length: 30000 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: '中文语音'.repeat(40),
    })),
    frames: Array.from({ length: 2000 }, (_, i) => ({ time: i, path: '/private/path/' + 'x'.repeat(400) })),
  };
  const summaries = Array.from({ length: 1000 }, (_, i) =>
    assetSummary({ ...large, id: `asset_${i}`, source: { ...large.source, title: '测试标题'.repeat(100) } }),
  );
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = materialPage(summaries, offset, 40);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < MATERIAL_PAGE_BYTES);
    assert.ok(!JSON.stringify(page).includes('/private/path'));
    assert.ok(!JSON.stringify(page).includes('中文语音'));
    ids.push(...page.items.map((a) => a.id));
    offset = page.nextOffset;
  }
  assert.deepEqual(
    ids,
    summaries.map((a) => a.id),
  );
});

test('transcript pagination is lossless, including a huge individual subtitle and time-filtered continuations', () => {
  const entries = [
    { start: 0, end: 1, text: 'outside' },
    { start: 1, end: 2, text: '中文😀'.repeat(10000) },
    ...Array.from({ length: 2000 }, (_, i) => ({ start: 2 + i, end: 3 + i, text: `词${i}` })),
  ];
  const result = new Map<number, string>();
  let cursor: { offset: number; textOffset: number } | null = { offset: 0, textOffset: 0 };
  while (cursor) {
    const page = transcriptPage(entries, { start: 1, end: 1000, ...cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < MATERIAL_PAGE_BYTES);
    assert.ok(page.items.length > 0);
    for (const item of page.items) result.set(item.index, (result.get(item.index) ?? '') + item.text);
    cursor = page.next;
  }
  assert.deepEqual(
    [...result.values()],
    entries.filter((e) => e.start < 1000 && e.end > 1).map((e) => e.text),
  );
  assert.throws(() => transcriptPage(entries, { start: 2, end: 1 }), { code: 'TRANSCRIPT_RANGE' });
});

test('catalog and cached ASR enforce source permissions and version checks', async (t) => {
  const { store, materials } = await fixture();
  t.after(() => store.close());
  const allowed = path.join(materials, 'one.txt'),
    denied = path.join(materials, 'two.txt');
  const task = await createTask(store, { prompt: 'test', materials: { paths: [allowed] } });
  const runner = new TaskRunner(store, task.id);
  const saved = {
    ...asset,
    taskId: task.id,
    source: { ...asset.source, path: allowed },
    sha256: await fileHash(allowed),
    transcript: [{ start: 0, end: 1, text: 'cached' }],
  };
  store.saveAsset(saved);
  assert.equal((await materialCatalog(runner.library)).items[0]?.id, saved.id);
  t.mock.method(runner.processes, 'run', () => {
    throw new Error('cached ASR must not start a process');
  });
  assert.deepEqual(await runner.library.analyzeAudio(saved.id, 'asr'), saved.transcript);
  store.saveAsset({ ...saved, transcript: [], analyzed: { asr: true } });
  assert.deepEqual(await runner.library.analyzeAudio(saved.id, 'asr'), []);
  await writeFile(allowed, 'changed');
  await assert.rejects(materialCatalog(runner.library), { code: 'ASSET_CHANGED' });
  await assert.rejects(runner.library.analyzeAudio(saved.id, 'asr'), { code: 'ASSET_CHANGED' });
  store.saveAsset({ ...saved, source: { ...saved.source, path: denied }, sha256: await fileHash(denied) });
  await assert.rejects(materialCatalog(runner.library), { code: 'PATH_DENIED' });
});

test('ASR stores unaligned recognizer tokens separately and caches only timed speech', async (t) => {
  const { store, materials } = await fixture();
  t.after(() => store.close());
  const file = path.join(materials, 'one.txt');
  const task = await createTask(store, { prompt: 'ASR fixture', materials: { paths: [file] } });
  const runner = new TaskRunner(store, task.id);
  store.saveAsset({
    ...asset,
    taskId: task.id,
    source: { kind: 'local', path: file },
    sha256: await fileHash(file),
  });
  const raw = {
    transcript: [{ start: 0, end: 0.18, text: '細' }],
    unalignedWords: [{ time: 0, text: '在' }],
  };
  const run = t.mock.method(runner.processes, 'run', async (command) => ({
    stdout: command === 'ffmpeg' ? '' : JSON.stringify(raw),
    stderr: '',
    code: 0,
  }));
  assert.deepEqual(await runner.library.analyzeAudio(asset.id, 'asr'), raw.transcript);
  const saved = store.artifact<any>(task.id, `analysis.asr.${asset.id}`)!.data;
  assert.deepEqual(saved.unalignedWords, raw.unalignedWords);
  assert.deepEqual(await runner.library.analyzeAudio(asset.id, 'asr'), raw.transcript);
  assert.equal(run.mock.callCount(), 2);
});
