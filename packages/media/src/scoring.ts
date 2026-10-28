import { z } from 'zod';
import { ProcessRunner, projectRoot } from '../../infrastructure/src/process.js';
import { modelEnvironment, modelRoots } from './assets.js';
import { FilmError, hash, invariant } from '../../core/src/util.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

export type SemanticPair = { premise: string; hypothesis: string };
export interface SimilarityModel {
  readonly version: string;
  compare(pairs: SemanticPair[]): Promise<{ similarity: number }[]>;
}
/** Retrieval only. Embedding similarity is never an acceptance decision. */
export class PythonEmbeddingModel implements SimilarityModel {
  readonly version = 'bge-retrieval-v1';
  constructor(readonly runner: ProcessRunner) {}
  async compare(pairs: SemanticPair[]) {
    if (!pairs.length) return [];
    invariant(
      process.env.FILMEDIT_MODEL_DIR,
      'MODEL_REQUIRED',
      'Configure the local embedding model for culture retrieval',
    );
    const output = await this.runner.run(
      process.env.FILMEDIT_PYTHON ?? 'python3',
      [path.join(projectRoot, 'python', 'embedding_worker.py')],
      {
        input: JSON.stringify({ pairs }),
        extraReads: modelRoots(),
        env: modelEnvironment(),
        timeoutMs: 900000,
      },
    );
    const rows = z
      .array(z.object({ similarity: z.number().min(-1).max(1) }))
      .parse(JSON.parse(output.stdout));
    invariant(rows.length === pairs.length, 'MODEL_OUTPUT', 'Embedding result count mismatch');
    return rows;
  }
}
export type SemanticResult = {
  similarity: number;
  entailment: number;
  contradiction: number;
  neutral: number;
  inputTooLong?: boolean;
  inputTokens?: number;
  maxInputTokens?: number;
};
export interface SemanticModel {
  readonly version: string;
  compare(pairs: SemanticPair[]): Promise<SemanticResult[]>;
}
const resultSchema = z.object({
  similarity: z.number().min(-1).max(1),
  entailment: z.number().min(0).max(1),
  contradiction: z.number().min(0).max(1),
  neutral: z.number().min(0).max(1),
  inputTooLong: z.boolean().optional(),
  inputTokens: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
});
export class PythonSemanticModel implements SemanticModel {
  readonly version: string;
  private constructor(
    readonly runner: ProcessRunner,
    manifest: unknown,
  ) {
    this.version = `bge-m3-xnli-cpu-v2:no-truncation:${hash(manifest)}`;
  }
  static async create(runner: ProcessRunner) {
    invariant(
      process.env.FILMEDIT_MODEL_DIR,
      'MODEL_REQUIRED',
      '本地语义评分模型尚未配置（与 DeepSeek API 无关）。请按 README「本地模型」初始化，并在 .env 中设置 FILMEDIT_MODEL_DIR 和 FILMEDIT_PYTHON。',
    );
    const manifestPath = path.join(process.env.FILMEDIT_MODEL_DIR, 'manifest.json');
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new FilmError(
            'MODEL_REQUIRED',
            `本地模型尚未下载完成：${manifestPath} 不存在。请完成 python/provision_models.py 初始化后恢复任务。`,
          );
        throw error;
      }),
    );
    invariant(
      manifest.embedding?.revision && manifest.nli?.revision,
      'MODEL_REQUIRED',
      '本地语义评分模型尚未下载完整：manifest.json 必须包含 embedding 和 nli 的固定版本。请重新执行 python/provision_models.py 继续下载。',
    );
    return new PythonSemanticModel(runner, { embedding: manifest.embedding, nli: manifest.nli });
  }
  async compare(pairs: SemanticPair[]) {
    if (!pairs.length) return [];
    const output = await this.runner.run(
      process.env.FILMEDIT_PYTHON ?? 'python3',
      [path.join(projectRoot, 'python', 'semantic_worker.py')],
      {
        input: JSON.stringify({ pairs }),
        extraReads: modelRoots(),
        env: modelEnvironment(),
        timeoutMs: 900000,
      },
    );
    const values = z.array(resultSchema).parse(JSON.parse(output.stdout));
    invariant(values.length === pairs.length, 'MODEL_OUTPUT', 'Semantic result count mismatch');
    return values;
  }
}
