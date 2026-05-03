import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyDeclarativeAgentTopology,
  loadDeclarativeAgentTopology,
} from './agent-topology.js';
import type { RegisteredGroup } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTopology(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-topology-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'agents.yaml');
  fs.writeFileSync(filePath, source);
  return filePath;
}

describe('loadDeclarativeAgentTopology', () => {
  it('returns no registrations when the topology file is absent', () => {
    const filePath = path.join(os.tmpdir(), 'missing-agents.yaml');

    expect(loadDeclarativeAgentTopology(filePath)).toEqual([]);
  });

  it('maps agents.yaml channels to registered groups', () => {
    const filePath = writeTopology(`
agents:
  omniclaw-discord:
    name: OCPeyton
    backend: docker
    agentRuntime: opencode
    description: Infrastructure agent
    serverFolder: servers/omniaura
    containerConfig:
      timeout: 300000
      memory: 4096
      networkMode: full
      additionalMounts:
        - hostPath: /tmp/project
          containerPath: project
          readonly: true
    channels:
      - jid: "dc:123456"
        name: omniclaw
        trigger: "@OCPeyton"
        requiresTrigger: true
        discordGuildId: "789"
        channelFolder: servers/omniaura/omniclaw
`);

    const registrations = loadDeclarativeAgentTopology(filePath);

    expect(registrations).toHaveLength(1);
    expect(registrations[0].jid).toBe('dc:123456');
    expect(registrations[0].group).toMatchObject({
      name: 'omniclaw',
      folder: 'omniclaw-discord',
      trigger: '@OCPeyton',
      backend: 'docker',
      agentRuntime: 'opencode',
      description: 'Infrastructure agent',
      discordGuildId: '789',
      serverFolder: 'servers/omniaura',
      channelFolder: 'servers/omniaura/omniclaw',
      containerConfig: {
        timeout: 300000,
        memory: 4096,
        networkMode: 'full',
        additionalMounts: [
          {
            hostPath: '/tmp/project',
            containerPath: 'project',
            readonly: true,
          },
        ],
      },
    });
    expect(registrations[0].group.added_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves existing added_at timestamps for stable upserts', () => {
    const filePath = writeTopology(`
agents:
  main:
    channels:
      - jid: "123@s.whatsapp.net"
        trigger: "@Omni"
`);
    const existing: Record<string, RegisteredGroup> = {
      '123@s.whatsapp.net': {
        name: 'Old name',
        folder: 'main',
        trigger: '@Old',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    };

    const registrations = loadDeclarativeAgentTopology(filePath, existing);

    expect(registrations[0].group.added_at).toBe('2026-01-01T00:00:00.000Z');
    expect(registrations[0].group.trigger).toBe('@Omni');
  });

  it('rejects unsafe folder names', () => {
    const filePath = writeTopology(`
agents:
  ../main:
    channels:
      - jid: "123@s.whatsapp.net"
        trigger: "@Omni"
`);

    expect(() => loadDeclarativeAgentTopology(filePath)).toThrow(
      /Invalid key in record/,
    );
  });

  it('rejects uppercase folder names', () => {
    const filePath = writeTopology(`
agents:
  Main:
    channels:
      - jid: "123@s.whatsapp.net"
        trigger: "@Omni"
`);

    expect(() => loadDeclarativeAgentTopology(filePath)).toThrow(
      /Invalid key in record/,
    );
  });

  it('rejects heartbeat blocks until scheduler wiring exists', () => {
    const filePath = writeTopology(`
agents:
  main:
    heartbeat:
      enabled: true
      interval: "1800000"
    channels:
      - jid: "123@s.whatsapp.net"
        trigger: "@Omni"
`);

    expect(() => loadDeclarativeAgentTopology(filePath)).toThrow(
      /Unrecognized key: "heartbeat"/,
    );
  });

  it('rejects snake_case aliases', () => {
    const filePath = writeTopology(`
agents:
  main:
    agent_runtime: opencode
    channels:
      - jid: "dc:123"
        trigger: "@Omni"
        discord_guild_id: "456"
`);

    expect(() => loadDeclarativeAgentTopology(filePath)).toThrow(
      /Unrecognized key/,
    );
  });

  it('rejects unknown agent keys', () => {
    const filePath = writeTopology(`
agents:
  main:
    chanels:
      - jid: "dc:123"
        trigger: "@Omni"
`);

    expect(() => loadDeclarativeAgentTopology(filePath)).toThrow(
      /Unrecognized key: "chanels"/,
    );
  });

  it('rejects unknown containerConfig keys', () => {
    const filePath = writeTopology(`
agents:
  main:
    containerConfig:
      memmory: 4096
    channels:
      - jid: "dc:123"
        trigger: "@Omni"
`);

    expect(() => loadDeclarativeAgentTopology(filePath)).toThrow(
      /Unrecognized key: "memmory"/,
    );
  });

  it('prefixes YAML parse errors clearly', () => {
    const filePath = writeTopology(`
agents:
  main:
    channels:
      - jid: "dc:123"
        trigger: "@Omni"
       badIndent: true
`);

    expect(() => loadDeclarativeAgentTopology(filePath)).toThrow(
      /Invalid agent topology YAML:/,
    );
  });

  it('rejects duplicate channel jids', () => {
    const filePath = writeTopology(`
agents:
  main:
    channels:
      - jid: "dc:123"
        trigger: "@Omni"
  other:
    channels:
      - jid: "dc:123"
        trigger: "@Other"
`);

    expect(() => loadDeclarativeAgentTopology(filePath)).toThrow(
      /duplicate channel jid dc:123/,
    );
  });
});

describe('applyDeclarativeAgentTopology', () => {
  it('returns 0 and does not register groups when the topology file is absent', () => {
    const filePath = path.join(os.tmpdir(), 'missing-agents.yaml');
    const registered: Array<{ jid: string; group: RegisteredGroup }> = [];

    const count = applyDeclarativeAgentTopology({
      filePath,
      existingGroups: {},
      registerGroup: (jid, group) => registered.push({ jid, group }),
    });

    expect(count).toBe(0);
    expect(registered).toEqual([]);
  });

  it('registers each loaded topology channel', () => {
    const filePath = writeTopology(`
agents:
  main:
    name: Omni
    channels:
      - jid: "123@s.whatsapp.net"
        trigger: "@Omni"
      - jid: "dc:456"
        trigger: "@Omni"
`);
    const registered: Array<{ jid: string; group: RegisteredGroup }> = [];

    const count = applyDeclarativeAgentTopology({
      filePath,
      existingGroups: {},
      registerGroup: (jid, group) => registered.push({ jid, group }),
    });

    expect(count).toBe(2);
    expect(registered.map((entry) => entry.jid)).toEqual([
      '123@s.whatsapp.net',
      'dc:456',
    ]);
    expect(registered.every((entry) => entry.group.folder === 'main')).toBe(
      true,
    );
  });

  it('does not delete existing groups that are absent from topology', () => {
    const filePath = writeTopology(`
agents:
  main:
    channels:
      - jid: "123@s.whatsapp.net"
        trigger: "@Omni"
`);
    const existingGroups: Record<string, RegisteredGroup> = {
      'stale@s.whatsapp.net': {
        name: 'Stale',
        folder: 'stale',
        trigger: '@Stale',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const registered: Array<{ jid: string; group: RegisteredGroup }> = [];

    const count = applyDeclarativeAgentTopology({
      filePath,
      existingGroups,
      registerGroup: (jid, group) => registered.push({ jid, group }),
    });

    expect(count).toBe(1);
    expect(registered.map((entry) => entry.jid)).toEqual([
      '123@s.whatsapp.net',
    ]);
  });
});
