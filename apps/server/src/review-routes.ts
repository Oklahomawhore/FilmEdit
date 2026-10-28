import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Workbench } from '../../../packages/application/src/workbench.js';
import { reviewTask, reviewArtifact } from '../../../packages/application/src/review.js';
import { TaskRunner } from '../../../packages/application/src/workflow.js';
import { PathPolicy } from '../../../packages/infrastructure/src/security.js';
import { invariant } from '../../../packages/core/src/util.js';
import { reviewPage } from './review-page.js';
import { streamMedia } from './media-response.js';

export function reviewRoutes(workbench: Workbench) {
  const tickets = new Map<string, { taskId: string; expires: number }>();
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    send: (status: number, value: unknown) => void,
  ) => {
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      request.method === 'POST' &&
      parts[0] === 'tasks' &&
      parts[1] &&
      parts[2] === 'review' &&
      parts.length === 3
    ) {
      workbench.store.productionTask(parts[1]);
      for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
      const ticket = randomBytes(24).toString('hex');
      tickets.set(ticket, { taskId: parts[1], expires: Date.now() + 3600_000 });
      send(201, { path: `/review/${ticket}`, expiresIn: 3600 });
      return true;
    }
    if (parts[0] !== 'review' || request.method !== 'GET') return false;
    const ticket = tickets.get(parts[1]!);
    invariant(
      ticket && ticket.expires > Date.now(),
      'UNAUTHORIZED',
      '审阅链接已过期，请在 TUI 使用 /review 重新打开',
    );
    const task = workbench.store.productionTask(ticket.taskId),
      policy = new PathPolicy(task.policy);
    if (parts.length === 2) {
      const nonce = randomBytes(16).toString('base64');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; connect-src 'self'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      });
      response.end(reviewPage(nonce));
      return true;
    }
    if (parts[2] === 'data' && parts.length === 3) {
      send(200, reviewTask(workbench.store, task.id));
      return true;
    }
    if (parts[2] === 'artifact' && parts[3] && parts.length === 4) {
      send(200, reviewArtifact(workbench.store, task.id, parts[3]));
      return true;
    }
    if (parts[2] === 'asset' && parts[3] && parts.length === 4) {
      const runner = new TaskRunner(workbench.store, task.id);
      const file = await runner.library.resolve(parts[3]);
      await streamMedia(request, response, file);
      return true;
    }
    if (parts[2] === 'output' && parts[3] && parts.length === 4) {
      const row = workbench.store.db
        .prepare('SELECT stage,data FROM artifacts WHERE task_id=? AND id=?')
        .get(task.id, parts[3]);
      invariant(
        row &&
          (['layout.preview', 'render.candidate_media', 'render', 'output.current'].includes(
            String(row.stage),
          ) ||
            String(row.stage).startsWith('export.')),
        'ARTIFACT_MISSING',
        'No rendered media in this artifact',
      );
      const file = JSON.parse(row.data as string).path;
      invariant(typeof file === 'string', 'VIDEO_MISSING', 'This artifact has no media file');
      await streamMedia(request, response, await policy.check(file, 'read'));
      return true;
    }
    send(404, { code: 'NOT_FOUND' });
    return true;
  };
}
