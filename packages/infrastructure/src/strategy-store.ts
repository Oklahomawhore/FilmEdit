import type { Store } from './store.js';
import { preferenceSchema, conceptSchema } from '../../core/src/creative-domain.js';
import { type PreferenceExample, type StrategySnapshot } from '../../core/src/creative-strategy.js';
import { canonical, hash, invariant } from '../../core/src/util.js';

const activeKey = (scope: string, audience: string) => `creative_strategy:${hash({ scope, audience })}`;
export const subjectKey = (subject: string) => subject.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
export class StrategyStore {
  constructor(readonly store: Store) {}
  validateScope(scope: string) {
    invariant(
      this.store.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(scope) ||
        this.store.db.prepare("SELECT 1 FROM tasks WHERE id=? AND purpose='production'").get(scope),
      'STRATEGY_SCOPE',
      '创作方法必须归属于一个现有账号或制作任务',
    );
  }
  examples(scope: string, audience: string): PreferenceExample[] {
    this.validateScope(scope);
    if (
      !this.store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creative_preferences'")
        .get()
    )
      return [];
    return this.store.db
      .prepare('SELECT id,task_id,data FROM creative_preferences WHERE scope=? ORDER BY id')
      .all(scope)
      .flatMap((row) => {
        const raw = JSON.parse(row.data as string);
        if (
          raw.provenance !== 'human' ||
          raw.audience !== audience ||
          raw.level !== 'concept' ||
          raw.choice === 'incomparable'
        )
          return [];
        const preference = preferenceSchema.parse(
          Object.fromEntries(Object.entries(raw).filter(([key]) => key in preferenceSchema.shape)),
        );
        const candidate = (id: string) => {
          const r = this.store.db
            .prepare('SELECT data FROM creative_candidates WHERE task_id=? AND id=?')
            .get(row.task_id!, id);
          invariant(r, 'STRATEGY_SOURCE_MISSING', '偏好记录对应的提案缺失');
          return conceptSchema.parse(JSON.parse(r.data as string));
        };
        return [
          {
            id: row.id as string,
            taskId: row.task_id as string,
            sourceHash: hash(raw),
            preference,
            left: candidate(preference.left),
            right: candidate(preference.right),
          },
        ];
      });
  }
  unchanged(scope: string, examples: PreferenceExample[]) {
    return examples.every((example) => {
      const row = this.store.db
        .prepare('SELECT data FROM creative_preferences WHERE scope=? AND id=?')
        .get(scope, example.id);
      return row && hash(JSON.parse(row.data as string)) === example.sourceHash;
    });
  }
  pending() {
    if (
      !this.store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creative_preferences'")
        .get()
    )
      return null;
    const scopes = this.store.db
      .prepare(
        "SELECT DISTINCT scope,json_extract(data,'$.audience') AS audience FROM creative_preferences ORDER BY scope,audience",
      )
      .all();
    const experiments = this.store.db
      .prepare("SELECT task_id,config FROM experiments WHERE kind='strategy'")
      .all();
    for (const row of scopes) {
      const scope = row.scope as string,
        audience = row.audience as string;
      const examples = this.examples(scope, audience);
      const subjects = new Set(
        examples
          .flatMap((e) => [e.left.proposal.theme.subject, e.right.proposal.theme.subject])
          .map(subjectKey),
      );
      if (
        examples.length < 10 ||
        subjects.size < 10 ||
        [...subjects].filter((s) => !this.usedSubject(scope, audience, s)).length < 5
      )
        continue;
      const alreadyTried = experiments.some((experiment) => {
        const config = JSON.parse(experiment.config as string);
        if (config.scope !== scope || config.audience !== audience) return false;
        if (!experiment.task_id) return true;
        const source = this.store.artifact(experiment.task_id as string, 'learning.strategy.source');
        return !source || source.hash === hash(examples);
      });
      if (!alreadyTried) return { kind: 'strategy' as const, scope, audience };
    }
    return null;
  }
  inspect(scope: string, audience: string) {
    this.validateScope(scope);
    const row = this.store.db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get(activeKey(scope, audience));
    if (!row) return { state: 'none' as const, strategy: null };
    const experimentId = JSON.parse(row.value as string) as string;
    const experiment = this.store.db
      .prepare("SELECT task_id,result FROM experiments WHERE id=? AND kind='strategy' AND state='completed'")
      .get(experimentId);
    invariant(experiment, 'STRATEGY_PUBLICATION', '创作方法的发布记录缺失');
    const result = JSON.parse(experiment.result as string);
    const dataset = this.store.artifact<{ examples: PreferenceExample[] }>(
      experiment.task_id as string,
      'learning.strategy.dataset',
    );
    invariant(
      dataset && result.published && result.scope === scope && result.audience === audience,
      'STRATEGY_PUBLICATION',
      '创作方法的发布归属不一致',
    );
    const strategy = { version: result.version, experimentId, rules: result.rules } as StrategySnapshot;
    return {
      state: this.unchanged(scope, dataset.data.examples) ? ('active' as const) : ('stale' as const),
      strategy,
    };
  }
  active(scope: string, audience: string): StrategySnapshot | null {
    const current = this.inspect(scope, audience);
    return current.state === 'active' ? current.strategy : null;
  }
  activate(scope: string, audience: string, experimentId: string) {
    this.store.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(activeKey(scope, audience), canonical(experimentId));
  }
  retract(scope: string, audience: string, version: string, reason: string) {
    return this.store.transaction(() => {
      const current = this.inspect(scope, audience);
      invariant(current.strategy?.version === version, 'VERSION_CONFLICT', '创作方法版本已变化，请重新查看');
      const row = this.store.db
        .prepare('SELECT task_id FROM experiments WHERE id=?')
        .get(current.strategy.experimentId)!;
      this.store.event(row.task_id as string, 'learning.strategy.retracted', {
        scope,
        audience,
        version,
        reason,
      });
      this.store.db.prepare('DELETE FROM settings WHERE key=?').run(activeKey(scope, audience));
      return { version, state: 'retracted' };
    });
  }
  private heldoutKey(scope: string, audience: string, subject: string) {
    return `strategy_topic_seen:${hash({ scope, audience })}:${hash(subjectKey(subject))}`;
  }
  seenTopics(scope: string, audience: string): { id: string; subject: string }[] {
    const prefix = `strategy_topic_seen:${hash({ scope, audience })}:`;
    return this.store.db
      .prepare('SELECT key,value FROM settings WHERE key LIKE ? ORDER BY key')
      .all(`${prefix}%`)
      .map((row) => ({
        id: (row.key as string).slice(prefix.length),
        subject: JSON.parse(row.value as string).subject,
      }));
  }
  usedSubject(scope: string, audience: string, subject: string) {
    return Boolean(
      this.store.db
        .prepare('SELECT 1 FROM settings WHERE key=?')
        .get(this.heldoutKey(scope, audience, subject)),
    );
  }
  recordExposure(scope: string, audience: string, subjects: string[], experimentId: string) {
    for (const subject of subjects) {
      const key = this.heldoutKey(scope, audience, subject);
      this.store.db
        .prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)')
        .run(key, canonical({ experimentId, subject }));
    }
  }
}
