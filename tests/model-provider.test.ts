import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveModelConfiguration,
  modelSummary,
  modelEnvironment,
  loadProjectEnv,
  modelRequestFailure,
} from '../packages/infrastructure/src/model-provider.js';

test('model billing errors are actionable without misclassifying other provider failures', () => {
  for (const body of [
    { type: 'insufficient_balance_error', message: 'Insufficient Balance (request_id: fixture)' },
    { error: { type: 'insufficient_balance_error', message: 'Insufficient Balance' } },
  ]) {
    const error = modelRequestFailure(`402: ${JSON.stringify(body)}`);
    assert.equal(error.code, 'MODEL_BALANCE');
    assert.match(error.message, /充值后可恢复/);
    assert.deepEqual(error.details, { status: 402 });
  }
  for (const message of [
    '401: {"message":"Invalid credentials"}',
    '429: {"message":"Insufficient Balance"}',
    '402: {"message":"Payment plan required"}',
    '402: invalid response',
    'An observation mentions 402: Insufficient Balance',
  ])
    assert.equal(modelRequestFailure(message).code, 'AGENT_FAILED');
});

test('one DeepSeek key configures the official endpoint, model alias, and pi worker credentials', () => {
  const config = resolveModelConfiguration({
    DEEPSEEK_API_KEY: 'fake-deepseek-key',
    ANTHROPIC_API_KEY: 'unrelated',
  });
  assert.equal(config.provider, 'deepseek');
  assert.equal(config.model, 'deepseek-flash');
  assert.equal(config.baseUrl, 'https://api.deepseek.com');
  const env = modelEnvironment(config);
  assert.deepEqual(env, { FILMEDIT_WORKER_API_KEY: 'fake-deepseek-key' });
  assert.ok(!JSON.stringify(modelSummary(config)).includes('fake-deepseek-key'));
  for (const name of ['deepseek-flash-v4.1', 'deepseek-v4.1-flash', 'deepseek-flash'])
    assert.equal(
      resolveModelConfiguration({ FILMEDIT_PROVIDER: 'deepseek', FILMEDIT_MODEL: name }).model,
      'deepseek-flash',
    );
});
test('explicit provider, endpoint and model overrides remain available without credential crossover', () => {
  const anthropic = resolveModelConfiguration({
    FILMEDIT_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'claude-key',
    DEEPSEEK_API_KEY: 'deepseek-key',
  });
  assert.equal(anthropic.model, 'claude-sonnet-4-6');
  assert.deepEqual(modelEnvironment(anthropic), { FILMEDIT_WORKER_API_KEY: 'claude-key' });
  assert.equal(resolveModelConfiguration({ ANTHROPIC_API_KEY: 'existing-key' }).provider, 'anthropic');
  assert.throws(
    () =>
      modelEnvironment(
        resolveModelConfiguration({ FILMEDIT_PROVIDER: 'deepseek', ANTHROPIC_API_KEY: 'wrong-provider' }),
      ),
    { code: 'AGENT_CREDENTIALS' },
  );
  assert.equal(
    resolveModelConfiguration({
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:1234/anthropic',
      FILMEDIT_MODEL: 'explicit-model',
    }).model,
    'explicit-model',
  );
  for (const endpoint of [
    'http://example.com',
    'https://key:secret@example.com',
    'https://example.com?api_key=x',
  ])
    assert.throws(() => resolveModelConfiguration({ DEEPSEEK_BASE_URL: endpoint }), { code: 'MODEL_CONFIG' });
});
test('project .env is optional, parsed as data, and does not override exported environment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'filmedit-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { FILMEDIT_MODEL: 'explicit' };
  await loadProjectEnv(root, env);
  await writeFile(
    path.join(root, '.env'),
    'DEEPSEEK_API_KEY="fake-key"\nFILMEDIT_MODEL=deepseek-flash-v4.1\n',
  );
  await loadProjectEnv(root, env);
  assert.equal(env.DEEPSEEK_API_KEY, 'fake-key');
  assert.equal(env.FILMEDIT_MODEL, 'explicit');
});
