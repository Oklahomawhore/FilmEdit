import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../../../packages/infrastructure/src/store.js';
import { CreativeStore } from '../../../packages/infrastructure/src/creative-store.js';
import { creativeStatus } from '../../../packages/application/src/creative-service.js';
import { PathPolicy } from '../../../packages/infrastructure/src/security.js';
import { LearningService } from '../../../packages/application/src/learning.js';
import { errorInfo, invariant } from '../../../packages/core/src/util.js';

import { Workbench, type WorkbenchOptions } from '../../../packages/application/src/workbench.js';
import { workbenchRoutes } from './api-workbench.js';
import { reviewRoutes } from './review-routes.js';
import { TaskService } from '../../../packages/application/src/task-service.js';
async function body(request: IncomingMessage) {
  invariant(
    request.headers['content-type']?.startsWith('application/json'),
    'CONTENT_TYPE',
    'Use application/json',
  );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    invariant(size <= 2_000_000, 'BODY_LIMIT', 'Request exceeds 2 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function send(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}
export function createApi(
  store: Store,
  token = process.env.FILMEDIT_API_TOKEN?.trim() || randomBytes(32).toString('hex'),
  options: WorkbenchOptions = {},
) {
  invariant(token.length > 0, 'API_TOKEN', 'API token must not be empty');
  const tasks = new TaskService(store);
  const learning = new LearningService(store);
  const workbench = new Workbench(store, tasks, options);
  const routes = workbenchRoutes(workbench);
  const reviews = reviewRoutes(workbench);
  const server = createServer(async (request, response) => {
    try {
      const provided = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const expected = Buffer.from(token);
      invariant(
        (provided.length === expected.length && timingSafeEqual(provided, expected)) ||
          (request.method === 'GET' &&
            /^\/(?:(?:preview|media)\/[a-f0-9]{48}|review\/[a-f0-9]{48}(?:\/(?:data|(?:artifact|asset|output)\/[A-Za-z0-9_-]+))?)$/.test(
              request.url ?? '',
            )),
        'UNAUTHORIZED',
        'Bearer token required',
      );
      invariant(!request.headers.origin, 'ORIGIN_DENIED', 'Browser cross-origin requests are not enabled');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const route = url.pathname.split('/').filter(Boolean);
      const method = request.method ?? 'GET';
      const command = (name: string, args: unknown, taskId?: string) =>
        workbench.command({
          requestId: request.headers['idempotency-key'] ?? crypto.randomUUID(),
          command: name,
          args,
          taskId,
        });
      if (await reviews(request, response, url, (status, data) => send(response, status, data))) return;
      if (
        await routes(
          request,
          response,
          url,
          () => body(request),
          (status, data) => send(response, status, data),
        )
      )
        return;
      if (route[0] === 'tasks' && route.length === 1) {
        if (method === 'GET') return send(response, 200, store.tasks());
        if (method === 'POST')
          return send(
            response,
            201,
            await workbench.command({
              requestId: request.headers['idempotency-key'] ?? crypto.randomUUID(),
              command: 'task.create',
              args: { input: await body(request) },
            }),
          );
      }
      if (route[0] === 'tasks' && route[1]) {
        const taskId = route[1];
        const task = store.productionTask(taskId);
        if (route.length === 2 && method === 'GET') return send(response, 200, task);
        if (['run', 'resume'].includes(route[2] ?? '') && method === 'POST')
          return send(
            response,
            202,
            await workbench.command({
              requestId: request.headers['idempotency-key'] ?? crypto.randomUUID(),
              command: 'task.run',
              taskId,
            }),
          );
        if (route[2] === 'cancel' && method === 'POST')
          return send(
            response,
            200,
            await workbench.command({
              requestId: request.headers['idempotency-key'] ?? crypto.randomUUID(),
              command: 'task.cancel',
              taskId,
            }),
          );
        if (route[2] === 'permissions' && method === 'PUT')
          return send(
            response,
            200,
            await workbench.command({
              requestId: crypto.randomUUID(),
              command: 'task.permissions',
              taskId,
              args: await body(request),
            }),
          );
        if (route[2] === 'budgets' && method === 'PUT')
          return send(
            response,
            200,
            await workbench.command({
              requestId: crypto.randomUUID(),
              command: 'task.budgets',
              taskId,
              args: await body(request),
            }),
          );
        if (route[2] === 'exports' && method === 'POST')
          return send(
            response,
            201,
            await workbench.command({
              requestId: request.headers['idempotency-key'] ?? crypto.randomUUID(),
              command: 'task.export',
              taskId,
              args: await body(request),
            }),
          );
        if (route[2] === 'creative' && method === 'GET')
          return send(response, 200, creativeStatus(store, taskId));
        if (route[2] === 'creative' && route[3] === 'resample' && method === 'POST') {
          const input = z
            .object({ seed: z.string().min(1).max(100).optional() })
            .strict()
            .parse(await body(request));
          return send(
            response,
            200,
            await workbench.command({
              requestId: crypto.randomUUID(),
              command: 'task.revise',
              taskId,
              args: {
                expectedVersion: task.version,
                kind: 'creative',
                instruction: '用户请求重新采样',
                seed: input.seed ?? crypto.randomUUID(),
              },
            }),
          );
        }
        if (route[2] === 'creative' && route[3] === 'feedback' && method === 'POST')
          return send(response, 201, await command('creative.feedback', await body(request), taskId));
        if (route[2] === 'culture' && method === 'GET') {
          const knowledge = new CreativeStore(store);
          return send(
            response,
            200,
            knowledge.search(knowledge.scope(taskId), url.searchParams.get('q') ?? ''),
          );
        }
        if (route[2] === 'culture' && method === 'POST') {
          return send(response, 201, await command('culture.ingest', await body(request), taskId));
        }
        if (route[2] === 'assets' && method === 'GET') return send(response, 200, store.assets(taskId));
        if (route[2] === 'artifacts' && route[3] && method === 'GET')
          return send(
            response,
            200,
            store.artifact(taskId, route[3], url.searchParams.get('accepted') !== 'false') ?? null,
          );
        if ((route[2] === 'editorial' || route[2] === 'layout') && method === 'PUT')
          return send(
            response,
            200,
            await workbench.command({
              requestId: crypto.randomUUID(),
              command: 'task.propose',
              taskId,
              args: { kind: route[2], value: await body(request) },
            }),
          );
        if (route[2] === 'feedback' && method === 'POST')
          return send(response, 201, await command('task.feedback', await body(request), taskId));
        if (route[2] === 'video' && method === 'GET') {
          const result = store.artifact<{ path: string }>(taskId, 'render');
          invariant(result, 'VIDEO_MISSING', 'No approved video available');
          const bytes = await new PathPolicy(task.policy).read(result.data.path);
          response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
          response.end(bytes);
          return;
        }
        if (route[2] === 'events' && method === 'GET') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          let cursor = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
          invariant(Number.isSafeInteger(cursor) && cursor >= 0, 'CURSOR', 'Invalid event cursor');
          const poll = () => {
            for (const event of store.events(taskId, cursor)) {
              cursor = event.seq as number;
              response.write(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
          };
          poll();
          const timer = setInterval(poll, 1000);
          request.on('close', () => clearInterval(timer));
          return;
        }
      }
      if (route[0] === 'accounts') {
        if (route.length === 1 && method === 'GET') return send(response, 200, store.accounts());
        if (route.length === 1 && method === 'POST')
          return send(response, 201, await command('account.create', await body(request)));
        if (route[1] && route[2] === 'memory' && method === 'GET')
          return send(
            response,
            200,
            await command('memory.list', { accountId: route[1], query: url.searchParams.get('q') ?? '' }),
          );
        if (route[1] && route[2] === 'memory' && method === 'POST')
          return send(
            response,
            201,
            await command('memory.add', { accountId: route[1], memory: await body(request) }),
          );
        if (route[1] && route[2] === 'memory' && route[3] && method === 'PUT')
          return send(
            response,
            200,
            await command('memory.correct', { ...(await body(request)), accountId: route[1], id: route[3] }),
          );
        if (route[1] && route[2] === 'memory' && route[3] && method === 'DELETE')
          return send(response, 200, await command('memory.remove', { accountId: route[1], id: route[3] }));
      }
      if (route[0] === 'learning' && route[1] === 'experiments') {
        if (route.length === 2 && method === 'GET') return send(response, 200, learning.list());
        if (route.length === 2 && method === 'POST')
          return send(response, 201, await command('learning.enqueue', await body(request)));
      }
      if (route[0] === 'releases' && method === 'GET')
        return send(
          response,
          200,
          store.db
            .prepare('SELECT * FROM releases ORDER BY created DESC')
            .all()
            .map((r) => ({ ...r, manifest: JSON.parse(r.manifest as string) })),
        );
      if (route[0] === 'releases' && route[1] === 'rollback' && method === 'POST')
        return send(response, 200, await command('releases.rollback', {}));
      send(response, 404, { code: 'NOT_FOUND' });
    } catch (error) {
      const info = errorInfo(error);
      if (response.headersSent) return response.end();
      send(
        response,
        info.code === 'UNAUTHORIZED'
          ? 401
          : info.code.endsWith('_MISSING')
            ? 404
            : info.code.endsWith('_BUSY')
              ? 409
              : 400,
        info,
      );
    }
  });
  server.on('close', () => {
    void workbench.close();
  });
  return { server, tasks, token, workbench };
}
