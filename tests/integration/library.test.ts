import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, copyFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../packages/infrastructure/src/store.js';
import { LocalLibrary } from '../../packages/library/src/library.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { fileHash } from '../../packages/infrastructure/src/files.js';

test(
  'shared library deduplicates, excludes symlinks, analyzes once and snapshots selected media across tasks',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'filmedit-library-')),
      store = new Store(path.join(root, 'state'));
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const a = await createTask(store, { prompt: 'A', materials: { strategy: 'local_only' } }),
      b = await createTask(store, { prompt: 'B', materials: { strategy: 'local_only' } });
    const runner = new TaskRunner(store, a.id);
    const source = path.join(a.policy.workspace, 'landscape.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=8:duration=1',
      '-c:v',
      'libx264',
      source,
    ]);
    const media = path.join(root, 'media');
    await mkdir(media);
    await copyFile(source, path.join(media, '汽车.mp4'));
    await copyFile(source, path.join(media, 'duplicate.mp4'));
    await symlink(source, path.join(media, 'outside.mp4'));
    const library = new LocalLibrary(store);
    const imported = await library.import([media], 'video', ['汽车']);
    assert.equal(imported.assetIds.length, 1);
    assert.equal(imported.count, 2);
    const id = imported.assetIds[0]!;
    await library.import([media], 'meme');
    assert.deepEqual(library.get(id).categories, ['video', 'meme']);
    assert.equal(library.search({ query: '汽车' }).items.length, 1);
    const analyzed = await library.analyze(id, ['frames']);
    assert.ok(analyzed.frames.length);
    const again = await library.analyze(id, ['frames']);
    assert.deepEqual(again.frames, analyzed.frames);
    const boundA = await library.bind(id, runner.library),
      boundB = await library.bind(id, new TaskRunner(store, b.id).library);
    assert.notEqual(boundA.taskId, boundB.taskId);
    assert.equal(boundA.sha256, boundB.sha256);
    assert.equal(boundA.source.libraryAssetId, id);
    const digest = await fileHash(boundA.source.path);
    await writeFile(path.join(media, '汽车.mp4'), 'changed');
    await writeFile(path.join(media, 'duplicate.mp4'), 'changed');
    await assert.rejects(library.resolve(id), { code: 'LIBRARY_SOURCE_CHANGED' });
    assert.equal(await fileHash(boundA.source.path), digest);
    assert.equal(await fileHash(boundB.source.path), digest);
    await rm(path.join(media, '汽车.mp4'));
    library.remove(id);
    assert.equal(library.search().items.length, 0);
    assert.equal(await fileHash(boundA.source.path), digest, 'removing index leaves task snapshot intact');
  },
);
