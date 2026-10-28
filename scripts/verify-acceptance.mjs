// Re-evaluate the requirement representation in an isolated acceptance workspace.
// This does not accept a video, alter its prompt or invent source evidence.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Store } from '../packages/infrastructure/src/store.ts';
import { loadProjectEnv } from '../packages/infrastructure/src/model-provider.ts';
import { TaskRunner } from '../packages/application/src/workflow.ts';
import { compileAcceptance } from '../packages/application/src/acceptance.ts';
import { errorInfo } from '../packages/core/src/util.ts';

await loadProjectEnv();
const home = path.resolve('.filmedit/verification/product-20261023/real-a4b');
const store = new Store(home),
  task = store.tasks()[0];
if (!task) throw new Error('A4b isolated sample is required');
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
const runner = new TaskRunner(store, task.id, controller.signal);
const lease = `acceptance_verification_${process.pid}`;
if (!store.acquireLease(`task:${task.id}`, lease)) throw new Error('Sample is already running');
const heartbeat = setInterval(() => store.acquireLease(`task:${task.id}`, lease), 30000);
heartbeat.unref();
const output = { taskId: task.id, diagnosticOnly: true, videoAccepted: false };
try {
  const brief = store.artifact(task.id, 'creative.brief')?.data;
  if (!brief) throw new Error('Frozen creative brief is required');
  console.log(JSON.stringify({ taskId: task.id, phase: 'compile' }));
  output.compiled = await compileAcceptance(store, task.id, runner.agent, brief, controller.signal);
  console.log(
    JSON.stringify({
      compiledSources: output.compiled.sources.length,
      checks: output.compiled.plan.sources.reduce((n, s) => n + s.checks.length, 0),
    }),
  );
} catch (error) {
  output.error = errorInfo(error);
  console.log(JSON.stringify(output.error));
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  store.releaseLease(`task:${task.id}`, lease);
  await runner.flushArtifacts();
  await writeFile(path.join(home, 'acceptance-compilation-v5.json'), JSON.stringify(output, null, 2));
  store.close();
}
