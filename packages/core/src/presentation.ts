import { z } from 'zod';
import type { Asset, RenderIR } from './domain.js';
import { invariant } from './util.js';
import { resolveBoxes } from './layout.js';

export const aspectRatios = { '16:9': [16, 9], '4:3': [4, 3], '9:16': [9, 16], '1:1': [1, 1] } as const;
const ratio = z.string().regex(/^[1-9][0-9]{0,2}:[1-9][0-9]{0,2}$/);
const ratioParts = (value: string): [number, number] => {
  const [w, h] = value.split(':').map(Number);
  return [w!, h!];
};
const dimension = z
  .number()
  .int()
  .min(128)
  .max(4096)
  .refine((n) => n % 2 === 0, 'H.264 dimensions must be even');
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
export const exportProfileInputSchema = z
  .object({
    aspectRatio: ratio.optional(),
    width: dimension.optional(),
    height: dimension.optional(),
    fps: z.number().int().min(1).max(60).default(30),
    fit: z.enum(['contain', 'cover']).default('contain'),
    background: color.default('#000000'),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.aspectRatio && (v.width === undefined) !== (v.height === undefined))
      ctx.addIssue({ code: 'custom', message: 'Provide both width and height, or an aspectRatio' });
    if (v.aspectRatio && v.width && v.height) {
      const [w, h] = ratioParts(v.aspectRatio);
      if (Math.abs(v.width / v.height - w / h) > 2 / v.height)
        ctx.addIssue({ code: 'custom', message: 'Dimensions conflict with aspectRatio' });
    }
  });
export type ExportProfileInput = z.input<typeof exportProfileInputSchema>;
export type ExportProfile = {
  width: number;
  height: number;
  fps: number;
  fit: 'contain' | 'cover';
  background: string;
};

/** Export policy, independent of content geometry and editorial duration. */
export function resolveExport(input: ExportProfileInput = {}, fallback?: RenderIR['canvas']): ExportProfile {
  const v = exportProfileInputSchema.parse(input);
  const [rw, rh] = v.aspectRatio ? ratioParts(v.aspectRatio) : [0, 0];
  const even = (n: number) => Math.round(n / 2) * 2;
  let width = v.width,
    height = v.height;
  if (v.aspectRatio) {
    if (width && !height) height = even((width * rh) / rw);
    else if (height && !width) width = even((height * rw) / rh);
    else if (!width && !height) {
      height = rh > rw ? 1920 : 1080;
      width = even((height * rw) / rh);
    }
  }
  width ??= fallback?.width ?? 1080;
  height ??= fallback?.height ?? 1920;
  dimension.parse(width);
  dimension.parse(height);
  return { width, height, fps: input.fps ?? fallback?.fps ?? v.fps, fit: v.fit, background: v.background };
}

export const compositionSchema = z
  .object({
    aspectRatio: z.union([ratio, z.literal('auto')]).default('auto'),
    width: dimension.optional(),
    height: dimension.optional(),
    fps: z.number().int().min(1).max(60).default(30),
    mediaFit: z.enum(['contain', 'cover']).default('contain'),
    background: color.default('#000000'),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.width === undefined) !== (v.height === undefined))
      ctx.addIssue({ code: 'custom', message: 'Composition width and height must be specified together' });
    if (v.width && v.height && v.aspectRatio !== 'auto') {
      const [w, h] = ratioParts(v.aspectRatio);
      if (Math.abs(v.width / v.height - w / h) > 2 / v.height)
        ctx.addIssue({ code: 'custom', message: 'Composition dimensions conflict with aspectRatio' });
    }
  });
