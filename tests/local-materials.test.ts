import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { LocalMaterials } from '../packages/media/src/local-materials.js';
import { MATERIAL_PAGE_BYTES } from '../packages/media/src/catalog.js';
import { hash } from '../packages/core/src/util.js';

const subtitle = '1\n00:00:00,000 --> 00:00:01,000\n人物开门\n';

test('authorized local discovery imports selected files without publishing or expanding access', async (t) => {
  const { store, root, materials } = await fixture();
  t.after(() => store.close());
  const folder = path.join(materials, '片段');
  const denied = path.join(materials, 'private');
  const outside = path.join(root, 'outside.srt');
  await mkdir(folder);
  await mkdir(denied);
  await writeFile(path.join(folder, '开门.srt'), subtitle);
  await writeFile(path.join(denied, '秘密.srt'), subtitle);
  await writeFile(outside, subtitle);
  await symlink(outside, path.join(materials, 'link.srt'));
  await symlink(folder, path.join(materials, 'inside-link'));
  const task = await createTask(store, {
    prompt: '从授权目录找人物开门的素材',
    materials: { strategy: 'local_only' },
    access: { readPaths: [materials, outside], denyPaths: [denied] },
  });
  const runner = new TaskRunner(store, task.id);
  const local = new LocalMaterials(runner.library);
  const roots = (await local.browse()).items as { path: string; sourceId: string }[];
  assert.equal(roots.length, 2);
  assert.ok(!roots.some((root) => root.path === task.policy.workspace));
  const sourceId = roots.find((source) => source.path.endsWith('/materials'))!.sourceId;
  assert.deepEqual((await local.browse({ sourceId })).items, [{ relativePath: '片段', kind: 'directory' }]);
  assert.deepEqual((await local.browse({ sourceId, relativePath: '片段' })).items, [
    { relativePath: '片段/开门.srt', kind: 'subtitle' },
  ]);
  assert.equal(store.assets(task.id).length, 0, 'listing does not import or analyze files');
  const policyBefore = hash(runner.policy.data);
  const imported = await local.import({ sourceId, relativePath: '片段/开门.srt' });
  assert.equal(imported.kind, 'subtitle');
  assert.equal(imported.transcriptSegments, 1);
  assert.equal((await local.import({ sourceId, relativePath: '片段/开门.srt' })).id, imported.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM library_assets').get()!.n, 0);
  assert.equal(hash(runner.policy.data), policyBefore, 'discovery/import cannot grant paths');
  await assert.rejects(runner.policy.write(path.join(folder, '开门.srt'), 'overwrite'), {
    code: 'PATH_DENIED',
  });
  for (const relativePath of [
    '../outside.srt',
    outside,
    'private/秘密.srt',
    'link.srt',
    'inside-link/开门.srt',
  ]) {
    await assert.rejects(local.import({ sourceId, relativePath }), { code: 'PATH_DENIED' });
  }
  await assert.rejects(local.import({ sourceId }), { code: 'MEDIA_FILE' });
  await assert.rejects(local.import({ sourceId: hash({ path: task.policy.workspace, kind: 'directory' }) }), {
    code: 'PATH_DENIED',
  });
  const fileSource = roots.find((source) => source.path.endsWith('/outside.srt'))!;
  assert.equal((await local.import({ sourceId: fileSource.sourceId })).kind, 'subtitle');
  await assert.rejects(local.browse({ sourceId: fileSource.sourceId }), { code: 'MEDIA_DIRECTORY' });
  await assert.rejects(
    local.import({ sourceId: fileSource.sourceId, relativePath: '../materials/片段/开门.srt' }),
    { code: 'PATH_DENIED' },
  );
  await writeFile(path.join(folder, '开门.srt'), subtitle + '\nchanged');
  await assert.rejects(runner.library.resolve(imported.id), { code: 'ASSET_CHANGED' });
  runner.policy.data.reads = runner.policy.data.reads.filter((grant) => !grant.path.endsWith('/materials'));
  await assert.rejects(local.browse({ sourceId }), { code: 'PATH_DENIED' });
  await assert.rejects(runner.library.resolve(imported.id), { code: 'PATH_DENIED' });
});

test('directory pages remain bounded and every eligible file stays reachable', async (t) => {
  const { store, materials } = await fixture();
  t.after(() => store.close());
  const relativePath = `${'d'.repeat(200)}/${'e'.repeat(200)}`;
  const folder = path.join(materials, relativePath);
  await mkdir(folder, { recursive: true });
  const names = Array.from({ length: 65 }, (_, i) => `${String(i).padStart(3, '0')}-${'片'.repeat(60)}.mp4`);
  await Promise.all(names.map((name) => writeFile(path.join(folder, name), 'unprobed')));
  const task = await createTask(store, { prompt: '分页发现', access: { readPaths: [materials] } });
  const runner = new TaskRunner(store, task.id);
  const local = new LocalMaterials(runner.library);
  const sourceId = ((await local.browse()).items[0] as { sourceId: string }).sourceId;
  const files: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await local.browse({ sourceId, relativePath, offset, limit: 40 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < MATERIAL_PAGE_BYTES);
    assert.ok(page.items.length > 0);
    files.push(...(page.items as { relativePath: string }[]).map((item) => path.basename(item.relativePath)));
    offset = page.nextOffset;
  }
  assert.deepEqual(files, names);
  assert.equal(store.assets(task.id).length, 0);
  await rename(folder, folder + '-moved');
  await symlink(folder + '-moved', folder);
  await assert.rejects(local.browse({ sourceId, relativePath }), { code: 'PATH_DENIED' });
  runner.cancellation.abort();
  await assert.rejects(local.browse(), { name: 'AbortError' });
});
