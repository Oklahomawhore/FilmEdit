// Controlled media fixtures for the real learning Agent; no generated hypothesis or solution is supplied.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadProjectEnv } from '../packages/infrastructure/src/model-provider.ts';
import { PathPolicy } from '../packages/infrastructure/src/security.ts';
import { ProcessRunner } from '../packages/infrastructure/src/process.ts';
import { videoSignature, compareSignatures } from '../packages/media/src/comparison.ts';

await loadProjectEnv();
const root = path.resolve('.filmedit/verification/product-20261023/technique-fixtures');
const data = path.resolve('.venv/lib/python3.12/site-packages/skimage/data');
const images = ['astronaut.png', 'camera.png', 'coffee.png', 'chelsea.png', 'rocket.jpg'];
await mkdir(root, { recursive: true });
const policy = await PathPolicy.create(path.join(root, 'runtime'), {
  materials: { paths: images.map((image) => path.join(data, image)), strategy: 'local_only' },
  access: { readPaths: [], writePaths: [root], denyPaths: [] },
});
const runner = new ProcessRunner(policy);
const paths = [];
for (let i = 0; i < images.length; i++) {
  const output = path.join(root, i === 0 ? 'reference.mp4' : `material-${i}.mp4`);
  const fit =
    'scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2:black,fps=12';
  await runner.run('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-loop',
    '1',
    '-i',
    path.join(data, images[i]),
    '-t',
    '5',
    '-vf',
    i === 0 ? `${fit},fade=t=in:st=0:d=1,fade=t=out:st=4:d=1` : fit,
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    output,
  ]);
  paths.push(output);
}
const reference = await videoSignature(paths[0], runner);
const unedited = await videoSignature(paths[1], runner);
const baseline = compareSignatures(reference, unedited, 12);
const control = path.join(root, 'unedited-reference.mp4');
await runner.run('ffmpeg', [
  '-nostdin',
  '-v',
  'error',
  '-y',
  '-loop',
  '1',
  '-i',
  path.join(data, images[0]),
  '-t',
  '5',
  '-vf',
  'scale=256:256,fps=12',
  '-an',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  control,
]);
const missingEffect = compareSignatures(reference, await videoSignature(control, runner), 12);
const transfers = [];
for (let i = 1; i < paths.length; i++) {
  const output = path.join(root, `control-fade-${i}.mp4`);
  await runner.run('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-i',
    paths[i],
    '-vf',
    'fade=t=in:st=0:d=1,fade=t=out:st=4:d=1',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    output,
  ]);
  transfers.push(compareSignatures(reference, await videoSignature(output, runner), 12));
}
await writeFile(
  path.join(root, 'fixture-manifest.json'),
  JSON.stringify(
    {
      source: 'Installed scikit-image sample data',
      paths,
      target: { fadeInSeconds: 1, holdSeconds: 3, fadeOutSeconds: 1 },
      reference,
      unedited,
      baseline,
      missingEffect,
      transfers,
      note: 'This controlled engineering experiment does not prove learning from arbitrary internet videos.',
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ paths, uneditedBaseline: baseline, missingEffect, transfers }));
if (baseline.passed || missingEffect.passed || transfers.some((value) => !value.passed))
  throw new Error('Technique comparison controls failed');
