import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,100}$/);
const text = z.string().min(1).max(4000);
export const dimensions = ['theme', 'content', 'expression'] as const;
export const fields = {
  theme: ['subject', 'question'],
  content: ['synopsis', 'narration'],
  expression: ['angle', 'persona', 'audience', 'tone', 'music', 'editing'],
} as const;
export const constraintSchema = z
  .object({
    id,
    dimension: z.enum(dimensions),
    field: z.string().min(1),
    value: z.string().max(20000),
    strength: z.enum(['fixed', 'preferred', 'open']),
    match: z.enum(['exact', 'semantic']),
    polarity: z.enum(['require', 'forbid']),
    modality: z.enum(['any', 'visual', 'audio', 'text']),
    source: z.enum(['prompt', 'structured', 'inferred']),
    quote: z.string().max(20000),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      !c.value &&
      !(
        c.dimension === 'content' &&
        c.field === 'narration' &&
        c.match === 'exact' &&
        c.polarity === 'require'
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Only exact empty narration may have an empty value' });
    if (c.field !== '*' && !(fields[c.dimension] as readonly string[]).includes(c.field))
      ctx.addIssue({ code: 'custom', message: `Invalid field ${c.dimension}.${c.field}` });
    if (c.source === 'inferred' && c.strength === 'fixed')
      ctx.addIssue({ code: 'custom', message: 'Inferences cannot become fixed user requirements' });
  });
export type IntentConstraint = z.infer<typeof constraintSchema>;
export const creativeOptionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    seed: z.string().min(1).max(100).optional(),
    batchSize: z.number().int().min(1).max(8).default(4),
    knowledge: z.enum(['local', 'web']).default('web'),
    constraints: z.array(constraintSchema).max(100).default([]),
  })
  .strict();
export const intentSchema = z
  .object({
    schemaVersion: z.literal(1),
    constraints: z.array(constraintSchema).max(100),
    openQuestions: z.array(z.string()).max(30),
    technical: z
      .array(
        z
          .object({
            kind: z.enum([
              'duration',
              'silent',
              'no_narration',
              'no_music',
              'narration_only',
              'no_sfx',
              'no_subtitles',
              'no_added_text',
              'preserve_frame',
              'landscape',
              'portrait',
              'local_materials',
              'source_grounded',
            ]),
            value: z.union([z.number().positive(), z.literal(true)]),
            quote: z.string().min(1),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type IntentSpec = z.infer<typeof intentSchema>;
export const operators = [
  {
    id: 'context_transfer',
    changes: ['content', 'expression'],
    description: '把角色或事物迁移到不同语境，建立可理解的联系',
  },
  { id: 'role_inversion', changes: ['content'], description: '交换人物的叙事功能，保留人物身份约束' },
  { id: 'tonal_contrast', changes: ['expression'], description: '通过情绪、声音、节奏反差重新解释画面' },
  {
    id: 'narrative_grafting',
    changes: ['content', 'expression'],
    description: '把一种叙事结构迁移到另一组事件',
  },
  { id: 'semantic_mutation', changes: ['content'], description: '改写熟悉台词；禁止修改精确保留的原文' },
  { id: 'visual_analogy', changes: ['expression'], description: '以动作、构图或剪辑建立视觉类比' },
] as const;
export const conceptSchema = z
  .object({
    id,
    proposal: z
      .object({
        theme: z.object({ subject: text, question: z.string() }).strict(),
        content: z.object({ synopsis: text, narration: z.string().max(20000) }).strict(),
        expression: z
          .object({
            angle: text,
            persona: text,
            audience: text,
            tone: text,
            music: z.string(),
            editing: text,
          })
          .strict(),
      })
      .strict(),
    operators: z.array(
      z.enum([
        'context_transfer',
        'role_inversion',
        'tonal_contrast',
        'narrative_grafting',
        'semantic_mutation',
        'visual_analogy',
      ]),
    ),
    knowledgeIds: z.array(id),
    bridge: text,
    surprise: z.string(),
    emotion: text,
    beats: z
      .array(
        z
          .object({
            id,
            action: text,
            visual: text,
            audio: z.string(),
            assetIds: z.array(id),
          })
          .strict(),
      )
      .min(1)
      .max(24),
    commitments: z
      .array(
        z
          .object({
            id,
            text,
            modality: z.enum(['visual', 'audio', 'text', 'any']),
            stage: z.enum(['editorial', 'render']),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    uncertainties: z.array(z.string()).max(30),
  })
  .strict();
export type ConceptIR = z.infer<typeof conceptSchema>;
export const conceptsSchema = z.object({ candidates: z.array(conceptSchema).min(1).max(8) }).strict();
export const conceptReviewSchema = z
  .object({
    understood: text,
    connection: text,
    understandable: z.boolean(),
    feasible: z.boolean(),
    emotion: z.string(),
    issues: z.array(z.object({ severity: z.enum(['blocking', 'warning']), message: text })).max(30),
  })
  .strict();
export type ConceptReview = z.infer<typeof conceptReviewSchema>;

// Desired material, not proof that it already exists. Real bindings belong to EditorialIR.
export type CreativeMaterialRequirements = {
  schemaVersion: 1;
  conceptId: string;
  beats: {
    beatId: string;
    action: string;
    visualQuery: string;
    audioQuery: string;
    candidateAssetIds: string[];
  }[];
  musicQuery: string;
};

export const cultureSourceSchema = z
  .object({
    id,
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), 'HTTPS source required'),
    title: text,
    excerpt: text,
    observedAt: z.string().datetime(),
  })
  .strict();
export const cultureEntitySchema = z
  .object({
    id,
    name: text,
    kind: z.enum(['meme', 'person', 'character', 'work', 'music', 'phrase', 'situation']),
    description: text,
    audience: z.string(),
    context: z.string(),
    tags: z.array(z.string()).max(30),
    provenance: z.enum(['source_narrative', 'inferred', 'creative_hypothesis']),
    sourceIds: z.array(id),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export const cultureRelationSchema = z
  .object({
    from: id,
    to: id,
    relation: text,
    sourceIds: z.array(id),
    provenance: z.enum(['source_narrative', 'inferred', 'creative_hypothesis']),
  })
  .strict();
export const cultureBundleSchema = z
  .object({
    sources: z.array(cultureSourceSchema).max(30),
    entities: z.array(cultureEntitySchema).max(40),
    relations: z.array(cultureRelationSchema).max(80),
  })
  .strict();
export type CultureBundle = z.infer<typeof cultureBundleSchema>;
export type CreativeBrief = {
  schemaVersion: 1;
  intent: IntentSpec;
  concept: ConceptIR;
  seed: string;
  round: number;
  knowledgeHash: string;
  materialIds?: string[];
  operatorVersion: string;
  tasteVersion: string;
  selection: { id: string; weight: number; probability: number }[];
};
export const preferenceSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    left: id,
    right: id,
    choice: z.enum(['left', 'right', 'both_bad', 'incomparable']),
    level: z.enum(['concept', 'sample', 'final']),
    audience: z.string().max(200).default('default'),
    comment: z.string().max(4000).default(''),
  })
  .strict();
export const preferenceLabels = {
  left: '更喜欢 A',
  right: '更喜欢 B',
  both_bad: '都不好',
  incomparable: '无法比较',
} as const;
export type ConceptPreference = z.output<typeof preferenceSchema> & { id: string };
export type ConceptComparison = {
  taskId: string;
  taskVersion: number;
  left: ConceptIR;
  right: ConceptIR;
  previous: ConceptPreference | null;
};
