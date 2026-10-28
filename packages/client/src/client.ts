import { readFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { FilmError, invariant } from '../../core/src/util.js';
import { projectRoot, runtimeScript } from '../../infrastructure/src/process.js';

export type Connection = { url: string; token: string; pid: number };
export class FilmClient {
  constructor(readonly connection: Connection) {}
  async request(route: string, method = 'GET', value?: unknown, signal?: AbortSignal): Promise<any> {
    const response = await fetch(`${this.connection.url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.connection.token}`,
        ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: value === undefined ? undefined : JSON.stringify(value),
      signal: signal ?? AbortSignal.timeout(30000),
    });
    const result = (await response.json()) as any;
    if (!response.ok)
      throw new FilmError(result.code ?? 'API_ERROR', result.message ?? response.statusText, result.details);
    return result;
  }
  command(
    command: string,
    args: Record<string, unknown> = {},
    taskId?: string,
    requestId = crypto.randomUUID(),
  ) {
    return this.request('/commands', 'POST', { requestId, command, args, taskId });
  }
  async *events(options: { after?: number; taskId?: string; conversationId?: string; signal: AbortSignal }) {
    let cursor = options.after ?? 0;
    while (!options.signal.aborted) {
      try {
        const query = new URLSearchParams({
          after: String(cursor),
          ...(options.taskId ? { taskId: options.taskId } : {}),
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        });
        const response = await fetch(`${this.connection.url}/events?${query}`, {
          headers: { Authorization: `Bearer ${this.connection.token}`, 'Last-Event-ID': String(cursor) },
          signal: options.signal,
        });
        invariant(response.ok && response.body, 'EVENT_STREAM', 'Cannot subscribe to task events');
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = '';
        try {
          while (!options.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = block.split('\n').find((line) => line.startsWith('data: '));
              if (!data) continue;
              const event = JSON.parse(data.slice(6));
              if (event.seq > cursor) {
                cursor = event.seq;
                yield event;
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch (error) {
        if (options.signal.aborted) break;
        if (error instanceof FilmError && error.code === 'UNAUTHORIZED') throw error;
      }
      if (!options.signal.aborted)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1000);
          function done() {
            clearTimeout(timer);
            options.signal.removeEventListener('abort', done);
            resolve();
          }
          options.signal.addEventListener('abort', done, { once: true });
        });
    }
  }
}
export async function connect(home?: string, autoStart = true): Promise<FilmClient> {
  let configured: string | undefined;
  try {
    configured = parseEnv(await readFile(path.join(projectRoot, '.env'), 'utf8')).FILMEDIT_HOME;
  } catch {}
  home = path.resolve(home ?? process.env.FILMEDIT_HOME ?? configured ?? '.filmedit');
  const descriptor = path.join(home, 'daemon.json');
  const read = async () => {
    const connection = JSON.parse(await readFile(descriptor, 'utf8')) as Connection;
    const url = new URL(connection.url);
    invariant(
      url.hostname === '127.0.0.1' && url.protocol === 'http:',
      'DAEMON_ADDRESS',
      'Only the local FilmEdit daemon is supported',
    );
    const client = new FilmClient(connection);
    await client.request('/health', 'GET', undefined, AbortSignal.timeout(1200));
    return client;
  };
  try {
    return await read();
  } catch (error) {
    if (!autoStart) throw error;
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const log = await open(path.join(home, 'server.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [runtimeScript('daemon.js')], {
      cwd: projectRoot,
      env: { ...process.env, FILMEDIT_HOME: home },
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    child.unref();
  } finally {
    await log.close();
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      return await read();
    } catch {
      /* lock owner may still be starting */
    }
  }
  throw new FilmError('DAEMON_START', 'Server did not start; inspect ' + path.join(home, 'server.log'));
}
