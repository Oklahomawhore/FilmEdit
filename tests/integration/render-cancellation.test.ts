import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from '../helpers.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { Renderer } from '../../packages/media/src/render.js';
import { defaultRender, validateEditorial } from '../../packages/core/src/ir.js';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function browsers(workspace: string, groups: Set<number>) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command=']);
  const rows = stdout.split('\n').flatMap((line) => {
    const row = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!row || row[4]!.startsWith('Z')) return [];
    const profile = row[5]!.includes(`--user-data-dir=${workspace}/`);
    return [
      {
        pid: Number(row[1]),
        parent: Number(row[2]),
        group: Number(row[3]),
        profile,
        capture: profile && row[5]!.includes('--autoplay-policy=no-user-gesture-required'),
      },
    ];
  });
  for (const row of rows) if (row.profile && row.pid === row.group) groups.add(row.group);
  // Helpers may omit the profile argument and outlive the browser root. Remember this fixture's groups.
  return rows.filter((row) => row.profile || groups.has(row.group));
}

for (const mode of ['responsive', 'unresponsive'] as const)
  test(
    `cancelling a ${mode} sandboxed render leaves no Chromium process after the worker settles`,
    { timeout: 60000 },
    async (t) => {
      const { store, root } = await fixture();
      const task = await createTask(store, {
        prompt: '本地中断回归',
        creative: { enabled: false },
        materials: { strategy: 'local_only' },
        composition: { width: 320, height: 180, fps: 30 },
        output: { width: 320, height: 180, fps: 30, duration: 60 },
      });
      const controller = new AbortController();
      const runner = new TaskRunner(store, task.id, controller.signal);
      const groups = new Set<number>();
      t.after(async () => {
        controller.abort();
        // A failed regression may leave an orphan. Only terminate this fixture's browser and helpers.
        for (const browser of await browsers(task.policy.workspace, groups)) {
          try {
            process.kill(browser.pid, 'SIGTERM');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        store.close();
        await rm(root, { recursive: true, force: true });
      });
      const source = path.join(task.policy.workspace, 'source.png');
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180',
        '-frames:v',
        '1',
        source,
      ]);
      const asset = await runner.library.importFile(source, 'generated');
      const editorial = validateEditorial(
        {
          schemaVersion: 1,
          revision: 0,
          duration: 60,
          shots: [{ id: 'long-shot', assetId: asset.id, sourceStart: 0, start: 0, duration: 60 }],
          audio: [],
          text: [],
          transitions: [],
        },
        store.assets(task.id),
      );
      const render = defaultRender(editorial, { width: 320, height: 180, fps: 30 });
      let settled = false;
      const rendering = new Renderer(runner.library, runner.processes).render(editorial, render).then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      let observed: Awaited<ReturnType<typeof browsers>> = [];
      for (let attempt = 0; attempt < 300; attempt++) {
        observed = await browsers(task.policy.workspace, groups);
        if (observed.some((browser) => browser.capture) && observed.some((browser) => !browser.profile))
          break;
        assert.equal(settled, false, 'render must still be active before cancellation');
        await delay(50);
      }
      assert.ok(
        observed.some((browser) => browser.capture),
        'must cancel actual HyperFrames capture, not setup',
      );
      assert.ok(
        observed.some((browser) => !browser.profile),
        'must observe Chromium helpers too',
      );
      if (mode === 'unresponsive') {
        const worker = observed.find((browser) => browser.capture)!.parent;
        const { stdout } = await exec('ps', ['-p', String(worker), '-o', 'command=']);
        assert.ok(stdout.includes('/render-worker.js') && stdout.includes(task.policy.workspace));
        process.kill(worker, 'SIGSTOP'); // Force the supervisor's SIGKILL path: browser owns a separate process group.
      }
      controller.abort();
      const result = await rendering;
      assert.equal(result.code, 'CANCELLED');
      let remaining = await browsers(task.policy.workspace, groups);
      for (let attempt = 0; remaining.length && attempt < 40; attempt++) {
        await delay(50);
        remaining = await browsers(task.policy.workspace, groups);
      }
      await writeFile(
        path.join(tmpdir(), `filmedit-render-cancellation-${mode}.json`),
        JSON.stringify({ observed, remaining }, null, 2),
      );
      assert.deepEqual(remaining, [], 'settled cancellation must not leave a detached browser running');
    },
  );
