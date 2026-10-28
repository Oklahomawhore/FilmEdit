import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { FilmError, invariant } from '../../core/src/util.js';
import { PathPolicy } from './security.js';
import { terminateProcessTree } from './process-tree.js';

function findRoot() {
  let folder = path.dirname(fileURLToPath(import.meta.url));
  while (folder !== path.dirname(folder)) {
    try {
      if (JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8')).name === 'filmedit-agent')
        return folder;
    } catch {
      /* next parent */
    }
    folder = path.dirname(folder);
  }
  throw new Error('FilmEdit installation root not found');
}
export const projectRoot = findRoot();
export const runtimeScript = (name: string) =>
  path.join(projectRoot, 'dist', 'apps', name === 'daemon.js' ? 'server' : 'worker', 'src', name);
export type ProcessResult = { stdout: string; stderr: string; code: number };
export const cleanEnvironment = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  ...extra,
});
export async function executable(name: string): Promise<string> {
  if (path.isAbsolute(name)) {
    await access(name);
    return name;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, name);
    try {
      await access(file);
      return file;
    } catch {
      /* next PATH directory */
    }
  }
  throw new FilmError('DEPENDENCY_MISSING', `Executable not found: ${name}`);
}
export class ProcessRunner {
  constructor(
    readonly policy: PathPolicy,
    readonly signal?: AbortSignal,
  ) {}
  async spawnOptions(
    command: string,
    args: string[],
    options: { domains?: string[]; env?: NodeJS.ProcessEnv; extraReads?: string[]; browser?: boolean } = {},
  ) {
    const binary = await executable(command);
    const resolvedBinary = await realpath(binary);
    const work = this.policy.data.workspace;
    const runtimeRoots = [
      '/usr',
      '/bin',
      '/sbin',
      '/System',
      '/Library/Fonts',
      '/Library/Apple',
      '/etc',
      '/private/etc',
      '/dev',
      '/opt/homebrew',
      '/proc',
      '/sys',
      '/lib',
      '/lib64',
      binary,
      resolvedBinary,
      path.join(projectRoot, 'node_modules'),
      path.join(projectRoot, 'apps'),
      path.join(projectRoot, 'packages'),
      path.join(projectRoot, 'dist'),
      path.join(projectRoot, 'python'),
      path.join(projectRoot, 'skills'),
      ...(options.extraReads ?? []),
    ];
    for (const candidate of [binary, resolvedBinary]) {
      const environment = path.dirname(path.dirname(candidate));
      if (existsSync(path.join(environment, 'pyvenv.cfg'))) {
        runtimeRoots.push(environment);
        // A venv links to its base interpreter. uv/pyenv keep its standard library
        // outside system directories, so grant that one Python installation read access.
        if (
          path.basename(path.dirname(resolvedBinary)) === 'bin' &&
          /^python(?:\d+(?:\.\d+)?)?$/.test(path.basename(resolvedBinary))
        )
          runtimeRoots.push(path.dirname(path.dirname(resolvedBinary)));
      }
    }
    const temporary = path.join(work, 'tmp');
    await mkdir(temporary, { recursive: true });
    const reads = [
      ...runtimeRoots,
      ...this.policy.data.reads.map((p) => p.path),
      ...this.policy.data.writes.map((p) => p.path),
    ].filter((p) => !this.policy.data.denies.some((d) => p === d || p.startsWith(`${d}${path.sep}`)));
    const settings = {
      filesystem: {
        denyRead: ['/', ...this.policy.data.denies].map((p) => ({ path: p, literal: true })),
        allowRead: reads.map((p) => ({ path: p, literal: true })),
        allowWrite: this.policy.data.writes.map((p) => ({ path: p.path, literal: true })),
        denyWrite: [...this.policy.data.denies, ...this.policy.data.originals.map((p) => p.path)].map(
          (p) => ({ path: p, literal: true }),
        ),
      },
      network: { allowedDomains: options.domains ?? [], deniedDomains: [], allowLocalBinding: true },
      enableWeakerNetworkIsolation: false,
    };
    // Additional denyRead entries are retained after broad grants, including cached source directories.
    const payload = Buffer.from(
      JSON.stringify({ command: binary, args, settings, browser: options.browser ?? false }),
    ).toString('base64url');
    const env = cleanEnvironment({
      HOME: work,
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      XDG_CACHE_HOME: path.join(work, 'cache'),
      ...options.env,
    });
    const childScript = runtimeScript('sandbox-child.js');
    return { command: process.execPath, args: [childScript, payload], cwd: work, env };
  }
  async run(
    command: string,
    args: string[],
    options: {
      domains?: string[];
      env?: NodeJS.ProcessEnv;
      extraReads?: string[];
      browser?: boolean;
      timeoutMs?: number;
      maxOutput?: number;
      input?: string;
    } = {},
  ): Promise<ProcessResult> {
    const prepared = await this.spawnOptions(command, args, options);
    return collect(
      spawn(prepared.command, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      }),
      {
        signal: this.signal,
        timeoutMs: options.timeoutMs,
        maxOutput: options.maxOutput,
        input: options.input,
      },
    );
  }
}
export async function collect(
  child: ChildProcess,
  options: { signal?: AbortSignal; timeoutMs?: number; maxOutput?: number; input?: string } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '';
    let done = false;
    let failure: Error | undefined;
    let termination: Promise<void> | undefined;
    let cleanupFailure: Error | undefined;
    const stop = (reason: Error) => {
      if (failure || done) return;
      failure = reason;
      termination = terminateProcessTree(child).catch((error) => {
        cleanupFailure = error;
      });
    };
    const abort = () => stop(new FilmError('CANCELLED', 'Operation cancelled'));
    const timer = setTimeout(
      () => stop(new FilmError('PROCESS_TIMEOUT', 'Process exceeded its time limit')),
      options.timeoutMs ?? 300000,
    );
    timer.unref();
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (target === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > (options.maxOutput ?? 8_000_000))
        stop(new FilmError('PROCESS_OUTPUT_LIMIT', 'Process output exceeded limit'));
    };
    child.stdout?.on('data', (c) => append('stdout', c));
    child.stderr?.on('data', (c) => append('stderr', c));
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.on('error', (e) => {
      if (!done) {
        done = true;
        cleanup();
        reject(e);
      }
    });
    child.on('close', async (code) => {
      if (done) return;
      done = true;
      cleanup();
      await termination;
      if (cleanupFailure) reject(cleanupFailure);
      else if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new FilmError(
            'PROCESS_FAILED',
            `Process exited ${code}: ${[stdout.trim(), stderr.trim()].filter(Boolean).join('\n').slice(-6000)}`,
            { code },
          ),
        );
      else resolve({ stdout, stderr, code: code ?? -1 });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    if (options.input) child.stdin?.write(options.input);
    child.stdin?.end();
  });
}
export async function versionOf(command: string) {
  try {
    const binary = await executable(command);
    const result = await collect(
      spawn(binary, [/^ff(?:mpeg|probe)$/.test(path.basename(command)) ? '-version' : '--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      }),
      { timeoutMs: 15000 },
    );
    return { available: true, binary, version: (result.stdout || result.stderr).split('\n')[0] };
  } catch (e) {
    return { available: false, error: e instanceof Error ? e.message : String(e) };
  }
}
