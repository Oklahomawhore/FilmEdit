import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FilmError, hash, invariant, within } from '../../core/src/util.js';
import type { PathGrant } from '../../infrastructure/src/security.js';
import { AssetLibrary, mediaKind } from './assets.js';
import { assetSummary, catalogQuerySchema, materialPage } from './catalog.js';

export const localBrowseSchema = catalogQuerySchema.extend({
  sourceId: z.string().optional(),
  relativePath: z.string().default('.'),
});
export const localImportSchema = z.object({
  sourceId: z.string(),
  relativePath: z.string().default('.'),
});

// This is a view over current read grants, not another persistent asset index.
// Discovery reads directory metadata only. Importing a selected file creates the task Asset.
export class LocalMaterials {
  constructor(readonly library: AssetLibrary) {}

  private sources() {
    return this.library.policy.data.reads
      .filter((grant) => !within(this.library.policy.data.workspace, grant.path))
      .filter((grant, index, all) => all.findIndex((other) => other.path === grant.path) === index)
      .map((grant) => ({ ...grant, sourceId: hash(grant) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private async resolve(source: PathGrant, relativePath: string) {
    this.library.processes.signal?.throwIfAborted();
    invariant(
      !path.isAbsolute(relativePath) &&
        !relativePath.includes('\0') &&
        !relativePath.split(path.sep).includes('..'),
      'PATH_DENIED',
      'Select a relative path within this source',
    );
    const file = path.resolve(source.path, relativePath);
    invariant(
      source.kind === 'file' ? file === source.path : within(source.path, file),
      'PATH_DENIED',
      'A file grant does not include its parent or siblings',
    );
    // Even a link into another allowed grant is not part of this selected source.
    let component = source.path;
    const parts = path.relative(source.path, file).split(path.sep).filter(Boolean);
    for (const part of [null, ...parts]) {
      if (part !== null) component = path.join(component, part);
      invariant(!(await lstat(component)).isSymbolicLink(), 'PATH_DENIED', 'Symlinks are not browsable');
    }
    const resolved = await this.library.policy.check(file, 'read');
    invariant(resolved === file, 'PATH_DENIED', 'The source path changed during discovery');
    return file;
  }

  private source(sourceId: string) {
    const source = this.sources().find((source) => source.sourceId === sourceId);
    invariant(source, 'PATH_DENIED', 'Source is not in the current task read grants');
    return source;
  }

  async browse(input: z.input<typeof localBrowseSchema> = {}) {
    const { sourceId, relativePath, offset, limit } = localBrowseSchema.parse(input);
    if (sourceId === undefined) {
      invariant(relativePath === '.', 'PATH_DENIED', 'Choose a source before browsing a directory');
      const sources = [];
      for (const source of this.sources()) {
        try {
          await this.resolve(source, '.');
          if (source.kind === 'directory' || mediaKind(source.path)) sources.push(source);
        } catch (error) {
          if (!(error instanceof FilmError && error.code === 'PATH_DENIED')) throw error;
        }
      }
      return materialPage(sources, offset, limit);
    }
    const source = this.source(sourceId);
    const directory = await this.resolve(source, relativePath);
    invariant((await lstat(directory)).isDirectory(), 'MEDIA_DIRECTORY', 'Select a directory to browse');
    const entries: { relativePath: string; kind: 'directory' | NonNullable<ReturnType<typeof mediaKind>> }[] =
      [];
    for (const name of (await readdir(directory)).sort()) {
      const relative = path.relative(source.path, path.join(directory, name));
      try {
        const file = await this.resolve(source, relative);
        const info = await lstat(file);
        const kind = info.isDirectory() ? 'directory' : info.isFile() ? mediaKind(file) : undefined;
        if (kind) entries.push({ relativePath: relative, kind });
      } catch (error) {
        if (!(error instanceof FilmError && error.code === 'PATH_DENIED')) throw error;
      }
    }
    await this.resolve(source, relativePath);
    return materialPage(entries, offset, limit);
  }

  async import(input: z.input<typeof localImportSchema>) {
    const { sourceId, relativePath } = localImportSchema.parse(input);
    const file = await this.resolve(this.source(sourceId), relativePath);
    invariant((await lstat(file)).isFile(), 'MEDIA_FILE', 'Select one media file, not a directory');
    return assetSummary(await this.library.importFile(file, 'local'));
  }
}
