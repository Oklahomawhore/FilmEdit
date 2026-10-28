import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench } from '../packages/application/src/workbench.js';
import { TaskService } from '../packages/application/src/task-service.js';
import { createTask } from '../packages/application/src/workflow.js';
import { CreativeStore } from '../packages/infrastructure/src/creative-store.js';
import { conceptFixture, fixture } from './helpers.js';

test('candidate browsing is bounded and stable under inserts; exact comparisons remain task-scoped without materials', async (t) => {
  const { store } = await fixture();
  const w = new Workbench(store, new TaskService(store), { autoStart: false });
  t.after(async () => {
    await w.close();
    store.close();
  });
  const a = await createTask(store, { prompt: '自由创作' }),
    b = await createTask(store, { prompt: '另一个任务' });
  const knowledge = new CreativeStore(store);
  for (let i = 0; i < 5; i++) knowledge.archive(a.id, conceptFixture(`c${i}`));
  knowledge.archive(b.id, conceptFixture('private'));
  const command = (name: string, args = {}) =>
    w.command({ requestId: crypto.randomUUID(), command: name, taskId: a.id, args });
  const page = await command('creative.candidates', { limit: 2 });
  assert.deepEqual(
    page.items.map((c: any) => c.id),
    ['c4', 'c3'],
  );
  assert.equal(page.items[0].beats, undefined, 'list returns summaries, not every full proposal');
  knowledge.archive(a.id, conceptFixture('new'));
  const older = await command('creative.candidates', { before: page.nextBefore, limit: 2 });
  assert.deepEqual(
    older.items.map((c: any) => c.id),
    ['c2', 'c1'],
  );
  const last = await command('creative.candidates', { before: older.nextBefore, limit: 2 });
  assert.deepEqual(
    last.items.map((c: any) => c.id),
    ['c0'],
  );
  assert.equal(last.nextBefore, null);
  await assert.rejects(command('creative.candidates', { limit: 1000 }));
  const pair = await command('creative.compare', { left: 'c0', right: 'c4' });
  assert.deepEqual([pair.taskId, pair.taskVersion, pair.left.id, pair.right.id], [a.id, 1, 'c0', 'c4']);
  assert.equal(pair.previous, null);
  assert.deepEqual(pair.left.beats[0].assetIds, []);
  assert.equal(store.assets(a.id).length, 0);
  await assert.rejects(command('creative.compare', { left: 'c0', right: 'private' }), {
    code: 'PREFERENCE_INVALID',
  });
  await assert.rejects(command('creative.compare', { left: 'c0', right: 'c0' }), {
    code: 'PREFERENCE_INVALID',
  });
});

test('human preference retains exact task version and pair orientation; corrections are audited without extra training votes', async (t) => {
  const { store } = await fixture();
  const w = new Workbench(store, new TaskService(store), { autoStart: false });
  t.after(async () => {
    await w.close();
    store.close();
  });
  const task = await createTask(store, { prompt: '比较创意' });
  const knowledge = new CreativeStore(store);
  knowledge.archive(task.id, conceptFixture('a'));
  knowledge.archive(task.id, conceptFixture('b'));
  const input = { expectedVersion: 1, left: 'a', right: 'b', choice: 'left', level: 'concept' };
  const save = (args: unknown) =>
    w.command({ requestId: crypto.randomUUID(), command: 'creative.feedback', taskId: task.id, args });
  await save(input);
  await save(input);
  assert.equal(store.events(task.id).filter((e) => e.type === 'creative.preference.recorded').length, 1);
  assert.equal(
    knowledge.compare(task.id, { left: 'b', right: 'a', audience: 'default' }).previous!.choice,
    'right',
  );
  await save({ ...input, choice: 'both_bad', comment: '两个都太像模板' });
  assert.equal(knowledge.taste(task.id).samples, 1);
  await save({ ...input, choice: 'incomparable' });
  assert.equal(knowledge.taste(task.id).samples, 0);
  assert.equal(store.events(task.id).filter((e) => e.type === 'creative.preference.recorded').length, 3);
  store.db.prepare('UPDATE tasks SET version=2 WHERE id=?').run(task.id);
  await assert.rejects(save(input), { code: 'VERSION_CONFLICT' });
  const pair = knowledge.compare(task.id, { left: 'a', right: 'b', audience: 'default' });
  assert.equal(pair.taskVersion, 2);
  assert.equal(pair.previous!.expectedVersion, 1);
  await save({ ...input, expectedVersion: 2, choice: 'right' });
  assert.equal(
    knowledge.compare(task.id, { left: 'a', right: 'b', audience: 'default' }).previous!.expectedVersion,
    2,
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0);
  assert.equal(store.task(task.id).stage, 'creative');
  assert.equal(
    store.artifact(task.id, 'creative.brief'),
    undefined,
    'voting does not choose a production plan',
  );
});
