/**
 * Daytona Provisioning for NanoClaw
 * Handles first-time setup of a Daytona sandbox.
 * Lighter than Sprites — Claude Code is pre-installed in default Daytona snapshots.
 */

import { logger } from '../logger.js';

type SandboxHandle = {
  process: {
    executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<{ exitCode: number; result: string }>;
  };
  getWorkDir(): Promise<string | undefined>;
  getUserHomeDir(): Promise<string | undefined>;
};

/** Run a command, log output, and throw on non-zero exit. */
async function run(
  sandbox: SandboxHandle,
  name: string,
  cmd: string,
  sandboxName: string,
  timeoutSec?: number,
): Promise<string> {
  logger.info({ sandbox: sandboxName }, `Provisioning: ${name}...`);
  const result = await sandbox.process.executeCommand(cmd, undefined, undefined, timeoutSec);
  if (result.exitCode !== 0) {
    logger.warn({ sandbox: sandboxName, exitCode: result.exitCode, output: result.result?.slice(-500) }, `Provisioning step failed: ${name}`);
  }
  return result.result || '';
}

/** Run a command, require success (throw on failure). */
async function runRequired(
  sandbox: SandboxHandle,
  name: string,
  cmd: string,
  sandboxName: string,
  timeoutSec?: number,
): Promise<string> {
  logger.info({ sandbox: sandboxName }, `Provisioning: ${name}...`);
  const result = await sandbox.process.executeCommand(cmd, undefined, undefined, timeoutSec);
  if (result.exitCode !== 0) {
    const msg = `Provisioning failed at "${name}": exit ${result.exitCode} — ${result.result?.slice(-300)}`;
    logger.error({ sandbox: sandboxName, exitCode: result.exitCode, output: result.result?.slice(-500) }, msg);
    throw new Error(msg);
  }
  return result.result || '';
}

/**
 * Check if a sandbox has already been provisioned.
 */
export async function isDaytonaProvisioned(sandbox: SandboxHandle): Promise<boolean> {
  try {
    const workdir = await sandbox.getWorkDir() || '/home/daytona';
    const result = await sandbox.process.executeCommand(`test -f ${workdir}/workspace/.nanoclaw-provisioned`);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Provision a Daytona sandbox with dependencies needed to run NanoClaw agent-runner.
 * This is idempotent — skips if already provisioned.
 *
 * Creates workspace dirs under the sandbox working directory and symlinks from
 * root-level paths so both the FS API (relative paths) and shell commands
 * (absolute paths in entrypoint.sh) resolve to the same files.
 */
export async function provisionDaytona(sandbox: SandboxHandle, sandboxName: string): Promise<void> {
  if (await isDaytonaProvisioned(sandbox)) {
    logger.info({ sandbox: sandboxName }, 'Daytona sandbox already provisioned, skipping');
    return;
  }

  logger.info({ sandbox: sandboxName }, 'Provisioning Daytona sandbox (first-time setup)...');

  const workdir = await sandbox.getWorkDir() || '/home/daytona';
  const homedir = await sandbox.getUserHomeDir() || '/home/daytona';

  // Install bun
  await run(sandbox, 'Installing bun', 'curl -fsSL https://bun.sh/install | bash', sandboxName, 120);
  await sandbox.process.executeCommand('echo \'export PATH="$HOME/.bun/bin:$PATH"\' >> ~/.bashrc');

  // Check if Claude Code is already installed (default Daytona snapshots include it)
  const claudeCheck = await sandbox.process.executeCommand('which claude');
  if (claudeCheck.exitCode === 0) {
    logger.info({ sandbox: sandboxName }, 'Claude Code already installed');
  } else {
    await runRequired(sandbox, 'Installing Claude Code',
      'export PATH="$HOME/.bun/bin:$PATH" && bun install -g @anthropic-ai/claude-code',
      sandboxName, 180);
  }

  // Install gh CLI — use the direct binary approach (more reliable than apt repo on Daytona)
  const ghCheck = await sandbox.process.executeCommand('which gh');
  if (ghCheck.exitCode === 0) {
    logger.info({ sandbox: sandboxName }, 'gh CLI already installed');
  } else {
    await runRequired(sandbox, 'Installing gh CLI',
      'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && ' +
      'sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && ' +
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && ' +
      'sudo apt-get update -qq && sudo apt-get install -y gh',
      sandboxName, 180);
    // Verify
    const verify = await sandbox.process.executeCommand('gh --version');
    logger.info({ sandbox: sandboxName, version: verify.result?.trim() }, 'gh CLI installed');
  }

  // Set up gh auth if GITHUB_TOKEN is available
  await run(sandbox, 'Configuring gh auth',
    'if [ -n "$GITHUB_TOKEN" ]; then echo "$GITHUB_TOKEN" | gh auth login --with-token && gh auth setup-git; fi',
    sandboxName, 30);

  // Install chromium for agent-browser
  await run(sandbox, 'Installing chromium',
    'sudo apt-get install -y chromium-browser 2>/dev/null || sudo apt-get install -y chromium 2>/dev/null || true',
    sandboxName, 120);

  // Create workspace directories under workdir (where FS API can write)
  await runRequired(sandbox, 'Creating workspace dirs',
    `mkdir -p ${workdir}/workspace/group ${workdir}/workspace/global ` +
    `${workdir}/workspace/ipc/messages ${workdir}/workspace/ipc/tasks ${workdir}/workspace/ipc/input ` +
    `${workdir}/workspace/env-dir ${workdir}/workspace/shared ` +
    `${workdir}/app/src ${homedir}/.claude`,
    sandboxName);

  // Create symlinks from absolute paths so entrypoint.sh and shell commands work
  await run(sandbox, 'Creating symlinks',
    `sudo ln -sfn ${workdir}/workspace /workspace 2>/dev/null || true && ` +
    `sudo ln -sfn ${workdir}/app /app 2>/dev/null || true`,
    sandboxName);

  // Write provision marker
  await sandbox.process.executeCommand(
    `echo "provisioned=$(date -Iseconds) workdir=${workdir}" > ${workdir}/workspace/.nanoclaw-provisioned`,
  );

  logger.info({ sandbox: sandboxName, workdir, homedir }, 'Daytona sandbox provisioning complete');
}
