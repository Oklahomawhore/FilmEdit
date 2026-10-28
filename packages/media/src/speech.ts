import { z } from 'zod';

export const speechAnalysisSchema = z.object({
  transcript: z.array(
    z
      .object({ start: z.number().nonnegative(), end: z.number().positive(), text: z.string().min(1) })
      .refine((word) => word.end > word.start, 'Timed speech needs a nonempty interval'),
  ),
  // An unaligned token is uncertain recognition, not evidence of audible speech.
  unalignedWords: z.array(z.object({ time: z.number().nonnegative(), text: z.string().min(1) })),
});
