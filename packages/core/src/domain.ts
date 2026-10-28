import { z } from 'zod';
import { compositionSchema, exportProfileInputSchema, resolveExport } from './presentation.js';
import { creativeOptionsSchema } from './creative-domain.js';

const finite = z.number().finite();
const positive = finite.positive();
const nonnegative = finite.nonnegative();
export const ID = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,100}$/);
export const accessSchema = z
  .object({
    readPaths: z.array(z.string()).default([]),
    writePaths: z.array(z.string()).default([]),
    denyPaths: z.array(z.string()).default([]),
  })
  .strict();
// null is persisted as "unlimited"; Infinity cannot survive JSON/SQLite round trips.
export const budgetsSchema = z
  .object({
    stageRounds: z.number().int().positive().nullable().default(null),
    renderRounds: z.number().int().positive().nullable().default(null),
    agentTurns: z.number().int().positive().nullable().default(null),
    usd: positive.nullable().default(null),
  })
  .strict();
export const taskInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(20000),
    accountId: ID.optional(),
    materials: z
      .object({
        paths: z.array(z.string()).default([]),
        strategy: z.enum(['local_only', 'local_first', 'web_first']).default('local_first'),
      })
      .strict()
      .prefault({}),
    access: accessSchema.prefault({}),
    composition: compositionSchema.prefault({}),
    creative: creativeOptionsSchema.prefault({}),
    output: exportProfileInputSchema
      .safeExtend({
        duration: positive.max(600).default(60),
      })
      .transform(({ duration, ...profile }) => ({ ...resolveExport(profile), duration }))
      .prefault({}),
    budgets: budgetsSchema.prefault({}),
  })
  .strict();
export type TaskInput = z.input<typeof taskInputSchema>;
export type TaskSpec = z.output<typeof taskInputSchema>;
export const sourceSchema = z
  .object({
    kind: z.enum(['local', 'web', 'generated']),
    path: z.string(),
    url: z.string().optional(),
    title: z.string().optional(),
    license: z.string().optional(),
    parentAssetId: ID.optional(),
    libraryAssetId: ID.optional(),
  })
  .strict();
export const assetSchema = z
  .object({
    id: ID,
    taskId: ID,
    source: sourceSchema,
    sha256: z.string().length(64),
    size: nonnegative,
    kind: z.enum(['video', 'audio', 'image', 'subtitle']),
    duration: nonnegative,
    width: nonnegative.optional(),
    height: nonnegative.optional(),
    hasAudio: z.boolean(),
    transcript: z.array(z.object({ start: nonnegative, end: positive, text: z.string() })).default([]),
    frames: z.array(z.object({ time: nonnegative, path: z.string() })).default([]),
    beats: z.array(nonnegative).default([]),
    analyzed: z.object({ asr: z.boolean().optional(), beats: z.boolean().optional() }).optional(),
    policyVersion: z.string(),
    analysisVersion: z.string().default('1'),
  })
  .strict();
export type Asset = z.infer<typeof assetSchema>;
export const scriptSchema = z
  .object({
    title: z.string(),
    topic: z.string(),
    angle: z.string(),
    personaId: z.string(),
    narration: z.string(),
    beats: z
      .array(z.object({ id: ID, text: z.string(), visualQuery: z.string(), durationHint: positive }))
      .min(1),
    facts: z.array(z.object({ claim: z.string(), url: z.string().url(), excerpt: z.string() })).default([]),
  })
  .strict();
export type Script = z.infer<typeof scriptSchema>;
export const reviewSchema = z
  .object({
    passed: z.boolean(),
    issues: z.array(
      z.object({ severity: z.enum(['blocking', 'warning']), message: z.string(), evidence: z.string() }),
    ),
  })
  .strict();
export type Review = z.infer<typeof reviewSchema>;
export const techniqueRef = z
  .object({
    id: ID,
    version: z.number().int().positive(),
    params: z.record(z.string(), z.union([z.string(), finite, z.boolean()])).default({}),
  })
  .strict();
