import { z } from 'zod';
import path from 'node:path';
import { Store } from '../../infrastructure/src/store.js';
import type { TaskService } from './task-service.js';
import { invalidateDerivedArtifacts } from './revision-context.js';
import { TaskRunner, createTask } from './workflow.js';
import { taskInputSchema, type TaskInput, type Stage } from '../../core/src/domain.js';
import { compositionSchema, exportProfileInputSchema, resolveExport } from '../../core/src/presentation.js';
import { LocalLibrary, categorySchema, libraryQuerySchema } from '../../library/src/library.js';
import { PathPolicy } from '../../infrastructure/src/security.js';
import { ProcessRunner } from '../../infrastructure/src/process.js';
import { runPiSession, textResult, tool } from '../../agent-runtime/src/pi-runtime.js';
import { readFile } from 'node:fs/promises';
import { projectRoot } from '../../infrastructure/src/process.js';
import { canonical, hash, id, invariant, errorInfo } from '../../core/src/util.js';
import { resampleCreative } from './creative-service.js';

import {
  revisionInputSchema as revisionSchema,
  describeCommand,
  parseFilmCommand,
  commandCatalog,
} from '../../core/src/commands.js';
import { LearningService } from './learning.js';
import { CreativeStore } from '../../infrastructure/src/creative-store.js';
import { ReleaseManager } from '../../infrastructure/src/releases.js';
import { taskProgress } from './progress.js';
import type { RevisionGuard } from '../../core/src/revision.js';
import { feedbackHistory, feedbackSummary, recordWorkFeedback } from './feedback.js';
import type { FeedbackOrigin } from '../../core/src/feedback.js';
import { learnedKnowledge, retractLearnedKnowledge } from './learned-knowledge.js';
import { StrategyStore } from '../../infrastructure/src/strategy-store.js';
export const commandSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    command: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
    taskId: z.string().optional(),
  })
  .strict();
