// Explicit real-model learning acceptance, isolated from production releases and memories.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadProjectEnv } from '../packages/infrastructure/src/model-provider.ts';
import { Store } from '../packages/infrastructure/src/store.ts';
import { LearningService } from '../packages/application/src/learning.ts';
import { errorInfo } from '../packages/core/src/util.ts';

await loadProjectEnv();
const [kind, query, ...localPaths] = process.argv.slice(2);
if (!['script', 'technique'].includes(kind) || !query)
  throw new Error(
    'Usage: node --import tsx scripts/verify-learning.mjs script|technique QUERY [REFERENCE MATERIALS...]',
  );
const home = path.resolve(
  process.env.FILMEDIT_VERIFICATION_DIR ?? `.filmedit/verification/product-20261023/real-learning-${kind}`,
);
const store = new Store(home);
const service = new LearningService(store);
const existing = service.list()[0];
if (!existing && !localPaths.length) throw new Error('Select reference media for the first run');
const experimentId =
  existing?.id ?? service.enqueue({ kind, query, localPaths: localPaths.map((p) => path.resolve(p)) });
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
console.log(JSON.stringify({ home, experimentId }));
try {
  const result = await service.run(experimentId, controller.signal);
  console.log(JSON.stringify({ experimentId, state: 'completed', result }));
} catch (error) {
  console.log(JSON.stringify({ experimentId, error: errorInfo(error) }));
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(home, 'acceptance.json'),
    JSON.stringify(
      {
        experiments: service.list(),
        memories: store.db.prepare('SELECT id,kind,provenance,source,confidence FROM memories').all(),
        artifacts: store.db
          .prepare('SELECT id,task_id,stage,accepted,hash FROM artifacts ORDER BY rowid')
          .all(),
      },
      null,
      2,
    ),
  );
  store.close();
}
