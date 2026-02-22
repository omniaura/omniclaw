import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'path';
import os from 'os';

import {
  validateMount,
  validateAdditionalMounts,
  generateAllowlistTemplate,
  _resetAllowlistCache,
  DEFAULT_BLOCKED_PATTERNS,
} from './mount-security.js';
import { MOUNT_ALLOWLIST_PATH } from './config.js';
import type { MountAllowlist } from './types.js';

// --- Helpers ---

const ALLOWLIST_DIR = path.dirname(MOUNT_ALLOWLIST_PATH);
let originalAllowlistExists = false;
let originalAllowlistContent: string | null = null;

// Save and restore any pre-existing allowlist file
function backupAllowlist(): void {
  try {
    if (existsSync(MOUNT_ALLOWLIST_PATH)) {
      originalAllowlistExists = true;
      originalAllowlistContent = require('fs').readFileSync(
        MOUNT_ALLOWLIST_PATH,
        'utf-8',
      );
    }
  } catch {
    // ignore
  }
}

function restoreAllowlist(): void {
  if (originalAllowlistExists && originalAllowlistContent !== null) {
    writeFileSync(MOUNT_ALLOWLIST_PATH, originalAllowlistContent);
  } else {
    try {
      rmSync(MOUNT_ALLOWLIST_PATH, { force: true });
    } catch {
      // ignore
    }
  }
}

function writeAllowlist(allowlist: MountAllowlist): void {
  mkdirSync(ALLOWLIST_DIR, { recursive: true });
  writeFileSync(MOUNT_ALLOWLIST_PATH, JSON.stringify(allowlist));
}

function removeAllowlist(): void {
  try {
    rmSync(MOUNT_ALLOWLIST_PATH, { force: true });
  } catch {
    // ignore
  }
}

// Create a valid temp directory to use as allowed root
const TEMP_ROOT = path.join(os.tmpdir(), 'mount-security-test');

function setupTempRoot(): void {
  mkdirSync(path.join(TEMP_ROOT, 'projects', 'my-app'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, '.ssh'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, 'safe-dir'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, 'credentials-dir'), { recursive: true });
}