const interval = { start: nonnegative, duration: positive };
export const editorialSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    duration: positive,
    shots: z
      .array(
        z
          .object({
            id: ID,
            assetId: ID,
            track: z.number().int().nonnegative().default(0),
            sourceStart: nonnegative,
            ...interval,
            speed: positive.max(10).default(1),
            techniques: z.array(techniqueRef).default([]),
          })
          .strict(),
      )
      .min(1),
    transitions: z
      .array(
        z
          .object({ from: ID, to: ID, kind: z.enum(['cut', 'fade', 'wipe', 'slide']), duration: nonnegative })
          .strict(),
      )
      .default([]),
    audio: z
      .array(
        z
          .object({
            id: ID,
            assetId: ID,
            role: z.enum(['narration', 'dialogue', 'music', 'ambience', 'effect']),
            sourceStart: nonnegative,
            ...interval,
            speed: positive.max(10).default(1),
            volume: nonnegative.max(4).default(1),
            fadeIn: nonnegative.default(0),
            fadeOut: nonnegative.default(0),
            duck: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
    text: z
      .array(
        z
          .object({
            id: ID,
            text: z.string().min(1),
            ...interval,
            role: z.enum(['subtitle', 'title', 'label']),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type EditorialIR = z.infer<typeof editorialSchema>;
const unit = nonnegative.max(1);
const normalizedSize = positive.max(1);
const rect = z
  .tuple([unit, unit, normalizedSize, normalizedSize])
  .describe('Normalized [x,y,width,height] relative to parent/source, not pixels; full frame is [0,0,1,1].');
const placementSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('rect'), rect }).strict(),
  z
    .object({
      mode: z.literal('anchor'),
      anchor: z.enum([
        'top-left',
        'top',
        'top-right',
        'left',
        'center',
        'right',
        'bottom-left',
        'bottom',
        'bottom-right',
      ]),
      size: z.tuple([normalizedSize, normalizedSize]).describe('Fraction of parent width and height.'),
      offset: z.tuple([finite.min(-1).max(1), finite.min(-1).max(1)]),
    })
    .strict(),
]);
export const renderSchema = z
  .object({
    schemaVersion: z.literal(1),
    editorialHash: z.string().length(64),
    animationTimebase: z.enum(['timeline', 'binding']).default('timeline'),
    canvas: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        fps: z.number().int().positive(),
        background: z
          .string()
          .regex(/^#[a-fA-F0-9]{6}$/)
          .default('#000000'),
      })
      .strict(),
    nodes: z
      .array(
        z
          .object({
            id: ID,
            parentId: ID.optional(),
            bindingId: ID.optional(),
            kind: z.enum(['media', 'text', 'group']),
            placement: placementSchema,
            z: z.number().int().default(0),
            opacity: nonnegative.max(1).default(1),
            fit: z.enum(['cover', 'contain', 'fill']).default('cover'),
            crop: rect.optional(),
            mask: z.enum(['none', 'circle', 'rounded']).default('none'),
            style: z
              .object({
                fontFamily: z.enum(['sans-serif', 'serif', 'monospace']).default('sans-serif'),
                fontSize: positive.default(52),
                color: z
                  .string()
                  .regex(/^#[a-fA-F0-9]{6}$/)
                  .default('#ffffff'),
                background: z
                  .string()
                  .regex(/^#[a-fA-F0-9]{6}$/)
                  .optional(),
                align: z.enum(['left', 'center', 'right']).default('center'),
                lineHeight: positive.default(1.3),
              })
              .strict()
              .optional(),
            keyframes: z
              .array(
                z
                  .object({
                    time: nonnegative,
                    x: finite.default(0),
                    y: finite.default(0),
                    scale: positive.default(1),
                    rotation: finite.default(0),
                    opacity: nonnegative.max(1).default(1),
                  })
                  .strict(),
              )
              .default([]),
            techniques: z.array(techniqueRef).default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type RenderIR = z.infer<typeof renderSchema>;
export const evidenceSchema = z
  .object({
    id: ID,
    bindingId: ID,
    start: nonnegative,
    end: nonnegative,
    modality: z.enum(['visual', 'audio', 'text']),
    observation: z.string().min(1).max(300),
    entityId: ID.nullable()
      .default(null)
      .describe(
        'Report-local identity of the single subject of this observation. Null for unknown identity, multiple subjects, or scene-level observations. Never use a shot, track, or asset ID as an entity identity.',
      ),
  })
  .strict();
export const audienceSchema = z
  .object({
    summary: z.string(),
    claims: z.array(
      z
        .object({ text: z.string().min(1), evidenceIds: z.array(ID).min(1), confidence: nonnegative.max(1) })
        .strict(),
    ),
    events: z.array(
      z.object({ text: z.string(), at: nonnegative, evidenceIds: z.array(ID).min(1) }).strict(),
    ),
    relations: z.array(
      z.object({ cause: z.string(), effect: z.string(), evidenceIds: z.array(ID).min(1) }).strict(),
    ),
    quantities: z
      .array(
        z
          .object({
            subject: z.string().min(1),
            count: z.number().int().nonnegative(),
            evidenceIds: z.array(ID).min(1),
            confidence: nonnegative.max(1),
          })
          .strict(),
      )
      .default([]),
    emotionTimeline: z.array(
      z
        .object({ emotion: z.string(), start: nonnegative, end: positive, evidenceIds: z.array(ID).min(1) })
        .strict(),
    ),
    pacing: z.string(),
    ambiguities: z.array(z.string()),
    evidence: z.array(evidenceSchema),
    issues: z
      .array(
        z
          .object({
            kind: z.enum(['layout', 'narrative', 'technical']),
            severity: z.enum(['blocking', 'warning']),
            message: z.string(),
            bindingId: ID.optional(),
            time: nonnegative.optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type AudienceIR = z.infer<typeof audienceSchema>;
export const memorySchema = z
  .object({
    kind: z.enum([
      'setting',
      'feedback',
      'history',
      'experience',
      'topic',
      'angle',
      'persona',
      'technique',
      'inferred_preference',
    ]),
    content: z.string().min(1),
    tags: z.array(z.string()).default([]),
    provenance: z.enum(['user', 'fictional', 'source_narrative', 'inferred', 'system']),
    source: z.string().optional(),
    confidence: nonnegative.max(1).default(1),
  })
  .strict();
export type MemoryInput = z.infer<typeof memorySchema>;
export type Stage = 'creative' | 'script' | 'materials' | 'editorial' | 'layout' | 'render' | 'complete';
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'waiting_input'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'completed';
