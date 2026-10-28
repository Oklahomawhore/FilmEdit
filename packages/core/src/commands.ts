import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ID, memorySchema, taskInputSchema } from './domain.js';
import { cultureBundleSchema, preferenceSchema } from './creative-domain.js';
import { compositionSchema, exportProfileInputSchema } from './presentation.js';
import { invariant } from './util.js';
import { timeScopeSchema } from './revision.js';
import { workFeedbackSchema } from './feedback.js';

export const revisionInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    kind: z.enum(['creative', 'script', 'editorial', 'layout', 'output']),
    instruction: z.string().min(1).max(20000),
    prompt: z.string().min(1).optional(),
    composition: compositionSchema.optional(),
    output: exportProfileInputSchema.optional(),
    seed: z.string().optional(),
    scope: timeScopeSchema.optional(),
  })
  .strict();

/** TUI shorthand keeps the same validated revision payload as CLI and API. */
export function parseRevisionCommand(parts: string[], expectedVersion: number) {
  const [kind, range, ...tail] = parts;
  const match = range?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  const scope = match ? { start: Number(match[1]), end: Number(match[2]) } : undefined;
  return revisionInputSchema.parse({
    expectedVersion,
    kind,
    scope,
    instruction: (match ? tail : parts.slice(1)).join(' '),
  });
}
export const commandCatalog = {
  'task.list': { description: '查看任务列表。', schema: z.object({}).strict() },
  'task.inspect': { description: '查看当前任务的进度、版本和产物。', schema: z.object({}).strict() },
  'task.run': { description: '按用户明确指令启动当前任务。', schema: z.object({}).strict() },
  'task.resume': { description: '按用户明确指令恢复当前任务。', schema: z.object({}).strict() },
  'task.pause': { description: '暂停当前制作任务，保留检查点和对话。', schema: z.object({}).strict() },
  'task.cancel': {
    description: '取消当前制作任务，保留历史和对话，不影响其他任务。',
    schema: z.object({}).strict(),
  },
  'account.create': {
    description: '创建账号。',
    schema: z.object({ name: z.string().trim().min(1) }).strict(),
  },
  'memory.list': {
    description: '查看账号记忆；全局 Persona 单独标注。',
    schema: z.object({ accountId: ID, query: z.string().default('') }).strict(),
  },
  'memory.add': {
    description: '记录用户明确提供的账号信息，保留来源。',
    schema: z.object({ accountId: ID, memory: memorySchema }).strict(),
  },
  'memory.correct': {
    description: '按用户明确纠正修改记忆，保留审计历史；不能修改其他账号或全局记忆。',
    schema: z
      .object({
        accountId: ID,
        id: ID,
        content: z.string().trim().min(1),
        tags: z.array(z.string()).default([]),
      })
      .strict(),
  },
  'memory.remove': {
    description: '按用户要求删除账号记忆，保留审计历史。',
    schema: z.object({ accountId: ID, id: ID }).strict(),
  },
  'learning.knowledge': {
    description: '分页查看已发布脚本学习的选题、角度、Persona 及撤回记录。',
    schema: z
      .object({
        experimentId: ID,
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(10).default(10),
      })
      .strict(),
  },
  'learning.retract': {
    description: '用户直接撤回一条已发布学习知识及关联文化条目，保留审计与历史任务快照；不启动重新学习。',
    schema: z.object({ experimentId: ID, memoryId: ID, reason: z.string().trim().min(1).max(2000) }).strict(),
  },
  'creative.feedback': {
    description: '用户直接提交创意 A/B 偏好，绑定所看的任务版本；不能把模型自评当作用户偏好。',
    schema: preferenceSchema,
  },
  'creative.strategy': {
    description: '查看账号或任务已发布的创作方法、版本与来源反馈是否仍有效。',
    schema: z.object({ scope: ID, audience: z.string().min(1).max(200).default('default') }).strict(),
  },
  'creative.strategy.retract': {
    description: '用户撤回指定创作方法版本；历史实验和已开始任务的快照保留。',
    schema: z
      .object({
        scope: ID,
        audience: z.string().min(1).max(200).default('default'),
        version: z.string().min(1),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict(),
  },
  'creative.candidates': {
    description: '分页查看当前任务的已归档创意摘要，包含历史候选，不代表均已通过评审。',
    schema: z
      .object({
        before: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(24).default(12),
      })
      .strict(),
  },
  'creative.compare': {
    description: '读取两个明确候选的完整提案和此前用户偏好；只读，不替换当前制作方案。',
    schema: z.object({ left: ID, right: ID, audience: z.string().max(200).default('default') }).strict(),
  },
  'culture.ingest': { description: '存入有来源的文化元素和关系。', schema: cultureBundleSchema },
  'task.feedback': {
    description:
      '记录指定版本的用户反馈，不会自动改稿。无需账号。先读 task.inspect；对话 Agent 只能以 comment 原样记录本轮用户消息，正式接受/拒绝/要求修改由用户直接提交。',
    schema: workFeedbackSchema,
  },
  'task.feedback.list': {
    description: '分页查看当前任务的人类反馈历史，与自动评审分开。',
    schema: z
      .object({
        before: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict(),
  },
  'task.create': { description: '创建任务；不会自动开跑。自由字段由创意模块生成。', schema: taskInputSchema },
  'task.revise': {
    description:
      '修改当前任务，自动暂停并重跑受影响阶段；必须先读当前 version。用户要求只改某个时间段时，editorial/layout 必须传 scope:{start,end}（秒），程序保护其余时间。script 改旁白，editorial 改镜头，layout 改位置，output 仅改导出，creative 改主题/创意。',
    schema: revisionInputSchema,
  },
  'task.export': { description: '复用已通过的剪辑和布局，创建新的导出。', schema: exportProfileInputSchema },
};
export function describeCommand(name?: string) {
  if (!name)
    return {
      commands: [
        'account.list',
        ...Object.keys(commandCatalog).filter((name) => !name.startsWith('task.')),
        'task.feedback',
        'task.feedback.list',
        'releases.rollback',
        'task.create',
        'task.list',
        'task.inspect',
        'task.run',
        'task.pause',
        'task.resume',
        'task.cancel',
        'task.revise',
        'task.export',
        'artifact.read',
        'library.search',
        'library.inspect',
        'library.import',
        'library.analyze',
        'library.update',
        'library.remove',
        'library.refresh',
        'library.bind',
        'library.match',
        'job.inspect',
        'learning.enqueue',
        'learning.run',
        'learning.list',
      ],
      detailed: Object.keys(commandCatalog),
    };
  const item = commandCatalog[name as keyof typeof commandCatalog];
  invariant(item, 'COMMAND_UNKNOWN', 'Use skills read library for library commands');
  return { description: item.description, input: z.toJSONSchema(item.schema, { io: 'input' }) };
}
/** No shell. The native CLI and model tool use the same parser and server commands. */
export function parseFilmCommand(argv: string[]) {
  const { positionals: p, values: v } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'string' },
      query: { type: 'string' },
      category: { type: 'string' },
      tag: { type: 'string', multiple: true },
      offset: { type: 'string' },
      limit: { type: 'string' },
      semantic: { type: 'boolean' },
      task: { type: 'string' },
      account: { type: 'string' },
      features: { type: 'string' },
    },
  });
  let [group, action, target] = p;
  invariant(
    group && action,
    'CLI_USAGE',
    'Use library search/import/inspect/analyze/bind, or task inspect/run/revise',
  );
  const args: any = v.json ? JSON.parse(v.json) : {};
  if (group === 'memory') {
    args.accountId ??= v.account;
    if (target) args.id ??= target;
    if (v.query) args.query = v.query;
  }
  if (group === 'library') {
    if (action === 'search') {
      Object.assign(args, {
        ...(v.query ? { query: v.query } : {}),
        ...(v.category ? { category: v.category } : {}),
        ...(v.offset ? { offset: Number(v.offset) } : {}),
        ...(v.limit ? { limit: Number(v.limit) } : {}),
        ...(v.semantic ? { semantic: true } : {}),
      });
    } else if (action === 'import') {
      args.paths ??= p.slice(2);
      args.paths = args.paths.map((value: string) => path.resolve(value));
      args.category ??= v.category;
      args.tags ??= v.tag ?? [];
    } else if (['inspect', 'remove', 'bind', 'update', 'analyze'].includes(action)) {
      args.id ??= target;
      if (action === 'analyze') args.features ??= (v.features ?? 'frames').split(',');
    }
  }
  const taskId = v.task ?? (group === 'task' && !['create', 'list'].includes(action) ? target : undefined);
  return { command: `${group}.${action}`, args, taskId };
}
