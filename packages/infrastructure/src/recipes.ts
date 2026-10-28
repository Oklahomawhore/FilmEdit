import { z } from 'zod';
import { editorialSchema, renderSchema, ID, type EditorialIR, type RenderIR } from '../../core/src/domain.js';
import { Store } from './store.js';
import { hash, invariant } from '../../core/src/util.js';
import { validateEditorial, validateRender } from '../../core/src/ir.js';

export const techniqueInvocationSchema = z
  .object({
    technique: z.object({ id: ID, version: z.number().int().positive() }).strict(),
    bindings: z.record(z.string(), ID),
    duration: z.number().positive().optional(),
    text: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export const editorialDraftSchema = z.union([editorialSchema, techniqueInvocationSchema]);
export const learnedRecipeSchema = z.object({
  id: ID,
  version: z.number().int().positive(),
  description: z.string(),
  layer: z.enum(['editorial', 'presentation']),
  hypothesis: z.string(),
  editorial: editorialSchema,
  render: renderSchema,
  materialSlots: z.array(ID),
  releaseId: ID,
});
export class RecipeRegistry {
  constructor(
    readonly store: Store,
    readonly releaseId: string,
  ) {}
  list() {
    const available = new Set<string>();
    let release: string | undefined = this.releaseId;
    while (release && !available.has(release)) {
      available.add(release);
      const row = this.store.db.prepare('SELECT manifest FROM releases WHERE id=?').get(release) as
        { manifest: string } | undefined;
      release = row ? JSON.parse(row.manifest).parent : undefined;
    }
    return this.store.db
      .prepare("SELECT id,content FROM memories WHERE account_id IS NULL AND kind='technique'")
      .all()
      .flatMap((row) => {
        const parsed = learnedRecipeSchema.parse(JSON.parse(row.content as string));
        return available.has(parsed.releaseId) ? [parsed] : [];
      });
  }
  expand(taskId: string, input: unknown): { editorial: EditorialIR; render: RenderIR } {
    const invocation = techniqueInvocationSchema.parse(input);
    const recipe = this.list().find(
      (t) => t.id === invocation.technique.id && t.version === invocation.technique.version,
    );
    invariant(
      recipe,
      'TECHNIQUE_UNSUPPORTED',
      `Unknown learned technique ${invocation.technique.id}@${invocation.technique.version} for this release`,
    );
    for (const slot of recipe.materialSlots)
      invariant(invocation.bindings[slot], 'RECIPE_BINDING', `Bind material slot ${slot}`);
    const scale = (invocation.duration ?? recipe.editorial.duration) / recipe.editorial.duration;
    const bind = (assetId: string) => {
      const value = invocation.bindings[assetId];
      invariant(value, 'RECIPE_BINDING', `Unbound source ${assetId}`);
      return value;
    };
    const editorial = validateEditorial(
      {
        ...recipe.editorial,
        revision: 0,
        duration: recipe.editorial.duration * scale,
        shots: recipe.editorial.shots.map((s) => ({
          ...s,
          assetId: bind(s.assetId),
          start: s.start * scale,
          duration: s.duration * scale,
          speed: s.speed / scale,
        })),
        audio: recipe.editorial.audio.map((a) => ({
          ...a,
          assetId: bind(a.assetId),
          start: a.start * scale,
          duration: a.duration * scale,
          speed: a.speed / scale,
          fadeIn: a.fadeIn * scale,
          fadeOut: a.fadeOut * scale,
        })),
        transitions: recipe.editorial.transitions.map((t) => ({ ...t, duration: t.duration * scale })),
        text: recipe.editorial.text.map((t) => ({
          ...t,
          text: invocation.text[t.id] ?? t.text,
          start: t.start * scale,
          duration: t.duration * scale,
        })),
      },
      this.store.assets(taskId),
    );
    const render = validateRender(
      {
        ...recipe.render,
        editorialHash: hash(editorial),
        nodes: recipe.render.nodes.map((n) => ({
          ...n,
          keyframes: n.keyframes.map((k) => ({ ...k, time: k.time * scale })),
        })),
      },
      editorial,
    );
    return { editorial, render };
  }
}
