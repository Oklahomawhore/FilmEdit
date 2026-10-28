import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { projectRoot } from './process.js';
import { FilmError, invariant } from '../../core/src/util.js';

export type ModelProvider = 'deepseek' | 'anthropic';
export type ModelConfiguration = {
  provider: ModelProvider;
  requestedModel: string;
  model: string;
  baseUrl: string;
  apiKey: string;
};

/** Classify the SDK's provider response after credentials have been redacted. */
export function modelRequestFailure(message: string): FilmError {
  const response = /^402:\s*(.+)$/s.exec(message);
  if (response) {
    let body;
    try {
      body = JSON.parse(response[1]!);
    } catch {
      // An unrecognized response remains an execution failure, never a candidate defect.
    }
    const error = body?.error ?? body;
    if (error?.type === 'insufficient_balance_error' || /^Insufficient Balance\b/i.test(error?.message ?? ''))
      return new FilmError('MODEL_BALANCE', '模型服务余额不足。已保留当前产物和检查点，充值后可恢复。', {
        status: 402,
      });
  }
  return new FilmError('AGENT_FAILED', message);
}

/** Read only this installation's explicit configuration, never a material directory's .env. */
export async function loadProjectEnv(root = projectRoot, env: NodeJS.ProcessEnv = process.env) {
  try {
    const values = parseEnv(await readFile(path.join(root, '.env'), 'utf8'));
    for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function resolveModelConfiguration(env: NodeJS.ProcessEnv = process.env): ModelConfiguration {
  const value = (name: string) => env[name]?.trim() || undefined;
  const provider =
    value('FILMEDIT_PROVIDER') ??
    (value('DEEPSEEK_API_KEY') ? 'deepseek' : value('ANTHROPIC_API_KEY') ? 'anthropic' : 'deepseek');
  invariant(
    provider === 'deepseek' || provider === 'anthropic',
    'MODEL_CONFIG',
    'FILMEDIT_PROVIDER must be deepseek or anthropic',
  );
  const requestedModel =
    value('FILMEDIT_MODEL') ?? (provider === 'deepseek' ? 'deepseek-flash-v4.1' : 'claude-sonnet-4-6');
  // The release name is not an official API identifier. Do not silently substitute another model family.
  const aliases = new Set(['deepseek-flash-v4.1', 'deepseek-v4.1-flash']);
  const model = provider === 'deepseek' && aliases.has(requestedModel) ? 'deepseek-flash' : requestedModel;
  const endpoint =
    value(provider === 'deepseek' ? 'DEEPSEEK_BASE_URL' : 'ANTHROPIC_BASE_URL') ??
    (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.anthropic.com');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid model API base URL');
  }
  invariant(
    !url.username && !url.password && !url.search && !url.hash,
    'MODEL_CONFIG',
    'Model API URL must not contain credentials, query parameters or a fragment',
  );
  invariant(
    url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)),
    'MODEL_CONFIG',
    'Model API requires HTTPS, except for local integration tests',
  );
  return {
    provider,
    requestedModel,
    model,
    // Migrate the former SDK endpoint; a custom /anthropic endpoint is also an explicit protocol alias.
    baseUrl: url
      .toString()
      .replace(/\/$/, '')
      .replace(provider === 'deepseek' ? /\/anthropic$/ : /$^/, ''),
    apiKey: value(provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY') ?? '',
  };
}

export function modelSummary(config: ModelConfiguration) {
  const { apiKey, ...summary } = config;
  return { ...summary, credentialConfigured: Boolean(apiKey) };
}
export function requireModelCredentials(config: ModelConfiguration) {
  invariant(
    config.apiKey,
    'AGENT_CREDENTIALS',
    `Fill ${config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY'} in the project .env before running agents`,
  );
}
export function modelEnvironment(config: ModelConfiguration): NodeJS.ProcessEnv {
  requireModelCredentials(config);
  return {
    FILMEDIT_WORKER_API_KEY: config.apiKey,
  };
}
