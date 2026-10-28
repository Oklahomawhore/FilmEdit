import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { createTask } from '../packages/application/src/workflow.js';
import { Workbench } from '../packages/application/src/workbench.js';
import { TaskService } from '../packages/application/src/task-service.js';
import { feedbackHistory, feedbackSummary } from '../packages/application/src/feedback.js';
import { reviewTask } from '../packages/application/src/review.js';
import { Store } from '../packages/infrastructure/src/store.js';
import { parseFilmCommand } from '../packages/core/src/commands.js';

const input = (artifactId: string | null, decision = 'comment', content = '构图完整，但节奏还需要改进') => ({
  expectedVersion: 1,
  artifactId,
  decision,
  dimensions: ['execution'],
  content,
});

test('free-mode feedback persists against an exact artifact; completion is not human acceptance and retry is idempotent', async (t) => {
  const { store, root } = await fixture();
  const w = new Workbench(store, new TaskService(store), { autoStart: false });
  t.after(async () => {
    await w.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = await createTask(store, { prompt: '自由创作' });
  const submit = (requestId: string, args: any) =>
    w.command({ requestId, command: 'task.feedback', taskId: task.id, args });
  await submit('comment', input(null));
  assert.equal(feedbackHistory(store, task.id).items.length, 1);
  assert.equal(store.task(task.id).status, 'queued');
  await assert.rejects(submit('premature', input(null, 'accept')), { code: 'FEEDBACK_OUTPUT' });
  const render = store.saveArtifact(task.id, 'render', { path: '/fixture/final.mp4' }, true);
  await assert.rejects(submit('unfinished', input(render.id, 'accept')), { code: 'FEEDBACK_NOT_READY' });
  store.updateTask(task.id, 'completed', 'complete');
  assert.equal(feedbackSummary(store, task.id).decision, 'unreviewed');
  const accepted = await submit('accept', input(render.id, 'accept', '这版可以采用'));
  assert.equal(accepted.artifact.hash, render.hash);
  assert.equal(accepted.artifact.revision, render.revision);
  assert.equal(feedbackSummary(store, task.id).decision, 'accept');
  // A crash after feedback committed but before command completion must not duplicate it.
  store.db.prepare("UPDATE commands SET state='running',result=NULL WHERE id='accept'").run();
  assert.deepEqual(await submit('accept', input(render.id, 'accept', '这版可以采用')), accepted);
  assert.equal(feedbackHistory(store, task.id).items.length, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0);
  const reopened = new Store(store.home);
  assert.equal(feedbackSummary(reopened, task.id).latest!.id, accepted.id);
  reopened.close();
  assert.equal(reviewTask(store, task.id).feedback.decision, 'accept');
  const parsed = parseFilmCommand([
    'task',
    'feedback',
    task.id,
    '--json',
    JSON.stringify(input(render.id, 'reject')),
  ]);
  await w.command({ requestId: 'cli-reject', ...parsed });
  assert.equal(feedbackSummary(store, task.id).decision, 'reject');
  assert.equal(store.task(task.id).status, 'completed', 'human rejection is separate from production status');
});

test('feedback cannot cross task, output, or version boundaries; new versions require their own verdict', async (t) => {
  const { store, root } = await fixture();
  const w = new Workbench(store, new TaskService(store), { autoStart: false });
  t.after(async () => {
    await w.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const a = await createTask(store, { prompt: 'A' }),
    b = await createTask(store, { prompt: 'B' });
  const oldOutput = store.saveArtifact(a.id, 'render', { path: '/fixture/first.mp4' }, true);
  const other = store.saveArtifact(b.id, 'render', { path: '/fixture/other.mp4' }, true);
  store.updateTask(a.id, 'completed', 'complete');
  const submit = (requestId: string, args: any) =>
    w.command({ requestId, command: 'task.feedback', taskId: a.id, args });
  await assert.rejects(submit('cross-task', input(other.id, 'accept')), { code: 'ARTIFACT_MISSING' });
  await submit('first', input(oldOutput.id, 'accept'));
  const newOutput = store.saveArtifact(a.id, 'output.current', { path: '/fixture/export.mp4' }, true);
  assert.equal(feedbackSummary(store, a.id).decision, 'unreviewed');
  await assert.rejects(submit('stale-output', input(oldOutput.id, 'accept')), {
    code: 'FEEDBACK_STALE_OUTPUT',
  });
  await submit('new', input(newOutput.id, 'changes_requested'));
  store.db.prepare('UPDATE tasks SET version=2 WHERE id=?').run(a.id);
  assert.equal(feedbackSummary(store, a.id).decision, 'unreviewed');
  await assert.rejects(submit('stale-version', input(newOutput.id, 'accept')), { code: 'VERSION_CONFLICT' });
  await submit('version-2', { ...input(newOutput.id, 'reject'), expectedVersion: 2 });
  const page = feedbackHistory(store, a.id, 0, 1);
  assert.equal(page.items[0]!.taskVersion, 2);
  const next = feedbackHistory(store, a.id, page.nextBefore!, 1);
  assert.equal(next.items[0]!.taskVersion, 1);
  assert.notEqual(next.items[0]!.id, page.items[0]!.id);
  assert.equal(feedbackHistory(store, b.id).items.length, 0);
});

test('account feedback memory retains user source and stays separate from adoption history', async (t) => {
  const { store, root } = await fixture();
  const w = new Workbench(store, new TaskService(store), { autoStart: false });
  t.after(async () => {
    await w.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const account = store.createAccount('A'),
    other = store.createAccount('B');
  const task = await createTask(store, { prompt: '账号作品', accountId: account });
  const args = input(null);
  const command = { requestId: 'account-feedback', command: 'task.feedback', taskId: task.id, args };
  const feedback = await w.command(command);
  await w.command(command);
  const memories = store.memories(account, '').filter((memory) => memory.accountId === account);
  assert.equal(memories.length, 1);
  assert.equal(memories[0]!.content, args.content);
  assert.equal(memories[0]!.provenance, 'user');
  assert.match(memories[0]!.source!, new RegExp(feedback.id));
  assert.equal(store.memories(other, '').filter((memory) => memory.accountId === other).length, 0);
  store.correctMemory(account, memories[0]!.id, null);
  assert.equal(
    feedbackHistory(store, task.id).items.length,
    1,
    'memory deletion does not rewrite the review audit',
  );
});

test('conversation feedback is verbatim and task-bound; the model cannot submit a human verdict', async (t) => {
  const { store, root } = await fixture();
  const task = await createTask(store, { prompt: 'A' }),
    other = await createTask(store, { prompt: 'B' });
  const render = store.saveArtifact(task.id, 'render', { path: '/fixture/final.mp4' }, true);
  store.updateTask(task.id, 'completed', 'complete');
  const w = new Workbench(store, new TaskService(store), {
    conversationExecutor: async ({ text, execute }) => {
      await assert.rejects(execute('task.feedback', input(render.id, 'accept', text)), {
        code: 'HUMAN_VERDICT_REQUIRED',
      });
      await assert.rejects(execute('task.feedback', input(render.id, 'comment', '模型自己觉得很好')), {
        code: 'FEEDBACK_SOURCE',
      });
      await assert.rejects(execute('task.feedback', input(null, 'comment', text), other.id), {
        code: 'FEEDBACK_SOURCE',
      });
      await execute('task.feedback', input(render.id, 'comment', text));
      return '已记录你的原话，没有替你提交采用结论';
    },
  });
  t.after(async () => {
    await w.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const conversation = w.createConversation();
  w.focus(conversation.id as string, task.id);
  const message = w.submitMessage(conversation.id as string, {
    requestId: 'opinion',
    text: '镜头不错，不过音乐太吵',
  });
  w.focus(conversation.id as string, other.id);
  for (let i = 0; i < 100 && w.job(message.jobId).state !== 'completed'; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.job(message.jobId).state, 'completed');
  const saved = feedbackHistory(store, task.id).items;
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.content, '镜头不错，不过音乐太吵');
  assert.deepEqual(saved[0]!.origin, { kind: 'conversation', messageId: message.id });
  assert.equal(feedbackSummary(store, task.id).decision, 'unreviewed');
  assert.equal(feedbackHistory(store, other.id).items.length, 0);
});
