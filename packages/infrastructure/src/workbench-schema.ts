import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { taskInputSchema } from '../../core/src/domain.js';
import { canonical } from '../../core/src/util.js';

/** Explicit persisted-data migrations; runtime consumes a single current task schema. */
export function migrateWorkbench(db: DatabaseSync, home: string) {
  const targetVersion = 6;
  if (
    [2, 3, 4, 5, 6].some((version) => !db.prepare('SELECT 1 FROM migrations WHERE version=?').get(version)) &&
    Number(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n) > 0
  ) {
    const folder = path.join(home, 'backups');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    db.prepare('VACUUM INTO ?').run(path.join(folder, `before-schema-${targetVersion}-${Date.now()}.sqlite`));
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=2').get()) {
    db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE activity(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, conversation_id TEXT, run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX activity_task ON activity(task_id,seq);
    CREATE INDEX activity_conversation ON activity(conversation_id,seq);
    CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, task_id TEXT, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), task_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, request_id TEXT, state TEXT NOT NULL DEFAULT 'completed', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(conversation_id,request_id));
    CREATE TABLE runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, input TEXT NOT NULL, result TEXT, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX runs_task ON runs(task_id,created);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, task_id TEXT, conversation_id TEXT, run_id TEXT, kind TEXT NOT NULL, state TEXT NOT NULL, input TEXT NOT NULL, result TEXT, priority INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX jobs_state ON jobs(state,priority,created);
    CREATE TABLE commands(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE agent_sessions(id TEXT PRIMARY KEY, scope TEXT NOT NULL, task_id TEXT, role TEXT NOT NULL, state TEXT NOT NULL, messages TEXT NOT NULL DEFAULT '[]', output TEXT, model TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX agent_scope ON agent_sessions(scope,created);
    CREATE TABLE tool_executions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id), name TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE stage_epochs(task_id TEXT NOT NULL, stage TEXT NOT NULL, floor INTEGER NOT NULL, PRIMARY KEY(task_id,stage));
    CREATE TABLE library_assets(id TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX library_hash ON library_assets(hash);
    CREATE TABLE library_sources(path TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES library_assets(id), size INTEGER NOT NULL, mtime REAL NOT NULL, state TEXT NOT NULL DEFAULT 'ready');
    CREATE TABLE library_analysis(hash TEXT NOT NULL, analyzer TEXT NOT NULL, version TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hash,analyzer,version));
    CREATE VIRTUAL TABLE library_fts USING fts5(asset_id UNINDEXED,terms,tokenize='unicode61');
    INSERT INTO migrations(version) VALUES(2);
    COMMIT;`);
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=3').get()) {
    db.exec(`BEGIN IMMEDIATE;
      UPDATE artifacts SET stage='assets.imported' WHERE stage='materials';
      UPDATE stage_epochs SET stage='assets.imported' WHERE stage='materials';
      INSERT INTO migrations(version) VALUES(3);
      COMMIT;`);
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=4').get()) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE memory_changes(id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, account_id TEXT NOT NULL,
        operation TEXT NOT NULL, before_data TEXT NOT NULL, after_data TEXT, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO migrations(version) VALUES(4);
      COMMIT;`);
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=5').get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare('SELECT id,spec FROM tasks').all()) {
        const previous = JSON.parse(row.spec as string);
        // Tasks created before creative sampling retain their accepted work through an explicit opt-out.
        const spec = taskInputSchema.parse({
          ...previous,
          creative: previous.creative ?? { enabled: false },
        });
        db.prepare('UPDATE tasks SET spec=? WHERE id=?').run(canonical(spec), row.id as string);
      }
      db.exec('INSERT INTO migrations(version) VALUES(5); COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=6').get()) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE tasks ADD COLUMN purpose TEXT NOT NULL DEFAULT 'production' CHECK(purpose IN ('production','learning'));
      ALTER TABLE experiments ADD COLUMN task_id TEXT REFERENCES tasks(id);
      ALTER TABLE experiments ADD COLUMN error TEXT;
      UPDATE experiments SET task_id=json_extract(result,'$.taskId')
        WHERE json_extract(result,'$.taskId') IN (SELECT id FROM tasks);
      UPDATE experiments SET error=json_extract(result,'$.error'),result=json_remove(result,'$.error') WHERE result IS NOT NULL;
      UPDATE tasks SET purpose='learning' WHERE id IN (SELECT task_id FROM experiments);
      UPDATE conversations SET task_id=NULL WHERE task_id IN (SELECT id FROM tasks WHERE purpose='learning');
      INSERT INTO migrations(version) VALUES(6);
      COMMIT;`);
  }
}
