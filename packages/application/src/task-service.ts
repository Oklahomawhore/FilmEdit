import { z } from 'zod';
import { Store } from '../../infrastructure/src/store.js';
import { Renderer } from '../../media/src/render.js';
import { inspectVideo } from '../../media/src/quality.js';
import { exportProfileInputSchema } from '../../core/src/presentation.js';
import { TaskRunner } from './workflow.js';
import { PathPolicy } from '../../infrastructure/src/security.js';
import { accessSchema, editorialSchema, renderSchema } from '../../core/src/domain.js';
import { validateEditorial, validateRender } from '../../core/src/ir.js';
import { RecipeRegistry } from '../../infrastructure/src/recipes.js';
import { errorInfo, invariant, canonical } from '../../core/src/util.js';
import { invalidateDerivedArtifacts } from './revision-context.js';

export class TaskService {
  readonly active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  constructor(readonly store: Store) {}
  start(taskId: string) {
    invariant(!this.active.has(taskId), 'TASK_BUSY', 'Task is already running');
    invariant(this.active.size === 0, 'WORKER_BUSY', 'The foreground worker is busy');
    this.store.productionTask(taskId);
    const controller = new AbortController();
    const runner = new TaskRunner(this.store, taskId, controller.signal);
    const done = runner
      .run()
      .catch((e) => {
        this.store.event(taskId, 'run.error', errorInfo(e));
      })
      .finally(async () => {
        try {
          await runner.flushArtifacts();
        } finally {
          this.active.delete(taskId);
        }
      });
    this.active.set(taskId, { controller, done });
    return { taskId, state: 'running' };
  }
  async export(taskId: string, input: unknown, signal?: AbortSignal) {
    this.store.productionTask(taskId);
    const profile = exportProfileInputSchema.parse(input);
    const owner = `export_${crypto.randomUUID()}`;
    invariant(
      !this.active.has(taskId) && this.store.acquireLease(`task:${taskId}`, owner),
      'TASK_BUSY',
      'Task is busy',
    );
    const heartbeat = setInterval(() => this.store.acquireLease(`task:${taskId}`, owner), 30000);
    heartbeat.unref();
    try {
      const editorial = this.store.artifact<z.infer<typeof editorialSchema>>(taskId, 'editorial')?.data;
      const layout = this.store.artifact<z.infer<typeof renderSchema>>(taskId, 'layout')?.data;
      invariant(editorial && layout, 'LAYOUT_MISSING', 'Export requires an accepted edit and layout');
      const runner = new TaskRunner(this.store, taskId, signal);
      const result = await new Renderer(runner.library, runner.processes).render(
        editorial,
        layout,
        false,
        profile,
      );
      const quality = await inspectVideo(
        result.path,
        editorial,
        layout,
        runner.processes,
        false,
        result.exportProfile,
      );
      invariant(quality.passed, 'EXPORT_QUALITY', 'Export failed deterministic media validation');
      const record = { ...result, quality, aiReviewed: false };
      this.store.saveArtifact(taskId, `export.${result.exportHash}`, record, true);
      this.store.event(taskId, 'export.completed', record);
      return record;
    } finally {
      clearInterval(heartbeat);
      this.store.releaseLease(`task:${taskId}`, owner);
    }
  }
  async cancel(taskId: string) {
    this.store.productionTask(taskId);
    const active = this.active.get(taskId);
    if (active) {
      active.controller.abort();
      await active.done;
    } else {
      const task = this.store.productionTask(taskId);
      this.store.updateTask(taskId, 'cancelled', task.stage);
    }
    return this.store.productionTask(taskId);
  }
  async budgets(taskId: string, input: unknown) {
    this.store.productionTask(taskId);
    const task = this.store.setTaskBudgets(taskId, input);
    await new PathPolicy(task.policy).write(
      `${task.policy.workspace}/task.json`,
      JSON.stringify(task, null, 2),
    );
    return task;
  }
  async permissions(taskId: string, input: unknown) {
    const access = accessSchema.parse(input);
    const task = this.store.productionTask(taskId);
    if (this.active.has(taskId)) await this.cancel(taskId);
    const spec = { ...task.spec, access };
    const policy = await PathPolicy.create(task.policy.workspace, spec);
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE tasks SET spec=?,policy=?,status=?,version=version+1 WHERE id=?')
        .run(canonical(spec), canonical(policy.data), 'queued', taskId);
      invalidateDerivedArtifacts(this.store, taskId, [
        'materials',
        'editorial',
        'editorial.audience',
        'editorial.alignment',
        'layout',
        'layout.audience',
        'layout.alignment',
        'render',
      ]);
      this.store.event(taskId, 'permissions.changed', { policyVersion: policy.data.version });
    });
    return policy.data;
  }
  propose(taskId: string, kind: 'editorial' | 'layout', input: unknown) {
    invariant(!this.active.has(taskId), 'TASK_BUSY', 'Pause the task before editing its IR');
    const task = this.store.productionTask(taskId);
    const expanded =
      kind === 'editorial' && input && typeof input === 'object' && 'technique' in input
        ? new RecipeRegistry(this.store, task.releaseId).expand(taskId, input).editorial
        : input;
    const value =
      kind === 'editorial'
        ? validateEditorial(expanded, this.store.assets(taskId))
        : validateRender(
            input,
            this.store.artifact<z.infer<typeof editorialSchema>>(taskId, 'editorial')!.data,
          );
    this.store.db.prepare('UPDATE tasks SET version=version+1 WHERE id=?').run(taskId);
    this.store.invalidateFrom(taskId, ['revision.guard']);
    this.store.invalidateFrom(
      taskId,
      kind === 'editorial'
        ? [
            'editorial',
            'editorial.audience',
            'editorial.alignment',
            'layout',
            'layout.audience',
            'layout.alignment',
            'render',
          ]
        : ['layout', 'layout.audience', 'layout.alignment', 'render'],
    );
    this.store.saveArtifact(taskId, `${kind}.proposed`, value);
    this.store.updateTask(taskId, 'queued', kind);
    return value;
  }
}
