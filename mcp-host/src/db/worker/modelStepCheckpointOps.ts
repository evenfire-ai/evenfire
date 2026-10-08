/**
 * Worker-side operations for durable model-step checkpoints (#1043,
 * migration 017). Every write is one SQLite transaction. Writes made by a
 * running task carry a fence (`claim_owner` + `claim_generation`); a write
 * whose fence no longer matches affects zero rows and reports
 * `applied: false`, so a superseded writer can never touch a re-claimed
 * checkpoint.
 */
import type { Database, Statement } from 'better-sqlite3'

export type ModelStepCheckpointRowStatus =
  | 'open'
  | 'resumable'
  | 'claimed'
  | 'blocked'
  | 'completed'
  | 'abandoned'

export const LIVE_MODEL_STEP_CHECKPOINT_STATUSES: readonly ModelStepCheckpointRowStatus[] = [
  'open',
  'resumable',
  'claimed',
  'blocked',
]

export type ModelStepCheckpointEntryKind = 'message' | 'tool_dispatch' | 'tool_result'

export interface ModelStepCheckpointRow {
  checkpoint_id: string
  session_key: string
  origin_turn_number: number
  origin_task_id: string
  continuation_task_id: string | null
  version: number
  status: ModelStepCheckpointRowStatus
  provider: string
  model: string
  host_id: string
  principal: string
  loop_state: string | null
  task_budget: string | null
  claim_owner: string
  claim_generation: number
  claim_expires_at: number | null
  blocked_reason: string | null
  failed_at: number | null
  expires_at: number | null
  created_at: number
  updated_at: number
}

export interface ModelStepCheckpointEntryRow {
  checkpoint_id: string
  seq: number
  kind: ModelStepCheckpointEntryKind
  tool_call_id: string | null
  payload: string
  created_at: number
}

export interface ModelStepCheckpointEntryInput {
  kind: ModelStepCheckpointEntryKind
  toolCallId: string | null
  /** Already-sanitized JSON. Never logged. */
  payload: string
}

/** Identifies the single writer allowed to touch a checkpoint. */
export interface ModelStepCheckpointFence {
  checkpointId: string
  owner: string
  generation: number
}

export interface ModelStepCheckpointToolLedger {
  confirmed: number
  unknown: number
  notDispatched: number
}

export interface ModelStepCheckpointSnapshot {
  header: ModelStepCheckpointRow
  tools: ModelStepCheckpointToolLedger
}

export type ModelStepClaimOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'completed'; taskId: string }
  | { outcome: 'replayed'; taskId: string }
  | { outcome: 'blocked'; blockedReason: string }
  | { outcome: 'version_mismatch'; current: ModelStepCheckpointSnapshot }
  | {
      outcome: 'claimed'
      taskId: string
      reclaimed: boolean
      fence: ModelStepCheckpointFence
      snapshot: ModelStepCheckpointSnapshot
    }

export interface ModelStepCheckpointOpenHeader {
  checkpointId: string
  sessionKey: string
  originTurnNumber: number
  originTaskId: string
  provider: string
  model: string
  hostId: string
  principal: string
  loopState: string | null
  taskBudget: string | null
}

export type ModelStepCheckpointOp =
  | {
      /** Creates the `open` header (owner = origin task, generation 0) with its first entries. */
      kind: 'model_step_checkpoint_open'
      header: ModelStepCheckpointOpenHeader
      entries: ModelStepCheckpointEntryInput[]
      now: number
    }
  | {
      kind: 'model_step_checkpoint_append'
      fence: ModelStepCheckpointFence
      entries: ModelStepCheckpointEntryInput[]
      now: number
    }
  | {
      kind: 'model_step_checkpoint_update_state'
      fence: ModelStepCheckpointFence
      loopState: string
      taskBudget: string | null
      now: number
    }
  | {
      kind: 'model_step_checkpoint_transition'
      fence: ModelStepCheckpointFence
      from: ModelStepCheckpointRowStatus[]
      to: ModelStepCheckpointRowStatus
      now: number
      failedAt?: number
      expiresAt?: number
      blockedReason?: string
    }
  | {
      kind: 'model_step_checkpoint_renew_lease'
      fence: ModelStepCheckpointFence
      claimExpiresAt: number
      now: number
    }
  | {
      /** Applies the status-first precedence of the continuation POST in one transaction. */
      kind: 'model_step_checkpoint_claim'
      sessionKey: string
      checkpointId: string
      version: number
      hostInstanceId: string
      newTaskId: string
      leaseMs: number
      now: number
    }
  | { kind: 'model_step_checkpoint_load_live'; sessionKey: string }
  | { kind: 'model_step_checkpoint_load_entries'; checkpointId: string }
  | {
      /** Boot reaper: `open` → `abandoned`; `claimed` by another host → `resumable`. */
      kind: 'model_step_checkpoint_boot_reap'
      hostInstanceId: string
      now: number
    }
  | {
      /**
       * TTL: past `expires_at`, a `resumable`/`blocked` row, or a `claimed` row
       * whose lease also lapsed, → `abandoned`; entries of old terminal rows
       * are deleted.
       */
      kind: 'model_step_checkpoint_sweep'
      now: number
      terminalRetentionMs: number
    }

