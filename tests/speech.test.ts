import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { speechAnalysisSchema } from '../packages/media/src/speech.js';

test('Whisper word normalization preserves unaligned tokens and rejects invalid times', async () => {
  await promisify(execFile)('python3', [
    '-m',
    'unittest',
    'discover',
    '-s',
    'python',
    '-p',
    'test_media_worker.py',
  ]);
  assert.throws(() =>
    speechAnalysisSchema.parse({
      transcript: [{ start: 0, end: 0, text: 'unlocated' }],
      unalignedWords: [],
    }),
  );
  assert.throws(() =>
    speechAnalysisSchema.parse({
      transcript: [{ start: 2, end: 1, text: 'backwards' }],
      unalignedWords: [],
    }),
  );
});
