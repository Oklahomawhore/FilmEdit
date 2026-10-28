import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Asset, MemoryInput, Stage, TaskSpec, TaskStatus } from '../../core/src/domain.js';
import { budgetsSchema, memorySchema } from '../../core/src/domain.js';
import type { PolicyData } from './security.js';
import { canonical, hash, id, invariant } from '../../core/src/util.js';
import { migrateWorkbench } from './workbench-schema.js';

export type TaskPurpose = 'production' | 'learning';
export type TaskRow = {
  id: string;
  purpose: TaskPurpose;
  spec: TaskSpec;
  policy: PolicyData;
  status: TaskStatus;
  stage: Stage;
  releaseId: string;
  cost: number;
  version: number;
  error?: unknown;
  created: string;
  updated: string;
};
export type MemoryRow = MemoryInput & { id: string; accountId: string | null; created: string };
export type Artifact = {
  id: string;
  taskId: string;
  stage: string;
  revision: number;
  hash: string;
  data: unknown;
  accepted: boolean;
  created: string;
};
const json = <T>(value: unknown): T => JSON.parse(value as string) as T;
export class Store {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(public readonly home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.home = realpathSync(home);
    this.db = new DatabaseSync(path.join(this.home, 'filmedit.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY, manifest TEXT NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, spec TEXT NOT NULL, policy TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, release_id TEXT NOT NULL REFERENCES releases(id), cost REAL NOT NULL DEFAULT 0, error TEXT, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), stage TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, accepted INTEGER NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(task_id,stage,revision));
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), kind TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL, provenance TEXT NOT NULL, source TEXT, confidence REAL NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, terms, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS experiments(id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, config TEXT NOT NULL, result TEXT, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      INSERT OR IGNORE INTO migrations(version) VALUES(1);
    `);
    this.db
      .prepare('INSERT OR IGNORE INTO releases(id,manifest,state) VALUES(?,?,?)')
      .run(
        'builtin_v1',
        canonical({ schemaVersion: 1, code: 'builtin', techniques: 1, knowledge: 1 }),
        'active',
      );
    this.db
      .prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)')
      .run('active_release', 'builtin_v1');
    migrateWorkbench(this.db, this.home);
    this.seed();
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  createAccount(name: string, accountId = id('account')) {
    this.db.prepare('INSERT INTO accounts(id,name) VALUES(?,?)').run(accountId, name);
    return accountId;
  }
  accounts() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY created').all();
  }
  activeRelease(): string {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get('active_release') as { value: string }
    ).value;
  }
  createTask(taskId: string, spec: TaskSpec, policy: PolicyData, purpose: TaskPurpose = 'production') {
    if (spec.accountId)
      invariant(
        this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(spec.accountId),
        'ACCOUNT_MISSING',
        `Unknown account: ${spec.accountId}`,
      );
    this.db
      .prepare('INSERT INTO tasks(id,spec,policy,status,stage,release_id,purpose) VALUES(?,?,?,?,?,?,?)')
      .run(
        taskId,
        canonical(spec),
        canonical(policy),
        'queued',
        spec.creative.enabled ? 'creative' : 'script',
        this.activeRelease(),
        purpose,
      );
    this.event(taskId, 'created', { policyVersion: policy.version });
    return this.task(taskId);
  }
  task(taskId: string): TaskRow {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as
      Record<string, unknown> | undefined;
    invariant(row, 'TASK_MISSING', `Unknown task: ${taskId}`);
    return {
      id: row.id as string,
      purpose: row.purpose as TaskPurpose,
      spec: json(row.spec),
      policy: json(row.policy),
      status: row.status as TaskStatus,
      stage: row.stage as Stage,
      releaseId: row.release_id as string,
      version: Number(row.version ?? 1),
      cost: row.cost as number,
      error: row.error ? json(row.error) : undefined,
      created: row.created as string,
      updated: row.updated as string,
    };
  }
  productionTask(taskId: string) {
    const task = this.task(taskId);
    invariant(
      task.purpose === 'production',
      'TASK_PURPOSE',
      'Learning workspaces are managed through experiments, not video tasks',
    );
    return task;
  }
  tasks(purpose: TaskPurpose = 'production') {
    return this.db
      .prepare('SELECT id FROM tasks WHERE purpose=? ORDER BY created DESC')
      .all(purpose)
      .map((r) => this.task(r.id as string));
  }
  updateTask(taskId: string, status: TaskStatus, stage: Stage, error?: unknown) {
    this.db
      .prepare('UPDATE tasks SET status=?,stage=?,error=?,updated=CURRENT_TIMESTAMP WHERE id=?')
      .run(status, stage, error ? canonical(error) : null, taskId);
    this.event(taskId, 'status', { status, stage, error });
  }
  replacePolicy(taskId: string, policy: PolicyData) {
    this.db.prepare('UPDATE tasks SET policy=? WHERE id=?').run(canonical(policy), taskId);
  }
  setTaskBudgets(taskId: string, input: unknown) {
    const budgets = budgetsSchema.parse(input);
    return this.transaction(() => {
      const task = this.task(taskId);
      const leased = this.db
        .prepare('SELECT 1 FROM leases WHERE name=? AND expires>=?')
        .get(`task:${taskId}`, Date.now());
      invariant(task.status !== 'running' && !leased, 'TASK_BUSY', 'Stop the task before changing budgets');
      this.db
        .prepare('UPDATE tasks SET spec=?,updated=CURRENT_TIMESTAMP WHERE id=?')
        .run(canonical({ ...task.spec, budgets }), taskId);
      this.event(taskId, 'budgets.changed', { before: task.spec.budgets, after: budgets });
      return this.task(taskId);
    });
  }
  addCost(taskId: string, usd: number) {
    this.db.prepare('UPDATE tasks SET cost=cost+? WHERE id=?').run(usd, taskId);
  }
  event(taskId: string, type: string, data: unknown) {
    this.db.prepare('INSERT INTO events(task_id,type,data) VALUES(?,?,?)').run(taskId, type, canonical(data));
    this.activity(type, data, { taskId });
  }
  activity(
    type: string,
    data: unknown,
    refs: { taskId?: string; conversationId?: string; runId?: string } = {},
  ) {
    const result = this.db
      .prepare('INSERT INTO activity(task_id,conversation_id,run_id,type,data) VALUES(?,?,?,?,?)')
      .run(refs.taskId ?? null, refs.conversationId ?? null, refs.runId ?? null, type, canonical(data));
    return Number(result.lastInsertRowid);
  }
  activityPage(after = 0, refs: { taskId?: string; conversationId?: string } = {}) {
    return this.db
      .prepare(
        'SELECT * FROM activity WHERE seq>? AND (? IS NULL OR task_id=?) AND (? IS NULL OR conversation_id=?) ORDER BY seq LIMIT 250',
      )
      .all(
        after,
        refs.taskId ?? null,
        refs.taskId ?? null,
        refs.conversationId ?? null,
        refs.conversationId ?? null,
      )
      .map((row) => ({ ...row, data: json(row.data) }));
  }
  events(taskId: string, after = 0) {
    return this.db
      .prepare('SELECT * FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 500')
      .all(taskId, after)
      .map((r) => ({
        seq: Number(r.seq),
        taskId: r.task_id as string,
        type: r.type as string,
        created: r.created as string,
        data: json(r.data),
      }));
  }
  saveArtifact(taskId: string, stage: string, data: unknown, accepted = false): Artifact {
    return this.transaction(() => {
      const revision = (
        this.db
          .prepare('SELECT COALESCE(MAX(revision),0)+1 AS n FROM artifacts WHERE task_id=? AND stage=?')
          .get(taskId, stage) as { n: number }
      ).n;
      const artifactId = id('artifact');
      const digest = hash(data);
      this.db
        .prepare('INSERT INTO artifacts(id,task_id,stage,revision,hash,data,accepted) VALUES(?,?,?,?,?,?,?)')
        .run(artifactId, taskId, stage, revision, digest, canonical(data), accepted ? 1 : 0);
      return {
        id: artifactId,
        taskId,
        stage,
        revision,
        hash: digest,
        data,
        accepted,
        created: new Date().toISOString(),
      };
    });
  }
  epoch(taskId: string): { artifactFloor: number; eventFloor: number } {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(`epoch:${taskId}`);
    return row ? JSON.parse(row.value as string) : { artifactFloor: 0, eventFloor: 0 };
  }
  artifact<T = unknown>(
    taskId: string,
    stage: string,
    accepted = true,
  ): (Omit<Artifact, 'data'> & { data: T }) | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM artifacts WHERE task_id=? AND stage=? AND rowid>? ${accepted ? 'AND accepted=1' : ''} ORDER BY revision DESC LIMIT 1`,
      )
      .get(taskId, stage, this.artifactFloor(taskId, stage));
    if (!row) return undefined;
    return {
      id: row.id as string,
      taskId,
      stage,
      revision: row.revision as number,
      hash: row.hash as string,
      data: json<T>(row.data),
      accepted: Boolean(row.accepted),
      created: row.created as string,
    };
  }
  invalidate(taskId: string, stages: string[]) {
    const stmt = this.db.prepare('UPDATE artifacts SET accepted=0 WHERE task_id=? AND stage=?');
    this.transaction(() => {
      for (const stage of stages) stmt.run(taskId, stage);
    });
  }
  stageEventFloor(taskId: string, stage: string) {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get(`stage-event:${taskId}:${stage}`);
    return Math.max(this.epoch(taskId).eventFloor, row ? Number(row.value) : 0);
  }
  artifactFloor(taskId: string, stage: string) {
    const rows = this.db.prepare('SELECT stage,floor FROM stage_epochs WHERE task_id=?').all(taskId);
    return Math.max(
      ['assets.imported', 'memory'].includes(stage) ? 0 : this.epoch(taskId).artifactFloor,
      ...rows.filter((r) => stage === r.stage || stage.startsWith(`${r.stage}.`)).map((r) => Number(r.floor)),
    );
  }
  invalidateFrom(taskId: string, stages: string[]) {
    const floor = Number(
      this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM artifacts WHERE task_id=?').get(taskId)!.n,
    );
    const eventFloor = Number(
      this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE task_id=?').get(taskId)!.n,
    );
    for (const stage of stages) {
      this.db
        .prepare('INSERT OR REPLACE INTO stage_epochs(task_id,stage,floor) VALUES(?,?,?)')
        .run(taskId, stage, floor);
      this.db
        .prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
        .run(`stage-event:${taskId}:${stage}`, String(eventFloor));
    }
  }
  saveAsset(asset: Asset) {
    this.db
      .prepare(
        'INSERT INTO assets(id,task_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(asset.id, asset.taskId, canonical(asset));
  }
  assets(taskId: string): Asset[] {
    return this.db
      .prepare('SELECT data FROM assets WHERE task_id=?')
      .all(taskId)
      .map((r) => json<Asset>(r.data));
  }
  asset(taskId: string, assetId: string) {
    const found = this.assets(taskId).find((a) => a.id === assetId);
    invariant(found, 'ASSET_MISSING', `Unknown task asset: ${assetId}`);
    return found;
  }
  addMemory(accountId: string | null, input: MemoryInput, memoryId = id('memory')) {
    const value = memorySchema.parse(input);
    invariant(
      accountId ||
        !['setting', 'feedback', 'history', 'experience', 'inferred_preference'].includes(value.kind),
      'MEMORY_SCOPE',
      'Account memory requires an account',
    );
    invariant(
      value.kind !== 'experience' || value.provenance === 'user',
      'MEMORY_PROVENANCE',
      'Account experience must come from the user',
    );
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO memories(id,account_id,kind,content,tags,provenance,source,confidence) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          memoryId,
          accountId,
          value.kind,
          value.content,
          canonical(value.tags),
          value.provenance,
          value.source ?? null,
          value.confidence,
        );
      this.db
        .prepare('INSERT INTO memory_fts(memory_id,terms) VALUES(?,?)')
        .run(memoryId, tokenize(`${value.content} ${value.tags.join(' ')}`).join(' '));
    });
    return memoryId;
  }
  memories(
    accountId: string | null,
    query = '',
    limit: number | null = 30,
    filters: {
      includeGlobal?: boolean;
      kinds?: MemoryInput['kind'][];
      provenance?: MemoryInput['provenance'];
    } = {},
  ): MemoryRow[] {
    const tokens = tokenize(query).slice(0, 40);
    const where = [
      filters.includeGlobal === false ? 'm.account_id IS ?' : '(m.account_id IS NULL OR m.account_id=?)',
    ];
    const values: (string | number | null)[] = [accountId];
    if (filters.kinds) {
      if (!filters.kinds.length) return [];
      where.push(`m.kind IN (${filters.kinds.map(() => '?').join(',')})`);
      values.push(...filters.kinds);
    }
    if (filters.provenance) {
      where.push('m.provenance=?');
      values.push(filters.provenance);
    }
    if (tokens.length) {
      where.push('memory_fts MATCH ?');
      values.push(tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR '));
    }
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m ${tokens.length ? 'JOIN memory_fts f ON f.memory_id=m.id' : ''} WHERE ${where.join(' AND ')} ORDER BY ${tokens.length ? 'rank,' : ''}m.created DESC,m.rowid DESC LIMIT ?`,
      )
      .all(...values, limit ?? -1);
    return rows.map((r) => ({
      id: r.id as string,
      accountId: r.account_id as string | null,
      kind: r.kind as MemoryInput['kind'],
      content: r.content as string,
      tags: json(r.tags),
      provenance: r.provenance as MemoryInput['provenance'],
      source: r.source as string | undefined,
      confidence: r.confidence as number,
      created: r.created as string,
    }));
  }
  correctMemory(accountId: string, memoryId: string, correction: { content: string; tags: string[] } | null) {
    const before = this.db
      .prepare('SELECT * FROM memories WHERE id=? AND account_id=?')
      .get(memoryId, accountId);
    invariant(before, 'MEMORY_MISSING', 'Memory does not belong to this account');
    const after = correction
      ? memorySchema.parse({
          kind: before.kind,
          source: before.source ?? undefined,
          content: correction.content,
          tags: correction.tags,
          // A fictional character stays fictional even when a user edits its story.
          provenance: before.provenance === 'fictional' ? 'fictional' : 'user',
          confidence: 1,
        })
      : null;
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO memory_changes(memory_id,account_id,operation,before_data,after_data) VALUES(?,?,?,?,?)',
        )
        .run(
          memoryId,
          accountId,
          after ? 'correct' : 'remove',
          canonical(before),
          after ? canonical(after) : null,
        );
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id=?').run(memoryId);
      if (after) {
        this.db
          .prepare(
            'UPDATE memories SET content=?,tags=?,provenance=?,confidence=? WHERE id=? AND account_id=?',
          )
          .run(after.content, canonical(after.tags), after.provenance, after.confidence, memoryId, accountId);
        this.db
          .prepare('INSERT INTO memory_fts(memory_id,terms) VALUES(?,?)')
          .run(memoryId, tokenize(`${after.content} ${after.tags.join(' ')}`).join(' '));
      } else this.db.prepare('DELETE FROM memories WHERE id=? AND account_id=?').run(memoryId, accountId);
    });
    return { id: memoryId, accountId, operation: after ? 'corrected' : 'removed' };
  }
  acquireLease(name: string, owner: string, ttlMs = 120000): boolean {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM leases WHERE expires<?').run(Date.now());
      const lease = this.db.prepare('SELECT owner FROM leases WHERE name=?').get(name);
      if (lease && lease.owner !== owner) return false;
      this.db
        .prepare(
          'INSERT INTO leases(name,owner,expires) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET expires=excluded.expires',
        )
        .run(name, owner, Date.now() + ttlMs);
      return true;
    });
  }
  releaseLease(name: string, owner: string) {
    this.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(name, owner);
  }
  private seed() {
    const personas = [
      [
        'observer',
        '城市观察者',
        '下班后绕远路走回家，在便利店和公交站观察普通人的细节。',
        ['城市', '孤独', '生活'],
      ],
      ['maker', '耐心的修理者', '拆坏过一台旧收音机，后来学会先记录故障再动手。', ['科技', '实践', '修复']],
      ['teacher', '好奇的老师', '讲错过一道题，第二天把纠错过程也讲给学生。', ['知识', '解释', '学习']],
      ['cook', '家常菜爱好者', '第一次独居时把汤煮干，慢慢学会用一顿饭安顿自己。', ['饮食', '日常', '成长']],
      ['runner', '业余跑者', '因急着提升速度受过伤，重新从散步开始。', ['运动', '耐心', '成长']],
      ['traveler', '慢旅行者', '错过末班车后，和车站值班的人聊了一夜。', ['旅行', '相遇', '人情']],
      ['designer', '务实设计师', '曾追求复杂效果，直到用户找不到最基本的按钮。', ['设计', '简洁', '产品']],
      ['gardener', '阳台园丁', '种死过薄荷，开始记录浇水和光照而不是凭感觉。', ['自然', '观察', '生活']],
    ] as const;
    for (const [key, name, experience, tags] of personas)
      if (!this.db.prepare('SELECT id FROM memories WHERE id=?').get(`persona_${key}`))
        this.addMemory(
          null,
          {
            kind: 'persona',
            content: canonical({ name, fictional: true, experience }),
            tags: [...tags],
            provenance: 'fictional',
            confidence: 1,
          },
          `persona_${key}`,
        );
  }
}
export function tokenize(text: string): string[] {
  return [
    ...new Set(
      [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment.toLowerCase()),
    ),
  ];
}