export type ModelStepCheckpointOpKind = ModelStepCheckpointOp['kind']

const WRITE_KINDS: ReadonlySet<ModelStepCheckpointOpKind> = new Set<ModelStepCheckpointOpKind>([
  'model_step_checkpoint_open',
  'model_step_checkpoint_append',
  'model_step_checkpoint_update_state',
  'model_step_checkpoint_transition',
  'model_step_checkpoint_renew_lease',
  'model_step_checkpoint_claim',
  'model_step_checkpoint_boot_reap',
  'model_step_checkpoint_sweep',
])

export function isModelStepCheckpointOp(op: { kind: string }): op is ModelStepCheckpointOp {
  return op.kind.startsWith('model_step_checkpoint_')
}

export function isModelStepCheckpointWriteOp(op: ModelStepCheckpointOp): boolean {
  return WRITE_KINDS.has(op.kind)
}

const LIVE_STATUS_SQL = "('open','resumable','claimed','blocked')"

interface Statements {
  insertHeader: Statement
  selectHeader: Statement
  selectLiveBySession: Statement
  selectMaxSeq: Statement
  insertEntry: Statement
  selectEntries: Statement
  selectFencedHeader: Statement
  updateState: Statement
  transition: Statement
  renewLease: Statement
  claim: Statement
  retireLiveBySession: Statement
  stampMessage: Statement
  selectOpen: Statement
  selectForeignClaims: Statement
  abandonById: Statement
  reopenClaim: Statement
  expireLive: Statement
  purgeTerminalEntries: Statement
  ledgerKinds: Statement
}

const statementCache = new WeakMap<Database, Statements>()

