import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { FilmError } from '../../core/src/util.js';

const exec = promisify(execFile);
type ProcessIdentity = { pid: number; parent: number; group: number; state: string; started: string };
async function processTable(): Promise<ProcessIdentity[]> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
    timeout: 2000,
    maxBuffer: 2_000_000,
  });
  return stdout.split('\n').flatMap((line) => {
    const row = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return row
      ? [
          {
            pid: Number(row[1]),
            parent: Number(row[2]),
            group: Number(row[3]),
            state: row[4]!,
            started: row[5]!,
          },
        ]
      : [];
  });
}
const sameProcess = (a: ProcessIdentity | undefined, b: ProcessIdentity) => a?.started === b.started;
const signalPid = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

/** Trusted supervisor only. Chromium creates a separate process group, outside the launcher's group. */
export async function terminateProcessTree(child: ChildProcess, graceMs = 1500) {
  if (!child.pid) return;
  const owned = new Map<number, ProcessIdentity>();
  const groups = new Map<number, ProcessIdentity>();
  try {
    const rows = await processTable();
    const root = rows.find((row) => row.pid === child.pid);
    if (!root || child.exitCode !== null || child.signalCode !== null) return;
    owned.set(root.pid, root);
    const refresh = (table: ProcessIdentity[]) => {
      const live = new Map(
        table.filter((row) => sameProcess(owned.get(row.pid), row)).map((row) => [row.pid, row]),
      );
      // Keep a group only while one of its known members survives; never adopt a reused PID/group.
      for (const [id, leader] of groups) {
        const currentLeader = table.find((row) => row.pid === id);
        if (
          (currentLeader && !sameProcess(leader, currentLeader)) ||
          ![...live.values()].some((row) => row.group === id)
        )
          groups.delete(id);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of table) {
          if (live.has(row.pid) || (!live.has(row.parent) && !groups.has(row.group))) continue;
          owned.set(row.pid, row);
          live.set(row.pid, row);
          changed = true;
        }
      }
      for (const row of live.values()) if (row.pid === row.group) groups.set(row.pid, row);
      return [...live.values()].filter((row) => !row.state.startsWith('Z'));
    };
    const send = (live: ProcessIdentity[], signal: NodeJS.Signals) => {
      for (const group of groups.keys())
        if (live.some((row) => row.group === group)) signalPid(-group, signal);
      for (const row of live) if (!groups.has(row.group)) signalPid(row.pid, signal);
    };
    let live = refresh(rows);
    send(live, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (live.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      live = refresh(await processTable());
    }
    if (live.length) {
      send(live, 'SIGKILL');
      for (let attempt = 0; live.length && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        live = refresh(await processTable());
      }
    }
    if (live.length) throw new Error(`Processes remain: ${live.map((row) => row.pid).join(',')}`);
  } catch (error) {
    // Always stop the known launcher, but surface incomplete tree cleanup instead of claiming success.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw new FilmError(
      'PROCESS_CLEANUP_FAILED',
      `无法确认子进程已全部退出：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
