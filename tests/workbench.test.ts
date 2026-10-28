import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { Workbench } from '../packages/application/src/workbench.js';
import { TaskService } from '../packages/application/src/task-service.js';
import { createTask, TaskRunner } from '../packages/application/src/workflow.js';
import { Store } from '../packages/infrastructure/src/store.js';
import { parseFilmCommand, parseRevisionCommand } from '../packages/core/src/commands.js';
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

test('learning workspaces cannot be listed, focused, started or edited as production tasks', async (t) => {
  const { store, root } = await fixture();
  const service = new TaskService(store);
  const w = new Workbench(store, service, { autoStart: false });
  t.after(async () => {
    await w.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const production = await createTask(store, { prompt: '作品' });
  const learning = await createTask(store, { prompt: '实验' }, 'task_learning', 'learning');
  const conversation = w.createConversation();
  w.focus(conversation.id as string, production.id);
  assert.deepEqual(
    (await w.command({ requestId: 'list', command: 'task.list' })).map((t: any) => t.id),
    [production.id],
  );
  assert.throws(() => w.focus(conversation.id as string, learning.id), { code: 'TASK_PURPOSE' });
  assert.throws(
    () => w.submitMessage(conversation.id as string, { requestId: 'msg', text: '开始', taskId: learning.id }),
    { code: 'TASK_PURPOSE' },
  );
  for (const command of [
    'task.inspect',
    'task.run',
    'task.pause',
    'task.cancel',
    'task.revise',
    'task.export',
  ])
    await assert.rejects(w.command({ requestId: command, command, taskId: learning.id }), {
      code: 'TASK_PURPOSE',
    });
  assert.throws(() => new TaskRunner(store, learning.id), { code: 'TASK_PURPOSE' });
  await assert.rejects(service.cancel(learning.id), { code: 'TASK_PURPOSE' });
  assert.equal(store.task(learning.id).status, 'queued');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0);
  assert.equal(w.conversation(conversation.id as string).task_id, production.id);
});

test('pausing or cancelling production from chat does not cancel its own conversation job', async (t) => {
  const f = await fixture();
  const selected = await createTask(f.store, { prompt: 'selected' });
  const other = await createTask(f.store, { prompt: 'other' });
  const workbench = new Workbench(f.store, new TaskService(f.store), {
    conversationExecutor: async ({ text, execute }) => {
      await execute(text === '暂停' ? 'task.pause' : 'task.cancel');
      const job = f.store.db
        .prepare("SELECT state FROM jobs WHERE task_id=? AND kind='chat' ORDER BY rowid DESC LIMIT 1")
        .get(selected.id)!;
      assert.equal(job.state, 'running', 'task control must leave the current conversation alive');
      return '操作已完成';
    },
  });
  t.after(async () => {
    await workbench.close();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const conversation = workbench.createConversation();
  workbench.focus(conversation.id as string, selected.id);
  for (const [text, status] of [
    ['暂停', 'paused'],
    ['取消', 'cancelled'],
  ] as const) {
    const submitted = workbench.submitMessage(conversation.id as string, { requestId: text, text });
    await until(() => workbench.job(submitted.jobId).state === 'completed');
    assert.equal(f.store.task(selected.id).status, status);
    assert.equal(f.store.task(other.id).status, 'queued');
  }
  assert.equal(workbench.messages(conversation.id as string).length, 4);
});

test('commands are idempotent; revision invalidates only downstream and preserves historical artifacts', async (t) => {
  const f = await fixture();
  t.after(async () => {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const w = new Workbench(f.store, new TaskService(f.store), { autoStart: false });
  const input = { requestId: 'create-1', command: 'task.create', args: { prompt: 'Test' } };
  const [a, b] = await Promise.all([w.command(input), w.command(input)]);
  assert.equal(a.id, b.id);
  assert.equal(f.store.tasks().length, 1);
  await assert.rejects(w.command({ ...input, args: { prompt: 'different' } }), { code: 'REQUEST_CONFLICT' });
  const script = f.store.saveArtifact(a.id, 'script', { narration: 'original' }, true),
    edit = f.store.saveArtifact(a.id, 'editorial', { shots: [] }, true),
    layout = f.store.saveArtifact(a.id, 'layout', { nodes: [] }, true);
  const revision = {
    requestId: 'revise-1',
    command: 'task.revise',
    taskId: a.id,
    args: {
      expectedVersion: 1,
      kind: 'layout',
      instruction: '不裁掉横屏画面',
      composition: { aspectRatio: '16:9' },
    },
  };
  const job = await w.command(revision);
  assert.equal(f.store.task(a.id).version, 2);
  assert.equal(f.store.artifact(a.id, 'script')?.id, script.id);
  assert.equal(f.store.artifact(a.id, 'editorial')?.id, edit.id);
  assert.equal(f.store.artifact(a.id, 'layout'), undefined);
  assert.equal((await w.command(revision)).id, job.id);
  assert.equal(w.runs(a.id).length, 1);
  assert.equal(f.store.db.prepare('SELECT accepted FROM artifacts WHERE id=?').get(layout.id)?.accepted, 1);
  await assert.rejects(w.command({ ...revision, requestId: 'outdated' }), { code: 'VERSION_CONFLICT' });
  const feedback = f.store.artifact<any>(a.id, 'layout.feedback', false)!.data;
  assert.ok(feedback.previousArtifactIds.some((r: any) => r.id === layout.id));
  assert.equal(w.runs(a.id)[0]!.input.spec.composition.aspectRatio, '16:9');
});

test('export revision preserves the edit, snapshot and conversation task targeting', async (t) => {
  const f = await fixture();
  t.after(async () => {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const w = new Workbench(f.store, new TaskService(f.store), { autoStart: false });
  const a = await createTask(f.store, { prompt: 'A' }),
    b = await createTask(f.store, { prompt: 'B' });
  const c = w.createConversation();
  w.focus(c.id as string, a.id);
  const edit = f.store.saveArtifact(a.id, 'editorial', { shots: [] }, true),
    layout = f.store.saveArtifact(a.id, 'layout', { nodes: [] }, true);
  const msg = w.submitMessage(c.id as string, { requestId: 'message', text: '请修改这个任务' });
  w.focus(c.id as string, b.id);
  assert.equal(w.job((msg as any).jobId).task_id, a.id, 'queued message must not move with focus');
  assert.throws(() => w.submitMessage(c.id as string, { requestId: 'message', text: 'different' }), {
    code: 'REQUEST_CONFLICT',
  });
  const job = await w.command({
    requestId: 'export',
    command: 'task.revise',
    taskId: a.id,
    args: {
      kind: 'output',
      expectedVersion: 1,
      instruction: '导出4:3',
      output: { aspectRatio: '4:3', width: 640 },
    },
  });
  assert.equal(job.kind, 'export');
  assert.equal(f.store.artifact(a.id, 'editorial')?.id, edit.id);
  assert.equal(f.store.artifact(a.id, 'layout')?.id, layout.id);
  assert.equal(f.store.task(a.id).spec.output.width, 640);
  assert.equal(f.store.task(b.id).version, 1);
});

test('restart resumes queued chat and keeps requests deduplicated and full history durable', async (t) => {
  const f = await fixture();
  let store = f.store;
  let w = new Workbench(store, new TaskService(store), { autoStart: false });
  const c = w.createConversation();
  const message = w.submitMessage(c.id as string, { requestId: 'request', text: '只讨论，不启动剪辑' });
  store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run((message as any).jobId);
  store.close();
  store = new Store(f.store.home);
  let calls = 0;
  w = new Workbench(store, new TaskService(store), {
    conversationExecutor: async ({ text }) => {
      calls++;
      return '讨论：' + text;
    },
  });
  t.after(async () => {
    await w.close();
    store.close();
    await rm(f.root, { recursive: true, force: true });
  });
  await until(() => w.job((message as any).jobId).state === 'completed');
  assert.equal(calls, 1);
  assert.equal(w.messages(c.id as string).length, 2);
  assert.equal(store.tasks().length, 0);
  w.submitMessage(c.id as string, { requestId: 'request', text: '只讨论，不启动剪辑' });
  assert.equal(w.messages(c.id as string).length, 2);
  const events = store.activityPage(0) as any[];
  assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq));
  assert.ok(events.some((e) => e.type === 'message.completed'));
});

test('CLI parser does not execute shell text and preserves Chinese paths and JSON arguments', () => {
  assert.deepEqual(parseRevisionCommand(['editorial', '0:3', '加强开头，后面保留'], 2), {
    expectedVersion: 2,
    kind: 'editorial',
    scope: { start: 0, end: 3 },
    instruction: '加强开头，后面保留',
  });
  assert.throws(() => parseRevisionCommand(['editorial', '3:0', '修改'], 2));
  assert.deepEqual(parseFilmCommand(['library', 'import', '/tmp/素材 文件', '--category', 'meme']), {
    command: 'library.import',
    args: { paths: ['/tmp/素材 文件'], category: 'meme', tags: [] },
    taskId: undefined,
  });
  assert.equal(
    parseFilmCommand(['library', 'search', '--query', '$(touch /tmp/no)']).args.query,
    '$(touch /tmp/no)',
  );
  assert.equal(
    parseFilmCommand(['task', 'revise', 'task_a', '--json', '{"kind":"script"}']).taskId,
    'task_a',
  );
});

test('chat stays responsive during heavy work; shutdown preserves queued jobs and one heavy worker resumes', async (t) => {
  const f = await fixture();
  let w: Workbench;
  const tasks = new TaskService(f.store);
  let parallel = 0,
    maximum = 0,
    finish = false;
  tasks.start = (taskId: string) => {
    const controller = new AbortController();
    parallel++;
    maximum = Math.max(maximum, parallel);
    f.store.updateTask(taskId, 'running', 'script');
    const done = new Promise<void>((resolve) => {
      const complete = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', complete);
        parallel--;
        if (!controller.signal.aborted)
          f.store.saveArtifact(taskId, 'render', { path: 'fixture-render.mp4' }, true);
        f.store.updateTask(
          taskId,
          controller.signal.aborted ? 'paused' : 'completed',
          controller.signal.aborted ? 'script' : 'complete',
        );
        tasks.active.delete(taskId);
        resolve();
      };
      const timer = setTimeout(complete, finish ? 20 : 60000);
      controller.signal.addEventListener('abort', complete, { once: true });
    });
    tasks.active.set(taskId, { controller, done });
    return { taskId, state: 'running' };
  };
  w = new Workbench(f.store, tasks, { conversationExecutor: async () => '后台执行时仍能讨论' });
  t.after(async () => {
    await w.close();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const a = await createTask(f.store, { prompt: 'A' }),
    b = await createTask(f.store, { prompt: 'B' });
  const first = await w.command({ requestId: 'run-a', command: 'task.run', taskId: a.id }),
    second = await w.command({ requestId: 'run-b', command: 'task.run', taskId: b.id });
  await until(() => w.job(first.id).state === 'running');
  assert.equal(w.job(second.id).state, 'queued');
  const c = w.createConversation();
  const msg = w.submitMessage(c.id as string, { requestId: 'live-chat', text: '询问状态' });
  await until(() => w.job((msg as any).jobId).state === 'completed');
  assert.equal(w.job(first.id).state, 'running');
  await w.close();
  assert.equal(w.job(first.id).state, 'queued');
  assert.equal(w.job(second.id).state, 'queued');
  finish = true;
  w = new Workbench(f.store, tasks, { conversationExecutor: async () => '' });
  await until(() => w.job(second.id).state === 'completed');
  assert.equal(w.job(first.id).state, 'completed');
  assert.equal(maximum, 1);
  assert.equal(w.runs(a.id).length, 1);
});

test('output publication, run snapshot and completion event commit together; a failed commit keeps the previous output', async (t) => {
  const { store, root } = await fixture();
  const tasks = new TaskService(store);
  const task = await createTask(store, { prompt: '导出持久性测试' });
  const oldOutput = store.saveArtifact(task.id, 'output.current', { path: 'old.mp4' }, true);
  const rendered = { path: 'new.mp4', exportHash: 'fixture-export' };
  let renders = 0;
  tasks.export = async (taskId) => {
    const cached = store.artifact(taskId, 'export.fixture-export');
    if (!cached) {
      renders++;
      store.saveArtifact(taskId, 'export.fixture-export', rendered, true);
    }
    return rendered as any;
  };
  const workbench = new Workbench(store, tasks);
  t.after(async () => {
    await workbench.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  // Fail at the last write, after output, task, job and run writes have all been attempted.
  store.db.exec(`CREATE TRIGGER fail_completion BEFORE INSERT ON activity
    WHEN NEW.type='job.completed' BEGIN SELECT RAISE(ABORT,'completion-write-failed'); END;`);
  const failed = await workbench.command({
    requestId: 'export-fault',
    command: 'task.export',
    taskId: task.id,
    args: {},
  });
  await until(() => workbench.job(failed.id).state === 'blocked');
  assert.match(workbench.job(failed.id).result.message, /completion-write-failed/);
  assert.equal(workbench.runs(task.id)[0]!.state, 'blocked');
  assert.equal(store.artifact(task.id, 'output.current')!.id, oldOutput.id);
  assert.equal(store.task(task.id).status, 'queued', 'failed publication cannot mark the task completed');
  assert.equal(store.activityPage().filter((event) => event.type === 'job.completed').length, 0);
  assert.ok(
    store.artifact(task.id, 'export.fixture-export'),
    'render checkpoint survives publication failure',
  );
  store.db.exec('DROP TRIGGER fail_completion');
  const recovered = await workbench.command({
    requestId: 'export-retry',
    command: 'task.export',
    taskId: task.id,
    args: {},
  });
  await until(() => workbench.job(recovered.id).state === 'completed');
  const current = store.artifact(task.id, 'output.current')!;
  const run = workbench.runs(task.id)[0]!;
  assert.equal(renders, 1, 'recovery can reuse the saved export');
  assert.deepEqual(current.data, rendered);
  assert.equal(store.task(task.id).status, 'completed');
  assert.equal(run.state, 'completed');
  assert.deepEqual(
    run.result.artifacts.find((artifact: any) => artifact.stage === 'output.current'),
    {
      id: current.id,
      stage: 'output.current',
      hash: current.hash,
    },
  );
  assert.equal(store.activityPage().filter((event) => event.type === 'job.completed').length, 1);
});

test('conversation tools cannot expand filesystem access using unselected paths', async (t) => {
  const f = await fixture();
  const w = new Workbench(f.store, new TaskService(f.store), {
    conversationExecutor: async ({ execute }) => {
      await execute('library.import', { paths: ['/private/unselected'], category: 'video' });
      return 'unexpected';
    },
  });
  t.after(async () => {
    await w.close();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const c = w.createConversation();
  const m = w.submitMessage(c.id as string, { requestId: 'paths', text: '讨论素材选择' });
  await until(() => w.job((m as any).jobId).state === 'blocked');
  assert.equal(w.job((m as any).jobId).result.code, 'PATH_NOT_SELECTED');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='library.import'").get()!.n, 0);
});
