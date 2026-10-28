import { cp, mkdir, readFile, readdir, realpath, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { Store } from './store.js';
import { PathPolicy } from './security.js';
import { ProcessRunner, projectRoot } from './process.js';
import { canonical, hash, id, invariant, within } from '../../core/src/util.js';
import { z } from 'zod';

export const codePatchSchema = z
  .object({
    files: z.array(z.object({ path: z.string(), content: z.string().max(200000) }).strict()).max(20),
  })
  .strict();
export type CodePatch = z.infer<typeof codePatchSchema>;
const allowedCore = new Set(['packages/media/src/compositor.ts', 'packages/media/src/techniques.ts']);
export const learnableSkills = new Set([
  'script-draft',
  'human-voice',
  'material-match',
  'editorial-plan',
  'layout-compose',
]);
export function validateCodePatch(input: unknown): CodePatch {
  const patch = codePatchSchema.parse(input);
  for (const file of patch.files) {
    const normalized = path.posix.normalize(file.path);
    invariant(
      normalized === file.path &&
        !file.path.includes('\\') &&
        !path.isAbsolute(file.path) &&
        !file.path.startsWith('../'),
      'PATCH_PATH',
      `Invalid patch path ${file.path}`,
    );
    invariant(
      allowedCore.has(file.path) ||
        /^packages\/media\/src\/extensions\/[a-z0-9_-]+\.ts$/.test(file.path) ||
        (file.path.startsWith('skills/') &&
          file.path.endsWith('/SKILL.md') &&
          learnableSkills.has(file.path.split('/')[1]!) &&
          file.path.split('/').length === 3),
      'PATCH_PROTECTED',
      `Learning cannot update ${file.path}`,
    );
  }
  return patch;
}
export class ReleaseManager {
  constructor(readonly store: Store) {}
  async prepare(patch: CodePatch, parent = this.store.activeRelease()) {
    validateCodePatch(patch);
    const releaseId = id('release');
    const directory = path.join(this.store.home, 'releases', releaseId);
    await this.verify(parent);
    const base = parent === 'builtin_v1' ? projectRoot : this.get(parent).manifest.directory;
    await mkdir(directory, { recursive: true });
    for (const item of ['apps', 'packages', 'skills', 'tests', 'python', 'tsconfig.json', 'package.json'])
      await cp(path.join(item === 'tests' ? projectRoot : base, item), path.join(directory, item), {
        recursive: true,
      });
    await symlink(path.join(projectRoot, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    const policy = await PathPolicy.create(directory, {
      materials: { paths: [], strategy: 'local_only' },
      access: { readPaths: [], writePaths: [], denyPaths: [] },
    });
    for (const file of patch.files) await policy.write(path.join(directory, file.path), file.content);
    const manifest = {
      schemaVersion: 1,
      parent,
      directory,
      patchHash: hash(patch),
      compiler: path.join(directory, 'dist', 'packages', 'media', 'src', 'compositor.js'),
      filters: path.join(directory, 'dist', 'packages', 'media', 'src', 'techniques.js'),
      evaluator: 'protected-v1',
      files: await treeHashes(directory),
      created: new Date().toISOString(),
    };
    this.store.db
      .prepare('INSERT INTO releases(id,manifest,state) VALUES(?,?,?)')
      .run(releaseId, canonical(manifest), 'candidate');
    return { releaseId, directory, policy, manifest };
  }
  async test(releaseId: string, signal?: AbortSignal) {
    const row = this.get(releaseId);
    invariant(row.state === 'candidate', 'RELEASE_STATE', 'Only candidates can be tested');
    await this.verify(releaseId);
    const policy = await PathPolicy.create(row.manifest.directory, {
      materials: { paths: [], strategy: 'local_only' },
      access: { readPaths: [], writePaths: [], denyPaths: [] },
    });
    const runner = new ProcessRunner(policy, signal);
    const config = path.join(row.manifest.directory, 'tsconfig.json');
    const compile = await runner.run(
      process.execPath,
      [path.join(projectRoot, 'node_modules/typescript/bin/tsc'), '-p', config],
      { timeoutMs: 180000 },
    );
    const tests = (await readdir(path.join(row.manifest.directory, 'tests')))
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => path.join(row.manifest.directory, 'tests', f));
    invariant(tests.length > 0, 'RELEASE_TESTS', 'Release has no protected regression tests');
    const testPolicy = new PathPolicy({
      ...policy.data,
      originals: [
        'apps',
        'packages',
        'dist',
        'tests',
        'skills',
        'python',
        'package.json',
        'tsconfig.json',
      ].map((name) => ({
        path: path.join(row.manifest.directory, name),
        kind: name.includes('.') ? ('file' as const) : ('directory' as const),
      })),
    });
    const result = await new ProcessRunner(testPolicy, signal).run(
      process.execPath,
      ['--import', path.join(projectRoot, 'node_modules/tsx/dist/loader.mjs'), '--test', ...tests],
      { timeoutMs: 600000 },
    );
    // Candidate code runs in a subprocess. Recheck protected files after tests, not just before.
    await this.verify(releaseId);
    const manifest = {
      ...row.manifest,
      buildHash: hash(await treeHashes(path.join(row.manifest.directory, 'dist'))),
      tests: { passed: true, outputHash: hash({ compile, result }) },
    };
    this.store.db.prepare('UPDATE releases SET manifest=? WHERE id=?').run(canonical(manifest), releaseId);
    return manifest;
  }
  get(releaseId: string) {
    const row = this.store.db.prepare('SELECT * FROM releases WHERE id=?').get(releaseId);
    invariant(row, 'RELEASE_MISSING', 'Release not found');
    return { id: row.id as string, state: row.state as string, manifest: JSON.parse(row.manifest as string) };
  }
  async verify(releaseId: string) {
    const { manifest } = this.get(releaseId);
    if (releaseId === 'builtin_v1') return;
    invariant(
      within(path.join(this.store.home, 'releases'), await realpath(manifest.directory)),
      'RELEASE_PATH',
      'Release path escaped release storage',
    );
    invariant(
      (await realpath(path.join(manifest.directory, 'node_modules'))) ===
        (await realpath(path.join(projectRoot, 'node_modules'))),
      'RELEASE_DEPENDENCIES',
      'Release must use the pinned installation dependencies',
    );
    const current = await treeHashes(manifest.directory);
    for (const [file, digest] of Object.entries(manifest.files))
      invariant(current[file] === digest, 'RELEASE_CHANGED', `Release source modified: ${file}`);
    if (manifest.buildHash)
      invariant(
        hash(await treeHashes(path.join(manifest.directory, 'dist'))) === manifest.buildHash,
        'RELEASE_CHANGED',
        'Release build changed after verification',
      );
  }
  async activate(
    releaseId: string,
    evaluation: { passed: boolean; heldOutPassed: number; evidenceHash: string },
    onActivate?: () => void,
  ) {
    const row = this.get(releaseId);
    await this.verify(releaseId);
    invariant(
      row.state === 'candidate' &&
        row.manifest.tests?.passed &&
        evaluation.passed &&
        evaluation.heldOutPassed >= 3,
      'RELEASE_GATE',
      'Candidate requires protected tests and three held-out evaluations',
    );
    this.store.transaction(() => {
      const previous = this.store.activeRelease();
      this.store.db.prepare('UPDATE releases SET state=? WHERE id=?').run('retired', previous);
      this.store.db
        .prepare('UPDATE releases SET state=?,manifest=? WHERE id=?')
        .run('active', canonical({ ...row.manifest, evaluation }), releaseId);
      this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(releaseId, 'active_release');
      onActivate?.();
    });
    return releaseId;
  }
  rollback(reason: string) {
    const current = this.get(this.store.activeRelease());
    invariant(current.id !== 'builtin_v1', 'RELEASE_BASELINE', 'Already using built-in release');
    const previous = current.manifest.parent ?? 'builtin_v1';
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE releases SET state=?,manifest=? WHERE id=?')
        .run('failed', canonical({ ...current.manifest, rollbackReason: reason }), current.id);
      this.store.db.prepare('UPDATE releases SET state=? WHERE id=?').run('active', previous);
      this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(previous, 'active_release');
    });
    return previous;
  }
}
async function treeHashes(directory: string, relative = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'tmp', 'cache', '.claude'].includes(entry.name)) continue;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await treeHashes(directory, name));
    else if (entry.isFile()) result[name] = hash(await readFile(path.join(directory, name)));
    else invariant(false, 'RELEASE_SYMLINK', `Unexpected symlink in release: ${name}`);
  }
  return result;
}
