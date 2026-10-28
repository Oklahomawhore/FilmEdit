import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Workbench } from '../../../packages/application/src/workbench.js';
import { PathPolicy } from '../../../packages/infrastructure/src/security.js';
import { invariant } from '../../../packages/core/src/util.js';
import { streamMedia } from './media-response.js';

export function workbenchRoutes(workbench: Workbench) {
  const tickets = new Map<string, { taskId: string; path: string; expires: number }>();
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    readBody: () => Promise<any>,
    send: (status: number, data: unknown) => void,
  ) => {
    const route = url.pathname.split('/').filter(Boolean),
      method = request.method ?? 'GET';
    if (method === 'GET' && route[0] === 'health') {
      send(200, { ok: true, version: 2, pid: process.pid });
      return true;
    }
    if (method === 'POST' && route[0] === 'commands') {
      send(200, await workbench.command(await readBody()));
      return true;
    }
    if (route[0] === 'conversations') {
      if (route.length === 1) {
        if (method === 'GET') send(200, workbench.conversations());
        else if (method === 'POST')
          send(
            201,
            workbench.createConversation(
              z.object({ title: z.string().min(1).max(200).default('新对话') }).parse(await readBody()).title,
            ),
          );
        else return false;
        return true;
      }
      const id = route[1]!;
      if (route.length === 2 && method === 'GET') {
        send(200, workbench.conversation(id));
        return true;
      }
      if (route[2] === 'focus' && method === 'PUT') {
        send(
          200,
          workbench.focus(id, z.object({ taskId: z.string().nullable() }).parse(await readBody()).taskId),
        );
        return true;
      }
      if (route[2] === 'messages') {
        if (method === 'GET') send(200, workbench.messages(id, Number(url.searchParams.get('after') ?? 0)));
        else if (method === 'POST') send(202, workbench.submitMessage(id, await readBody()));
        else return false;
        return true;
      }
    }
    if (route[0] === 'jobs' && route[1] && method === 'GET') {
      send(200, workbench.job(route[1]));
      return true;
    }
    if (route[0] === 'tasks' && route[1]) {
      if (route[2] === 'runs' && method === 'GET') {
        send(200, workbench.runs(route[1]));
        return true;
      }
      if (route[2] === 'artifacts' && route.length === 3 && method === 'GET') {
        send(200, workbench.artifacts(route[1]));
        return true;
      }
      if (route[2] === 'preview' && method === 'POST') {
        const task = workbench.store.task(route[1]);
        const value = z.object({ artifactId: z.string().optional() }).parse(await readBody());
        const artifact = value.artifactId
          ? await workbench.command({
              requestId: crypto.randomUUID(),
              command: 'artifact.read',
              taskId: task.id,
              args: { id: value.artifactId },
            })
          : (workbench.store.artifact(task.id, 'output.current') ??
            workbench.store.artifact(task.id, 'render'));
        invariant(
          artifact &&
            typeof artifact.data.path === 'string' &&
            (artifact.stage === 'render' ||
              artifact.stage?.startsWith('export.') ||
              artifact.data.path.endsWith('.mp4')),
          'VIDEO_MISSING',
          'No rendered preview available',
        );
        await new PathPolicy(task.policy).check(artifact.data.path, 'read');
        for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
        const ticket = randomBytes(24).toString('hex');
        tickets.set(ticket, { taskId: task.id, path: artifact.data.path, expires: Date.now() + 3600_000 });
        send(201, {
          path: `/preview/${ticket}`,
          expiresIn: 3600,
          artifactId: artifact.id,
          taskId: task.id,
          taskVersion: task.version,
        });
        return true;
      }
    }
    if ((route[0] === 'preview' || route[0] === 'media') && route[1] && method === 'GET') {
      const ticket = tickets.get(route[1]);
      invariant(ticket && ticket.expires > Date.now(), 'UNAUTHORIZED', 'Preview link expired');
      if (route[0] === 'preview') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'",
        });
        response.end(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>FilmEdit 预览</title><style>body{background:#101416;color:#e5ebdf;font:16px system-ui;margin:24px}video{display:block;max-width:100%;max-height:85vh;margin:auto}p{text-align:center}</style><video controls src="/media/${route[1]}"></video><p>FilmEdit · 本地预览</p></html>`,
        );
        return true;
      }
      const file = await new PathPolicy(workbench.store.task(ticket.taskId).policy).check(
        ticket.path,
        'read',
      );
      await streamMedia(request, response, file);
      return true;
    }
    if (route[0] === 'events' && method === 'GET') {
      let cursor = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      invariant(Number.isSafeInteger(cursor) && cursor >= 0, 'CURSOR', 'Invalid event cursor');
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.flushHeaders();
      const poll = () => {
        for (const event of workbench.store.activityPage(cursor, {
          taskId: url.searchParams.get('taskId') ?? undefined,
          conversationId: url.searchParams.get('conversationId') ?? undefined,
        }) as any[]) {
          cursor = event.seq as number;
          response.write(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      };
      poll();
      const timer = setInterval(poll, 300),
        heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
      request.on('close', () => {
        clearInterval(timer);
        clearInterval(heartbeat);
      });
      return true;
    }
    return false;
  };
}
