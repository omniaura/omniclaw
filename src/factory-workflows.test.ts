import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createSchema } from './db.js';
import {
  FactoryWorkflowStore,
  validateFactoryPhaseTransition,
} from './factory-workflows.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

function makeStore(): { db: Database; store: FactoryWorkflowStore } {
  const db = new Database(':memory:');
  createSchema(db);
  return { db, store: new FactoryWorkflowStore(db) };
}

describe('FactoryWorkflowStore handoffs', () => {
  it('round-trips a handoff record with structured fields', () => {
    const { db, store } = makeStore();

    const created = store.createHandoff({
      id: 'handoff-1',
      workflowId: 'omniaura/omniclaw#643',
      repo: 'omniaura/omniclaw',
      sourceIssue: '643',
      phase: 'spec',
      ownerAgentId: 'ocpeyton',
      driver: 'product-driver',
      intent: 'Define durable factory handoffs',
      summary: 'Need durable records before UI work.',
      body: 'The next driver should implement persistence first.',
      decisions: ['Use SQLite for records and claims'],
      artifacts: [{ type: 'issue', label: '#643', url: 'https://example/643' }],
      blockers: ['Lease primitive still pending'],
      nextDriver: 'implement-driver',
      nextScope: 'schema/module spike',
      metadata: { priority: 'P2' },
      createdAt: '2026-05-04T00:00:00.000Z',
    });

    expect(created.id).toBe('handoff-1');
    expect(store.getHandoff('handoff-1')).toEqual(created);
    expect(store.findLatestHandoffByIssue('omniaura/omniclaw', '643')).toEqual(
      created,
    );

    db.close();
  });

  it('rejects backward phase transitions for a workflow', () => {
    const { db, store } = makeStore();
    store.createHandoff({
      workflowId: 'workflow-1',
      repo: 'omniaura/omniclaw',
      phase: 'qa',
      ownerAgentId: 'qa-agent',
      driver: 'qa-driver',
      intent: 'Verify PR',
      summary: 'QA started',
      body: 'Run targeted checks.',
      createdAt: '2026-05-04T01:00:00.000Z',
    });

    expect(() =>
      store.createHandoff({
        workflowId: 'workflow-1',
        repo: 'omniaura/omniclaw',
        phase: 'impl',
        ownerAgentId: 'impl-agent',
        driver: 'implement-driver',
        intent: 'Implement PR',
        summary: 'Implementation should not reopen after QA',
        body: 'This should be rejected.',
        createdAt: '2026-05-04T02:00:00.000Z',
      }),
    ).toThrow('Factory workflow cannot move backward: qa -> impl');

    db.close();
  });

  it('allows same-phase and forward transitions', () => {
    expect(() => validateFactoryPhaseTransition('impl', 'impl')).not.toThrow();
    expect(() => validateFactoryPhaseTransition('impl', 'qa')).not.toThrow();
    expect(() => validateFactoryPhaseTransition('qa', 'review')).toThrow();
  });
});

describe('FactoryWorkflowStore claims', () => {
  it('detects duplicate active workflow owners', () => {
    const { db, store } = makeStore();
    const first = store.acquireClaim({
      workflowId: 'workflow-1',
      repo: 'omniaura/omniclaw',
      ownerAgentId: 'ocpeyton',
      ownerRunId: 'run-1',
      phase: 'impl',
      ttlMs: 60_000,
      now: new Date('2026-05-04T00:00:00.000Z'),
    });
    expect(first.acquired).toBe(true);

    const second = store.acquireClaim({
      workflowId: 'workflow-1',
      repo: 'omniaura/omniclaw',
      ownerAgentId: 'cody',
      ownerRunId: 'run-2',
      phase: 'impl',
      ttlMs: 60_000,
      now: new Date('2026-05-04T00:00:10.000Z'),
    });

    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.conflict.ownerRunId).toBe('run-1');

    db.close();
  });

  it('expires stale claims before acquiring a new owner', () => {
    const { db, store } = makeStore();
    store.acquireClaim({
      workflowId: 'workflow-1',
      repo: 'omniaura/omniclaw',
      ownerAgentId: 'ocpeyton',
      ownerRunId: 'run-1',
      phase: 'impl',
      ttlMs: 1_000,
      now: new Date('2026-05-04T00:00:00.000Z'),
    });

    const result = store.acquireClaim({
      workflowId: 'workflow-1',
      repo: 'omniaura/omniclaw',
      ownerAgentId: 'cody',
      ownerRunId: 'run-2',
      phase: 'qa',
      ttlMs: 60_000,
      now: new Date('2026-05-04T00:00:02.000Z'),
    });

    expect(result.acquired).toBe(true);
    if (result.acquired) expect(result.claim.ownerRunId).toBe('run-2');

    db.close();
  });

  it('persists records and claims across database reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclaw-factory-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'messages.db');

    const db = new Database(dbPath);
    createSchema(db);
    const store = new FactoryWorkflowStore(db);
    store.createHandoff({
      id: 'handoff-1',
      workflowId: 'workflow-1',
      repo: 'omniaura/omniclaw',
      sourceIssue: '643',
      phase: 'spec',
      ownerAgentId: 'ocpeyton',
      driver: 'product-driver',
      intent: 'Define workflow',
      summary: 'Persist handoffs',
      body: 'Body',
      createdAt: '2026-05-04T00:00:00.000Z',
    });
    store.acquireClaim({
      workflowId: 'workflow-1',
      repo: 'omniaura/omniclaw',
      ownerAgentId: 'ocpeyton',
      ownerRunId: 'run-1',
      phase: 'spec',
      ttlMs: 60_000,
      now: new Date('2026-05-04T00:00:00.000Z'),
    });
    db.close();

    const reopened = new Database(dbPath);
    createSchema(reopened);
    const reopenedStore = new FactoryWorkflowStore(reopened);

    expect(reopenedStore.getHandoff('handoff-1')?.workflowId).toBe(
      'workflow-1',
    );
    expect(reopenedStore.getClaim('workflow-1')?.ownerRunId).toBe('run-1');

    reopened.close();
  });
});
