import { describe, it, expect } from 'bun:test';

import {
  findJidByFolder,
  findGroupByFolder,
  findMainGroupJid,
  isMainGroup,
} from './group-helpers.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test',
    trigger: '@test',
    added_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('group-helpers', () => {
  const groups: Record<string, RegisteredGroup> = {
    'jid-main@g.us': makeGroup({ name: 'Main', folder: 'main', trigger: '@omni' }),
    'jid-dev@g.us': makeGroup({ name: 'Dev', folder: 'dev-chat', trigger: '@dev' }),
    'jid-omniclaw@g.us': makeGroup({ name: 'OmniClaw', folder: 'omniclaw', trigger: '@claw' }),
  };

  describe('findJidByFolder', () => {
    it('returns the JID for a matching folder', () => {
      expect(findJidByFolder(groups, 'dev-chat')).toBe('jid-dev@g.us');
    });

    it('returns undefined for a non-existent folder', () => {
      expect(findJidByFolder(groups, 'nonexistent')).toBeUndefined();
    });

    it('returns the main group JID when searching for "main"', () => {
      expect(findJidByFolder(groups, 'main')).toBe('jid-main@g.us');
    });

    it('handles empty groups map', () => {
      expect(findJidByFolder({}, 'anything')).toBeUndefined();
    });
  });

  describe('findGroupByFolder', () => {
    it('returns [jid, group] tuple for a matching folder', () => {
      const result = findGroupByFolder(groups, 'omniclaw');
      expect(result).toBeDefined();
      expect(result![0]).toBe('jid-omniclaw@g.us');
      expect(result![1].name).toBe('OmniClaw');
    });

    it('returns undefined for non-existent folder', () => {
      expect(findGroupByFolder(groups, 'nonexistent')).toBeUndefined();
    });

    it('handles empty groups map', () => {
      expect(findGroupByFolder({}, 'test')).toBeUndefined();
    });
  });

  describe('findMainGroupJid', () => {
    it('returns the JID of the main group', () => {
      expect(findMainGroupJid(groups)).toBe('jid-main@g.us');
    });

    it('returns undefined when no main group exists', () => {
      const noMain: Record<string, RegisteredGroup> = {
        'jid-dev@g.us': makeGroup({ folder: 'dev-chat' }),
      };
      expect(findMainGroupJid(noMain)).toBeUndefined();
    });

    it('handles empty groups map', () => {
      expect(findMainGroupJid({})).toBeUndefined();
    });
  });

  describe('isMainGroup', () => {
    it('returns true for "main"', () => {
      expect(isMainGroup('main')).toBe(true);
    });

    it('returns false for other folders', () => {
      expect(isMainGroup('dev-chat')).toBe(false);
      expect(isMainGroup('omniclaw')).toBe(false);
      expect(isMainGroup('')).toBe(false);
    });

    it('is case-sensitive', () => {
      expect(isMainGroup('Main')).toBe(false);
      expect(isMainGroup('MAIN')).toBe(false);
    });
  });
});
