import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';

import type {
  FactoryHandoffRecord,
  FactoryWorkflowArtifact,
  FactoryWorkflowClaim,
  FactoryWorkflowPhase,
} from './types.js';

export const FACTORY_WORKFLOW_PHASES: FactoryWorkflowPhase[] = [
  'discovery',
  'spec',
  'impl',
  'review',
  'qa',
  'done',
];

const PHASE_ORDER = new Map(
  FACTORY_WORKFLOW_PHASES.map((phase, index) => [phase, index]),
);

export interface NewFactoryHandoffRecord {
  id?: string;
  workflowId: string;
  repo: string;
  sourceIssue?: string;
  sourcePr?: string;
  phase: FactoryWorkflowPhase;
  ownerAgentId: string;
  driver: string;
  intent: string;
  summary: string;
  body: string;
  decisions?: string[];
  artifacts?: FactoryWorkflowArtifact[];
  blockers?: string[];
  nextDriver?: string;
  nextScope?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface AcquireWorkflowClaimInput {
  workflowId: string;
  repo: string;
  ownerAgentId: string;
  ownerRunId: string;
  phase: FactoryWorkflowPhase;
  ttlMs: number;
  now?: Date;
}

export type AcquireWorkflowClaimResult =
  | { acquired: true; claim: FactoryWorkflowClaim }
  | { acquired: false; conflict: FactoryWorkflowClaim };

interface HandoffRow {
  id: string;
  workflow_id: string;
  repo: string;
  source_issue: string | null;
  source_pr: string | null;
  phase: string;
  owner_agent_id: string;
  driver: string;
  intent: string;
  summary: string;
  body: string;
  decisions_json: string;
  artifacts_json: string;
  blockers_json: string;
  next_driver: string | null;
  next_scope: string | null;
  metadata_json: string;
  created_at: string;
}

interface ClaimRow {
  workflow_id: string;
  repo: string;
  owner_agent_id: string;
  owner_run_id: string;
  phase: string;
  claimed_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export function isFactoryWorkflowPhase(
  value: string,
): value is FactoryWorkflowPhase {
  return PHASE_ORDER.has(value as FactoryWorkflowPhase);
}

export function validateFactoryPhaseTransition(
  from: FactoryWorkflowPhase | null,
  to: FactoryWorkflowPhase,
): void {
  if (!isFactoryWorkflowPhase(to)) {
    throw new Error(`Invalid factory workflow phase: ${to}`);
  }
  if (from === null) return;
  const fromIndex = PHASE_ORDER.get(from);
  const toIndex = PHASE_ORDER.get(to);
  if (fromIndex === undefined || toIndex === undefined) {
    throw new Error(`Invalid factory workflow transition: ${from} -> ${to}`);
  }
  if (toIndex < fromIndex) {
    throw new Error(`Factory workflow cannot move backward: ${from} -> ${to}`);
  }
}

export class FactoryWorkflowStore {
  constructor(private readonly db: Database) {}

  createHandoff(input: NewFactoryHandoffRecord): FactoryHandoffRecord {
    const latest = this.getLatestHandoff(input.workflowId);
    validateFactoryPhaseTransition(latest?.phase ?? null, input.phase);

    const record: FactoryHandoffRecord = {
      id: input.id ?? randomUUID(),
      workflowId: input.workflowId,
      repo: input.repo,
      sourceIssue: input.sourceIssue,
      sourcePr: input.sourcePr,
      phase: input.phase,
      ownerAgentId: input.ownerAgentId,
      driver: input.driver,
      intent: input.intent,
      summary: input.summary,
      body: input.body,
      decisions: input.decisions ?? [],
      artifacts: input.artifacts ?? [],
      blockers: input.blockers ?? [],
      nextDriver: input.nextDriver,
      nextScope: input.nextScope,
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO factory_handoff_records
          (id, workflow_id, repo, source_issue, source_pr, phase, owner_agent_id,
           driver, intent, summary, body, decisions_json, artifacts_json,
           blockers_json, next_driver, next_scope, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workflowId,
        record.repo,
        record.sourceIssue ?? null,
        record.sourcePr ?? null,
        record.phase,
        record.ownerAgentId,
        record.driver,
        record.intent,
        record.summary,
        record.body,
        JSON.stringify(record.decisions),
        JSON.stringify(record.artifacts),
        JSON.stringify(record.blockers),
        record.nextDriver ?? null,
        record.nextScope ?? null,
        JSON.stringify(record.metadata),
        record.createdAt,
      );

    return record;
  }

  getHandoff(id: string): FactoryHandoffRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM factory_handoff_records WHERE id = ?')
      .get(id) as HandoffRow | undefined;
    return row ? mapHandoffRow(row) : undefined;
  }

