#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { connect } from '../../../packages/client/src/client.js';
import { parseFilmCommand, describeCommand } from '../../../packages/core/src/commands.js';
import { errorInfo, invariant } from '../../../packages/core/src/util.js';
import { projectRoot } from '../../../packages/infrastructure/src/process.js';

const help = `FilmEdit · 视频剪辑工作台 (pi)

  filmedit                         打开 TUI；Server 自动在后台启动
  filmedit tui [--conversation ID]
  filmedit chat "剪一条横屏汽车视频" [--conversation ID] [--task ID]
  filmedit server start | status | stop
  filmedit create --prompt "需求" [--asset PATH ...] [--strategy local_only]
      [--composition 16:9] [--ratio 9:16] [--fit contain] [--duration 60]
  filmedit run|resume|pause|cancel TASK_ID
  filmedit status [TASK_ID]
  filmedit review TASK_ID             打开任务流程审阅链接
  filmedit memory list --account ID
  filmedit memory correct MEMORY_ID --account ID --json '{"content":"纠正后的记忆","tags":[]}'
  filmedit export TASK_ID --ratio 16:9 [--height 1080] [--wait]
  filmedit task revise TASK_ID --json '{"expectedVersion":1,"kind":"layout","instruction":"保留画面全貌"}'
  filmedit library import PATH --category meme|sfx|bgm|video [--tag TEXT]
  filmedit library search --query TEXT [--category bgm] [--semantic]
  filmedit library inspect|analyze|bind LIBRARY_ID [--task TASK_ID]
  filmedit command COMMAND --json '{}' [--task ID] [--wait]
  filmedit schema [task.create|task.revise|task.export]
  filmedit skills list | skills read library
  filmedit doctor | model-test

TUI: F1–F5 切换面板 · Ctrl+T 任务 · Ctrl+N 对话 · Ctrl+O 预览
关闭 TUI 不会中断任务；暂停请用 /pause。全部变更通过本地 Server。
`;
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
export async function main(argv = process.argv.slice(2)) {
  const [first, second] = argv;
  if (first === 'help' || argv.includes('--help')) {
    process.stdout.write(help);
    return;
  }
  if (first === 'schema') {
    print(describeCommand(second));
    return;
  }
  if (first === 'skills') {
    if (second === 'list') {
      print(['conversation', 'library', 'script-draft', 'material-match', 'editorial-plan']);
      return;
    }
    const name = argv[2];
    invariant(name && /^[a-z-]+$/.test(name), 'SKILL_NAME', 'Use skills read library');
    process.stdout.write(await readFile(path.join(projectRoot, 'skills', name, 'SKILL.md'), 'utf8'));
    return;
  }
  if (first === 'doctor' || first === 'model-test') {
    const { loadProjectEnv } = await import('../../../packages/infrastructure/src/model-provider.js');
    await loadProjectEnv();
    if (first === 'doctor') {
      const { doctor, formatDoctor } = await import('../../../packages/infrastructure/src/doctor.js');
      const report = await doctor();
      if (argv.includes('--json')) print(report);
      else process.stdout.write(formatDoctor(report));
    } else
      print(
        await (
          await import('../../../packages/application/src/model-check.js')
        ).checkModelConnection(undefined, argv.includes('--vision')),
      );
    return;
  }
  if (first === 'serve') {
    const { startDaemon } = await import('../../server/src/daemon.js');
    const port = argv.indexOf('--port');
    const api = await startDaemon(undefined, port >= 0 ? Number(argv[port + 1]) : 8787);
    print({ url: api.url, credentials: 'Stored in FILMEDIT_HOME/daemon.json (mode 600)' });
    return;
  }
  const client = await connect(undefined, !(first === 'server' && ['status', 'stop'].includes(second ?? '')));
  if (first === 'server') {
    if (second === 'stop') {
      await client.request('/health');
      process.kill(client.connection.pid, 'SIGTERM');
      print({ stopping: true });
    } else print(await client.request('/health'));
    return;
  }
  if (!first || first === 'tui') {
    invariant(
      process.stdin.isTTY && process.stdout.isTTY,
      'TTY_REQUIRED',
      'TUI needs a terminal. Use filmedit chat or filmedit --help in scripts.',
    );
    const index = argv.indexOf('--conversation');
    await (await import('./tui.js')).launchTui(client, index < 0 ? undefined : argv[index + 1]);
    return;
  }
  if (['library', 'task', 'account', 'memory'].includes(first ?? '')) {
    const wait = argv.includes('--wait'),
      c = parseFilmCommand(argv.filter((x) => x !== '--wait'));
    const result = await client.command(c.command, c.args, c.taskId);
    print(wait ? await waitJob(client, result) : result);
    return;
  }
  const { positionals: p, values: v } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      prompt: { type: 'string' },
      input: { type: 'string' },
      json: { type: 'string' },
      asset: { type: 'string', multiple: true },
      strategy: { type: 'string' },
      read: { type: 'string', multiple: true },
      write: { type: 'string', multiple: true },
      deny: { type: 'string', multiple: true },
      account: { type: 'string' },
      duration: { type: 'string' },
      ratio: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      fps: { type: 'string' },
      fit: { type: 'string' },
      background: { type: 'string' },
      composition: { type: 'string' },
      'media-fit': { type: 'string' },
      'no-creative': { type: 'boolean' },
      seed: { type: 'string' },
      task: { type: 'string' },
      conversation: { type: 'string' },
      wait: { type: 'boolean' },
      name: { type: 'string' },
      query: { type: 'string' },
      resample: { type: 'boolean' },
      run: { type: 'string' },
      list: { type: 'boolean' },
      daemon: { type: 'boolean' },
      interval: { type: 'string' },
    },
  });
  const profile = {
    aspectRatio: v.ratio,
    width: v.width ? Number(v.width) : undefined,
    height: v.height ? Number(v.height) : undefined,
    fps: v.fps ? Number(v.fps) : undefined,
    fit: v.fit,
    background: v.background,
  };
  const data = v.input
    ? JSON.parse(await readFile(path.resolve(v.input), 'utf8'))
    : v.json
      ? JSON.parse(v.json)
      : {};
  let result: any;
  if (first === 'chat') {
    const conversation = v.conversation
      ? await client.request(`/conversations/${v.conversation}`)
      : await client.request('/conversations', 'POST', {
          title: p.slice(1).join(' ').slice(0, 80) || 'CLI 对话',
        });
    invariant(p[1], 'MESSAGE_REQUIRED', 'Use filmedit chat "消息"');
    const submitted = await client.request(`/conversations/${conversation.id}/messages`, 'POST', {
      requestId: crypto.randomUUID(),
      text: p.slice(1).join(' '),
      ...(v.task ? { taskId: v.task } : {}),
    });
    result = { conversationId: conversation.id, ...(await waitJob(client, { id: submitted.jobId })) };
  } else if (first === 'command') {
    invariant(second, 'COMMAND_REQUIRED', 'Command name required');
    result = await client.command(second, data, v.task);
  } else if (first === 'create')
    result = await client.command(
      'task.create',
      v.input || v.json
        ? data
        : {
            prompt: v.prompt,
            accountId: v.account,
            materials: { paths: v.asset?.map((p) => path.resolve(p)), strategy: v.strategy },
            access: {
              readPaths: v.read?.map((p) => path.resolve(p)),
              writePaths: v.write?.map((p) => path.resolve(p)),
              denyPaths: v.deny?.map((p) => path.resolve(p)),
            },
            output: { ...profile, duration: v.duration ? Number(v.duration) : undefined },
            composition: { aspectRatio: v.composition, mediaFit: v['media-fit'] },
            creative: { enabled: !v['no-creative'], seed: v.seed },
          },
    );
  else if (['run', 'resume', 'pause', 'cancel'].includes(first))
    result = await client.command(`task.${first}`, {}, second);
  else if (first === 'status')
    result = await client.command(second ? 'task.inspect' : 'task.list', {}, second);
  else if (first === 'export') result = await client.command('task.export', profile, second);
  else if (first === 'unlimit')
    result = await client.command(
      'task.budgets',
      { stageRounds: null, renderRounds: null, agentTurns: null, usd: null },
      second,
    );
  else if (first === 'review') {
    const result = await client.request(`/tasks/${second}/review`, 'POST', {});
    print({ url: client.connection.url + result.path, expiresIn: result.expiresIn });
    return;
  } else if (first === 'accounts')
    result = await client.request(
      '/accounts',
      v.name ? 'POST' : 'GET',
      v.name ? { name: v.name } : undefined,
    );
  else if (first === 'memory')
    result = await client.request(
      `/accounts/${second}/memory${v.query ? '?q=' + encodeURIComponent(v.query) : ''}`,
      v.input ? 'POST' : 'GET',
      v.input ? data : undefined,
    );
  else if (first === 'creative') {
    if (v.resample) {
      const t = await client.request(`/tasks/${second}`);
      result = await client.command(
        'task.revise',
        {
          expectedVersion: t.version,
          kind: 'creative',
          instruction: '重新采样创意',
          seed: v.seed ?? crypto.randomUUID(),
        },
        second,
      );
    } else result = await client.request(`/tasks/${second}/creative`);
  } else if (first === 'creative-feedback')
    result = await client.request(`/tasks/${second}/creative/feedback`, 'POST', data);
  else if (first === 'culture')
    result = await client.request(
      `/tasks/${second}/culture${v.query ? '?q=' + encodeURIComponent(v.query) : ''}`,
      v.input ? 'POST' : 'GET',
      v.input ? data : undefined,
    );
  else if (first === 'learn')
    result = await client.command(
      v.daemon
        ? 'learning.configure'
        : v.list
          ? 'learning.list'
          : v.run
            ? 'learning.run'
            : 'learning.enqueue',
      v.daemon ? { enabled: true, intervalSeconds: Number(v.interval ?? 300) } : v.run ? { id: v.run } : data,
    );
  else if (first === 'releases') result = await client.request('/releases');
  else if (first === 'rollback') result = await client.request('/releases/rollback', 'POST', {});
  else {
    process.stdout.write(help);
    throw new Error('Unknown command ' + first);
  }
  print(v.wait ? await waitJob(client, result) : result);
}
async function waitJob(client: Awaited<ReturnType<typeof connect>>, result: any) {
  if (!result?.id?.startsWith('job_')) return result;
  while (true) {
    const job = await client.request(`/jobs/${result.id}`);
    if (job.state === 'completed') return job;
    if (['blocked', 'paused', 'cancelled'].includes(job.state)) {
      print(job);
      throw new Error(`Job ${job.state}: ${job.result?.message ?? job.id}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
main().catch((error) => {
  process.stderr.write(JSON.stringify(errorInfo(error), null, 2) + '\n');
  process.exitCode = 1;
});