function cleanupTempRoot(): void {
  try {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// --- Setup / Teardown ---

backupAllowlist();
setupTempRoot();

beforeEach(() => {
  _resetAllowlistCache();
  removeAllowlist();
});

afterAll(() => {
  _resetAllowlistCache();
  restoreAllowlist();
  cleanupTempRoot();
});

// --- DEFAULT_BLOCKED_PATTERNS ---

describe('DEFAULT_BLOCKED_PATTERNS', () => {
  it('includes critical security-sensitive paths', () => {
    expect(DEFAULT_BLOCKED_PATTERNS).toContain('.ssh');
    expect(DEFAULT_BLOCKED_PATTERNS).toContain('.gnupg');
    expect(DEFAULT_BLOCKED_PATTERNS).toContain('.aws');
    expect(DEFAULT_BLOCKED_PATTERNS).toContain('.env');
    expect(DEFAULT_BLOCKED_PATTERNS).toContain('id_rsa');
    expect(DEFAULT_BLOCKED_PATTERNS).toContain('id_ed25519');
    expect(DEFAULT_BLOCKED_PATTERNS).toContain('private_key');
    expect(DEFAULT_BLOCKED_PATTERNS).toContain('.kube');
    expect(DEFAULT_BLOCKED_PATTERNS).toContain('.docker');
  });

  it('has at least 15 patterns', () => {
    expect(DEFAULT_BLOCKED_PATTERNS.length).toBeGreaterThanOrEqual(15);
  });
});

// --- validateMount (no allowlist) ---

describe('validateMount without allowlist', () => {
  it('rejects all mounts when no allowlist file exists', () => {
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist configured');
  });
});

// --- validateMount (with allowlist) ---

describe('validateMount with allowlist', () => {
  const baseAllowlist: MountAllowlist = {
    allowedRoots: [
      {
        path: TEMP_ROOT + '/projects',
        allowReadWrite: true,
        description: 'Project directory',
      },
      {
        path: TEMP_ROOT + '/safe-dir',
        allowReadWrite: false,
        description: 'Read-only reference',
      },
    ],
    blockedPatterns: ['secret-file'],
    nonMainReadOnly: true,
  };

  it('allows mount under allowed root', () => {
    writeAllowlist(baseAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('Allowed under root');
    expect(result.realHostPath).toBeDefined();
    expect(result.resolvedContainerPath).toBe('my-app');
  });

  it('rejects mount outside allowed roots', () => {
    writeAllowlist(baseAllowlist);
    // Use /tmp which exists but is not under any allowed root
    const result = validateMount({ hostPath: '/tmp' }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('rejects mount matching default blocked pattern (.ssh)', () => {
    writeAllowlist(baseAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/.ssh' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked pattern');
    expect(result.reason).toContain('.ssh');
  });

  it('rejects mount matching custom blocked pattern', () => {
    writeAllowlist(baseAllowlist);
    // Create a dir that matches "credentials" default pattern
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/credentials-dir' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked pattern');
    expect(result.reason).toContain('credentials');
  });

  it('rejects non-existent host path', () => {
    writeAllowlist(baseAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/does-not-exist' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('uses basename of hostPath as default containerPath', () => {
    writeAllowlist(baseAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('my-app');
  });

  it('uses explicit containerPath when provided', () => {
    writeAllowlist(baseAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app', containerPath: 'custom-name' },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('custom-name');
  });

  it('rejects container path with ..', () => {
    writeAllowlist(baseAllowlist);
    const result = validateMount(
      {
        hostPath: TEMP_ROOT + '/projects/my-app',
        containerPath: '../escape',
      },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it('rejects absolute container path', () => {
    writeAllowlist(baseAllowlist);
    const result = validateMount(
      {
        hostPath: TEMP_ROOT + '/projects/my-app',
        containerPath: '/workspace/exploit',
      },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });

  it('falls back to basename when containerPath is empty string', () => {
    writeAllowlist(baseAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app', containerPath: '' },
      true,
    );
    // Empty string is falsy, so it falls back to path.basename(hostPath)
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('my-app');
  });

  it('rejects whitespace-only container path', () => {
    writeAllowlist(baseAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app', containerPath: '   ' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path');
  });
});

// --- Readonly enforcement ---

describe('validateMount readonly enforcement', () => {
  const rwAllowlist: MountAllowlist = {
    allowedRoots: [
      {
        path: TEMP_ROOT + '/projects',
        allowReadWrite: true,
        description: 'RW allowed',
      },
      {
        path: TEMP_ROOT + '/safe-dir',
        allowReadWrite: false,
        description: 'RW not allowed',
      },
    ],
    blockedPatterns: [],
    nonMainReadOnly: true,
  };

  it('allows read-write for main group under RW root', () => {
    writeAllowlist(rwAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app', readonly: false },
      true, // isMain
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces readonly for non-main group (nonMainReadOnly=true)', () => {
    writeAllowlist(rwAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app', readonly: false },
      false, // not main
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('forces readonly when root does not allow RW', () => {
    writeAllowlist(rwAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/safe-dir', readonly: false },
      true, // isMain
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('defaults to readonly when not specified', () => {
    writeAllowlist(rwAllowlist);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows RW for non-main when nonMainReadOnly=false', () => {
    const permissiveList: MountAllowlist = {
      ...rwAllowlist,
      nonMainReadOnly: false,
    };
    writeAllowlist(permissiveList);
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app', readonly: false },
      false, // not main
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });
});

// --- Allowlist loading edge cases ---

describe('loadMountAllowlist edge cases', () => {
  it('rejects malformed JSON', () => {
    mkdirSync(ALLOWLIST_DIR, { recursive: true });
    writeFileSync(MOUNT_ALLOWLIST_PATH, 'not json {{{');
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist configured');
  });

  it('rejects allowlist missing allowedRoots array', () => {
    mkdirSync(ALLOWLIST_DIR, { recursive: true });
    writeFileSync(
      MOUNT_ALLOWLIST_PATH,
      JSON.stringify({
        allowedRoots: 'not-an-array',
        blockedPatterns: [],
        nonMainReadOnly: true,
      }),
    );
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result.allowed).toBe(false);
  });

  it('rejects allowlist missing blockedPatterns array', () => {
    mkdirSync(ALLOWLIST_DIR, { recursive: true });
    writeFileSync(
      MOUNT_ALLOWLIST_PATH,
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: 'not-an-array',
        nonMainReadOnly: true,
      }),
    );
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result.allowed).toBe(false);
  });

  it('rejects allowlist missing nonMainReadOnly boolean', () => {
    mkdirSync(ALLOWLIST_DIR, { recursive: true });
    writeFileSync(
      MOUNT_ALLOWLIST_PATH,
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: 'yes',
      }),
    );
    const result = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result.allowed).toBe(false);
  });

  it('merges default blocked patterns with custom ones', () => {
    writeAllowlist({
      allowedRoots: [
        { path: TEMP_ROOT, allowReadWrite: false },
      ],
      blockedPatterns: ['my-custom-secret'],
      nonMainReadOnly: true,
    });
    // .ssh should be blocked by defaults
    const sshResult = validateMount(
      { hostPath: TEMP_ROOT + '/.ssh' },
      true,
    );
    expect(sshResult.allowed).toBe(false);
    expect(sshResult.reason).toContain('.ssh');
  });

  it('caches allowlist across calls', () => {
    writeAllowlist({
      allowedRoots: [
        { path: TEMP_ROOT + '/projects', allowReadWrite: false },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    // First call loads the allowlist
    const result1 = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result1.allowed).toBe(true);

    // Now delete the file — cached result should still work
    removeAllowlist();
    const result2 = validateMount(
      { hostPath: TEMP_ROOT + '/projects/my-app' },
      true,
    );
    expect(result2.allowed).toBe(true);
  });
});

// --- validateAdditionalMounts ---

describe('validateAdditionalMounts', () => {
  const allowlist: MountAllowlist = {
    allowedRoots: [
      {
        path: TEMP_ROOT + '/projects',
        allowReadWrite: true,
      },
    ],
    blockedPatterns: [],
    nonMainReadOnly: false,
  };

  it('returns validated mounts with correct containerPath prefix', () => {
    writeAllowlist(allowlist);
    const validated = validateAdditionalMounts(
      [{ hostPath: TEMP_ROOT + '/projects/my-app' }],
      'test-group',
      true,
    );
    expect(validated).toHaveLength(1);
    expect(validated[0].containerPath).toBe('/workspace/extra/my-app');
    expect(validated[0].readonly).toBe(true); // default
  });

  it('filters out rejected mounts', () => {
    writeAllowlist(allowlist);
    const validated = validateAdditionalMounts(
      [
        { hostPath: TEMP_ROOT + '/projects/my-app' },   // allowed
        { hostPath: '/nonexistent/path' },               // rejected
        { hostPath: TEMP_ROOT + '/projects/my-app', containerPath: '../bad' }, // rejected
      ],
      'test-group',
      true,
    );
    expect(validated).toHaveLength(1);
    expect(validated[0].containerPath).toBe('/workspace/extra/my-app');
  });

  it('returns empty array when all mounts rejected', () => {
    writeAllowlist(allowlist);
    const validated = validateAdditionalMounts(
      [{ hostPath: '/nonexistent' }],
      'test-group',
      true,
    );
    expect(validated).toHaveLength(0);
  });

  it('returns empty array for empty mounts list', () => {
    writeAllowlist(allowlist);
    const validated = validateAdditionalMounts([], 'test-group', true);
    expect(validated).toHaveLength(0);
  });

  it('preserves readonly setting from validation', () => {
    writeAllowlist(allowlist);
    const validated = validateAdditionalMounts(
      [{ hostPath: TEMP_ROOT + '/projects/my-app', readonly: false }],
      'test-group',
      true, // isMain
    );
    expect(validated).toHaveLength(1);
    expect(validated[0].readonly).toBe(false);
  });
});

// --- generateAllowlistTemplate ---

describe('generateAllowlistTemplate', () => {
  it('returns valid JSON', () => {
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template);
    expect(parsed).toBeDefined();
  });

  it('has required top-level fields', () => {
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template) as MountAllowlist;
    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });

  it('includes example allowed roots', () => {
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template) as MountAllowlist;
    expect(parsed.allowedRoots.length).toBeGreaterThan(0);
    expect(parsed.allowedRoots[0].path).toBeDefined();
    expect(typeof parsed.allowedRoots[0].allowReadWrite).toBe('boolean');
  });

  it('sets nonMainReadOnly to true by default', () => {
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template) as MountAllowlist;
    expect(parsed.nonMainReadOnly).toBe(true);
  });
});
