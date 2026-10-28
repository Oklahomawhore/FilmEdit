import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, asset, editorial } from './helpers.js';
import { createTask } from '../packages/application/src/workflow.js';
import { defaultRender } from '../packages/core/src/ir.js';
import { RecipeRegistry } from '../packages/infrastructure/src/recipes.js';
import { canonical } from '../packages/core/src/util.js';
test('learned DSL expands material slots and timing, only for a pinned release lineage', async (t) => {
  const { store } = await fixture();
  t.after(() => store.close());
  const task = await createTask(store, { prompt: 'test' });
  const material = { ...asset, taskId: task.id };
  store.saveAsset(material);
  const ir = editorial();
  const render = defaultRender(ir, { width: 1080, height: 1920, fps: 30 });
  store.db
    .prepare('INSERT INTO releases(id,manifest,state) VALUES(?,?,?)')
    .run('release_learned', canonical({ parent: 'builtin_v1' }), 'active');
  store.addMemory(null, {
    kind: 'technique',
    content: canonical({
      id: 'learned_cut',
      version: 1,
      description: 'two shots',
      layer: 'editorial',
      hypothesis: 'same order',
      editorial: ir,
      render,
      materialSlots: ['asset_a'],
      releaseId: 'release_learned',
    }),
    tags: [],
    provenance: 'inferred',
    confidence: 1,
  });
  assert.equal(new RecipeRegistry(store, 'builtin_v1').list().length, 0);
  const registry = new RecipeRegistry(store, 'release_learned');
  const expanded = registry.expand(task.id, {
    technique: { id: 'learned_cut', version: 1 },
    bindings: { asset_a: asset.id },
    duration: 8,
    text: { text_a: '新文字' },
  });
  assert.equal(expanded.editorial.duration, 8);
  assert.equal(expanded.editorial.shots[1]!.start, 4);
  assert.equal(expanded.editorial.shots[1]!.speed, 0.5);
  assert.equal(expanded.editorial.text[0]!.text, '新文字');
  assert.throws(
    () => registry.expand(task.id, { technique: { id: 'learned_cut', version: 1 }, bindings: {} }),
    { code: 'RECIPE_BINDING' },
  );
  store.addMemory(null, {
    kind: 'technique',
    content: '{"broken":true}',
    tags: [],
    provenance: 'inferred',
    confidence: 1,
  });
  assert.throws(
    () => registry.list(),
    /invalid|Invalid/,
    'Corrupt learned code must fail visibly, never disappear from the registry',
  );
});
