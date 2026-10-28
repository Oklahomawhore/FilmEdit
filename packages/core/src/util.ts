import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export class FilmError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function invariant(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new FilmError(code, message);
}
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value))
    .digest('hex');
export function errorInfo(error: unknown) {
  return error instanceof FilmError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
}
export const within = (root: string, candidate: string) =>
  candidate === root ||
  (!path.relative(root, candidate).startsWith(`..${path.sep}`) &&
    path.relative(root, candidate) !== '..' &&
    !path.isAbsolute(path.relative(root, candidate)));
export function checkAbort(signal?: AbortSignal) {
  signal?.throwIfAborted();
}
