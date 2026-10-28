import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { Store } from '../../infrastructure/src/store.js';
import { ProcessRunner, runtimeScript } from '../../infrastructure/src/process.js';
import {
  resolveModelConfiguration,
  requireModelCredentials,
  modelEnvironment,
  modelSummary,
  modelRequestFailure,
} from '../../infrastructure/src/model-provider.js';
import { canonical, errorInfo, FilmError, hash, id, invariant } from '../../core/src/util.js';
import { rejectRepeatedState } from '../../infrastructure/src/loop-progress.js';

export type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
  details?: unknown;
  terminate?: boolean;
};
export type FilmTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  execute: (args: any, callId: string) => Promise<ToolResult>;
  replaySafe?: boolean;
};
export function tool(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  execute: FilmTool['execute'],
): FilmTool {
  return { name, description, schema: z.object(shape), execute, replaySafe: true };
}
export const textResult = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: canonical(value) }],
});
export type SessionOptions = {
  scope: string;
  role: string;
  system: string;
  prompt: string;
  tools: FilmTool[];
  taskId?: string;
  conversationId?: string;
  images?: { data: string; mimeType: string; type: 'image'; label: string }[];
  structured?: boolean;
  maxTurns?: number;
  budgetUsd?: number;
  initialMessages?: any[];
  onAccepted?: (output: unknown) => void;
};
export async function runPiSession(store: Store, runner: ProcessRunner, options: SessionOptions) {
  const config = resolveModelConfiguration();
  requireModelCredentials(config);
  const scope = hash({
    scope: options.scope,
    role: options.role,
    system: options.system,
    prompt: options.prompt,
    images: options.images?.map((image) => ({
      digest: hash(image.data),
      label: image.label,
      mimeType: image.mimeType,
    })),
    model: modelSummary(config),
  });
  const previous = store.db
    .prepare(
      "SELECT * FROM agent_sessions WHERE scope=? AND state IN ('running','interrupted') ORDER BY rowid DESC LIMIT 1",
    )
    .get(scope);
  const sessionId = (previous?.id as string) ?? id('session');
  let messages: any[] = previous ? JSON.parse(previous.messages as string) : (options.initialMessages ?? []);
  let output: unknown = previous?.output ? JSON.parse(previous.output as string) : undefined;
  const emit = (type: string, data: unknown) => {
    store.activity(
      type,
      { role: options.role, sessionId, ...(data as object) },
      { taskId: options.taskId, conversationId: options.conversationId },
    );
    if (options.taskId && ['agent.started', 'agent.completed', 'agent.tool'].includes(type))
      store.event(options.taskId, type, { role: options.role, sessionId, ...(data as object) });
  };
  if (!previous)
    store.db
      .prepare('INSERT INTO agent_sessions(id,scope,task_id,role,state,messages,model) VALUES(?,?,?,?,?,?,?)')
      .run(
        sessionId,
        scope,
        options.taskId ?? null,
        options.role,
        'running',
        canonical(messages),
        canonical(modelSummary(config)),
      );
  if (output !== undefined) {
    options.onAccepted?.(output);
    store.db.prepare("UPDATE agent_sessions SET state='completed' WHERE id=?").run(sessionId);
    return { sessionId, output, text: '' };
  }
  store.db
    .prepare("UPDATE agent_sessions SET state='running',updated=CURRENT_TIMESTAMP WHERE id=?")
    .run(sessionId);
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  const execute = async (name: string, args: any, callId: string): Promise<ToolResult> => {
    runner.signal?.throwIfAborted();
    invariant(output === undefined, 'AGENT_ALREADY_SUBMITTED', 'Result already submitted');
    const definition = tools.get(name);
    invariant(definition, 'CAPABILITY_DENIED', `Tool ${name} is unavailable to ${options.role}`);
    const executionId = `${sessionId}:${callId}`;
    const cached = store.db.prepare('SELECT * FROM tool_executions WHERE id=?').get(executionId);
    if (cached?.state === 'completed') return JSON.parse(cached.result as string);
    if (cached && !definition.replaySafe)
      return {
        ...textResult({
          code: 'TOOL_INTERRUPTED',
          action: 'Inspect current state before repeating this operation.',
        }),
        isError: true,
      };
    store.db
      .prepare('INSERT OR IGNORE INTO tool_executions(id,session_id,name,args,state) VALUES(?,?,?,?,?)')
      .run(executionId, sessionId, name, canonical(args), 'running');
    emit('agent.tool', { tool: name, callId, allowed: true });
    let parsed: any;
    let fatal: FilmError | undefined;
    let result: ToolResult;
    try {
      parsed = definition.schema.parse(args);
      result = await definition.execute(parsed, executionId);
    } catch (error) {
      result = { ...textResult(errorInfo(error)), isError: true };
      if (error instanceof FilmError && error.code === 'NO_PROGRESS') fatal = error;
    }
    if (result.terminate && !result.isError && name === 'submit_result') {
      output = parsed.result;
      store.db.prepare('UPDATE agent_sessions SET output=? WHERE id=?').run(canonical(output), sessionId);
      options.onAccepted?.(output);
    }
    store.db
      .prepare("UPDATE tool_executions SET state='completed',result=?,updated=CURRENT_TIMESTAMP WHERE id=?")
      .run(canonical(result), executionId);
    if (fatal) throw fatal;
    return result;
  };
  // A crash between tool completion and transcript append must not run a write twice.
  if (previous && messages.length) {
    let assistant = messages.length - 1;
    while (assistant >= 0 && messages[assistant].role === 'toolResult') assistant--;
    const tail = messages[assistant];
    if (tail?.role === 'assistant') {
      const done = new Set(messages.slice(assistant + 1).map((m) => m.toolCallId));
      for (const call of tail.content.filter((c: any) => c.type === 'toolCall' && !done.has(c.id))) {
        const result = await execute(call.name, call.arguments, call.id);
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          details: result.details,
          isError: Boolean(result.isError),
          timestamp: Date.now(),
        });
      }
    }
    if (output !== undefined) {
      store.db
        .prepare("UPDATE agent_sessions SET state='completed',messages=? WHERE id=?")
        .run(canonical(messages), sessionId);
      return { sessionId, output, text: '' };
    }
    if (messages.at(-1)?.role === 'assistant')
      messages.push({
        role: 'user',
        content: '上次运行中断。请根据已保存结果继续完成，不要重复已完成的操作。',
        timestamp: Date.now(),
      });
  }
  const prepared = await runner.spawnOptions(
    process.execPath,
    ['--use-env-proxy', runtimeScript('pi-worker.js')],
    {
      domains: [new URL(config.baseUrl).hostname],
      env: modelEnvironment(config),
    },
  );
  emit('agent.started', { model: modelSummary(config), resumed: Boolean(previous) });
  const child = spawn(prepared.command, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const redact = (s: string) => s.replaceAll(config.apiKey, '[REDACTED]');
  let diagnostic = '',
    settled = false,
    killTimer: NodeJS.Timeout | undefined;
  child.stderr.on('data', (b) => {
    diagnostic = (diagnostic + redact(String(b))).slice(-3000);
  });
  const send = (message: unknown) => {
    if (!child.stdin.destroyed) child.stdin.write(`${canonical(message)}\n`);
  };
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill();
    }
  };
  const abort = () => {
    send({ type: 'abort' });
    killTimer = setTimeout(kill, 1500);
    killTimer.unref();
  };
  runner.signal?.addEventListener('abort', abort, { once: true });
  if (runner.signal?.aborted) abort();
  const usage = (value: any) => {
    const cost = value?.cost?.total ?? 0;
    if (options.taskId) store.addCost(options.taskId, cost);
    emit('agent.usage', { usage: value });
  };
  try {
    const result = await new Promise<{ text: string }>((resolve, reject) => {
      const finish = (error?: Error, value?: any) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve(value);
      };
      child.on('error', (error) => finish(error));
      child.on('close', (code) =>
        finish(
          new FilmError(
            runner.signal?.aborted ? 'CANCELLED' : 'AGENT_FAILED',
            `Agent process exited ${code}: ${diagnostic}`,
          ),
        ),
      );
      createInterface({ input: child.stdout }).on('line', (line) => {
        void (async () => {
          const packet = JSON.parse(line);
          if (packet.type === 'done') return finish(undefined, packet.data);
          if (packet.type === 'failed')
            return finish(
              runner.signal?.aborted
                ? new FilmError('CANCELLED', redact(packet.data.message))
                : modelRequestFailure(redact(packet.data.message)),
            );
          if (packet.type === 'delta') {
            emit('agent.delta', packet.data);
            return;
          }
          let result: unknown = {};
          if (packet.type === 'tool')
            result = await execute(packet.data.name, packet.data.args, packet.data.callId);
          else if (packet.type === 'checkpoint') {
            store.db
              .prepare('UPDATE agent_sessions SET messages=?,updated=CURRENT_TIMESTAMP WHERE id=?')
              .run(canonical(packet.data.messages), sessionId);
            if (packet.data.message.role === 'assistant') usage(packet.data.message.usage);
            // pi can reject arguments before invoking the host tool. Inspect the persisted
            // result instead so both schema and domain-validation failures use one guard.
            const message = packet.data.message;
            if (options.structured && options.taskId && output === undefined) {
              if (message.role === 'toolResult' && message.toolName === 'submit_result' && message.isError) {
                const submission = packet.data.messages
                  .filter((entry: any) => entry.role === 'assistant')
                  .flatMap((entry: any) => entry.content)
                  .findLast((entry: any) => entry.type === 'toolCall' && entry.id === message.toolCallId);
                invariant(submission, 'AGENT_PROTOCOL', 'Rejected submission has no matching tool call');
                rejectRepeatedState(
                  store,
                  options.taskId,
                  store.task(options.taskId).stage,
                  `submission:${options.role}:${scope}`,
                  submission.arguments?.result ?? submission.arguments,
                  message.content,
                );
              } else if (
                message.role === 'assistant' &&
                !['error', 'aborted'].includes(message.stopReason) &&
                !message.content.some((entry: any) => entry.type === 'toolCall')
              ) {
                rejectRepeatedState(
                  store,
                  options.taskId,
                  store.task(options.taskId).stage,
                  `missing_submission:${options.role}:${scope}`,
                  {
                    text: message.content
                      .filter((entry: any) => entry.type === 'text')
                      .map((entry: any) => entry.text)
                      .join(''),
                  },
                  { code: 'AGENT_NO_OUTPUT', requiredTool: 'submit_result' },
                );
              }
            }
          } else if (packet.type === 'before_request') {
            if (options.taskId && options.budgetUsd !== undefined)
              invariant(
                store.task(options.taskId).cost < options.budgetUsd,
                'BUDGET_EXHAUSTED',
                'Configured model budget exhausted',
              );
          } else if (packet.type === 'usage') usage(packet.data);
          else if (packet.type === 'event') emit('agent.event', packet.data);
          send({ id: packet.id, data: result });
        })().catch((error) => {
          if (error instanceof FilmError && error.code === 'NO_PROGRESS') {
            finish(error);
            return;
          }
          try {
            send({ id: JSON.parse(line).id, error: redact(error.message) });
          } catch {
            finish(error);
          }
        });
      });
      send({
        type: 'start',
        data: {
          sessionId,
          model: modelSummary(config),
          system: options.system,
          prompt: options.prompt,
          tools: options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: z.toJSONSchema(t.schema, { io: 'input' }),
          })),
          messages,
          resume: Boolean(previous && messages.length),
          images: options.images,
          structured: options.structured,
          maxTurns: options.maxTurns,
        },
      });
    });
    if (options.structured)
      invariant(output !== undefined, 'AGENT_NO_OUTPUT', 'No validated structured output was submitted');
    store.db
      .prepare("UPDATE agent_sessions SET state='completed',updated=CURRENT_TIMESTAMP WHERE id=?")
      .run(sessionId);
    emit('agent.completed', {});
    return { ...result, sessionId, output };
  } catch (error) {
    store.db
      .prepare("UPDATE agent_sessions SET state='interrupted',updated=CURRENT_TIMESTAMP WHERE id=?")
      .run(sessionId);
    throw error;
  } finally {
    runner.signal?.removeEventListener('abort', abort);
    if (killTimer) clearTimeout(killTimer);
    child.stdin.end();
    kill();
  }
}
