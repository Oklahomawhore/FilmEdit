import type { Store } from '../../infrastructure/src/store.js';

const stages = ['creative', 'script', 'editorial', 'layout', 'render'] as const;

/** Current user inputs only; never recover superseded or explicitly invalidated instructions. */
export function readUserRevisions(store: Store, taskId: string) {
  return stages.flatMap((stage) => {
    const artifact = store.artifact(taskId, `${stage}.user_revision`);
    return artifact ? [{ stage, data: artifact.data }] : [];
  });
}

/** Recomputing derived work does not withdraw the user's current instructions. */
export function invalidateDerivedArtifacts(store: Store, taskId: string, prefixes: string[]) {
  return store.transaction(() => {
    const inputs = readUserRevisions(store, taskId).filter(({ stage }) =>
      prefixes.some((prefix) => `${stage}.user_revision`.startsWith(`${prefix}.`)),
    );
    store.invalidateFrom(taskId, prefixes);
    for (const input of inputs) store.saveArtifact(taskId, `${input.stage}.user_revision`, input.data, true);
  });
}

/** Replace evaluation policy without deleting the work being evaluated or its preview. */
export function reassessExistingWork(store: Store, taskId: string) {
  return store.transaction(() => {
    for (const stage of ['editorial', 'layout'] as const) {
      const previous = store.artifact(taskId, stage) ?? store.artifact(taskId, `${stage}.candidate`, false);
      store.invalidate(taskId, [stage]);
      // Feedback is normally read with accepted=false; clearing its flag alone would replay it.
      store.invalidateFrom(taskId, [`${stage}.feedback`, `${stage}.alignment`]);
      if (previous) {
        store.saveArtifact(taskId, `${stage}.candidate`, previous.data);
        store.saveArtifact(taskId, `${stage}.pending_assessment`, { candidateHash: previous.hash }, true);
      }
    }
    store.invalidate(taskId, ['render', 'manifest']);
    store.invalidateFrom(taskId, ['final.alignment']);
  });
}
