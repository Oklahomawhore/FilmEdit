import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';

// This trusted launcher is outside learned releases. Never add an unsandboxed fallback.
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function main() {
  const payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString()) as {
    command: string;
    args: string[];
    settings: SandboxRuntimeConfig;
    browser?: boolean;
  };
  const taskTemporary = process.env.TMPDIR;
  if (!taskTemporary) throw new Error('Task temporary directory is required');
  // SRT creates Unix sockets using os.tmpdir(). Task paths can exceed macOS's
  // 104-byte sun_path, truncating distinct socket names into the same address.
  // Each trusted launcher owns a short, private IPC directory (mkdtemp: 0700).
  // Do not grant this directory to media/agent code or broaden task permissions.
  const ipcTemporary = await mkdtemp('/tmp/filmedit-srt-');
  process.env.TMPDIR = ipcTemporary;
  try {
    await SandboxManager.initialize(payload.settings);
    // Only the launcher uses the IPC directory. Child scratch files stay in the
    // task workspace, including when SRT supplies its own generic TMPDIR.
    const command = await SandboxManager.wrapWithSandbox(
      [
        '/usr/bin/env',
        `TMPDIR=${taskTemporary}`,
        `TMP=${taskTemporary}`,
        `TEMP=${taskTemporary}`,
        payload.command,
        ...payload.args,
      ]
        .map(quote)
        .join(' '),
    );
    let child;
    if (payload.browser && process.platform === 'darwin') {
      // Chromium registers a Mach rendezvous port for its child processes. SRT's
      // generic command profile does not grant registration. Extend only that IPC
      // namespace; retain the generated filesystem and network restrictions.
      const tokens: unknown[] = createRequire(import.meta.url)('shell-quote').parse(command);
      if (!tokens.every((t) => typeof t === 'string')) throw new Error('Unexpected sandbox command syntax');
      const argv = tokens as string[];
      const index = argv.indexOf('/usr/bin/sandbox-exec');
      if (index < 0 || argv[index + 1] !== '-p') throw new Error('Unsupported sandbox-runtime profile shape');
      argv[index + 2] +=
        '\n(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))\n(allow mach-lookup (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))';
      child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', env: process.env });
    } else child = spawn(command, { shell: '/bin/sh', stdio: 'inherit', env: process.env });
    const term = () => child.kill('SIGTERM');
    const interrupt = () => child.kill('SIGINT');
    process.on('SIGTERM', term);
    process.on('SIGINT', interrupt);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (value) => resolve(value ?? 1));
      });
    } finally {
      process.off('SIGTERM', term);
      process.off('SIGINT', interrupt);
    }
  } finally {
    try {
      await SandboxManager.reset();
    } finally {
      await rm(ipcTemporary, { recursive: true, force: true });
    }
  }
}
main().catch((e) => {
  process.stderr.write(`SANDBOX_UNAVAILABLE: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 78;
});
