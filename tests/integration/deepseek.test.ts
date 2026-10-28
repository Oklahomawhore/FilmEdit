import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Store } from '../../packages/infrastructure/src/store.js';
import { createTask, TaskRunner } from '../../packages/application/src/workflow.js';
import { PiAgentDriver } from '../../packages/agent-runtime/src/agents.js';
import { FilmError } from '../../packages/core/src/util.js';
import { Workbench } from '../../packages/application/src/workbench.js';
import { TaskService } from '../../packages/application/src/task-service.js';
import { runPiSession } from '../../packages/agent-runtime/src/pi-runtime.js';

test(
  'sandboxed pi uses native DeepSeek streaming, real image tools, reviewer repair and durable resume',
  { timeout: 150000 },
  async (t) => {
    const requests: any[] = [];
    let mode = 'long',
      frameAssetId = '',
      feedbackTaskId = '',
      feedbackText = '',
      calls = 0;
    const server = createServer(async (req, res) => {
      const buffers = [];
      for await (const b of req) buffers.push(b);
      const body = JSON.parse(Buffer.concat(buffers).toString());
      requests.push({ body, auth: req.headers.authorization });
      calls++;
      assert.equal(req.url, '/chat/completions');
      if (mode === 'balance') {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Insufficient Balance', type: 'insufficient_balance_error' }));
        return;
      }
      if (mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: 'Invalid fixture credential', type: 'authentication_error' } }),
        );
        return;
      }
      const plainResponses = body.messages.filter(
        (message: any) =>
          message.role === 'assistant' && JSON.stringify(message.content).includes('等待提交结果'),
      ).length;
      if (
        (mode === 'stuck_text' && plainResponses >= 2) ||
        (mode === 'stuck_empty' &&
          body.messages.filter((message: any) => message.role === 'assistant').length >= 2)
      ) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Fixture guard: a third unchanged text-only request was made' },
          }),
        );
        return;
      }
      const results = body.messages.filter((m: any) => m.role === 'tool');
      let name = 'submit_result',
        args: any = { result: { status: 'ok', echoed: 'filmedit' } },
        callId = `call_${calls}`;
      if (mode.startsWith('conversation_feedback_')) {
        const concept = mode.includes('_concept_');
        const feedback = {
          expectedVersion: 1,
          artifactId: null,
          decision: mode.endsWith('_comment') ? 'comment' : 'accept',
          dimensions: [],
          content: feedbackText,
        };
        name = mode.endsWith('_cli') ? 'film_cli' : 'film_command';
        const command = concept ? 'creative.feedback' : 'task.feedback';
        const input = concept
          ? { expectedVersion: 1, left: 'left', right: 'right', choice: 'left', level: 'concept' }
          : feedback;
        args =
          name === 'film_cli'
            ? { argv: [...command.split('.'), '--task', feedbackTaskId, '--json', JSON.stringify(input)] }
            : { command, args: input, taskId: feedbackTaskId };
      }
      if (mode === 'long' && results.length < 26) {
        name = results.length === 0 ? 'frame' : results.length === 2 ? 'transcript' : 'assets';
        args =
          name === 'frame'
            ? { assetId: frameAssetId, times: [0] }
            : name === 'transcript'
              ? { assetId: frameAssetId }
              : {};
      }
      if (mode === 'resume' && results.length === 0) {
        name = 'assets';
        args = {};
      } else if (mode === 'resume') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'simulated outage' } }));
        return;
      }
      if (mode === 'schema' && !JSON.stringify(results).includes('invalid'))
        args = { result: { status: 'invalid', echoed: 'filmedit' } };
      if (mode === 'stuck_schema') args = { result: { status: 'invalid', echoed: 'filmedit' } };
      if (mode === 'discover' && results.length < 3) {
        if (results.length === 0) {
          name = 'local_materials';
          args = {};
        } else if (results.length === 1) {
          name = 'import_local_material';
          args = { sourceId: JSON.parse(results[0].content).items[0].sourceId };
        } else {
          name = 'frame';
          args = { assetId: JSON.parse(results[1].content).id, times: [0] };
        }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: any, finish_reason: any = null) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'completion',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'deepseek-flash',
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            '\n\n',
        );
      chunk({ role: 'assistant', reasoning_content: `fixture reasoning ${calls}` });
      if (mode === 'stuck_empty') {
        chunk({}, 'stop');
        res.end('data: [DONE]\n\n');
        return;
      }
      if (mode === 'stuck_text' || (mode === 'text_then_submit' && plainResponses === 0)) {
        chunk({ content: '等待提交结果' }, 'stop');
        res.end('data: [DONE]\n\n');
        return;
      }
      if (mode.startsWith('conversation_feedback_') && results.length) {
        chunk({ content: '反馈操作已检查' }, 'stop');
        res.end('data: [DONE]\n\n');
        return;
      }
      chunk({
        tool_calls: [
          { index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      });
      chunk({}, 'tool_calls');
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'completion',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-flash',
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const port = (server.address() as any).port,
      changes = {
        FILMEDIT_PROVIDER: 'deepseek',
        FILMEDIT_MODEL: 'deepseek-flash-v4.1',
        DEEPSEEK_API_KEY: 'fixture-key',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
      };
    const old = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]]));
    Object.assign(process.env, changes);
    t.after(() => {
      for (const [k, v] of Object.entries(old))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    });
    const root = await mkdtemp(path.join(tmpdir(), 'filmedit-pi-')),
      store = new Store(root);
    t.after(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const task = await createTask(store, { prompt: 'pi fixture' });
    store.addCost(task.id, 140);
    const runner = new TaskRunner(store, task.id, AbortSignal.timeout(120000));
    const picture = path.join(task.policy.workspace, 'red.jpg');
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=32x32',
      '-frames:v',
      '1',
      picture,
    ]);
    const asset = await runner.library.importFile(picture, 'generated');
    frameAssetId = asset.id;
    asset.transcript = Array.from({ length: 5000 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: '中文历史资料'.repeat(30),
    }));
    store.saveAsset(asset);
    const agent = new PiAgentDriver(store, task.id, runner.library, runner.processes);
    const input = {
      role: 'audience_review' as const,
      instruction: 'submit fixture result',
      input: { test: 'first' },
      schema: z.object({ status: z.literal('ok'), echoed: z.literal('filmedit') }).strict(),
      images: [{ path: picture, label: 'red' }],
    };
    assert.deepEqual(await agent.run(input), { status: 'ok', echoed: 'filmedit' });
    assert.ok(requests.length >= 27, 'unlimited loop continues beyond former 24 turns');
    assert.ok(requests.some((r) => JSON.stringify(r.body.messages).includes('image_url')));
    const initialContent = requests[0].body.messages.find((m: any) => m.role === 'user').content;
    const imageIndex = initialContent.findIndex((c: any) => c.type === 'image_url');
    assert.equal(
      initialContent[imageIndex - 1].text,
      'red',
      'each image carries its adjacent evidence label',
    );
    assert.ok(requests.every((r) => r.auth === 'Bearer fixture-key' && r.body.model === 'deepseek-flash'));
    const ledger = store.db.prepare("SELECT result FROM tool_executions WHERE name='transcript'").get()!;
    const transcript = JSON.parse(ledger.result as string);
    assert.ok(Buffer.byteLength(JSON.stringify(transcript)) < 16000);
    assert.ok(JSON.parse(transcript.content[0].text).next);
    mode = 'complete';
    for (const role of ['strategy_partition', 'strategy_learner', 'strategy_predict', 'learner'] as const) {
      const start = requests.length;
      await agent.run({
        role,
        toolAccess: 'none',
        instruction: 'submit fixture result',
        schema: input.schema,
        ...(role === 'learner' ? { images: input.images } : {}),
        input:
          role === 'strategy_learner'
            ? { training: 'PRIVATE_STRATEGY_TRAINING_LABEL' }
            : { independent: role },
      });
      assert.equal(requests.length, start + 1);
      assert.deepEqual(
        requests[start].body.tools.map((tool: any) => tool.function.name),
        ['submit_result'],
      );
      if (role === 'strategy_predict')
        assert.ok(!JSON.stringify(requests[start].body.messages).includes('PRIVATE_STRATEGY_TRAINING_LABEL'));
      if (role === 'learner') assert.ok(JSON.stringify(requests[start].body.messages).includes('image_url'));
    }
    mode = 'repair';
    let validations = 0;
    await agent.run({
      ...input,
      input: { test: 'repair' },
      validateOutput: (value) => {
        validations++;
        if (validations === 1) throw new FilmError('EVIDENCE_RANGE', 'End beyond shot');
        return value;
      },
    });
    assert.equal(validations, 2);
    assert.ok(requests.some((r) => JSON.stringify(r.body.messages).includes('EVIDENCE_RANGE')));
    mode = 'schema';
    const beforeSchema = requests.length;
    await agent.run({ ...input, input: { test: 'schema' } });
    assert.ok(
      requests.length - beforeSchema >= 2,
      'schema validation returns feedback and retries in the same loop',
    );
    for (const stuck of ['stuck_schema', 'stuck_validation', 'stuck_text', 'stuck_empty']) {
      mode = stuck;
      let fixed = false;
      const request = {
        ...input,
        input: { test: stuck },
        validateOutput: (value: z.infer<typeof input.schema>) => {
          if (stuck === 'stuck_validation' && !fixed)
            throw new FilmError('EVIDENCE_RANGE', 'Identical invalid evidence interval');
          return value;
        },
      };
      const before = requests.length;
      await assert.rejects(agent.run(request), { code: 'NO_PROGRESS' });
      assert.equal(
        requests.length - before,
        2,
        'host stops identical rejected submissions without an arbitrary turn budget',
      );
      const session = store.db
        .prepare('SELECT id,state FROM agent_sessions ORDER BY rowid DESC LIMIT 1')
        .get()!;
      assert.equal(session.state, 'interrupted');
      if (stuck === 'stuck_text' || stuck === 'stuck_empty') {
        assert.equal(
          store.db.prepare('SELECT COUNT(*) AS n FROM tool_executions WHERE session_id=?').get(session.id!)!
            .n,
          0,
        );
        const diagnostic = store.artifact<any>(
          task.id,
          `${store.task(task.id).stage}.no_progress`,
          false,
        )!.data;
        assert.deepEqual(diagnostic.feedback, { code: 'AGENT_NO_OUTPUT', requiredTool: 'submit_result' });
        assert.equal(diagnostic.candidate.text, stuck === 'stuck_text' ? '等待提交结果' : '');
      }
      fixed = true;
      mode = 'complete';
      assert.deepEqual(await agent.run(request), { status: 'ok', echoed: 'filmedit' });
      assert.equal(
        store.db.prepare('SELECT id FROM agent_sessions ORDER BY rowid DESC LIMIT 1').get()!.id,
        session.id,
        'repair resumes the same observer session',
      );
      assert.equal(
        store.db.prepare('SELECT state FROM agent_sessions WHERE id=?').get(session.id!)!.state,
        'completed',
      );
    }
    mode = 'text_then_submit';
    const beforeCorrection = requests.length;
    assert.deepEqual(await agent.run({ ...input, input: { test: 'one reminder then valid submission' } }), {
      status: 'ok',
      echoed: 'filmedit',
    });
    assert.equal(
      requests.length - beforeCorrection,
      2,
      'one non-submission can be corrected without blocking',
    );
    mode = 'stuck_text';
    for (let turn = 0; turn < 2; turn++) {
      const reply = await runPiSession(store, runner.processes, {
        scope: 'ordinary conversation fixture',
        role: 'conversation',
        taskId: task.id,
        system: 'Answer in plain text',
        prompt: 'Say the fixture text',
        tools: [],
        structured: false,
      });
      assert.equal(
        reply.text,
        '等待提交结果',
        'ordinary conversation has no structured submission requirement',
      );
    }
    mode = 'resume';
    const resumed = { ...input, input: { test: 'resume' } };
    await assert.rejects(agent.run(resumed), { code: 'AGENT_FAILED' });
    const session = store.db
      .prepare("SELECT * FROM agent_sessions WHERE state='interrupted' ORDER BY rowid DESC LIMIT 1")
      .get()!;
    const before = store.db
      .prepare("SELECT COUNT(*) AS n FROM tool_executions WHERE session_id=? AND name='assets'")
      .get(session.id as string)!.n;
    mode = 'complete';
    await agent.run(resumed);
    assert.equal(
      store.db.prepare('SELECT state FROM agent_sessions WHERE id=?').get(session.id as string)!.state,
      'completed',
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM tool_executions WHERE session_id=? AND name='assets'")
        .get(session.id as string)!.n,
      before,
      'resume does not repeat completed tools',
    );
    mode = 'resume';
    const changedEvidence = { ...input, input: { test: 'changed-image' } };
    await assert.rejects(agent.run(changedEvidence), { code: 'AGENT_FAILED' });
    const previousEvidence = store.db
      .prepare("SELECT id FROM agent_sessions WHERE state='interrupted' ORDER BY rowid DESC LIMIT 1")
      .get()!;
    await runner.processes.run('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32',
      '-frames:v',
      '1',
      picture,
    ]);
    mode = 'complete';
    await agent.run(changedEvidence);
    assert.equal(
      store.db.prepare('SELECT state FROM agent_sessions WHERE id=?').get(previousEvidence.id!)!.state,
      'interrupted',
      'changed image bytes must create a new observer context',
    );
    mode = 'unauthorized';
    await assert.rejects(
      agent.run({ ...input, input: { test: 'auth' } }),
      (e) => (e as any).code === 'AGENT_FAILED' && /401|Invalid/.test((e as Error).message),
    );
    mode = 'balance';
    const billingRequest = { ...input, input: { test: 'billing-resume' } };
    const requestCount = requests.length;
    await assert.rejects(agent.run(billingRequest), { code: 'MODEL_BALANCE' });
    assert.equal(requests.length - requestCount, 1, 'billing failure must not retry a paid model call');
    const billingSession = store.db
      .prepare("SELECT id FROM agent_sessions WHERE state='interrupted' ORDER BY rowid DESC LIMIT 1")
      .get()!;
    mode = 'complete';
    await agent.run(billingRequest);
    assert.equal(
      store.db.prepare('SELECT state FROM agent_sessions WHERE id=?').get(billingSession.id!)!.state,
      'completed',
      'resume completes the same session after the provider becomes available',
    );
    const workbench = new Workbench(store, new TaskService(store));
    mode = 'discover';
    for (const role of ['materials', 'script', 'facts_review'] as const) {
      const localTask = await createTask(store, {
        prompt: '按需读取已授权源内容，其他部分自由创作',
        materials: { strategy: 'local_only' },
        access: { readPaths: [picture] },
      });
      const localRunner = new TaskRunner(store, localTask.id);
      const beforeDiscovery = requests.length;
      await localRunner.agent.run({ ...input, role, images: undefined, input: { test: 'discover' } });
      assert.equal(requests.length - beforeDiscovery, 4);
      assert.equal(store.assets(localTask.id).length, 1);
      assert.equal(store.assets(localTask.id)[0]!.source.path, picture);
      assert.ok(JSON.stringify(requests.at(-1)!.body.messages).includes('image_url'));
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM library_assets').get()!.n, 0);
    try {
      feedbackTaskId = task.id;
      for (const variant of ['command', 'cli', 'concept_command', 'concept_cli', 'comment']) {
        mode = `conversation_feedback_${variant}`;
        feedbackText =
          variant === 'comment'
            ? '我觉得开头节奏太慢'
            : variant.startsWith('concept')
              ? '哪个创意比较好？先分析一下'
              : '检查一下现在的进度';
        const conversation = workbench.createConversation();
        workbench.focus(conversation.id as string, task.id);
        const requestStart = requests.length;
        const submitted = workbench.submitMessage(conversation.id as string, {
          requestId: variant,
          text: feedbackText,
        });
        for (let i = 0; i < 250 && workbench.job(submitted.jobId).state !== 'completed'; i++)
          await new Promise((r) => setTimeout(r, 20));
        assert.equal(workbench.job(submitted.jobId).state, 'completed');
        if (variant !== 'comment') {
          assert.ok(
            requests
              .slice(requestStart)
              .some((r) => JSON.stringify(r.body.messages).includes('HUMAN_VERDICT_REQUIRED')),
          );
          assert.equal(
            store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='task.feedback'").get()!.n,
            0,
          );
        } else {
          const feedback = await workbench.command({
            requestId: 'read-feedback',
            command: 'task.feedback.list',
            taskId: task.id,
          });
          assert.equal(feedback.items.length, 1);
          assert.equal(feedback.items[0].content, feedbackText);
          assert.deepEqual(feedback.items[0].origin, { kind: 'conversation', messageId: submitted.id });
        }
      }
    } finally {
      await workbench.close();
    }
    assert.ok(!JSON.stringify(store.activityPage(0)).includes('fixture-key'));
  },
);
