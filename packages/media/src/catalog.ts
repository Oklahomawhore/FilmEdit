import path from 'node:path';
import { z } from 'zod';
import type { Asset } from '../../core/src/domain.js';
import type { AssetLibrary } from './assets.js';
import { invariant } from '../../core/src/util.js';

// Transport bounds, not task/agent budgets. Every omitted record has a continuation cursor.
export const MATERIAL_PAGE_BYTES = 16000;
export const catalogQuerySchema = z.object({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(40).default(20),
});
export const transcriptQuerySchema = z.object({
  start: z.number().nonnegative().default(0),
  end: z.number().positive().optional(),
  offset: z.number().int().nonnegative().default(0),
  textOffset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(80),
});
export function assetSummary(asset: Asset) {
  return {
    id: asset.id,
    title: (asset.source.title || path.basename(asset.source.path)).slice(0, 160),
    source: asset.source.kind,
    kind: asset.kind,
    duration: asset.duration,
    width: asset.width,
    height: asset.height,
    hasAudio: asset.hasAudio,
    transcriptSegments: asset.transcript.length,
    frameCount: asset.frames.length,
    sampledTimes: asset.frames.slice(0, 8).map((f) => f.time),
    beatCount: asset.beats.length,
  };
}
export function materialPage<T>(items: T[], offset: number, limit: number) {
  const page: T[] = [];
  let bytes = 512;
  for (const item of items.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    invariant(size + 512 <= MATERIAL_PAGE_BYTES, 'MATERIAL_ITEM_SIZE', 'Material summary is too large');
    if (bytes + size > MATERIAL_PAGE_BYTES) break;
    page.push(item);
    bytes += size;
  }
  const end = offset + page.length;
  return { items: page, total: items.length, offset, nextOffset: end < items.length ? end : null };
}
export async function materialCatalog(library: AssetLibrary, query: z.input<typeof catalogQuerySchema> = {}) {
  const { offset, limit } = catalogQuerySchema.parse(query);
  const page = materialPage(library.store.assets(library.taskId).map(assetSummary), offset, limit);
  // Cached metadata must not bypass current permissions or source-version validation.
  for (const item of page.items) await library.resolve(item.id);
  return page;
}
type TranscriptEntry = Asset['transcript'][number] & { bindingId?: string };
export function transcriptPage(
  entries: TranscriptEntry[],
  query: z.input<typeof transcriptQuerySchema> = {},
) {
  const { start, end, offset, textOffset, limit } = transcriptQuerySchema.parse(query);
  invariant(end === undefined || end > start, 'TRANSCRIPT_RANGE', 'end must be greater than start');
  const selected = entries.filter((e) => e.end > start && (end === undefined || e.start < end));
  invariant(offset <= selected.length, 'TRANSCRIPT_CURSOR', 'offset is outside the selected transcript');
  invariant(
    textOffset === 0 || (selected[offset] && textOffset < selected[offset]!.text.length),
    'TRANSCRIPT_CURSOR',
    'textOffset is outside the selected segment',
  );
  const items: (TranscriptEntry & { index: number; textOffset: number })[] = [];
  let index = offset,
    char = textOffset,
    bytes = 512;
  while (index < selected.length && items.length < limit) {
    const entry = selected[index]!;
    const text = entry.text.slice(char, char + 1000);
    const item = { ...entry, text, index, textOffset: char };
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > MATERIAL_PAGE_BYTES) break;
    items.push(item);
    bytes += size;
    char += text.length;
    if (char >= entry.text.length) {
      index++;
      char = 0;
    }
  }
  return {
    items,
    total: selected.length,
    start,
    end,
    next: index < selected.length ? { offset: index, textOffset: char } : null,
  };
}
