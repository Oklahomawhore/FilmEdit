import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { fixture } from '../helpers.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import { defaultRender } from '../../packages/core/src/ir.js';
import { Renderer } from '../../packages/media/src/render.js';
import { projectRoot } from '../../packages/infrastructure/src/process.js';

const models = process.env.FILMEDIT_MODEL_DIR ?? path.join(projectRoot, '.filmedit/models');
const python = process.env.FILMEDIT_PYTHON ?? path.join(projectRoot, '.venv/bin/python');
const portrait = path.join(projectRoot, '.venv/lib/python3.12/site-packages/skimage/data/astronaut.png');

test(
  'local portrait segmentation keeps image duration and video alpha through actual composition',
  {
    timeout: 180000,
    skip: ![python, portrait, path.join(models, 'matte/u2net.onnx')].every(existsSync)
      ? 'Provision local U2Net and the public scikit-image astronaut fixture first'
      : false,
  },
  async (t) => {
    const previous = {
      FILMEDIT_MODEL_DIR: process.env.FILMEDIT_MODEL_DIR,
      FILMEDIT_PYTHON: process.env.FILMEDIT_PYTHON,
    };
    Object.assign(process.env, { FILMEDIT_MODEL_DIR: models, FILMEDIT_PYTHON: python });
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const { store } = await fixture();
    t.after(() => store.close());
    const task = await createTask(store, {
      prompt: '人像分割验收',
      materials: { paths: [portrait], strategy: 'local_only' },
    });
    const runner = new TaskRunner(store, task.id);
    const picture = await runner.library.importFile(portrait, 'local');
    const videoPath = path.join(task.policy.workspace, 'portrait.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-loop',
      '1',
      '-i',
      portrait,
      '-t',
      '3',
      '-vf',
      'scale=256:256,fps=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ]);
    const video = await runner.library.importFile(videoPath, 'generated');
    const edit = editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration: 3,
      shots: [
        {
          id: 'still',
          assetId: picture.id,
          sourceStart: 0,
          start: 0,
          duration: 1.5,
          techniques: [{ id: 'portrait_matte', version: 1, params: {} }],
        },
        {
          id: 'moving',
          assetId: video.id,
          sourceStart: 0,
          start: 1.5,
          duration: 1.5,
          techniques: [{ id: 'portrait_matte', version: 1, params: {} }],
        },
      ],
    });
    const layout = defaultRender(edit, { width: 256, height: 256, fps: 2 });
    layout.canvas.background = '#0000ff';
    const rendered = await new Renderer(runner.library, runner.processes).render(edit, layout);
    for (const time of [1, 2.5]) {
      const frame = path.join(rendered.exportDirectory, `check-${time}.rgb`);
      await runner.processes.run('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        String(time),
        '-i',
        rendered.path,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        frame,
      ]);
      const rgb = await readFile(frame);
      assert.equal(rgb.length, 256 * 256 * 3);
      let background = 0,
        person = 0;
      for (let i = 0; i < rgb.length; i += 3) {
        if (rgb[i]! < 40 && rgb[i + 1]! < 40 && rgb[i + 2]! > 180) background++;
        if (rgb[i]! > 80 && rgb[i + 1]! > 40 && rgb[i + 2]! < 180) person++;
      }
      assert.ok(background > 256 * 256 * 0.2, `transparent background must reveal blue at ${time}s`);
      assert.ok(person > 256 * 256 * 0.15, `person must remain visible at ${time}s`);
    }
    const videoFrames = await readdir(path.join(rendered.directory, 'matte', 'moving'));
    assert.equal(videoFrames.filter((name) => name.startsWith('alpha-')).length, 3);
  },
);