type Command = z.infer<typeof commandSchema>;
export type WorkbenchOptions = {
  autoStart?: boolean;
  conversationExecutor?: (input: {
    text: string;
    taskId?: string;
    history: any[];
    execute: (command: string, args?: any, taskId?: string) => Promise<unknown>;
    signal: AbortSignal;
  }) => Promise<string>;
};
export class Workbench {
  readonly library: LocalLibrary;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private heavy?: { id: string; controller: AbortController; done: Promise<void> };
  private chat?: { id: string; controller: AbortController; done: Promise<void> };
  private preempted = new Set<string>();
  private operations = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: Store,
    readonly tasks: TaskService,
    readonly options: WorkbenchOptions = {},
  ) {
    this.library = new LocalLibrary(store);
    if (options.autoStart !== false) this.start();
  }
  start() {
    // Only the daemon owner calls start. Recover interrupted jobs, preserving their IDs and checkpoints.
    this.store.db.prepare("UPDATE jobs SET state='queued' WHERE state='running'").run();
    this.store.db.prepare("UPDATE runs SET state='queued' WHERE state='running'").run();
    this.timer = setInterval(() => this.pump(), 200);
    this.timer.unref();
    this.pump();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.heavy?.controller.abort();
    this.chat?.controller.abort();
    await Promise.allSettled([this.heavy?.done, this.chat?.done]);
  }
  conversations() {
    return this.store.db.prepare('SELECT * FROM conversations ORDER BY updated DESC,rowid DESC').all();
  }
  conversation(conversationId: string) {
    const c = this.store.db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
    invariant(c, 'CONVERSATION_MISSING', 'Conversation not found');
    return c;
  }
  createConversation(title = '新对话') {
    const conversationId = id('conversation');
    this.store.db.prepare('INSERT INTO conversations(id,title) VALUES(?,?)').run(conversationId, title);
    return this.conversation(conversationId);
  }
  focus(conversationId: string, taskId: string | null) {
    this.conversation(conversationId);
    if (taskId) this.store.productionTask(taskId);
    this.store.db
      .prepare('UPDATE conversations SET task_id=?,updated=CURRENT_TIMESTAMP WHERE id=?')
      .run(taskId, conversationId);
    return this.conversation(conversationId);
  }
  messages(conversationId: string, after = 0) {
    this.conversation(conversationId);
    return this.store.db
      .prepare(
        'SELECT rowid AS seq,* FROM messages WHERE conversation_id=? AND rowid>? ORDER BY rowid LIMIT 200',
      )
      .all(conversationId, after)
      .map((r) => ({ ...r, content: JSON.parse(r.content as string) }));
  }
  submitMessage(conversationId: string, input: unknown) {
    const value = z
      .object({
        requestId: z.string().min(1).max(200),
        text: z.string().min(1).max(50000),
        taskId: z.string().nullable().optional(),
        references: z
          .array(
            z.object({
              kind: z.enum(['asset', 'shot', 'artifact']),
              id: z.string(),
              taskId: z.string().optional(),
            }),
          )
          .max(30)
          .default([]),
      })
      .strict()
      .parse(input);
    const conversation = this.conversation(conversationId),
      taskId = value.taskId === undefined ? (conversation.task_id as string | null) : value.taskId;
    if (taskId) this.store.productionTask(taskId);
    for (const ref of value.references) {
      if (ref.kind === 'asset') this.library.get(ref.id);
      if (ref.kind === 'artifact')
        invariant(
          this.store.db
            .prepare('SELECT id FROM artifacts WHERE id=? AND task_id=?')
            .get(ref.id, ref.taskId ?? taskId),
          'REFERENCE_MISSING',
          'Artifact not in the selected task',
        );
      if (ref.kind === 'shot') {
        const edit = this.store.artifact<any>(ref.taskId ?? taskId ?? '', 'editorial')?.data;
        invariant(
          edit?.shots.some((s: any) => s.id === ref.id),
          'REFERENCE_MISSING',
          'Shot not in the selected task',
        );
      }
    }
    const existing = this.store.db
      .prepare('SELECT * FROM messages WHERE conversation_id=? AND request_id=?')
      .get(conversationId, value.requestId);
    const content = { text: value.text, references: value.references };
    if (existing) {
      invariant(
        existing.content === canonical(content) && existing.task_id === taskId,
        'REQUEST_CONFLICT',
        'Request ID was already used for a different message',
      );
      return { id: existing.id, state: existing.state };
    }
    return this.store.transaction(() => {
      const messageId = id('message');
      this.store.db
        .prepare(
          "INSERT INTO messages(id,conversation_id,task_id,role,content,request_id,state) VALUES(?,?,?,?,?,?,'queued')",
        )
        .run(messageId, conversationId, taskId, 'user', canonical(content), value.requestId);
      this.store.db
        .prepare('UPDATE conversations SET updated=CURRENT_TIMESTAMP WHERE id=?')
        .run(conversationId);
      const job = this.enqueue(
        'chat',
        { messageId, text: value.text, references: value.references },
        `chat:${conversationId}:${value.requestId}`,
        { conversationId, taskId: taskId ?? undefined },
        100,
      );
      this.store.activity(
        'message.created',
        { id: messageId, role: 'user', content, state: 'queued' },
        { conversationId, taskId: taskId ?? undefined },
      );
      return { id: messageId, state: 'queued', jobId: job.id };
    });
  }
  enqueue(
    kind: string,
    input: unknown,
    key: string,
    refs: { taskId?: string; conversationId?: string; runId?: string } = {},
    priority = 10,
  ) {
    const jobId = `job_${hash(key).slice(0, 32)}`;
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO jobs(id,task_id,conversation_id,run_id,kind,state,input,priority) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        jobId,
        refs.taskId ?? null,
        refs.conversationId ?? null,
        refs.runId ?? null,
        kind,
        'queued',
        canonical(input),
        priority,
      );
    if (priority >= 50 && this.heavy && Number(this.job(this.heavy.id).priority) < priority) {
      this.preempted.add(this.heavy.id);
      this.heavy.controller.abort();
    }
    this.store.activity('job.queued', { jobId, kind }, refs);
    return this.job(jobId);
  }
  job(jobId: string): any {
    const row = this.store.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
    invariant(row, 'JOB_MISSING', 'Job not found');
    return {
      ...row,
      input: JSON.parse(row.input as string),
      result: row.result ? JSON.parse(row.result as string) : null,
    };
  }
  runs(taskId: string) {
    this.store.productionTask(taskId);
    return this.store.db
      .prepare('SELECT * FROM runs WHERE task_id=? ORDER BY rowid DESC')
      .all(taskId)
      .map((r) => ({
        ...r,
        input: JSON.parse(r.input as string),
        result: r.result ? JSON.parse(r.result as string) : null,
      }));
  }
  artifacts(taskId: string) {
    this.store.productionTask(taskId);
    return this.store.db
      .prepare(
        'SELECT id,stage,revision,hash,accepted,created FROM artifacts WHERE task_id=? ORDER BY rowid DESC LIMIT 500',
      )
      .all(taskId);
  }
  private snapshot(taskId: string) {
    return this.store.db
      .prepare('SELECT id,stage,hash FROM artifacts WHERE task_id=? AND accepted=1 ORDER BY rowid')
      .all(taskId)
      .filter((r) => this.store.artifact(taskId, r.stage as string)?.id === r.id);
  }
  private queueRun(taskId: string, key: string, kind = 'production', input: unknown = {}) {
    const task = this.store.productionTask(taskId),
      runId = `run_${hash(key).slice(0, 32)}`;
    const active = this.store.db
      .prepare(
        "SELECT * FROM jobs WHERE task_id=? AND kind IN ('production','export') AND state IN ('queued','running') ORDER BY rowid DESC LIMIT 1",
      )
      .get(taskId);
    if (active) return this.job(active.id as string);
    this.store.db
      .prepare('INSERT OR IGNORE INTO runs(id,task_id,version,kind,state,input) VALUES(?,?,?,?,?,?)')
      .run(
        runId,
        taskId,
        task.version,
        kind,
        'queued',
        canonical({
          spec: task.spec,
          releaseId: task.releaseId,
          policyVersion: task.policy.version,
          runtimeVersion: 'pi@1.4.0/filmedit@0.2.0',
          artifacts: this.snapshot(taskId),
          input,
        }),
      );
    if (kind === 'production')
      this.store.updateTask(taskId, 'queued', task.stage === 'complete' ? 'render' : task.stage);
    return this.enqueue(kind, input, key, { taskId, runId }, 50);
  }
  async command(raw: unknown, origin: FeedbackOrigin = { kind: 'direct' }): Promise<any> {
    const command = commandSchema.parse(raw),
      fingerprint = hash({
        command: command.command,
        args: command.args,
        taskId: command.taskId,
        ...(['task.feedback', 'creative.feedback', 'learning.retract', 'creative.strategy.retract'].includes(
          command.command,
        )
          ? { origin }
          : {}),
      });
    const record = this.store.db.prepare('SELECT * FROM commands WHERE id=?').get(command.requestId);
    if (record) {
      invariant(
        record.fingerprint === fingerprint,
        'REQUEST_CONFLICT',
        'Request ID was already used for another operation',
      );
      if (record.state === 'completed') return JSON.parse(record.result as string);
    }
    if (this.operations.has(command.requestId)) return this.operations.get(command.requestId);
    this.store.db
      .prepare("INSERT OR IGNORE INTO commands(id,fingerprint,state) VALUES(?,?,'running')")
      .run(command.requestId, fingerprint);
    const operation = this.dispatch(command, origin)
      .then((result) => {
        this.store.db
          .prepare("UPDATE commands SET state='completed',result=?,updated=CURRENT_TIMESTAMP WHERE id=?")
          .run(canonical(result), command.requestId);
        this.store.activity(
          'command.completed',
          { command: command.command, requestId: command.requestId, result },
          { taskId: command.taskId },
        );
        return result;
      })
      .catch((error) => {
        this.store.db
          .prepare("UPDATE commands SET state='failed',result=? WHERE id=?")
          .run(canonical(errorInfo(error)), command.requestId);
        throw error;
      })
      .finally(() => this.operations.delete(command.requestId));
    this.operations.set(command.requestId, operation);
    return operation;
  }
  private async dispatch(c: Command, origin: FeedbackOrigin = { kind: 'direct' }): Promise<unknown> {
    const a = c.args,
      taskId = c.taskId ?? (a.taskId as string | undefined);
    if (taskId) this.store.productionTask(taskId);
    const task = () => {
      invariant(taskId, 'TASK_REQUIRED', 'Select a task first');
      return this.store.productionTask(taskId);
    };
    switch (c.command) {
      case 'account.list':
        return this.store.accounts();
      case 'account.create': {
        const input = commandCatalog['account.create'].schema.parse(a);
        return { id: this.store.createAccount(input.name) };
      }
      case 'memory.list': {
        const input = commandCatalog['memory.list'].schema.parse(a);
        invariant(
          this.store.accounts().some((account) => account.id === input.accountId),
          'ACCOUNT_MISSING',
          'Unknown account',
        );
        return this.store.memories(input.accountId, input.query);
      }
      case 'memory.add': {
        const input = commandCatalog['memory.add'].schema.parse(a);
        return { id: this.store.addMemory(input.accountId, input.memory) };
      }
      case 'memory.correct': {
        const input = commandCatalog['memory.correct'].schema.parse(a);
        return this.store.correctMemory(input.accountId, input.id, input);
      }
      case 'memory.remove': {
        const input = commandCatalog['memory.remove'].schema.parse(a);
        return this.store.correctMemory(input.accountId, input.id, null);
      }
      case 'learning.knowledge': {
        const input = commandCatalog['learning.knowledge'].schema.parse(a);
        return learnedKnowledge(this.store, input.experimentId, input.offset, input.limit);
      }
      case 'learning.retract': {
        invariant(
          origin.kind === 'direct',
          'EXPLICIT_ACTION_REQUIRED',
          '全局学习知识的撤回须由用户直接提交；对话 Agent 可以查看和解释记录',
        );
        const input = commandCatalog['learning.retract'].schema.parse(a);
        return retractLearnedKnowledge(this.store, input.experimentId, input.memoryId, input.reason);
      }
      case 'creative.strategy': {
        const input = commandCatalog['creative.strategy'].schema.parse(a);
        return new StrategyStore(this.store).inspect(input.scope, input.audience);
      }
      case 'creative.strategy.retract': {
        invariant(origin.kind === 'direct', 'EXPLICIT_ACTION_REQUIRED', '撤回创作方法须由用户直接提交');
        const input = commandCatalog['creative.strategy.retract'].schema.parse(a);
        return new StrategyStore(this.store).retract(
          input.scope,
          input.audience,
          input.version,
          input.reason,
        );
      }
      case 'creative.feedback':
        invariant(
          origin.kind === 'direct',
          'HUMAN_VERDICT_REQUIRED',
          '创意偏好训练只接受用户直接提交的比较结果；对话 Agent 可以记录原话，不能替用户选择候选',
        );
        return new CreativeStore(this.store).feedback(task().id, a);
      case 'creative.candidates': {
        const input = commandCatalog['creative.candidates'].schema.parse(a);
        return new CreativeStore(this.store).candidatePage(task().id, input.before, input.limit);
      }
      case 'creative.compare':
        return new CreativeStore(this.store).compare(
          task().id,
          commandCatalog['creative.compare'].schema.parse(a),
        );
      case 'culture.ingest': {
        const knowledge = new CreativeStore(this.store);
        return knowledge.ingest(knowledge.scope(task().id), a);
      }
      case 'task.feedback': {
        return recordWorkFeedback(this.store, task().id, c.requestId, a, origin);
      }
      case 'task.feedback.list': {
        const input = commandCatalog['task.feedback.list'].schema.parse(a);
        return feedbackHistory(this.store, task().id, input.before, input.limit);
      }
      case 'releases.rollback':
        return { id: new ReleaseManager(this.store).rollback('User requested rollback') };
      case 'schema':
        return describeCommand(a.name as string | undefined);
      case 'task.list':
        return this.store.tasks().map((task) => ({
          ...task,
          progress: taskProgress(this.store, task.id),
          feedback: feedbackSummary(this.store, task.id),
        }));
      case 'task.inspect':
        return {
          task: task(),
          progress: taskProgress(this.store, taskId!),
          runs: this.runs(taskId!),
          artifacts: this.artifacts(taskId!),
          feedback: feedbackSummary(this.store, taskId!),
        };
      case 'task.create': {
        const taskId = `task_${hash(c.requestId).slice(0, 32)}`;
        const existing = this.store.db.prepare('SELECT id FROM tasks WHERE id=?').get(taskId);
        const input = taskInputSchema.parse(a.input ?? a);
        return existing ? this.store.productionTask(taskId) : createTask(this.store, input, taskId);
      }
      case 'task.run':
      case 'task.resume': {
        task();
        return this.queueRun(taskId!, c.requestId);
      }
      case 'task.pause':
      case 'task.cancel': {
        const t = task(),
          pause = c.command === 'task.pause';
        if (this.heavy && this.job(this.heavy.id).task_id === taskId) {
          this.store.updateTask(t.id, pause ? 'pausing' : 'cancelled', t.stage);
          this.heavy.controller.abort();
          await this.tasks.cancel(t.id);
          await this.heavy?.done;
        }
        this.store.db
          .prepare(
            "UPDATE jobs SET state=? WHERE task_id=? AND kind IN ('production','export') AND state IN ('queued','running')",
          )
          .run(pause ? 'paused' : 'cancelled', t.id);
        this.store.db
          .prepare("UPDATE runs SET state=? WHERE task_id=? AND state IN ('queued','running')")
          .run(pause ? 'paused' : 'cancelled', t.id);
        this.store.updateTask(t.id, pause ? 'paused' : 'cancelled', this.store.productionTask(t.id).stage);
        return this.store.productionTask(t.id);
      }
      case 'task.export': {
        task();
        return this.queueRun(taskId!, c.requestId, 'export', exportProfileInputSchema.parse(a));
      }
      case 'task.revise': {
        const change = revisionSchema.parse(a),
          t = task();
        const prior = this.store.db
          .prepare('SELECT id FROM runs WHERE id=?')
          .get(`run_${hash(c.requestId).slice(0, 32)}`);
        if (prior) return this.job(`job_${hash(c.requestId).slice(0, 32)}`);
        invariant(
          t.version === change.expectedVersion,
          'VERSION_CONFLICT',
          `Task is now version ${t.version}; reload before editing`,
        );
        if (change.kind !== 'creative')
          invariant(
            !change.prompt && !change.seed,
            'REVISION_SCOPE',
            'Prompt and sampling changes require a creative revision',
          );
        if (change.composition)
          invariant(
            ['creative', 'layout'].includes(change.kind),
            'REVISION_SCOPE',
            'Composition changes require a layout revision',
          );
        if (change.kind === 'output')
          invariant(change.output, 'REVISION_SCOPE', 'Export-only revision requires output settings');
        if (change.scope) {
          invariant(
            ['editorial', 'layout'].includes(change.kind) && !change.composition && !change.output,
            'REVISION_SCOPE',
            'A time-scoped edit applies to editorial/layout and cannot change global canvas or export settings',
          );
          const baseline = this.store.artifact<any>(t.id, 'editorial');
          invariant(
            baseline && change.scope.end <= baseline.data.duration,
            'REVISION_SCOPE',
            'Choose an interval within an approved edit',
          );
          invariant(
            this.store.artifact(t.id, 'layout'),
            'REVISION_SCOPE',
            'Review and approve the original layout before a local revision',
          );
        }
        await this.dispatch({
          requestId: `${c.requestId}:stop`,
          command: 'task.pause',
          taskId: t.id,
          args: {},
        });
        invariant(
          this.store.productionTask(t.id).version === change.expectedVersion,
          'VERSION_CONFLICT',
          'Task changed while pausing; reload before editing',
        );
        if (change.kind === 'creative')
          await resampleCreative(this.store, t.id, change.seed ?? t.spec.creative.seed);
        let spec = this.store.productionTask(t.id).spec;
        spec = {
          ...spec,
          ...(change.prompt ? { prompt: change.prompt } : {}),
          ...(change.composition ? { composition: change.composition } : {}),
          ...(change.output
            ? { output: { ...resolveExport(change.output, t.spec.output), duration: t.spec.output.duration } }
            : {}),
        };
        const stages: Record<string, string[]> = {
          script: ['script', 'narration', 'materials', 'editorial', 'composition', 'layout', 'render'],
          editorial: ['editorial', 'composition', 'layout', 'render'],
          layout: ['layout', 'render'],
          output: [],
          creative: [],
        };
        return this.store.transaction(() => {
          const previousArtifactIds = this.snapshot(t.id);
          const previousArtifact = this.store.artifact(
            t.id,
            change.kind === 'output' ? 'layout' : change.kind,
          )?.data;
          const guard: RevisionGuard | undefined = change.scope
            ? {
                version: t.version + 1,
                scope: change.scope,
                editorial: this.store.artifact<any>(t.id, 'editorial')!.data,
                layout: this.store.artifact<any>(t.id, 'layout')!.data,
              }
            : undefined;
          this.store.db
            .prepare('UPDATE tasks SET spec=?,version=version+1 WHERE id=?')
            .run(canonical(spec), t.id);
          invalidateDerivedArtifacts(this.store, t.id, stages[change.kind]!);
          this.store.invalidateFrom(t.id, ['revision.guard']);
          if (guard) this.store.saveArtifact(t.id, 'revision.guard', guard, true);
          const stage = change.kind === 'output' ? 'render' : change.kind;
          this.store.saveArtifact(t.id, `${stage}.feedback`, {
            userInstruction: change.instruction,
            previousArtifactIds,
            previousArtifact,
          });
          this.store.saveArtifact(
            t.id,
            `${stage}.user_revision`,
            { instruction: change.instruction, previousArtifact },
            true,
          );
          if (change.kind === 'creative')
            this.store.saveArtifact(t.id, 'creative.user_feedback', { instruction: change.instruction });
          this.store.updateTask(t.id, 'queued', stage as Stage);
          return this.queueRun(
            t.id,
            c.requestId,
            change.kind === 'output' ? 'export' : 'production',
            change.kind === 'output' ? change.output : change,
          );
        });
      }
      case 'artifact.read': {
        const row = this.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(z.string().parse(a.id));
        invariant(row, 'ARTIFACT_MISSING', 'Artifact not found');
        if (taskId)
          invariant(row.task_id === taskId, 'REFERENCE_MISSING', 'Artifact belongs to another task');
        return { ...row, data: JSON.parse(row.data as string) };
      }
      case 'library.search':
        return this.library.semanticSearch(libraryQuerySchema.parse(a));
      case 'library.inspect': {
        const id = z.string().parse(a.id);
        await this.library.resolve(id);
        return this.library.inspect(id, z.number().int().min(0).default(0).parse(a.offset));
      }
      case 'library.import': {
        const v = z
          .object({
            paths: z.array(z.string()).min(1),
            category: categorySchema,
            tags: z.array(z.string()).default([]),
          })
          .parse(a);
        return this.enqueue('library.import', v, c.requestId, {}, 10);
      }
      case 'library.analyze': {
        const v = z
          .object({
            id: z.string(),
            features: z.array(z.enum(['frames', 'asr', 'beats', 'audio', 'vision'])).min(1),
          })
          .parse(a);
        return this.enqueue('library.analyze', v, c.requestId, {}, 5);
      }
      case 'library.refresh':
        return this.enqueue('library.refresh', {}, c.requestId, {}, 5);
      case 'library.update':
        return this.library.update(
          z.string().parse(a.id),
          z
            .object({
              title: z.string().max(300).optional(),
              tags: z.array(z.string().max(100)).max(100).optional(),
              categories: z.array(categorySchema).min(1).optional(),
            })
            .parse(a),
        );
      case 'library.remove':
        return this.library.remove(z.string().parse(a.id));
      case 'library.bind': {
        task();
        const runner = new TaskRunner(this.store, taskId!);
        return this.library.bind(z.string().parse(a.id), runner.library);
      }
      case 'library.match': {
        const t = task(),
          edit = this.store.artifact<any>(t.id, 'editorial')?.data,
          shot = edit?.shots.find((s: any) => s.id === a.shotId);
        invariant(shot || typeof a.query === 'string', 'SHOT_MISSING', 'Provide a shot ID or visual query');
        const query = String(a.query ?? shot.description ?? shot.intent ?? '');
        const candidates = await this.library.semanticSearch({
          query,
          category: a.category as any,
          semantic: Boolean(a.semantic),
          limit: 20,
        });
        return {
          ...candidates,
          items: candidates.items.map((item) => {
            const asset = this.library.get(item.id);
            return {
              ...item,
              sampledObservations: asset.segments,
              requiresFrameReview: true,
              suggestedRange: { start: 0, end: Math.min(asset.duration, shot?.duration ?? asset.duration) },
            };
          }),
        };
      }
      case 'learning.configure': {
        const v = z
          .object({ enabled: z.boolean(), intervalSeconds: z.number().int().min(10).default(300) })
          .parse(a);
        this.store.db
          .prepare(
            "INSERT INTO settings(key,value) VALUES('learning_schedule',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(canonical({ ...v, nextAt: 0 }));
        if (!v.enabled && this.heavy && this.job(this.heavy.id).kind === 'learning.tick')
          this.heavy.controller.abort();
        return v;
      }
      case 'learning.list':
        return new LearningService(this.store).list();
      case 'learning.enqueue': {
        const experimentId = new LearningService(this.store).enqueue(a as any);
        return { id: experimentId };
      }
      case 'learning.run':
        return this.enqueue('learning', { id: z.string().parse(a.id) }, c.requestId, {}, 0);
      case 'task.propose': {
        const t = task();
        await this.dispatch({
          requestId: c.requestId + ':stop',
          command: 'task.pause',
          taskId: t.id,
          args: {},
        });
        return this.tasks.propose(t.id, z.enum(['editorial', 'layout']).parse(a.kind), a.value);
      }
      case 'task.budgets':
        return this.tasks.budgets(task().id, a);
      case 'task.permissions': {
        const t = task();
        await this.dispatch({
          requestId: c.requestId + ':stop',
          command: 'task.pause',
          taskId: t.id,
          args: {},
        });
        return this.tasks.permissions(t.id, a);
      }
      case 'job.inspect':
        return this.job(z.string().parse(a.id));
      default:
        invariant(false, 'COMMAND_UNKNOWN', `Unknown command ${c.command}`);
    }
  }
  private pump() {
    if (this.closed) return;
    if (!this.heavy) {
      const setting = this.store.db.prepare("SELECT value FROM settings WHERE key='learning_schedule'").get();
      if (setting) {
        const config = JSON.parse(setting.value as string);
        if (config.enabled && config.nextAt < Date.now()) {
          this.enqueue('learning.tick', {}, `learning-tick:${Date.now()}`, {}, 0);
          this.store.db
            .prepare("UPDATE settings SET value=? WHERE key='learning_schedule'")
            .run(canonical({ ...config, nextAt: Date.now() + config.intervalSeconds * 1000 }));
        }
      }
    }
    const next = (chat: boolean) =>
      this.store.db
        .prepare(
          `SELECT id FROM jobs WHERE state='queued' AND kind ${chat ? '=' : '!='} 'chat' ORDER BY priority DESC,rowid LIMIT 1`,
        )
        .get();
    for (const lane of ['heavy', 'chat'] as const) {
      if (this[lane]) continue;
      const row = next(lane === 'chat');
      if (!row) continue;
      const controller = new AbortController(),
        jobId = row.id as string;
      this.store.db
        .prepare("UPDATE jobs SET state='running',updated=CURRENT_TIMESTAMP WHERE id=?")
        .run(jobId);
      const done = this.executeJob(jobId, controller.signal).finally(() => {
        this[lane] = undefined;
        if (!this.closed) this.pump();
      });
      this[lane] = { id: jobId, controller, done };
    }
  }
  private async executeJob(jobId: string, signal: AbortSignal) {
    const job = this.job(jobId),
      refs = {
        taskId: job.task_id as string | undefined,
        conversationId: job.conversation_id as string | undefined,
        runId: job.run_id as string | undefined,
      };
    if (job.run_id)
      this.store.db
        .prepare("UPDATE runs SET state='running',updated=CURRENT_TIMESTAMP WHERE id=?")
        .run(job.run_id);
    this.store.activity('job.started', { jobId, kind: job.kind }, refs);
    try {
      if (job.run_id) {
        const run = this.store.db.prepare('SELECT version FROM runs WHERE id=?').get(job.run_id)!;
        invariant(
          Number(run.version) === this.store.productionTask(job.task_id).version,
          'VERSION_CONFLICT',
          'Queued run refers to an older task version',
        );
      }
      let result: unknown;
      if (job.kind === 'production') {
        this.tasks.start(job.task_id as string);
        const active = this.tasks.active.get(job.task_id as string)!;
        const stop = () => active.controller.abort();
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        try {
          await active.done;
        } finally {
          signal.removeEventListener('abort', stop);
        }
        const t = this.store.productionTask(job.task_id as string);
        invariant(
          t.status === 'completed',
          t.error ? (t.error as any).code : 'TASK_INCOMPLETE',
          t.error ? (t.error as any).message : `Task ended ${t.status}`,
        );
        result = t;
      } else if (job.kind === 'export')
        result = await this.tasks.export(job.task_id as string, job.input, signal);
      else if (job.kind === 'chat') result = await this.runConversation(job, signal);
      else if (job.kind === 'learning.tick') result = await new LearningService(this.store).tick(signal);
      else if (job.kind === 'learning')
        result = await new LearningService(this.store).run(job.input.id, signal);
      else {
        const lib = new LocalLibrary(this.store, signal);
        if (job.kind === 'library.import') {
          const imported = await lib.import(job.input.paths, job.input.category, job.input.tags);
          result = imported;
          for (const id of imported.assetIds) {
            const a = lib.get(id),
              features = ['video', 'image'].includes(a.kind)
                ? ['frames']
                : a.kind === 'audio'
                  ? ['audio']
                  : [];
            if (features.length)
              this.enqueue('library.analyze', { id, features }, `${jobId}:analyze:${id}`, {}, 5);
          }
        } else if (job.kind === 'library.analyze')
          result = await lib.analyze(job.input.id, job.input.features);
        else if (job.kind === 'library.refresh') result = await lib.refresh();
      }
      signal.throwIfAborted();
      // Publish the output and completion together; a run snapshot must refer to that exact output.
      this.store.transaction(() => {
        if (job.kind === 'production' || job.kind === 'export') {
          const output = job.kind === 'export' ? result : this.store.artifact(job.task_id, 'render')?.data;
          invariant(output, 'OUTPUT_MISSING', '制作结束时缺少已保存的渲染结果');
          this.store.saveArtifact(job.task_id, 'output.current', output, true);
        }
        if (job.kind === 'export' && this.store.productionTask(job.task_id as string).status === 'queued')
          this.store.updateTask(job.task_id as string, 'completed', 'complete');
        this.store.db
          .prepare("UPDATE jobs SET state='completed',result=?,updated=CURRENT_TIMESTAMP WHERE id=?")
          .run(canonical(result ?? {}), jobId);
        if (job.run_id)
          this.store.db
            .prepare("UPDATE runs SET state='completed',result=?,updated=CURRENT_TIMESTAMP WHERE id=?")
            .run(
              canonical({
                result,
                artifacts: this.snapshot(job.task_id as string),
                assets: this.store.assets(job.task_id as string).map((a) => ({ id: a.id, sha256: a.sha256 })),
              }),
              job.run_id,
            );
        this.store.activity('job.completed', { jobId, result }, refs);
      });
    } catch (error) {
      const state =
        this.closed || this.preempted.delete(jobId) ? 'queued' : signal.aborted ? 'paused' : 'blocked';
      this.store.transaction(() => {
        this.store.db
          .prepare('UPDATE jobs SET state=?,result=?,updated=CURRENT_TIMESTAMP WHERE id=?')
          .run(state, canonical(errorInfo(error)), jobId);
        if (job.run_id)
          this.store.db
            .prepare('UPDATE runs SET state=?,result=?,updated=CURRENT_TIMESTAMP WHERE id=?')
            .run(state, canonical(errorInfo(error)), job.run_id);
        if (job.kind === 'chat')
          this.store.db.prepare('UPDATE messages SET state=? WHERE id=?').run(state, job.input.messageId);
        this.store.activity('job.failed', { jobId, state, error: errorInfo(error) }, refs);
      });
    }
  }
  private async runConversation(job: any, signal: AbortSignal) {
    const conversationId = job.conversation_id as string;
    const feedbackOrigin: FeedbackOrigin = { kind: 'conversation', messageId: job.input.messageId };
    let selected = (job.task_id ?? undefined) as string | undefined;
    const history = this.store.db
      .prepare(
        "SELECT role,content,task_id FROM messages WHERE conversation_id=? AND state='completed' ORDER BY rowid DESC LIMIT 60",
      )
      .all(conversationId)
      .reverse()
      .map((r) => ({ ...r, content: JSON.parse(r.content as string) }));
    let calls = 0,
      waiting = false;
    const humanText = this.store.db
      .prepare("SELECT content FROM messages WHERE conversation_id=? AND role='user'")
      .all(conversationId)
      .map((r) => JSON.parse(r.content as string).text)
      .join('\n');
    const authorize = (command: string, args: any) => {
      if (['memory.add', 'memory.correct', 'memory.remove'].includes(command))
        invariant(
          /记住|记忆|忘掉|删除|纠正|更正|改成|偏好|喜欢|不喜欢|选|好|差|满意|remember|forget|correct|prefer|like|feedback/i.test(
            job.input.text,
          ),
          'EXPLICIT_ACTION_REQUIRED',
          'Only explicit user statements may update memory or human preferences',
        );
      invariant(
        command !== 'library.remove' || /删除|移除|remove|delete/i.test(job.input.text),
        'EXPLICIT_ACTION_REQUIRED',
        'Removing an index requires an explicit user request',
      );
      const value = args.input ?? args;
      const paths =
        command === 'library.import'
          ? value.paths
          : command === 'task.create'
            ? [
                ...(value.materials?.paths ?? []),
                ...(value.access?.readPaths ?? []),
                ...(value.access?.writePaths ?? []),
              ]
            : command === 'task.permissions'
              ? [...(value.readPaths ?? []), ...(value.writePaths ?? [])]
              : [];
      for (const file of paths ?? [])
        invariant(
          typeof file === 'string' && humanText.includes(file) && path.resolve(file) === file,
          'PATH_NOT_SELECTED',
          '该路径尚未由用户明确提供。请询问具体绝对路径，不可自行扩大访问范围。',
        );
    };
    const execute = async (command: string, args: any = {}, taskId = selected) => {
      invariant(
        !['library.remove'].includes(command) || /删除|移除|remove|delete/i.test(job.input.text),
        'EXPLICIT_ACTION_REQUIRED',
        'Removing an index requires an explicit user request',
      );
      authorize(command, args);
      const result: any = await this.command(
        {
          requestId: `${job.id}:command:${++calls}`,
          command,
          args,
          taskId,
        },
        feedbackOrigin,
      );
      if (command === 'task.create') {
        selected = result.id;
        this.focus(conversationId, selected!);
      }
      this.store.activity('conversation.action', { command, result }, { conversationId, taskId: selected });
      return result;
    };
    let text: string;
    if (this.options.conversationExecutor)
      text = await this.options.conversationExecutor({
        text: job.input.text,
        taskId: selected,
        history,
        execute,
        signal,
      });
    else {
      const policy = await PathPolicy.create(path.join(this.store.home, 'conversations', conversationId), {
        materials: { paths: [], strategy: 'local_only' },
        access: { readPaths: [], writePaths: [], denyPaths: [] },
      });
      const instructions = (
        await Promise.all(
          ['conversation', 'library'].map((name) =>
            readFile(path.join(projectRoot, 'skills', name, 'SKILL.md'), 'utf8'),
          ),
        )
      ).join('\n\n');
      const result = await runPiSession(this.store, new ProcessRunner(policy, signal), {
        scope: job.id,
        role: 'conversation',
        conversationId,
        system: instructions,
        prompt: canonical({
          message: job.input.text,
          references: job.input.references,
          currentTask: selected ? this.store.productionTask(selected) : null,
          history,
        }),
        tools: [
          tool(
            'command_schema',
            '读取命令列表或指定命令的精确 JSON Schema。创建/改稿/导出前先查看对应 Schema。',
            { name: z.string().optional() },
            async ({ name }) => textResult(describeCommand(name)),
          ),
          tool(
            'film_cli',
            '执行 filmedit 的 library/task CLI。argv 是参数数组，不经过 shell。与用户 CLI 共用解析器和服务端。',
            { argv: z.array(z.string()).min(2).max(40) },
            async ({ argv }, callId) => {
              const c = parseFilmCommand(argv);
              invariant(
                c.command !== 'library.remove' || /删除|移除|remove|delete/i.test(job.input.text),
                'EXPLICIT_ACTION_REQUIRED',
                'Explicit removal request required',
              );
              authorize(c.command, c.args);
              return textResult(
                await this.command({ ...c, taskId: c.taskId ?? selected, requestId: callId }, feedbackOrigin),
              );
            },
          ),
          tool(
            'film_command',
            '执行 FilmEdit 结构化命令。使用 task.create/run/inspect/list/pause/resume/cancel/revise/export；library.search/inspect/import/analyze/bind；artifact.read；job.inspect。',
            {
              command: z.string(),
              args: z.record(z.string(), z.unknown()).default({}),
              taskId: z.string().optional(),
            },
            async ({ command, args, taskId }, callId) => {
              invariant(
                command !== 'library.remove' || /删除|移除|remove|delete/i.test(job.input.text),
                'EXPLICIT_ACTION_REQUIRED',
                'Removing an index requires an explicit user request',
              );
              authorize(command, args);
              const result: any = await this.command(
                {
                  requestId: callId,
                  command,
                  args,
                  taskId: taskId ?? selected,
                },
                feedbackOrigin,
              );
              if (command === 'task.create') {
                selected = result.id;
                this.focus(conversationId, selected!);
              }
              this.store.activity(
                'conversation.action',
                { command, result },
                { conversationId, taskId: selected },
              );
              return textResult(result);
            },
          ),
          tool(
            'ask_user',
            '缺少完成请求所必需的信息时询问用户，并结束本轮等待回复。',
            { question: z.string().min(1) },
            async ({ question }) => {
              waiting = true;
              return { ...textResult({ question }), terminate: true };
            },
          ),
          tool(
            'conversation_history',
            '读取完整已保存历史的一页。',
            { after: z.number().int().min(0).default(0) },
            async ({ after }) => textResult(this.messages(conversationId, after)),
          ),
        ],
      });
      text = result.text;
      if (waiting && !text) {
        const record = this.store.db
          .prepare(
            "SELECT result FROM tool_executions WHERE session_id=? AND name='ask_user' ORDER BY rowid DESC LIMIT 1",
          )
          .get(result.sessionId);
        if (record) text = JSON.parse(JSON.parse(record.result as string).content[0].text).question;
      }
    }
    const responseId = `message_${hash(job.id).slice(0, 32)}`;
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO messages(id,conversation_id,task_id,role,content,state) VALUES(?,?,?,?,?,'completed')",
        )
        .run(
          responseId,
          conversationId,
          selected ?? null,
          'assistant',
          canonical({ text: text || '操作已记录，请查看任务状态。', waitingInput: waiting }),
        );
      this.store.db.prepare("UPDATE messages SET state='completed' WHERE id=?").run(job.input.messageId);
      this.store.activity(
        'message.completed',
        { id: responseId, text, waitingInput: waiting },
        { conversationId, taskId: selected },
      );
    });
    return { messageId: responseId, text, waitingInput: waiting };
  }
}
