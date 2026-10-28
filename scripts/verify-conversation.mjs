// Real-model, isolated conversation acceptance. Never points at the production daemon.
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadProjectEnv } from '../packages/infrastructure/src/model-provider.ts';
import { Store } from '../packages/infrastructure/src/store.ts';
import { createTask } from '../packages/application/src/workflow.ts';
import { createApi } from '../apps/server/src/service.ts';
import { FilmClient } from '../packages/client/src/client.ts';

await loadProjectEnv();
const home = path.resolve('.filmedit/verification/product-20261023', `conversation-${Date.now()}`);
const store = new Store(home);
const first = await createTask(store, { prompt: '保时捷短片', materials: { strategy: 'local_only' } });
const second = await createTask(store, { prompt: '另一个待处理任务', materials: { strategy: 'local_only' } });
store.updateTask(first.id, 'paused', 'creative');
const api = createApi(store);
await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
const client = new FilmClient({
  url: `http://127.0.0.1:${api.server.address().port}`,
  token: api.token,
  pid: process.pid,
});
const conversation = await client.request('/conversations', 'POST', { title: '真实对话验收' });
await client.request(`/conversations/${conversation.id}/focus`, 'PUT', { taskId: first.id });
const exchanges = [];
async function say(text) {
  const submitted = await client.request(`/conversations/${conversation.id}/messages`, 'POST', {
    requestId: crypto.randomUUID(),
    text,
  });
  const deadline = Date.now() + 180000;
  let job;
  while (Date.now() < deadline) {
    job = await client.request(`/jobs/${submitted.jobId}`);
    if (!['queued', 'running'].includes(job.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(job?.state, 'completed', JSON.stringify(job?.result ?? job?.state));
  exchanges.push({ input: text, response: job.result });
  console.log(JSON.stringify({ exchange: exchanges.length, state: job.state }));
}
let passed = false;
try {
  await say('先只是讨论：是不是应该先有创意，再在素材补充阶段找画面？不要创建或执行任何任务。');
  assert.equal(store.tasks().length, 2);
  assert.equal(store.task(first.id).status, 'paused');
  await say('当前任务进度怎么样？保持暂停，只告诉我现有进度。');
  assert.equal(store.task(first.id).status, 'paused');
  await say('取消当前任务。另一个任务不要改动。');
  assert.equal(store.task(first.id).status, 'cancelled');
  assert.equal(store.task(second.id).status, 'queued');
  await say('新建一条保时捷的15秒横屏短片任务，16:9，内容和表达自由发挥。只创建，不要开始执行。');
  assert.equal(store.tasks().length, 3);
  const current = await client.request(`/conversations/${conversation.id}`);
  const created = store.task(current.task_id);
  assert.ok(![first.id, second.id].includes(created.id));
  assert.equal(created.status, 'queued');
  const version = created.version;
  await say('我们只讨论配乐可以怎么做，不要改任务，也不要开始。');
  assert.equal(store.task(created.id).version, version);
  assert.equal(store.task(created.id).status, 'queued');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind!='chat'").get().n, 0);
  passed = true;
} finally {
  await api.workbench.close();
  api.server.closeAllConnections();
  await new Promise((resolve) => api.server.close(resolve));
  await writeFile(
    path.join(home, 'acceptance.json'),
    JSON.stringify({ passed, conversationId: conversation.id, exchanges, tasks: store.tasks() }, null, 2),
  );
  store.close();
  const reopened = new Store(home);
  if (passed)
    assert.equal(
      reopened.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(conversation.id)
        .n,
      exchanges.length * 2,
    );
  reopened.close();
  console.log(JSON.stringify({ home, passed, persistedExchanges: exchanges.length }));
}
