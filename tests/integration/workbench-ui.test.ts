import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
// Exercise the shipped build: the server embeds its compiled browser client in the review page.
import { Store } from '../../dist/packages/infrastructure/src/store.js';
import { createApi } from '../../dist/apps/server/src/service.js';
import { FilmClient } from '../../dist/packages/client/src/client.js';
import { FilmTui } from '../../dist/apps/cli/src/tui.js';
import { TaskRunner, createTask } from '../../dist/packages/application/src/workflow.js';
import { CreativeStore } from '../../dist/packages/infrastructure/src/creative-store.js';
import { conceptFixture } from '../helpers.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import puppeteer from 'puppeteer';
import { browserConfiguration } from '../../dist/packages/media/src/render.js';

class FakeTerminal implements Terminal {
  columns = 140;
  rows = 35;
  kittyProtocolActive = false;
  output = '';
  input?: (data: string) => void;
  resize?: () => void;
  start(input: (data: string) => void, resize: () => void) {
    this.input = input;
    this.resize = resize;
  }
  stop() {}
  write(data: string) {
    this.output += data;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}
const delay = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('Expected UI state did not arrive');
};

test(
  'TUI compares actual archived proposals, collects direct choices, pages candidates and rejects stale task/version input',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'filmedit-comparison-')),
      store = new Store(root);
    const api = createApi(store, 'comparison-fixture');
    await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
    const client = new FilmClient({
      url: `http://127.0.0.1:${(api.server.address() as any).port}`,
      token: 'comparison-fixture',
      pid: process.pid,
    });
    const task = await createTask(store, { prompt: '比较创意，无需先有素材' }),
      other = await createTask(store, { prompt: '另一个任务' });
    const conversation = api.workbench.createConversation();
    api.workbench.focus(conversation.id as string, task.id);
    const terminal = new FakeTerminal(),
      tui = new FilmTui(client, terminal),
      knowledge = new CreativeStore(store);
    await tui.start(conversation.id as string);
    t.after(async () => {
      await tui.close();
      await api.workbench.close();
      api.server.closeAllConnections();
      await new Promise<void>((r) => api.server.close(() => r()));
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const lines = () => tui.tui.getScreenLines();
    await tui.submit('/compare');
    await delay();
    assert.ok(lines().join('\n').includes('尚无已归档创意'));
    knowledge.archive(task.id, conceptFixture('candidate_0', '候选0'));
    await tui.submit('/compare');
    await delay();
    assert.ok(lines().join('\n').includes('只有一个已归档候选'));
    for (let i = 1; i < 14; i++) knowledge.archive(task.id, conceptFixture(`candidate_${i}`, `候选${i}`));
    await tui.submit('/compare');
    await delay();
    assert.ok(
      lines().some((line) => line.includes('A · 候选13') && line.includes('B · 候选12')),
      'wide view places both candidates side by side',
    );
    assert.ok(lines().every((line) => visibleWidth(line) <= terminal.columns));
    assert.ok(lines()[0]!.includes('FilmEdit'), 'long proposals cannot displace the application header');
    assert.ok(lines().join('\n').includes('F6 创意'));
    assert.ok(lines().join('\n').includes('任务 v1'));
    await writeFile(path.join(tmpdir(), 'filmedit-creative-wide.txt'), lines().join('\n'));
    terminal.columns = 70;
    terminal.resize?.();
    await delay();
    await writeFile(path.join(tmpdir(), 'filmedit-creative-narrow.txt'), lines().join('\n'));
    assert.ok(lines().some((line) => line.includes('A · 候选13')));
    assert.ok(lines().every((line) => visibleWidth(line) <= 70));
    assert.ok(lines()[0]!.includes('FilmEdit'));
    for (let i = 0; i < 4; i++) terminal.input?.('\x1b[6~');
    await delay();
    assert.ok(
      lines().some((line) => line.includes('B · 候选12')),
      'stacked candidate B is reachable by paging',
    );
    assert.ok(lines()[0]!.includes('FilmEdit'), 'paging scrolls proposals only');
    for (let i = 0; i < 4; i++) terminal.input?.('\x1b[5~');
    await delay();
    terminal.columns = 140;
    terminal.resize?.();
    await delay();
    await tui.submit('/compare a');
    await delay();
    for (let i = 0; i < 11; i++) terminal.input?.('\x1b[B');
    terminal.input?.('\r');
    await until(() => lines().join('\n').includes('候选0'));
    terminal.input?.('\r');
    await until(() => lines().some((line) => /A · 候选1(?:\s|$)/.test(line)));
    await tui.submit('/prefer');
    await delay();
    terminal.input?.('\x1b[B');
    terminal.input?.('\r');
    await until(
      () =>
        knowledge.compare(task.id, { left: 'candidate_1', right: 'candidate_12', audience: 'default' })
          .previous?.choice === 'right',
    );
    assert.equal(
      knowledge.compare(task.id, { left: 'candidate_1', right: 'candidate_12', audience: 'default' })
        .previous!.expectedVersion,
      1,
    );
    for (const choice of ['both_bad', 'incomparable', 'left']) {
      await tui.submit(`/prefer ${choice} 直接输入的意见`);
      assert.equal(
        knowledge.compare(task.id, { left: 'candidate_1', right: 'candidate_12', audience: 'default' })
          .previous!.choice,
        choice,
      );
    }
    assert.equal(knowledge.taste(task.id).samples, 1);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n,
      0,
      'review and voting do not start production or call a model',
    );
    assert.equal(store.assets(task.id).length, 0, 'concept review does not require material backup');
    assert.equal(store.artifact(task.id, 'creative.brief'), undefined);
    store.db.prepare('UPDATE tasks SET version=2 WHERE id=?').run(task.id);
    await assert.rejects(tui.submit('/prefer right'), (e: any) => e.code === 'VERSION_CONFLICT');
    const beforeRefresh = client.command.bind(client);
    client.command = async (...args: Parameters<typeof client.command>) => {
      if (args[0] === 'creative.compare') await delay(80); // Render the short loading state before new data.
      return beforeRefresh(...args);
    };
    terminal.input?.('\x1b[17~');
    await until(() => lines().join('\n').includes('任务 v2')).catch(async (error) => {
      await writeFile(path.join(tmpdir(), 'filmedit-creative-refresh-failed.txt'), lines().join('\n'));
      throw error;
    });
    client.command = beforeRefresh;
    await tui.submit('/prefer right 新要求下选择 B');
    assert.equal(
      knowledge.compare(task.id, { left: 'candidate_1', right: 'candidate_12', audience: 'default' })
        .previous!.expectedVersion,
      2,
    );
    // A delayed old-task read must not replace the newly focused task's view or voting target.
    const command = client.command.bind(client);
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    client.command = async (...args: Parameters<typeof client.command>) => {
      const value = await command(...args);
      if (args[0] === 'creative.compare' && args[2] === task.id) {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return value;
    };
    const reading = tui.submit('/compare candidate_2 candidate_3');
    await pending;
    await tui.submit(`/task ${other.id}`);
    release();
    await reading;
    client.command = command;
    await delay();
    assert.ok(lines().join('\n').includes('尚无已归档创意'));
    await assert.rejects(tui.submit('/prefer left'), (e: any) => e.code === 'COMPARISON_REQUIRED');
    assert.equal(knowledge.taste(other.id).samples, 0);
    await assert.rejects(tui.submit('/compare unknown other'), (e: any) => e.code === 'PREFERENCE_INVALID');
    await delay();
    assert.ok(lines().join('\n').includes('读取候选失败'));
    assert.ok(!lines().join('\n').includes('正在读取候选'));
    await assert.rejects(tui.submit('/prefer left'), (e: any) => e.code === 'COMPARISON_REQUIRED');
  },
);
test(
  'TUI chats, task switching, review panes, SSE reconnect and preview ranges use the same local API',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'filmedit-ui-')),
      store = new Store(root);
    const api = createApi(store, 'fixture-token', {
      conversationExecutor: async ({ text, execute }) => {
        if (text === '创建测试任务') {
          const task: any = await execute('task.create', {
            prompt: '中文横屏测试',
            composition: { aspectRatio: '16:9' },
          });
          return '已创建 ' + task.id;
        }
        return '只是讨论：' + text;
      },
    });
    await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(api.server.address() as any).port}`,
      client = new FilmClient({ url, token: 'fixture-token', pid: process.pid });
    const terminal = new FakeTerminal(),
      tui = new FilmTui(client, terminal);
    await tui.start();
    t.after(async () => {
      await tui.close();
      await api.workbench.close();
      api.server.closeAllConnections();
      await new Promise<void>((r) => api.server.close(() => r()));
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    await tui.submit('创建测试任务');
    for (let i = 0; i < 80 && !store.tasks().length; i++) await delay();
    assert.equal(store.tasks().length, 1);
    await delay(300);
    const task = store.tasks()[0]!;
    store.saveArtifact(
      task.id,
      'script',
      { title: '横屏片', topic: '汽车', angle: '历史', narration: '这是旁白', beats: [] },
      true,
    );
    await tui.submit(`/task ${task.id}`);
    await tui.submit('/review script');
    await delay();
    assert.ok(tui.tui.getScreenLines().join('\n').includes('这是旁白'));
    terminal.columns = 70;
    terminal.resize?.();
    await delay();
    assert.ok(tui.tui.getScreenLines().length <= terminal.rows);
    assert.ok(tui.tui.getScreenLines().join('\n').includes('FilmEdit'));
    await tui.submit('只讨论如何卡点');
    await delay(500);
    assert.equal(store.tasks().length, 1, 'discussion must not create another task');
    const events = store.activityPage(0) as any[],
      cursor = events.at(-1)!.seq;
    const abort = new AbortController();
    const stream = client.events({ after: cursor, signal: abort.signal });
    const next = stream.next();
    const seq = store.activity('test.reconnect', { value: 1 });
    assert.equal((await next).value.seq, seq);
    abort.abort();
    await stream.return(undefined);
    const file = path.join(task.policy.workspace, 'fixture.mp4');
    await new TaskRunner(store, task.id).processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=12:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      file,
    ]);
    const bytes = await readFile(file);
    const rendered = store.saveArtifact(task.id, 'render', { path: file }, true);
    store.updateTask(task.id, 'completed', 'complete');
    const preview = await client.request(`/tasks/${task.id}/preview`, 'POST', {});
    assert.equal(preview.artifactId, rendered.id);
    assert.equal(preview.taskVersion, 1);
    const page = await fetch(url + preview.path);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<video controls/);
    const response = await fetch(url + preview.path.replace('/preview/', '/media/'), {
      headers: { Range: 'bytes=2-5' },
    });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(2, 6));
    assert.equal((await fetch(url + '/media/' + '0'.repeat(48))).status, 401);
    assert.equal((await fetch(url + '/tasks')).status, 401);
    await tui.submit(`/task ${task.id}`);
    await tui.submit(`/artifact ${rendered.id}`);
    await assert.rejects(tui.submit('/feedback unknown'), (error: any) => error.code === 'CLI_USAGE');
    await assert.rejects(tui.submit('/feedback comment'), (error: any) => error.code === 'CLI_USAGE');
    await tui.submit('/feedback accept 这版可以采用');
    await delay();
    assert.ok(tui.tui.getScreenLines().join('\n').includes('用户已接受'));
    assert.equal((await client.command('task.inspect', {}, task.id)).feedback.decision, 'accept');
    store.db.prepare('UPDATE tasks SET version=2 WHERE id=?').run(task.id);
    await assert.rejects(tui.submit('/feedback accept'), (error: any) => error.code === 'VERSION_CONFLICT');
    assert.equal((await client.command('task.inspect', {}, task.id)).feedback.decision, 'unreviewed');
    const updated = store.saveArtifact(
      task.id,
      'output.current',
      { path: file, exportHash: 'new-profile' },
      true,
    );
    await tui.submit(`/task ${task.id}`);
    await tui.submit(`/artifact ${updated.id}`);
    await tui.submit('/feedback reject 新比例不合适');
    await tui.submit('/feedback');
    await delay();
    assert.ok(tui.tui.getScreenLines().join('\n').includes('新比例不合适'));
    const feedback = await client.command('task.feedback.list', {}, task.id);
    assert.deepEqual(
      feedback.items.map((item: any) => [item.taskVersion, item.decision]),
      [
        [2, 'reject'],
        [1, 'accept'],
      ],
    );
    const review = await client.request(`/tasks/${task.id}/review`, 'POST', {});
    const reviewPage = await fetch(url + review.path);
    assert.equal(reviewPage.status, 200);
    assert.match(reviewPage.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(await reviewPage.text(), /制作流程/);
    const snapshot = (await (await fetch(url + review.path + '/data')).json()) as any;
    assert.equal(snapshot.task.id, task.id);
    assert.equal(snapshot.feedback.decision, 'reject');
    assert.equal(snapshot.feedbackHistory.items.length, 2);
    const scriptNode = snapshot.nodes.find((n: any) => n.id === 'script');
    assert.ok(scriptNode.artifacts.some((a: any) => a.stage === 'script' && a.current));
    const selected = scriptNode.artifacts.find((a: any) => a.stage === 'script');
    const content = (await (await fetch(url + review.path + '/artifact/' + selected.id)).json()) as any;
    assert.equal(content.data.narration, '这是旁白');
    const renderArtifact = snapshot.nodes.find((n: any) => n.id === 'output').artifacts[0];
    const reviewMedia = await fetch(url + review.path + '/output/' + renderArtifact.id, {
      headers: { Range: 'bytes=1-3' },
    });
    assert.equal(reviewMedia.status, 206);
    assert.deepEqual(Buffer.from(await reviewMedia.arrayBuffer()), bytes.subarray(1, 4));
    assert.equal((await fetch(url + review.path + '/artifact/not_in_this_task')).status, 404);
    assert.equal((await fetch(url + '/review/' + '0'.repeat(48) + '/data')).status, 401);
    assert.equal((await fetch(url + review.path + '/data', { method: 'POST' })).status, 401);
    const browser = await puppeteer.launch({
      executablePath: (await browserConfiguration()).binary,
      headless: 'shell',
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(url + review.path);
      await page
        .waitForFunction(() => document.querySelector('#status')?.textContent?.includes('用户已拒绝'), {
          timeout: 5000,
        })
        .catch(async (error) => {
          throw new Error(
            JSON.stringify({
              error: String(error),
              pageErrors: errors,
              status: await page.$eval('#status', (node) => node.textContent),
            }),
          );
        });
      await page.click('button[data-id="output"]');
      await page.waitForFunction(() =>
        document.querySelector('#detail')?.textContent?.includes('新比例不合适'),
      );
      assert.ok((await page.$eval('#detail', (node) => node.textContent))?.includes('用户直接提交'));
      await page.$eval('video', async (video) => {
        video.muted = true;
        await video.play();
        video.pause();
        video.currentTime = 1;
      });
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return video && !video.seeking && video.readyState >= 2 && video.currentTime === 1;
      });
      assert.deepEqual(
        await page.$eval('video', (video) => [video.videoWidth, video.videoHeight, video.duration]),
        [320, 180, 2],
      );
      await page.screenshot({ path: path.join(tmpdir(), 'filmedit-feedback-review.png') });
      await page.setViewport({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
    await tui.close();
    assert.equal((await client.request('/health')).ok, true, 'detaching TUI leaves daemon alive');
  },
);