  getLatestHandoff(workflowId: string): FactoryHandoffRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM factory_handoff_records
         WHERE workflow_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(workflowId) as HandoffRow | undefined;
    return row ? mapHandoffRow(row) : undefined;
  }

  listHandoffsForWorkflow(workflowId: string): FactoryHandoffRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM factory_handoff_records
         WHERE workflow_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(workflowId) as HandoffRow[];
    return rows.map(mapHandoffRow);
  }

  findLatestHandoffByIssue(
    repo: string,
    sourceIssue: string,
  ): FactoryHandoffRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM factory_handoff_records
         WHERE repo = ? AND source_issue = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(repo, sourceIssue) as HandoffRow | undefined;
    return row ? mapHandoffRow(row) : undefined;
  }

  acquireClaim(input: AcquireWorkflowClaimInput): AcquireWorkflowClaimResult {
    if (input.ttlMs <= 0)
      throw new Error('Workflow claim TTL must be positive');
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();

    const claim: FactoryWorkflowClaim = {
      workflowId: input.workflowId,
      repo: input.repo,
      ownerAgentId: input.ownerAgentId,
      ownerRunId: input.ownerRunId,
      phase: input.phase,
      claimedAt: nowIso,
      heartbeatAt: nowIso,
      expiresAt,
    };

    const transaction = this.db.transaction(() => {
      this.deleteExpiredClaims(nowIso);

      const existing = this.getClaim(input.workflowId);
      if (existing) return existing;

      this.db
        .prepare(
          `INSERT OR IGNORE INTO factory_workflow_claims
            (workflow_id, repo, owner_agent_id, owner_run_id, phase,
             claimed_at, heartbeat_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claim.workflowId,
          claim.repo,
          claim.ownerAgentId,
          claim.ownerRunId,
          claim.phase,
          claim.claimedAt,
          claim.heartbeatAt,
          claim.expiresAt,
        );

      return this.getClaim(input.workflowId);
    });

    const current = transaction() as FactoryWorkflowClaim | undefined;
    if (current?.ownerRunId === claim.ownerRunId) {
      return { acquired: true, claim: current };
    }

    if (current) return { acquired: false, conflict: current };

    throw new Error('Failed to acquire workflow claim');
  }

  refreshClaim(
    workflowId: string,
    ownerRunId: string,
    ttlMs: number,
    now = new Date(),
  ): FactoryWorkflowClaim | undefined {
    if (ttlMs <= 0) throw new Error('Workflow claim TTL must be positive');
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE factory_workflow_claims
         SET heartbeat_at = ?, expires_at = ?
         WHERE workflow_id = ? AND owner_run_id = ? AND expires_at > ?`,
      )
      .run(nowIso, expiresAt, workflowId, ownerRunId, nowIso);
    if (result.changes === 0) return undefined;
    return this.getClaim(workflowId);
  }

  releaseClaim(workflowId: string, ownerRunId?: string): void {
    if (ownerRunId) {
      this.db
        .prepare(
          'DELETE FROM factory_workflow_claims WHERE workflow_id = ? AND owner_run_id = ?',
        )
        .run(workflowId, ownerRunId);
      return;
    }
    this.db
      .prepare('DELETE FROM factory_workflow_claims WHERE workflow_id = ?')
      .run(workflowId);
  }

  getClaim(workflowId: string): FactoryWorkflowClaim | undefined {
    const row = this.db
      .prepare('SELECT * FROM factory_workflow_claims WHERE workflow_id = ?')
      .get(workflowId) as ClaimRow | undefined;
    return row ? mapClaimRow(row) : undefined;
  }

  deleteExpiredClaims(nowIso = new Date().toISOString()): number {
    const result = this.db
      .prepare('DELETE FROM factory_workflow_claims WHERE expires_at <= ?')
      .run(nowIso);
    return result.changes;
  }
}

function mapHandoffRow(row: HandoffRow): FactoryHandoffRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    repo: row.repo,
    sourceIssue: row.source_issue ?? undefined,
    sourcePr: row.source_pr ?? undefined,
    phase: row.phase as FactoryWorkflowPhase,
    ownerAgentId: row.owner_agent_id,
    driver: row.driver,
    intent: row.intent,
    summary: row.summary,
    body: row.body,
    decisions: parseJson<string[]>(row.decisions_json, []),
    artifacts: parseJson<FactoryWorkflowArtifact[]>(row.artifacts_json, []),
    blockers: parseJson<string[]>(row.blockers_json, []),
    nextDriver: row.next_driver ?? undefined,
    nextScope: row.next_scope ?? undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function mapClaimRow(row: ClaimRow): FactoryWorkflowClaim {
  return {
    workflowId: row.workflow_id,
    repo: row.repo,
    ownerAgentId: row.owner_agent_id,
    ownerRunId: row.owner_run_id,
    phase: row.phase as FactoryWorkflowPhase,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
