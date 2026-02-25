import { describe, it, expect } from 'bun:test';

import {
  getFolder,
  getName,
  isAgent,
  getContainerConfig,
  getServerFolder,
  getBackendType,
  type AgentOrGroup,
} from './types.js';
import type { Agent, RegisteredGroup } from '../types.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    folder: 'agent-folder',
    backend: 'apple-container',
    isAdmin: false,
    isLocal: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'group-folder',
    trigger: '@test',
    added_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('backends/types.ts', () => {
  describe('getFolder', () => {
    it('returns folder from an Agent', () => {
      expect(getFolder(makeAgent({ folder: 'my-agent' }))).toBe('my-agent');
    });

    it('returns folder from a RegisteredGroup', () => {
      expect(getFolder(makeGroup({ folder: 'my-group' }))).toBe('my-group');
    });
  });

  describe('getName', () => {
    it('returns name from an Agent', () => {
      expect(getName(makeAgent({ name: 'AgentX' }))).toBe('AgentX');
    });

    it('returns name from a RegisteredGroup', () => {
      expect(getName(makeGroup({ name: 'GroupY' }))).toBe('GroupY');
    });
  });

  describe('isAgent', () => {
    it('returns true for an Agent object', () => {
      expect(isAgent(makeAgent())).toBe(true);
    });

    it('returns false for a RegisteredGroup', () => {
      expect(isAgent(makeGroup())).toBe(false);
    });

    it('distinguishes by the presence of both id and isAdmin fields', () => {
      // Object with only 'id' but not 'isAdmin' should not be Agent
      const ambiguous = { ...makeGroup(), id: 'something' } as any;
      // isAgent checks for both 'id' and 'isAdmin'
      expect(isAgent(ambiguous)).toBe(false);
    });
  });

  describe('getContainerConfig', () => {
    it('returns containerConfig from an Agent', () => {
      const config = { timeout: 60000, memory: 2048 };
      expect(getContainerConfig(makeAgent({ containerConfig: config }))).toEqual(config);
    });

    it('returns containerConfig from a RegisteredGroup', () => {
      const config = { timeout: 120000 };
      expect(getContainerConfig(makeGroup({ containerConfig: config }))).toEqual(config);
    });

    it('returns undefined when no containerConfig', () => {
      expect(getContainerConfig(makeAgent({ containerConfig: undefined }))).toBeUndefined();
    });
  });

  describe('getServerFolder', () => {
    it('returns serverFolder from an Agent', () => {
      expect(getServerFolder(makeAgent({ serverFolder: 'servers/discord' }))).toBe('servers/discord');
    });

    it('returns serverFolder from a RegisteredGroup', () => {
      expect(getServerFolder(makeGroup({ serverFolder: 'servers/wa' }))).toBe('servers/wa');
    });

    it('returns undefined when no serverFolder', () => {
      expect(getServerFolder(makeAgent({ serverFolder: undefined }))).toBeUndefined();
    });
  });

  describe('getBackendType', () => {
    it('returns backend from an Agent directly', () => {
      expect(getBackendType(makeAgent({ backend: 'apple-container' }))).toBe('apple-container');
    });

    it('returns backend from a RegisteredGroup', () => {
      expect(getBackendType(makeGroup({ backend: 'docker' }))).toBe('docker');
    });

    it('defaults to apple-container for RegisteredGroup without backend', () => {
      expect(getBackendType(makeGroup({ backend: undefined }))).toBe('apple-container');
    });

    it('returns each backend type correctly for Agent', () => {
      expect(getBackendType(makeAgent({ backend: 'apple-container' }))).toBe('apple-container');
      expect(getBackendType(makeAgent({ backend: 'docker' }))).toBe('docker');
    });

    it('returns each backend type correctly for RegisteredGroup', () => {
      expect(getBackendType(makeGroup({ backend: 'apple-container' }))).toBe('apple-container');
      expect(getBackendType(makeGroup({ backend: 'docker' }))).toBe('docker');
    });
  });
});
