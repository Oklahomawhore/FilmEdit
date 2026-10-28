import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PathPolicy } from '../packages/infrastructure/src/security.js';
import { collect, ProcessRunner } from '../packages/infrastructure/src/process.js';

test('failed tools preserve compiler diagnostics written to stdout as well as stderr', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'console.log("candidate.ts:3 error TS2322: wrong type"); console.error("compiler stopped"); process.exit(2)',
    ],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  await assert.rejects(collect(child), (error: any) => {
    assert.equal(error.code, 'PROCESS_FAILED');
    assert.equal(error.details.code, 2);
    assert.match(error.message, /error TS2322/);
    assert.match(error.message, /compiler stopped/);
    return true;
  });
});

test('venv grants its base Python runtime, without granting sibling installations or unrelated binaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'filmedit-python-policy-'));
  try {
    const installation = path.join(root, 'runtimes', 'python-3.12');
    const venv = path.join(root, 'venv');
    await mkdir(path.join(installation, 'bin'), { recursive: true });
    await mkdir(path.join(venv, 'bin'), { recursive: true });
    await writeFile(path.join(venv, 'pyvenv.cfg'), `home = ${installation}/bin\n`);
    const policy = await PathPolicy.create(path.join(root, 'work'), {
      materials: { paths: [], strategy: 'local_only' },
      access: { readPaths: [], writePaths: [], denyPaths: [] },
    });
    for (const command of ['python3.12', 'unrelated-tool']) {
      await writeFile(path.join(installation, 'bin', command), 'fixture');
      const binary = path.join(venv, 'bin', command);
      await symlink(path.join(installation, 'bin', command), binary);
      const options = await new ProcessRunner(policy).spawnOptions(binary, []);
      const payload = JSON.parse(Buffer.from(options.args[1]!, 'base64url').toString());
      const reads = payload.settings.filesystem.allowRead.map((entry: { path: string }) => entry.path);
      assert.ok(reads.includes(venv));
      // realpath may canonicalize /var to /private/var on macOS.
      const { realpath } = await import('node:fs/promises');
      assert.equal(reads.includes(await realpath(installation)), command === 'python3.12');
      assert.ok(!reads.includes(await realpath(path.dirname(installation))));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
