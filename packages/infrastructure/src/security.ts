import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { hash, invariant, within } from '../../core/src/util.js';
import type { TaskSpec } from '../../core/src/domain.js';

export type PathGrant = { path: string; kind: 'file' | 'directory' };
export type PolicyData = {
  version: string;
  workspace: string;
  reads: PathGrant[];
  writes: PathGrant[];
  denies: string[];
  originals: PathGrant[];
};
async function resolveExistingParent(input: string): Promise<string> {
  const absolute = path.resolve(input);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    invariant(parent !== absolute, 'PATH_INVALID', `Cannot resolve ${input}`);
    return path.join(await resolveExistingParent(parent), path.basename(absolute));
  }
}
async function grant(input: string, mustExist: boolean): Promise<PathGrant> {
  const resolved = mustExist ? await realpath(path.resolve(input)) : await resolveExistingParent(input);
  const info = await stat(resolved).catch(() => undefined);
  invariant(!mustExist || info, 'PATH_MISSING', `Path does not exist: ${input}`);
  return { path: resolved, kind: info?.isFile() ? 'file' : 'directory' };
}
const covers = (grant: PathGrant, file: string) =>
  grant.kind === 'file' ? grant.path === file : within(grant.path, file);

export class PathPolicy {
  constructor(public readonly data: PolicyData) {}
  static async create(workspace: string, spec: Pick<TaskSpec, 'materials' | 'access'>): Promise<PathPolicy> {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const work = await grant(workspace, true);
    const originals = await Promise.all(spec.materials.paths.map((p) => grant(p, true)));
    const data = {
      workspace: work.path,
      reads: [work, ...originals, ...(await Promise.all(spec.access.readPaths.map((p) => grant(p, true))))],
      writes: [work, ...(await Promise.all(spec.access.writePaths.map((p) => grant(p, false))))],
      denies: await Promise.all(spec.access.denyPaths.map(resolveExistingParent)),
      originals,
    };
    invariant(
      !data.denies.some((p) => within(p, work.path)),
      'POLICY_INVALID',
      'The task workspace cannot be denied',
    );
    invariant(
      !originals.some((p) => covers(p, work.path)),
      'POLICY_INVALID',
      'Task workspace must be outside original material directories',
    );
    return new PathPolicy({ ...data, version: hash(data) });
  }
  async check(input: string, mode: 'read' | 'write'): Promise<string> {
    invariant(!input.includes('\0'), 'PATH_INVALID', 'NUL is not allowed in a path');
    const lexical = path.resolve(input);
    const resolved = mode === 'read' ? await realpath(lexical) : await resolveExistingParent(lexical);
    invariant(
      !this.data.denies.some((p) => within(p, resolved) || within(p, lexical)),
      'PATH_DENIED',
      `Denied path: ${input}`,
    );
    // Check both names: a symlink cannot turn a denied/ungranted path into a capability.
    const list = mode === 'read' ? [...this.data.reads, ...this.data.writes] : this.data.writes;
    invariant(
      list.some((p) => covers(p, resolved)),
      'PATH_DENIED',
      `No ${mode} grant for ${input}`,
    );
    if (mode === 'write')
      invariant(
        !this.data.originals.some((p) => covers(p, resolved)),
        'READ_ONLY_MATERIAL',
        `Original material is read-only: ${input}`,
      );
    return resolved;
  }
  async read(input: string): Promise<Buffer> {
    const file = await this.check(input, 'read');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  async write(input: string, contents: string | Buffer): Promise<void> {
    const file = await this.check(input, 'write');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await this.check(file, 'write');
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
  }
  async isSymlink(input: string) {
    return (await lstat(input)).isSymbolicLink();
  }
}
