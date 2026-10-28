import test from 'node:test';
import assert from 'node:assert/strict';
import { editorialSchema } from '../packages/core/src/domain.js';
import { validateEditingTechniques } from '../packages/core/src/techniques.js';
import { asset, editorial } from './helpers.js';

test('cut labels require actual source discontinuity and beats in the audible timeline', () => {
  const edit = editorial();
  edit.shots[1]!.techniques = [{ id: 'jump_cut', version: 1, params: {} }];
  assert.doesNotThrow(() => validateEditingTechniques(edit, [asset]));
  edit.shots[1]!.sourceStart = 2;
  assert.throws(() => validateEditingTechniques(edit, [asset]), { code: 'TECHNIQUE_UNREALIZED' });
  edit.shots[1]!.techniques = [{ id: 'beat_cut', version: 1, params: {} }];
  const cut = editorialSchema.parse({
    ...edit,
    audio: [
      { id: 'music', assetId: asset.id, role: 'music', start: 0, sourceStart: 4, speed: 2, duration: 4 },
    ],
  });
  assert.doesNotThrow(() => validateEditingTechniques(cut, [{ ...asset, beats: [8] }]));
  for (const beats of [[], [2], [8.5]])
    assert.throws(() => validateEditingTechniques(cut, [{ ...asset, beats }]), {
      code: 'TECHNIQUE_UNREALIZED',
    });
});

test('J/L cuts preserve source sound synchronization and cannot be unrelated narration', () => {
  const edit = editorial();
  edit.shots[1]!.techniques = [{ id: 'j_cut', version: 1, params: {} }];
  const cut = editorialSchema.parse({
    ...edit,
    audio: [{ id: 'sound', assetId: asset.id, role: 'dialogue', start: 1.5, sourceStart: 4.5, duration: 2 }],
  });
  assert.doesNotThrow(() => validateEditingTechniques(cut, [asset]));
  cut.audio[0]!.sourceStart = 0;
  assert.throws(() => validateEditingTechniques(cut, [asset]), { code: 'TECHNIQUE_UNREALIZED' });
  cut.shots[1]!.techniques = [];
  cut.shots[0]!.techniques = [{ id: 'l_cut', version: 1, params: {} }];
  cut.audio[0]!.start = 0;
  cut.audio[0]!.duration = 2.5;
  assert.doesNotThrow(() => validateEditingTechniques(cut, [asset]));
  cut.audio[0]!.duration = 2;
  assert.throws(() => validateEditingTechniques(cut, [asset]), { code: 'TECHNIQUE_UNREALIZED' });
});
