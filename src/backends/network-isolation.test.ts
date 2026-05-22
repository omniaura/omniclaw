import { describe, expect, it, mock } from 'bun:test';

/**
 * Tests for network configuration in container args.
 *
 * Default behavior: containers run with full network access so agents can
 * reach the LLM API (api.anthropic.com) and use WebFetch / WebSearch tools.
 * Per-group override via containerConfig.networkMode = 'none' opts back
 * into outbound network isolation.
 */

const { buildContainerArgs } = await import('./local-backend.js');

mock.restore();

describe('buildContainerArgs network configuration', () => {
  it('non-main containers get full network by default', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: false,
      runtime: 'docker',
    });
    expect(args).not.toContain('--network');
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

  it('explicit networkMode=none still isolates', () => {
    const args = buildContainerArgs({
      mounts: [],
      containerName: 'test-container',
      isMain: false,
      networkMode: 'none',
      runtime: 'docker',
    });
    expect(args).toContain('--network');
    const networkIdx = args.indexOf('--network');
    expect(args[networkIdx + 1]).toBe('none');
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