function statements(db: Database): Statements {
  const cached = statementCache.get(db)
  if (cached) return cached
  const prepared: Statements = {
    insertHeader: db.prepare(`
      INSERT INTO model_step_checkpoints (
        checkpoint_id, session_key, origin_turn_number, origin_task_id, continuation_task_id,
        version, status, provider, model, host_id, principal, loop_state, task_budget,
        claim_owner, claim_generation, claim_expires_at, blocked_reason, failed_at, expires_at,
        created_at, updated_at
      ) VALUES (
        @checkpoint_id, @session_key, @origin_turn_number, @origin_task_id, NULL,
        1, 'open', @provider, @model, @host_id, @principal, @loop_state, @task_budget,
        @origin_task_id, 0, NULL, NULL, NULL, NULL,
        @now, @now
      )
    `),
    selectHeader: db.prepare('SELECT * FROM model_step_checkpoints WHERE checkpoint_id = ?'),
    selectLiveBySession: db.prepare(
      `SELECT * FROM model_step_checkpoints WHERE session_key = ? AND status IN ${LIVE_STATUS_SQL}`
    ),
    selectMaxSeq: db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM model_step_checkpoint_entries WHERE checkpoint_id = ?'
    ),
    insertEntry: db.prepare(`
      INSERT INTO model_step_checkpoint_entries (checkpoint_id, seq, kind, tool_call_id, payload, created_at)
      VALUES (@checkpoint_id, @seq, @kind, @tool_call_id, @payload, @created_at)
    `),
    selectEntries: db.prepare(
      'SELECT * FROM model_step_checkpoint_entries WHERE checkpoint_id = ? ORDER BY seq'
    ),
    selectFencedHeader: db.prepare(`
      SELECT checkpoint_id FROM model_step_checkpoints
      WHERE checkpoint_id = @checkpoint_id AND claim_owner = @owner AND claim_generation = @generation
        AND status IN ${LIVE_STATUS_SQL}
    `),
    updateState: db.prepare(`
      UPDATE model_step_checkpoints
      SET loop_state = @loop_state, task_budget = @task_budget, updated_at = @now
      WHERE checkpoint_id = @checkpoint_id AND claim_owner = @owner AND claim_generation = @generation
        AND status IN ('open','claimed')
    `),
    transition: db.prepare(`
      UPDATE model_step_checkpoints
      SET status = @to, version = version + 1, updated_at = @now,
          failed_at = COALESCE(@failed_at, failed_at),
          expires_at = COALESCE(@expires_at, expires_at),
          blocked_reason = CASE WHEN @to = 'blocked' THEN @blocked_reason ELSE NULL END,
          claim_expires_at = CASE WHEN @to = 'claimed' THEN claim_expires_at ELSE NULL END
      WHERE checkpoint_id = @checkpoint_id AND claim_owner = @owner AND claim_generation = @generation
        AND status = @from
    `),
    renewLease: db.prepare(`
      UPDATE model_step_checkpoints
      SET claim_expires_at = @claim_expires_at, updated_at = @now
      WHERE checkpoint_id = @checkpoint_id AND claim_owner = @owner AND claim_generation = @generation
        AND status = 'claimed'
    `),
    claim: db.prepare(`
      UPDATE model_step_checkpoints
      SET status = 'claimed', version = version + 1, continuation_task_id = @task_id,
          claim_owner = @owner, claim_generation = claim_generation + 1,
          claim_expires_at = @claim_expires_at, blocked_reason = NULL, updated_at = @now
      WHERE checkpoint_id = @checkpoint_id AND version = @version
    `),
    retireLiveBySession: db.prepare(`
      UPDATE model_step_checkpoints
      SET status = 'abandoned', version = version + 1, claim_expires_at = NULL, updated_at = @now
      WHERE session_key = @session_key AND status IN ${LIVE_STATUS_SQL}
    `),
    stampMessage: db.prepare(
      'UPDATE messages SET model_step_checkpoint_id = @checkpoint_id WHERE session_id = @session_id AND ordinal = @ordinal'
    ),
    selectOpen: db.prepare(
      "SELECT checkpoint_id FROM model_step_checkpoints WHERE status = 'open'"
    ),
    selectForeignClaims: db.prepare(
      "SELECT checkpoint_id FROM model_step_checkpoints WHERE status = 'claimed' AND claim_owner != ?"
    ),
    abandonById: db.prepare(`
      UPDATE model_step_checkpoints
      SET status = 'abandoned', version = version + 1, claim_expires_at = NULL, updated_at = @now
      WHERE checkpoint_id = @checkpoint_id
    `),
    reopenClaim: db.prepare(`
      UPDATE model_step_checkpoints
      SET status = 'resumable', version = version + 1, claim_expires_at = NULL, updated_at = @now
      WHERE checkpoint_id = @checkpoint_id AND status = 'claimed'
    `),
    expireLive: db.prepare(`
      UPDATE model_step_checkpoints
      SET status = 'abandoned', version = version + 1, claim_expires_at = NULL, updated_at = @now
      WHERE expires_at IS NOT NULL AND expires_at <= @now
        AND (status IN ('resumable','blocked')
             OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= @now))
    `),
    purgeTerminalEntries: db.prepare(`
      DELETE FROM model_step_checkpoint_entries WHERE checkpoint_id IN (
        SELECT checkpoint_id FROM model_step_checkpoints
        WHERE status IN ('completed','abandoned') AND updated_at <= @cutoff
      )
    `),
    ledgerKinds: db.prepare(`
      SELECT kind, tool_call_id FROM model_step_checkpoint_entries
      WHERE checkpoint_id = ? AND kind IN ('tool_dispatch','tool_result')
    `),
  }
  statementCache.set(db, prepared)
  return prepared
}

/**
 * Tool ledger of a checkpoint. A dispatch with a recorded result is
 * `confirmed`; a dispatch without one is `unknown` (its effect may have
 * happened). Calls announced by the model but never dispatched are counted
 * from the message entries by the caller that reconstructs the transcript,
 * so this ledger reports them as 0.
 */
