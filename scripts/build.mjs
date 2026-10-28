import { rm, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await rm('dist', { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
await writeFile('dist/cli.js', "#!/usr/bin/env node\nimport './apps/cli/src/cli.js';\n");
await chmod('dist/cli.js', 0o755);
