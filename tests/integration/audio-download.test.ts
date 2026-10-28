import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Store } from '../../packages/infrastructure/src/store.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { LocalLibrary } from '../../packages/library/src/library.js';
import { projectRoot } from '../../packages/infrastructure/src/process.js';
import type { FilmTool } from '../../packages/agent-runtime/src/pi-runtime.js';
import { fileHash } from '../../packages/infrastructure/src/files.js';

test(
  'sandboxed downloads accept direct video without resolution metadata and index actual audio/video streams',
  { timeout: 120000 },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'filmedit-audio-download-')));
    const store = new Store(path.join(root, 'state'));
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const task = await createTask(store, {
      prompt: 'audio transport fixture',
      materials: { strategy: 'web_first' },
    });
    const runner = new TaskRunner(store, task.id, AbortSignal.timeout(110000));
    const work = task.policy.workspace;
    const opus = path.join(work, 'tone.opus');
    const webm = path.join(work, 'tone.webm');
    const covered = path.join(work, 'covered.mp3');
    const cover = path.join(work, 'cover.jpg');
    const clip = path.join(work, 'clip.mp4');
    const silentClip = path.join(work, 'silent.mp4');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'libopus',
      opus,
    ]);
    await runner.processes.run('ffmpeg', ['-nostdin', '-v', 'error', '-i', opus, '-c:a', 'copy', webm]);
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32',
      '-frames:v',
      '1',
      '-pix_fmt',
      'yuvj420p',
      cover,
    ]);
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-i',
      opus,
      '-i',
      cover,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'libmp3lame',
      '-c:v',
      'copy',
      '-disposition:v:0',
      'attached_pic',
      '-id3v2_version',
      '3',
      covered,
    ]);
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=8:duration=2',
      '-i',
      opus,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      clip,
    ]);
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-i',
      clip,
      '-c:v',
      'copy',
      '-an',
      silentClip,
    ]);
    const originalHashes = await Promise.all([opus, webm, covered, clip].map(fileHash));
    const shared = new LocalLibrary(store);
    for (const source of [opus, webm, covered]) {
      const taskAsset = await runner.library.importFile(source, 'generated');
      const libraryAsset = await shared.importFile(source, 'sfx');
      for (const asset of [taskAsset, libraryAsset]) {
        assert.equal(asset.kind, 'audio', path.basename(source));
        assert.equal(asset.hasAudio, true);
        assert.equal(asset.width, undefined, 'album art is not a video track');
        assert.equal(asset.height, undefined);
        assert.ok(asset.duration > 1.9 && asset.duration < 2.2, `${source}: ${asset.duration}`);
      }
      const bound = await shared.bind(libraryAsset.id, runner.library);
      assert.equal(bound.kind, 'audio');
    }
    const video = await runner.library.importFile(clip, 'generated');
    assert.equal(video.kind, 'video');
    assert.equal(video.width, 160);
    assert.equal(video.hasAudio, true);

    // A trusted local CA keeps this transport test independent of public services.
    // Only certificate trust is injected; real yt-dlp/FFmpeg and the process sandbox remain enabled.
    const key = path.join(root, 'key.pem'),
      cert = path.join(root, 'cert.pem'),
      config = path.join(root, 'openssl.cnf');
    await writeFile(
      config,
      '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n',
    );
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      config,
      '-keyout',
      key,
      '-out',
      cert,
    ]);
    const bodies = new Map([
      ['/tone.opus', { data: await readFile(opus), type: 'audio/ogg' }],
      ['/clip.mp4', { data: await readFile(clip), type: 'video/mp4' }],
      ['/silent.mp4', { data: await readFile(silentClip), type: 'video/mp4' }],
      ['/covered.mp3', { data: await readFile(covered), type: 'audio/mpeg' }],
    ]);
    const requests: string[] = [];
    const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
      requests.push(req.url!);
      const body = bodies.get(req.url!);
      if (!body) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': body.type, 'Content-Length': body.data.length });
      res.end(req.method === 'HEAD' ? undefined : body.data);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const port = (server.address() as { port: number }).port;
    const execute = runner.processes.run.bind(runner.processes);
    t.mock.method(runner.processes, 'run', (command, args, options = {}) => {
      if (command !== 'yt-dlp') return execute(command, args, options);
      return execute(command, ['--compat-options', 'no-certifi', ...args], {
        ...options,
        extraReads: [cert],
        env: { SSL_CERT_FILE: cert },
      });
    });
    const tools = (runner.agent as any).createTools(
      { role: 'materials', instruction: '', input: {}, schema: z.any() },
      false,
    ) as FilmTool[];
    const download = tools.find((tool) => tool.name === 'download_material')!;
    for (const route of ['/clip.mp4', '/silent.mp4']) {
      const result = await download.execute({ url: `https://127.0.0.1:${port}${route}`, kind: 'video' });
      const summary = JSON.parse((result.content[0] as { text: string }).text);
      const downloaded = store.asset(task.id, summary.id);
      assert.equal(downloaded.kind, 'video');
      assert.equal(downloaded.width, 160);
      assert.equal(downloaded.height, 90);
      assert.equal(downloaded.hasAudio, route === '/clip.mp4');
      assert.equal(downloaded.source.url, `https://127.0.0.1:${port}${route}`);
      assert.ok(downloaded.source.path.startsWith(path.join(work, 'downloads')));
    }
    await assert.rejects(download.execute({ url: `https://127.0.0.1:${port}/covered.mp3`, kind: 'video' }), {
      code: 'MEDIA_KIND',
    });
    for (const route of ['/tone.opus', '/clip.mp4']) {
      const result = await download.execute({ url: `https://127.0.0.1:${port}${route}`, kind: 'audio' });
      const summary = JSON.parse((result.content[0] as { text: string }).text);
      const downloaded = store.asset(task.id, summary.id);
      assert.equal(downloaded.kind, 'audio');
      assert.equal(downloaded.hasAudio, true);
      assert.ok(downloaded.duration > 1.9 && downloaded.duration < 2.2);
      assert.ok(downloaded.source.path.startsWith(path.join(work, 'downloads')));
      assert.equal(downloaded.source.url, `https://127.0.0.1:${port}${route}`);
      assert.ok(requests.includes(route));
      if (route.endsWith('opus'))
        assert.equal(downloaded.sha256, originalHashes[0], 'native audio is not needlessly re-encoded');
      const probe = await execute('ffprobe', [
        '-v',
        'error',
        '-show_streams',
        '-of',
        'json',
        downloaded.source.path,
      ]);
      assert.deepEqual(
        JSON.parse(probe.stdout).streams.map((s: any) => s.codec_type),
        ['audio'],
      );
      const oldPython = process.env.FILMEDIT_PYTHON;
      process.env.FILMEDIT_PYTHON ??= path.join(projectRoot, '.venv/bin/python');
      try {
        await runner.library.analyzeAudio(downloaded.id, 'beats');
        assert.equal(store.asset(task.id, downloaded.id).analyzed?.beats, true);
      } finally {
        if (oldPython === undefined) delete process.env.FILMEDIT_PYTHON;
        else process.env.FILMEDIT_PYTHON = oldPython;
      }
    }
    assert.deepEqual(await Promise.all([opus, webm, covered, clip].map(fileHash)), originalHashes);
  },
);
