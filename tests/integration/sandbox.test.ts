import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PathPolicy } from '../../packages/infrastructure/src/security.js';
import { ProcessRunner } from '../../packages/infrastructure/src/process.js';

test('OS sandbox denies out-of-scope reads, original writes, child processes and literal wildcard paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'filmedit-os-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  const original = path.join(source, 'clip.txt');
  await writeFile(original, 'original');
  const secret = path.join(root, 'secret');
  await writeFile(secret, 'secret');
  const bracket = path.join(root, '[ab]');
  await mkdir(bracket);
  await writeFile(path.join(bracket, 'allowed'), 'ok');
  await mkdir(path.join(root, 'a'));
  await writeFile(path.join(root, 'a', 'leak'), 'no');
  const policy = await PathPolicy.create(path.join(root, 'work'), {
    materials: { paths: [source], strategy: 'local_only' },
    access: { readPaths: [bracket], writePaths: [], denyPaths: [] },
  });
  const runner = new ProcessRunner(policy);
  const allowed = await runner.run(process.execPath, [
    '-e',
    'console.log(require("fs").readFileSync(process.argv[1],"utf8"))',
    await policy.check(original, 'read'),
  ]);
  assert.match(allowed.stdout, /original/);
  for (const denied of [secret, path.join(root, 'a', 'leak')])
    await assert.rejects(
      runner.run(process.execPath, ['-e', 'require("fs").readFileSync(process.argv[1])', denied]),
      /EPERM|EACCES/,
    );
  await assert.rejects(
    runner.run(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1],"changed")', original]),
    /EPERM|EACCES/,
  );
  await assert.rejects(
    runner.run('/bin/sh', ['-c', 'cat "$1"', 'sh', secret]),
    /Operation not permitted|Permission denied/,
  );
  assert.equal(await readFile(original, 'utf8'), 'original');
});

test('long task paths allow concurrent agent, FFmpeg and Python sandboxes', { timeout: 30000 }, async () => {
  const root = await mkdtemp('/tmp/filmedit-ipc-test-');
  const work = path.join(root, 'task-' + 'x'.repeat(100));
  const policy = await PathPolicy.create(work, {
    materials: { paths: [], strategy: 'local_only' },
    access: { readPaths: [], writePaths: [], denyPaths: [] },
  });
  const runner = new ProcessRunner(policy);
  const temporary = path.join(policy.data.workspace, 'tmp');
  assert.ok(Buffer.byteLength(temporary) > 104);
  const prepared = await runner.spawnOptions(process.execPath, [
    '-e',
    'console.log(JSON.stringify({tmp:require("os").tmpdir()})); process.stdin.resume()',
  ]);
  const agent = spawn(prepared.command, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const closed = once(agent, 'close');
  try {
    const [data] = await once(agent.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    assert.equal(JSON.parse(data.toString()).tmp, temporary);
    const frame = path.join(policy.data.workspace, 'frame.jpg');
    const [ffmpeg, python] = await Promise.all([
      runner.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x64',
        '-frames:v',
        '1',
        frame,
      ]),
      runner.run('python3', [
        '-c',
        'import os,tempfile; print(tempfile.gettempdir()); open(os.path.join(tempfile.gettempdir(),"asr-test.txt"),"w").write("ok")',
      ]),
    ]);
    assert.equal(ffmpeg.code, 0);
    assert.equal(python.stdout.trim(), temporary);
    assert.ok((await readFile(frame)).length > 100);
    assert.equal(await readFile(path.join(temporary, 'asr-test.txt'), 'utf8'), 'ok');
    const secret = path.join(root, 'outside.txt');
    await writeFile(secret, 'must remain private');
    await assert.rejects(
      runner.run(process.execPath, ['-e', 'require("fs").readFileSync(process.argv[1])', secret]),
      /EPERM|EACCES/,
    );
  } finally {
    agent.stdin.end();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
