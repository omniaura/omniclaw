import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Tests for network isolation in container args.
 *
 * [Upstream PR #460] Non-main containers run with --network none by default
 * to prevent data exfiltration. Main containers keep full network for
 * WebFetch/WebSearch. Per-group override via containerConfig.networkMode.
 */

// Mock config module with all required exports
const mockConfig = {
  CONTAINER_IMAGE: 'test-image:latest',
  CONTAINER_MEMORY: '4096m',
  CONTAINER_TIMEOUT: 300_000,
  IDLE_TIMEOUT: 30_000,
  LOCAL_RUNTIME: 'docker',
  TIMEZONE: 'America/Los_Angeles',
  CONTAINER_MAX_OUTPUT_SIZE: 10_000_000,
  CONTAINER_STARTUP_TIMEOUT: 30_000,
  DATA_DIR: '/tmp/test-data',
  GROUPS_DIR: '/tmp/test-data/groups',
  STORE_DIR: '/tmp/test-data/store',
  MAIN_GROUP_FOLDER: 'main',
  MOUNT_ALLOWLIST_PATH: '/tmp/test-data/mount-allowlist.json',
  ASSISTANT_NAME: 'Omni',
  TRIGGER_PATTERN: /^@Omni\b/i,
  POLL_INTERVAL: 2000,
  SCHEDULER_POLL_INTERVAL: 60000,
  IPC_POLL_INTERVAL: 1000,
  SESSION_MAX_AGE: 14_400_000,
  MAX_CONCURRENT_CONTAINERS: 8,
  MAX_TASK_CONTAINERS: 7,
  DISCORD_BOT_TOKEN: '',
  TELEGRAM_BOT_TOKEN: '',
  SLACK_BOT_TOKEN: '',
  SLACK_APP_TOKEN: '',
  ANTHROPIC_MODEL: undefined,
  escapeRegex: (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  buildTriggerPattern: () => /^@Omni\b/i,
};

mock.module('../config.js', () => mockConfig);

// Import after mocking
const { buildContainerArgs } = await import('./local-backend.js');

describe('buildContainerArgs network isolation', () => {
  beforeEach(() => {
    mockConfig.LOCAL_RUNTIME = 'docker';
  });

  it('non-main containers get --network none by default', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: false,
    });
    expect(args).toContain('--network');
    const networkIdx = args.indexOf('--network');
    expect(args[networkIdx + 1]).toBe('none');
  });

  it('main containers get full network by default (no --network flag)', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: true,
    });
    expect(args).not.toContain('--network');
  });

  it('non-main containers can override to full network via networkMode', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: false,
      networkMode: 'full',
    });
    expect(args).not.toContain('--network');
  });

  it('main containers can override to no network via networkMode', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: true,
      networkMode: 'none',
    });
    expect(args).toContain('--network');
    const networkIdx = args.indexOf('--network');
    expect(args[networkIdx + 1]).toBe('none');
  });

  it('Docker containers always have --pids-limit and --no-new-privileges', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: false,
    });
    expect(args).toContain('--pids-limit');
    const pidsIdx = args.indexOf('--pids-limit');
    expect(args[pidsIdx + 1]).toBe('256');

    expect(args).toContain('--security-opt');
    const secIdx = args.indexOf('--security-opt');
    expect(args[secIdx + 1]).toBe('no-new-privileges:true');
  });
});