function ledger(s: Statements, checkpointId: string): ModelStepCheckpointToolLedger {
  const rows = s.ledgerKinds.all(checkpointId) as Array<{
    kind: ModelStepCheckpointEntryKind
    tool_call_id: string | null
  }>
  const dispatched = new Set<string>()
  const resulted = new Set<string>()
  for (const row of rows) {
    if (row.tool_call_id === null) continue
    if (row.kind === 'tool_dispatch') dispatched.add(row.tool_call_id)
    else resulted.add(row.tool_call_id)
  }
  let unknown = 0
  for (const id of dispatched) if (!resulted.has(id)) unknown += 1
  return { confirmed: resulted.size, unknown, notDispatched: 0 }
}

function snapshot(s: Statements, header: ModelStepCheckpointRow): ModelStepCheckpointSnapshot {
  return { header, tools: ledger(s, header.checkpoint_id) }
}

function appendEntries(
  s: Statements,
  checkpointId: string,
  entries: ModelStepCheckpointEntryInput[],
  now: number
): void {
  let seq = (s.selectMaxSeq.get(checkpointId) as { max_seq: number }).max_seq
  for (const entry of entries) {
    seq += 1
    s.insertEntry.run({
      checkpoint_id: checkpointId,
      seq,
      kind: entry.kind,
      tool_call_id: entry.toolCallId,
      payload: entry.payload,
      created_at: now,
    })
  }
}

function fenceParams(fence: ModelStepCheckpointFence) {
  return {
    checkpoint_id: fence.checkpointId,
    owner: fence.owner,
    generation: fence.generation,
  }
}

/**
 * Retires every live checkpoint of a session. Runs inside the transaction
 * that admits a new turn (`persist_turn_boundary` with a user message).
 */
export function retireLiveModelStepCheckpoints(
  db: Database,
  sessionKey: string,
  now: number
): void {
  statements(db).retireLiveBySession.run({ session_key: sessionKey, now })
}

/**
 * Completes a claimed checkpoint and stamps the continuation's final message,
 * inside the transaction that writes that message. A fence mismatch throws so
 * the whole boundary rolls back: a superseded continuation never writes a
 * final answer.
 */
export function completeModelStepCheckpointWithMessage(
  db: Database,
  fence: ModelStepCheckpointFence,
  message: { session_id: string; ordinal: number },
  now: number
): void {
  const s = statements(db)
  const result = s.transition.run({
    ...fenceParams(fence),
    from: 'claimed',
    to: 'completed',
    now,
    failed_at: null,
    expires_at: null,
    blocked_reason: null,
  })
  if (result.changes !== 1) {
    throw new Error('model-step checkpoint fence mismatch on completion')
  }
  s.stampMessage.run({
    checkpoint_id: fence.checkpointId,
    session_id: message.session_id,
    ordinal: message.ordinal,
  })
}

