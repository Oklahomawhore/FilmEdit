import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [modulePath, project, operation] = process.argv.slice(2);
if (!modulePath || !project || !['html', 'filters'].includes(operation ?? ''))
  throw new Error('compiler-worker requires module, directory and operation');
const { editorial, render, prepared } = JSON.parse(await readFile(path.join(project, 'input.json'), 'utf8'));
const implementation = await import(pathToFileURL(modulePath).href);
if (operation === 'html') {
  const html = implementation.compileHtml(editorial, render, new Map(prepared));
  if (typeof html !== 'string' || html.length > 5_000_000)
    throw new Error('Compiler must produce bounded HTML');
  await writeFile(path.join(project, 'output.html'), html);
} else {
  const filters = Object.fromEntries(
    editorial.shots.map((shot: { id: string }) => [shot.id, implementation.videoFilters(shot)]),
  );
  const output = JSON.stringify(filters);
  if (output.length > 1_000_000) throw new Error('Compiler must produce bounded filters');
  await writeFile(path.join(project, 'output.json'), output);
}
