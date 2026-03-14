import { describe, expect, it, mock } from 'bun:test';

/**
 * Tests for network isolation in container args.
 *
 * [Upstream PR #460] Non-main containers run with --network none by default
 * to prevent data exfiltration. Main containers keep full network for
 * WebFetch/WebSearch. Per-group override via containerConfig.networkMode.
 */

const { buildContainerArgs } = await import('./local-backend.js');

mock.restore();

describe('buildContainerArgs network isolation', () => {
  it('non-main containers get --network none by default', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: false,
      runtime: 'docker',
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
      runtime: 'docker',
    });
    expect(args).not.toContain('--network');
  });

  it('non-main containers can override to full network via networkMode', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: false,
      networkMode: 'full',
      runtime: 'docker',
    });
    expect(args).not.toContain('--network');
  });

  it('main containers can override to no network via networkMode', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: true,
      networkMode: 'none',
      runtime: 'docker',
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
      runtime: 'docker',
    });
    expect(args).toContain('--pids-limit');
    const pidsIdx = args.indexOf('--pids-limit');
    expect(args[pidsIdx + 1]).toBe('256');

    expect(args).toContain('--security-opt');
    const secIdx = args.indexOf('--security-opt');
    expect(args[secIdx + 1]).toBe('no-new-privileges:true');
  });
});