export type CompositionPolicy = z.output<typeof compositionSchema>;
export function resolveComposition(policy: CompositionPolicy, assets: Asset[]): RenderIR['canvas'] {
  if (policy.width && policy.height)
    return { width: policy.width, height: policy.height, fps: policy.fps, background: policy.background };
  let selected = policy.aspectRatio;
  if (selected === 'auto') {
    const weights = Object.fromEntries(Object.keys(aspectRatios).map((k) => [k, 0]));
    for (const asset of assets) {
      if (!asset.width || !asset.height || !['video', 'image'].includes(asset.kind)) continue;
      const nearest = Object.entries(aspectRatios).sort(
        ([, a], [, b]) =>
          Math.abs(Math.log(asset.width! / asset.height! / (a[0] / a[1]))) -
          Math.abs(Math.log(asset.width! / asset.height! / (b[0] / b[1]))),
      )[0]![0];
      weights[nearest]! += asset.kind === 'image' ? 5 : Math.min(asset.duration, 90);
    }
    selected = (Object.entries(weights).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      '16:9') as keyof typeof aspectRatios;
  }
  const result = resolveExport({ aspectRatio: selected, fps: policy.fps, background: policy.background });
  return { width: result.width, height: result.height, fps: policy.fps, background: policy.background };
}

/** Pure geometry: contain preserves all content; cover is an explicit, measurable crop. */
export function projectCanvas(canvas: { width: number; height: number }, profile: ExportProfile) {
  const scale = (profile.fit === 'contain' ? Math.min : Math.max)(
    profile.width / canvas.width,
    profile.height / canvas.height,
  );
  const width = canvas.width * scale,
    height = canvas.height * scale;
  return {
    scale,
    x: (profile.width - width) / 2,
    y: (profile.height - height) / 2,
    width,
    height,
    retainedArea: Math.min(1, profile.width / width) * Math.min(1, profile.height / height),
  };
}
export function exportVideoFilter(profile: ExportProfile): string {
  const { width: w, height: h, fps, background } = profile;
  const scale = `scale=${w}:${h}:force_original_aspect_ratio=${profile.fit === 'contain' ? 'decrease' : 'increase'}:force_divisible_by=2`;
  return [
    scale,
    profile.fit === 'contain' ? `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${background}` : `crop=${w}:${h}`,
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p',
  ].join(',');
}

export function validateComposition(render: RenderIR, canvas: RenderIR['canvas'], policy: CompositionPolicy) {
  invariant(
    render.canvas.width === canvas.width &&
      render.canvas.height === canvas.height &&
      render.canvas.fps === canvas.fps,
    'IR_COMPOSITION',
    'Layout cannot change the frozen composition canvas; export settings are separate',
  );
  if (policy.mediaFit === 'contain') {
    const boxes = resolveBoxes(render);
    const mediaAncestors = new Set<string>();
    for (const node of render.nodes.filter((n) => n.kind === 'media')) {
      invariant(
        node.fit === 'contain' && !node.crop,
        'IR_COMPOSITION',
        `Media ${node.id} must preserve its source; select composition.mediaFit=cover to permit cropping`,
      );
      mediaAncestors.add(node.id);
      let parent = node.parentId;
      while (parent) {
        mediaAncestors.add(parent);
        parent = render.nodes.find((n) => n.id === parent)?.parentId;
      }
    }
    for (const node of render.nodes.filter((n) => mediaAncestors.has(n.id))) {
      invariant(
        node.mask === 'none',
        'IR_COMPOSITION',
        `Mask of ${node.id} would crop content under contain policy`,
      );
      const box = boxes.get(node.id)!;
      const parent = node.parentId ? boxes.get(node.parentId)! : render.canvas;
      const frames = [{ x: 0, y: 0, scale: 1, rotation: 0 }, ...node.keyframes];
      for (const f of frames) {
        // Rotation can exceed endpoint bounds mid-tween; contain permits translation/uniform scale only.
        invariant(f.rotation === 0, 'IR_COMPOSITION', `Rotating ${node.id} requires explicit cover policy`);
        const w = box.width * f.scale,
          h = box.height * f.scale;
        const x = box.x + (box.width - w) / 2 + f.x,
          y = box.y + (box.height - h) / 2 + f.y;
        invariant(
          x >= -0.01 && y >= -0.01 && x + w <= parent.width + 0.01 && y + h <= parent.height + 0.01,
          'IR_COMPOSITION',
          `Transform of ${node.id} would crop content under contain policy`,
        );
      }
    }
  }
  return render;
}
