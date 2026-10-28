import { z } from 'zod';
import type { EditorialIR } from '../../core/src/domain.js';

export function videoFilters(shot: EditorialIR['shots'][number]): string[] {
  const filters: string[] = [];
  if (shot.techniques.some((t) => t.id === 'reverse')) filters.push('reverse');
  const grade = shot.techniques.find((t) => t.id === 'grade');
  if (grade) {
    const p = z
      .object({
        brightness: z.number().min(-1).max(1).default(0),
        contrast: z.number().min(0).max(3).default(1),
        saturation: z.number().min(0).max(3).default(1),
      })
      .strict()
      .parse(grade.params);
    filters.push(`eq=brightness=${p.brightness}:contrast=${p.contrast}:saturation=${p.saturation}`);
  }
  const key = shot.techniques.find((t) => t.id === 'chromakey');
  if (key) {
    const p = z
      .object({
        color: z
          .string()
          .regex(/^0x[0-9a-fA-F]{6}$/)
          .default('0x00ff00'),
        similarity: z.number().min(0.01).max(1).default(0.1),
        blend: z.number().min(0).max(1).default(0.1),
      })
      .strict()
      .parse(key.params);
    filters.push(`format=rgba,colorkey=${p.color}:${p.similarity}:${p.blend}`);
  }
  return filters;
}
