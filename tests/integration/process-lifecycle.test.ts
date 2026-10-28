import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PathPolicy } from '../../packages/infrastructure/src/security.js';
import { collect, ProcessRunner } from '../../packages/infrastructure/src/process.js';

for (const mode of ['timeout', 'output_limit'] as const)
  test(
    `${mode} cleans a sandboxed detached descendant while leaving an unrelated process alive`,
    { timeout: 15000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'filmedit-lifecycle-'));
      const policy = await PathPolicy.create(path.join(root, 'work'), {
        materials: { paths: [], strategy: 'local_only' },
        access: { readPaths: [], writePaths: [], denyPaths: [] },
      });
      const program = path.join(policy.data.workspace, 'process.cjs');
      const ready = path.join(policy.data.workspace, 'ready.json');
      await writeFile(
        program,
        `
      const {spawn} = require('node:child_process');
      const {writeFileSync} = require('node:fs');
      process.on('SIGTERM', () => {});
      if (process.argv[2] === 'child') {
        writeFileSync(process.argv[3], JSON.stringify({pid:process.pid,parent:process.ppid}));
      } else {
        spawn(process.execPath,[__filename,'child',process.argv[2]],{detached:true,stdio:'ignore'});
        process.stdin.on('data', () => process.stdout.write('x'.repeat(200)));
      }
      setInterval(() => {}, 1000);
    `,
      );
      const prepared = await new ProcessRunner(policy).spawnOptions(process.execPath, [program, ready]);
      const child = spawn(prepared.command, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      let descendant: { pid: number; parent: number } | undefined;
      t.after(async () => {
        for (const pid of [child.pid, descendant?.pid, unrelated.pid]) {
          if (!pid) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        await rm(root, { recursive: true, force: true });
      });
      await once(unrelated, 'spawn');
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          descendant = JSON.parse(await readFile(ready, 'utf8'));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(descendant, 'detached descendant must be running before failure injection');
      await assert.rejects(
        collect(
          child,
          mode === 'timeout' ? { timeoutMs: 50 } : { maxOutput: 64, input: 'produce', timeoutMs: 5000 },
        ),
        {
          code: mode === 'timeout' ? 'PROCESS_TIMEOUT' : 'PROCESS_OUTPUT_LIMIT',
        },
      );
      assert.throws(() => process.kill(descendant!.pid, 0), { code: 'ESRCH' });
      assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
    },
  );
