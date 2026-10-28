import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../packages/infrastructure/src/store.js';
import { ReleaseManager } from '../../packages/infrastructure/src/releases.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { skillsForRole } from '../../packages/agent-runtime/src/agents.js';
import { projectRoot } from '../../packages/infrastructure/src/process.js';
import { editorialSchema } from '../../packages/core/src/domain.js';
import { defaultRender } from '../../packages/core/src/ir.js';
import { Renderer } from '../../packages/media/src/render.js';
test(
  'candidate regression gates, atomic activation, version pinning and rollback',
  { timeout: 180000 },
  async (t) => {
    const store = new Store(await mkdtemp(path.join(tmpdir(), 'filmedit-release-')));
    t.after(() => store.close());
    const releases = new ReleaseManager(store);
    const oldTask = await createTask(store, { prompt: 'before' });
    const learnedVoice = 'Versioned creator voice for fixture';
    const originalFilters = await readFile(
      path.join(projectRoot, 'packages/media/src/techniques.ts'),
      'utf8',
    );
    const candidate = await releases.prepare({
      files: [
        { path: 'skills/human-voice/SKILL.md', content: learnedVoice },
        {
          path: 'packages/media/src/techniques.ts',
          content: originalFilters.replace('return filters;', "return [...filters, 'hue=s=0'];"),
        },
      ],
    });
    assert.ok((await skillsForRole(store, 'script', candidate.releaseId)).includes(learnedVoice));
    assert.ok(!(await skillsForRole(store, 'voice_review', candidate.releaseId)).includes(learnedVoice));
    assert.ok(!(await skillsForRole(store, 'script', 'builtin_v1')).includes(learnedVoice));
    await assert.rejects(
      releases.activate(candidate.releaseId, { passed: true, heldOutPassed: 3, evidenceHash: 'fixture' }),
      { code: 'RELEASE_GATE' },
    );
    await releases.test(candidate.releaseId);
    await assert.rejects(
      releases.activate(candidate.releaseId, { passed: true, heldOutPassed: 2, evidenceHash: 'fixture' }),
      { code: 'RELEASE_GATE' },
    );
    await releases.activate(candidate.releaseId, { passed: true, heldOutPassed: 3, evidenceHash: 'fixture' });
    const next = await createTask(store, { prompt: 'after' });
    assert.equal(next.releaseId, candidate.releaseId);
    assert.equal(store.task(oldTask.id).releaseId, 'builtin_v1');
    const runner = new TaskRunner(store, next.id),
      source = path.join(next.policy.workspace, 'source.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=64x64:r=8:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      source,
    ]);
    const asset = await runner.library.importFile(source, 'generated');
    const edit = editorialSchema.parse({
      schemaVersion: 1,
      revision: 0,
      duration: 1,
      shots: [{ id: 'one', assetId: asset.id, sourceStart: 0, start: 0, duration: 1 }],
    });
    const layout = defaultRender(edit, { width: 128, height: 128, fps: 8 });
    const movie = await new Renderer(runner.library, runner.processes).render(edit, layout);
    const frame = path.join(next.policy.workspace, 'frame.rgb');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      movie.path,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      frame,
    ]);
    const rgb = await readFile(frame);
    assert.ok(
      Math.abs(rgb[0]! - rgb[1]!) < 5 && Math.abs(rgb[1]! - rgb[2]!) < 5 && rgb[0]! > 25,
      'published video filters must affect actual media, not just be stored as code',
    );
    const forbidden = path.join(next.policy.workspace, 'unselected-reference.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=64x64:r=8:d=1',
      '-c:v',
      'libx264',
      forbidden,
    ]);
    const badFilters = await releases.prepare({
      files: [
        {
          path: 'packages/media/src/techniques.ts',
          content: originalFilters.replace(
            'return filters;',
            `return [${JSON.stringify(`movie=${forbidden}[other];[in][other]overlay`)}];`,
          ),
        },
      ],
    });
    await releases.test(badFilters.releaseId);
    await assert.rejects(
      new Renderer(runner.library, runner.processes, badFilters.releaseId).render(edit, layout),
      /Operation not permitted|Permission denied/,
      'learned FFmpeg filters cannot read other task or reference media',
    );
    assert.equal(
      store.activeRelease(),
      candidate.releaseId,
      'a failed candidate cannot replace the active release',
    );
    assert.equal(releases.rollback('fixture regression'), 'builtin_v1');
    assert.equal(store.task(next.id).releaseId, candidate.releaseId);
    await appendFile(path.join(candidate.directory, 'dist', 'render.js'), '\n// unexpected modification\n');
    await assert.rejects(releases.verify(candidate.releaseId), { code: 'RELEASE_CHANGED' });
  },
);