/** Executes one checkpoint op inside an IMMEDIATE transaction where it writes. */
export function dispatchModelStepCheckpointOp(op: ModelStepCheckpointOp, db: Database): unknown {
  const s = statements(db)
  switch (op.kind) {
    case 'model_step_checkpoint_open': {
      const tx = db.transaction(() => {
        s.insertHeader.run({
          checkpoint_id: op.header.checkpointId,
          session_key: op.header.sessionKey,
          origin_turn_number: op.header.originTurnNumber,
          origin_task_id: op.header.originTaskId,
          provider: op.header.provider,
          model: op.header.model,
          host_id: op.header.hostId,
          principal: op.header.principal,
          loop_state: op.header.loopState,
          task_budget: op.header.taskBudget,
          now: op.now,
        })
        appendEntries(s, op.header.checkpointId, op.entries, op.now)
      })
      tx.immediate()
      return { applied: true }
    }

    case 'model_step_checkpoint_append': {
      const tx = db.transaction((): boolean => {
        if (!s.selectFencedHeader.get(fenceParams(op.fence))) return false
        appendEntries(s, op.fence.checkpointId, op.entries, op.now)
        return true
      })
      return { applied: tx.immediate() }
    }

    case 'model_step_checkpoint_update_state': {
      const tx = db.transaction(
        () =>
          s.updateState.run({
            ...fenceParams(op.fence),
            loop_state: op.loopState,
            task_budget: op.taskBudget,
            now: op.now,
          }).changes === 1
      )
      return { applied: tx.immediate() }
    }

    case 'model_step_checkpoint_transition': {
      const tx = db.transaction((): { applied: boolean; version?: number } => {
        for (const from of op.from) {
          const changed = s.transition.run({
            ...fenceParams(op.fence),
            from,
            to: op.to,
            now: op.now,
            failed_at: op.failedAt ?? null,
            expires_at: op.expiresAt ?? null,
            blocked_reason: op.blockedReason ?? null,
          }).changes
          if (changed === 1) {
            const header = s.selectHeader.get(op.fence.checkpointId) as ModelStepCheckpointRow
            return { applied: true, version: header.version }
          }
        }
        return { applied: false }
      })
      return tx.immediate()
    }

    case 'model_step_checkpoint_renew_lease': {
      const tx = db.transaction(
        () =>
          s.renewLease.run({
            ...fenceParams(op.fence),
            claim_expires_at: op.claimExpiresAt,
            now: op.now,
          }).changes === 1
      )
      return { applied: tx.immediate() }
    }

    case 'model_step_checkpoint_claim': {
      const tx = db.transaction((): ModelStepClaimOutcome => {
        const header = s.selectHeader.get(op.checkpointId) as ModelStepCheckpointRow | undefined
        // Status first; the version only matters for a resumable checkpoint.
        if (
          !header ||
          header.session_key !== op.sessionKey ||
          header.status === 'abandoned' ||
          header.status === 'open'
        ) {
          return { outcome: 'not_found' }
        }
        if (header.status === 'completed') {
          return { outcome: 'completed', taskId: requireTaskId(header) }
        }
        if (header.status === 'blocked') {
          return { outcome: 'blocked', blockedReason: header.blocked_reason ?? '' }
        }
        let reclaimed = false
        if (header.status === 'claimed') {
          if (header.claim_expires_at !== null && header.claim_expires_at > op.now) {
            return { outcome: 'replayed', taskId: requireTaskId(header) }
          }
          reclaimed = true
        } else if (header.version !== op.version) {
          return { outcome: 'version_mismatch', current: snapshot(s, header) }
        }
        const changed = s.claim.run({
          checkpoint_id: header.checkpoint_id,
          version: header.version,
          task_id: op.newTaskId,
          owner: op.hostInstanceId,
          claim_expires_at: op.now + op.leaseMs,
          now: op.now,
        }).changes
        if (changed !== 1) {
          throw new Error('model-step checkpoint claim lost inside its own transaction')
        }
        const claimed = s.selectHeader.get(header.checkpoint_id) as ModelStepCheckpointRow
        return {
          outcome: 'claimed',
          taskId: op.newTaskId,
          reclaimed,
          fence: {
            checkpointId: claimed.checkpoint_id,
            owner: claimed.claim_owner,
            generation: claimed.claim_generation,
          },
          snapshot: snapshot(s, claimed),
        }
      })
      return tx.immediate()
    }

    case 'model_step_checkpoint_load_live': {
      const header = s.selectLiveBySession.get(op.sessionKey) as ModelStepCheckpointRow | undefined
      return header ? snapshot(s, header) : null
    }

    case 'model_step_checkpoint_load_entries':
      return s.selectEntries.all(op.checkpointId) as ModelStepCheckpointEntryRow[]

    case 'model_step_checkpoint_boot_reap': {
      const tx = db.transaction(() => {
        const open = s.selectOpen.all() as Array<{ checkpoint_id: string }>
        for (const row of open) s.abandonById.run({ checkpoint_id: row.checkpoint_id, now: op.now })
        const foreign = s.selectForeignClaims.all(op.hostInstanceId) as Array<{
          checkpoint_id: string
        }>
        for (const row of foreign)
          s.reopenClaim.run({ checkpoint_id: row.checkpoint_id, now: op.now })
        return { abandoned: open.length, reopened: foreign.length }
      })
      return tx.immediate()
    }

    case 'model_step_checkpoint_sweep': {
      const tx = db.transaction(() => {
        const expired = s.expireLive.run({ now: op.now }).changes
        const purged = s.purgeTerminalEntries.run({
          cutoff: op.now - op.terminalRetentionMs,
        }).changes
        return { expired, purgedEntries: purged }
      })
      return tx.immediate()
    }
  }
}

function requireTaskId(header: ModelStepCheckpointRow): string {
  if (!header.continuation_task_id) {
    throw new Error(
      `model-step checkpoint ${header.checkpoint_id} is ${header.status} without a continuation task id`
    )
  }
  return header.continuation_task_id
}
