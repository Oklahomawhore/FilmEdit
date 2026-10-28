import path from 'node:path';
import { mkdir, open, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { Store } from '../../../packages/infrastructure/src/store.js';
import { createApi } from './service.js';
import { loadProjectEnv } from '../../../packages/infrastructure/src/model-provider.js';
import { errorInfo, invariant } from '../../../packages/core/src/util.js';

export async function startDaemon(home?: string, port = 0) {
  await loadProjectEnv();
  home = path.resolve(home ?? process.env.FILMEDIT_HOME ?? '.filmedit');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, 'daemon.lock');
  const claim = async () => {
    const file = await open(lock, 'wx', 0o600);
    await file.writeFile(JSON.stringify({ pid: process.pid }));
    await file.close();
  };
  try {
    await claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner: { pid: number };
    try {
      owner = JSON.parse(await readFile(lock, 'utf8'));
    } catch {
      throw new Error('Daemon is starting; retry shortly');
    }
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    invariant(!alive, 'DAEMON_BUSY', 'Another server owns this FILMEDIT_HOME');
    await rm(lock);
    await claim();
  }
  let store: Store | undefined;
  let api: ReturnType<typeof createApi> | undefined;
  try {
    store = new Store(home);
    api = createApi(store);
    await new Promise<void>((resolve, reject) => {
      api!.server.once('error', reject);
      api!.server.listen(port, '127.0.0.1', resolve);
    });
    const address = api.server.address();
    invariant(address && typeof address !== 'string', 'SERVER_ADDRESS', 'No server address');
    const descriptor = { url: `http://127.0.0.1:${address.port}`, token: api.token, pid: process.pid };
    const temporary = path.join(home, `daemon.${process.pid}.json`);
    await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 });
    await rename(temporary, path.join(home, 'daemon.json'));
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await api!.workbench.close();
      api!.server.closeAllConnections();
      await new Promise<void>((r) => api!.server.close(() => r()));
      store!.close();
      await rm(path.join(home, 'daemon.json'), { force: true });
      await rm(lock, { force: true });
    };
    process.once('SIGTERM', () => void close());
    process.once('SIGINT', () => void close());
    return { ...api, close, url: descriptor.url };
  } catch (error) {
    if (api) await api.workbench.close();
    api?.server.close();
    store?.close();
    await rm(lock, { force: true });
    throw error;
  }
}
if (process.argv[1]?.endsWith('/daemon.js') || process.argv[1]?.endsWith('/daemon.ts'))
  startDaemon(undefined, Number(process.env.FILMEDIT_PORT ?? 0))
    .then((api) => process.stdout.write(`FilmEdit listening at ${api.url}\n`))
    .catch((e) => {
      process.stderr.write(JSON.stringify(errorInfo(e)) + '\n');
      process.exitCode = 1;
    });
