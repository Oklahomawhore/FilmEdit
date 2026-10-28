import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { symlink, writeFile, mkdir } from 'node:fs/promises';
import { PathPolicy } from '../packages/infrastructure/src/security.js';
import { fixture } from './helpers.js';
import { validateCodePatch } from '../packages/infrastructure/src/releases.js';

test('file selection grants only that file, not siblings; original remains read-only', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const source = path.join(f.materials, 'one.txt');
  const policy = await PathPolicy.create(path.join(f.root, 'work'), {
    materials: { paths: [source], strategy: 'local_only' },
    access: { readPaths: [], writePaths: [f.materials], denyPaths: [] },
  });
  assert.equal((await policy.read(source)).toString(), 'one');
  await assert.rejects(policy.write(source, 'overwrite'), { code: 'READ_ONLY_MATERIAL' });
  const restricted = await PathPolicy.create(path.join(f.root, 'other-work'), {
    materials: { paths: [source], strategy: 'local_only' },
    access: { readPaths: [], writePaths: [], denyPaths: [] },
  });
  await assert.rejects(restricted.read(path.join(f.materials, 'two.txt')), { code: 'PATH_DENIED' });
});
test('deny wins, traversal and symlinks cannot escape a directory grant', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const secret = path.join(f.root, 'secret.txt');
  await writeFile(secret, 'secret');
  await symlink(secret, path.join(f.materials, 'link.txt'));
  await symlink(f.materials, path.join(f.root, 'alias'));
  const policy = await PathPolicy.create(path.join(f.root, 'work'), {
    materials: { paths: [f.materials], strategy: 'local_only' },
    access: { readPaths: [], writePaths: [], denyPaths: [path.join(f.materials, 'two.txt')] },
  });
  await assert.rejects(policy.read(path.join(f.materials, 'link.txt')), { code: 'PATH_DENIED' });
  await assert.rejects(policy.read(path.join(f.materials, '..', 'secret.txt')), { code: 'PATH_DENIED' });
  await assert.rejects(policy.read(path.join(f.root, 'alias', 'two.txt')), { code: 'PATH_DENIED' });
  await symlink(f.materials, path.join(policy.data.workspace, 'escape'));
  await assert.rejects(policy.write(path.join(policy.data.workspace, 'escape', 'new.txt'), 'x'), {
    code: 'PATH_DENIED',
  });
});
test('learning patches cannot alter evaluators, permissions, tests or path aliases', () => {
  assert.doesNotThrow(() =>
    validateCodePatch({ files: [{ path: 'packages/media/src/compositor.ts', content: 'export {}' }] }),
  );
  for (const file of [
    'packages/core/src/scoring.ts',
    'packages/core/src/techniques.ts',
    'packages/media/src/render.ts',
    'packages/infrastructure/src/security.ts',
    'packages/infrastructure/src/process.ts',
    'packages/infrastructure/src/releases.ts',
    'packages/application/src/workflow.ts',
    'tests/security.test.ts',
    'skills/audience-read/SKILL.md',
    'skills/render-review/SKILL.md',
    'skills/fact-review/SKILL.md',
    'skills/technique-learn/SKILL.md',
    '../packages/media/src/compositor.ts',
    'src/../packages/media/src/compositor.ts',
    '/tmp/layout.ts',
  ])
    assert.throws(() => validateCodePatch({ files: [{ path: file, content: '' }] }));
});
