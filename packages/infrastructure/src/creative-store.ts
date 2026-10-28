import { z } from 'zod';
import type { Store } from './store.js';
import { tokenize } from './store.js';
import {
  cultureBundleSchema,
  preferenceSchema,
  type CultureBundle,
  type ConceptIR,
  type ConceptComparison,
  type ConceptPreference,
  operators,
} from '../../core/src/creative-domain.js';
import { canonical, hash, invariant } from '../../core/src/util.js';
import type { SimilarityModel } from '../../media/src/scoring.js';
import { StrategyStore } from './strategy-store.js';

const preferenceId = (
  taskId: string,
  input: { left: string; right: string; audience: string; level: string },
) =>
  `preference_${hash({ taskId, pair: [input.left, input.right].sort(), level: input.level, audience: input.audience }).slice(0, 24)}`;

export class CreativeStore {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS culture_sources(scope TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS culture_entities(scope TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS culture_relations(scope TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS creative_candidates(task_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(task_id,id));
      CREATE TABLE IF NOT EXISTS creative_preferences(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL,created TEXT DEFAULT CURRENT_TIMESTAMP);
    `);
  }
  scope(taskId: string) {
    return this.store.task(taskId).spec.accountId ?? taskId;
  }
  ingest(scope: string, raw: unknown): CultureBundle {
    const bundle = cultureBundleSchema.parse(raw);
    const sourceIds = new Set(bundle.sources.map((s) => s.id));
    const entityIds = new Set(bundle.entities.map((e) => e.id));
    invariant(
      sourceIds.size === bundle.sources.length && entityIds.size === bundle.entities.length,
      'CULTURE_INVALID',
      'Duplicate cultural IDs',
    );
    for (const e of [...bundle.entities, ...bundle.relations]) {
      invariant(
        e.sourceIds.every((s) => sourceIds.has(s)),
        'CULTURE_INVALID',
        'Unknown cultural source',
      );
      invariant(
        e.provenance !== 'source_narrative' || e.sourceIds.length > 0,
        'CULTURE_INVALID',
        'Source narratives require citations',
      );
    }
    for (const e of bundle.relations)
      invariant(entityIds.has(e.from) && entityIds.has(e.to), 'CULTURE_INVALID', 'Unknown relation endpoint');
    // Content-addressed IDs prevent a later research batch from overwriting a running task's evidence.
    const ids = new Map([
      ...bundle.sources.map((s) => [s.id, `source_${hash({ scope, s }).slice(0, 24)}`] as const),
      ...bundle.entities.map(
        (e) => [e.id, `culture_${hash({ scope, e, sources: bundle.sources }).slice(0, 24)}`] as const,
      ),
    ]);
    const result: CultureBundle = {
      sources: bundle.sources.map((s) => ({ ...s, id: ids.get(s.id)! })),
      entities: bundle.entities.map((e) => ({
        ...e,
        id: ids.get(e.id)!,
        sourceIds: e.sourceIds.map((s) => ids.get(s)!),
      })),
      relations: bundle.relations.map((e) => ({
        ...e,
        from: ids.get(e.from)!,
        to: ids.get(e.to)!,
        sourceIds: e.sourceIds.map((s) => ids.get(s)!),
      })),
    };
    this.store.transaction(() => {
      for (const [table, rows] of [
        ['sources', result.sources],
        ['entities', result.entities],
        ['relations', result.relations],
      ] as const)
        for (const row of rows)
          this.store.db
            .prepare(`INSERT OR IGNORE INTO culture_${table}(scope,id,data) VALUES(?,?,?)`)
            .run(scope, 'id' in row ? row.id : hash(row), canonical(row));
    });
    return result;
  }
  search(scope: string, query: string, limit = 24): CultureBundle {
    const rows = <T>(table: string): T[] =>
      this.store.db
        .prepare(`SELECT data FROM culture_${table} WHERE scope IN (?, 'global') ORDER BY id`)
        .all(scope)
        .map((r) => JSON.parse(r.data as string));
    const all = rows<CultureBundle['entities'][number]>('entities');
    const words = tokenize(query);
    const relevance = (e: (typeof all)[number]) =>
      words.filter((w) => canonical(e).toLowerCase().includes(w)).length;
    const ranked = [...all].sort((a, b) => relevance(b) - relevance(a) || a.id.localeCompare(b.id));
    const selected = ranked.slice(0, Math.max(1, limit - 4));
    const relations = rows<CultureBundle['relations'][number]>('relations');
    const selectedIds = new Set(selected.map((e) => e.id));
    const neighborIds = new Set(
      relations
        .filter((r) => selectedIds.has(r.from) || selectedIds.has(r.to))
        .flatMap((r) => [r.from, r.to]),
    );
    // Reserve retrieval space for relations and distant domains rather than returning only keyword neighbors.
    const extra = all
      .filter((e) => !selectedIds.has(e.id))
      .sort(
        (a, b) =>
          Number(neighborIds.has(b.id)) - Number(neighborIds.has(a.id)) ||
          hash({ query, id: a.id }).localeCompare(hash({ query, id: b.id })),
      )
      .slice(0, 4);
    const entities = [...selected, ...extra].slice(0, limit);
    const ids = new Set(entities.map((e) => e.id));
    const edges = relations.filter((r) => ids.has(r.from) && ids.has(r.to)).slice(0, 80);
    const sources = new Set([...entities, ...edges].flatMap((e) => e.sourceIds));
    return {
      entities,
      relations: edges,
      sources: rows<CultureBundle['sources'][number]>('sources').filter((s) => sources.has(s.id)),
    };
  }
  async retrieve(scope: string, query: string, model: SimilarityModel): Promise<CultureBundle> {
    const pool = this.search(scope, query, 40);
    if (!pool.entities.length) return pool;
    const scores = await model.compare(
      pool.entities.map((e) => ({ premise: `${e.name}：${e.description}；${e.context}`, hypothesis: query })),
    );
    const ranked = pool.entities
      .map((e, i) => ({ e, score: scores[i]?.similarity ?? -1 }))
      .sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
    const entities = ranked.slice(0, 20).map((r) => r.e);
    // Four exploration slots remain available even when embedding similarity strongly favors one domain.
    entities.push(
      ...ranked
        .slice(20)
        .sort((a, b) => hash({ query, id: a.e.id }).localeCompare(hash({ query, id: b.e.id })))
        .slice(0, 4)
        .map((r) => r.e),
    );
    const ids = new Set(entities.map((e) => e.id));
    const relations = pool.relations.filter((r) => ids.has(r.from) && ids.has(r.to));
    const sources = new Set([...entities, ...relations].flatMap((e) => e.sourceIds));
    return { entities, relations, sources: pool.sources.filter((s) => sources.has(s.id)) };
  }
  removeEntity(scope: string, entityId: string) {
    const entity = this.store.db
      .prepare('SELECT data FROM culture_entities WHERE scope=? AND id=?')
      .get(scope, entityId);
    invariant(entity, 'CULTURE_MISSING', '发布记录关联的文化条目缺失');
    const relations = this.store.db
      .prepare(
        "SELECT id,data FROM culture_relations WHERE scope=? AND (json_extract(data,'$.from')=? OR json_extract(data,'$.to')=?)",
      )
      .all(scope, entityId, entityId);
    this.store.transaction(() => {
      for (const relation of relations)
        this.store.db
          .prepare('DELETE FROM culture_relations WHERE scope=? AND id=?')
          .run(scope, relation.id!);
      this.store.db.prepare('DELETE FROM culture_entities WHERE scope=? AND id=?').run(scope, entityId);
    });
    // Keep source citations for history and for other entities from the same video.
    return {
      entity: JSON.parse(entity.data as string),
      relations: relations.map((r) => JSON.parse(r.data as string)),
    };
  }
  archive(taskId: string, concept: ConceptIR) {
    const existing = this.store.db
      .prepare('SELECT data FROM creative_candidates WHERE task_id=? AND id=?')
      .get(taskId, concept.id);
    invariant(
      !existing || existing.data === canonical(concept),
      'CONCEPT_ID_REUSED',
      'A candidate ID cannot identify two different concepts',
    );
    this.store.db
      .prepare('INSERT OR IGNORE INTO creative_candidates(task_id,id,data) VALUES(?,?,?)')
      .run(taskId, concept.id, canonical(concept));
  }
  candidates(taskId: string): ConceptIR[] {
    return this.store.db
      .prepare('SELECT data FROM creative_candidates WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((r) => JSON.parse(r.data as string));
  }
  candidatePage(taskId: string, before: number, limit: number) {
    const rows = this.store.db
      .prepare(
        "SELECT rowid AS cursor,id,substr(json_extract(data,'$.proposal.theme.subject'),1,120) AS subject,substr(json_extract(data,'$.proposal.content.synopsis'),1,220) AS synopsis FROM creative_candidates WHERE task_id=? AND (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?",
      )
      .all(taskId, before, before, limit + 1);
    return {
      items: rows.slice(0, limit),
      nextBefore: rows.length > limit ? Number(rows[limit - 1]!.cursor) : null,
    };
  }
  private candidate(taskId: string, candidateId: string): ConceptIR {
    const row = this.store.db
      .prepare('SELECT data FROM creative_candidates WHERE task_id=? AND id=?')
      .get(taskId, candidateId);
    invariant(row, 'PREFERENCE_INVALID', '候选不属于当前任务');
    return JSON.parse(row.data as string);
  }
  compare(taskId: string, input: { left: string; right: string; audience: string }): ConceptComparison {
    const task = this.store.productionTask(taskId);
    invariant(input.left !== input.right, 'PREFERENCE_INVALID', '请选择两个不同的候选');
    const row = this.store.db
      .prepare('SELECT id,data FROM creative_preferences WHERE id=?')
      .get(preferenceId(taskId, { ...input, level: 'concept' }));
    const previous: ConceptPreference | null = row
      ? { id: row.id as string, ...JSON.parse(row.data as string) }
      : null;
    // A/B are presentation positions, not candidate identities.
    if (previous && previous.left !== input.left) {
      [previous.left, previous.right] = [previous.right, previous.left];
      if (previous.choice === 'left' || previous.choice === 'right')
        previous.choice = previous.choice === 'left' ? 'right' : 'left';
    }
    return {
      taskId,
      taskVersion: task.version,
      left: this.candidate(taskId, input.left),
      right: this.candidate(taskId, input.right),
      previous,
    };
  }
  feedback(taskId: string, raw: unknown) {
    const input = preferenceSchema.parse(raw);
    return this.store.transaction(() => {
      const task = this.store.productionTask(taskId);
      invariant(
        task.version === input.expectedVersion,
        'VERSION_CONFLICT',
        '任务需求已变化，请重新查看候选后提交偏好',
      );
      invariant(input.left !== input.right, 'PREFERENCE_INVALID', 'Compare two different candidates');
      const left = this.candidate(taskId, input.left),
        right = this.candidate(taskId, input.right);
      // Concept-only API cannot claim the user saw two rendered samples or finished videos.
      invariant(
        input.level === 'concept',
        'PREFERENCE_INVALID',
        'Only concept comparisons are available until both sample/final artifacts exist',
      );
      const feedbackId = preferenceId(taskId, input);
      const data = canonical({
        ...input,
        leftFeatures: features(left),
        rightFeatures: features(right),
        provenance: 'human',
      });
      const prior = this.store.db.prepare('SELECT data FROM creative_preferences WHERE id=?').get(feedbackId);
      this.store.db
        .prepare(
          'INSERT INTO creative_preferences(id,task_id,scope,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(feedbackId, taskId, this.scope(taskId), data);
      if (prior?.data !== data)
        this.store.event(taskId, 'creative.preference.recorded', { id: feedbackId, ...input });
      return { id: feedbackId, ...input };
    });
  }
  taste(scope: string, audience = 'default') {
    const rows = this.store.db
      .prepare('SELECT id,data FROM creative_preferences WHERE scope=? ORDER BY rowid')
      .all(scope)
      .map((r) => ({ id: r.id, ...JSON.parse(r.data as string) }))
      .filter((r) => r.audience === audience && r.level === 'concept' && r.choice !== 'incomparable');
    const weights: number[] = operators.map(() => 0);
    // Small local pairwise logistic ranker. Model self-reviews never enter this table.
    if (rows.length >= 5)
      for (let epoch = 0; epoch < 150; epoch++) {
        for (const row of rows) {
          const examples =
            row.choice === 'both_bad'
              ? [
                  { x: row.leftFeatures as number[], target: 0 },
                  { x: row.rightFeatures as number[], target: 0 },
                ]
              : [
                  {
                    x: (row.leftFeatures as number[]).map((v, i) => v - row.rightFeatures[i]),
                    target: row.choice === 'left' ? 1 : 0,
                  },
                ];
          for (const { x, target } of examples) {
            const p = 1 / (1 + Math.exp(-x.reduce((n, v, i) => n + v * weights[i]!, 0)));
            weights.forEach((w, i) => {
              weights[i] = w + 0.03 * ((target - p) * x[i]! - 0.05 * w);
            });
          }
        }
      }
    const strategy = new StrategyStore(this.store).active(scope, audience);
    return {
      version: `taste-v2:${hash({ rows, strategy })}`,
      samples: rows.length,
      trained: rows.length >= 5,
      weights,
      strategy,
    };
  }
}
export function features(concept: ConceptIR) {
  return operators.map((o) => Number(concept.operators.includes(o.id)));
}
