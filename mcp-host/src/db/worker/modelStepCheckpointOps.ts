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
  source_message: string | null
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

/**
 * Raw bytes of one inline uploaded file, held for a continuation (migration
 * 018). Crosses the worker boundary as a Uint8Array, never base64.
 */
export interface ModelStepCheckpointAttachmentInput {
  attachmentId: string
  /** sha256 of `bytes`, lowercase hex; re-verified when loaded. */
  digestHex: string
  bytes: Uint8Array
  /** Absolute first-capture expiry; a duplicate write cannot change it. */
  expiresAt: number
}

export interface ModelStepCheckpointAttachmentRow {
  attachment_id: string
  digest_hex: string
  size_bytes: number
  bytes: Uint8Array
  expires_at: number
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
  /**
   * JSON of the turn's `ResumeSourceMessage` (metadata, no inline bytes); the
   * continuation rebuilds file-reference pins and attachment lines from it.
   */
  sourceMessage: string | null
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
      provider?: string
      model?: string
      /**
       * Bytes of inline uploaded files and transcript images, written in the
       * same transaction and only with `to: 'resumable'`. Each byte carries
       * its immutable first-capture expiry.
       */
      attachments?: ModelStepCheckpointAttachmentInput[]
      taskBudget?: string
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
  | {
      /** Admission failed before a task took ownership: retire its claim and reopen the session atomically. */
      kind: 'model_step_checkpoint_abandon_admission'
      sessionKey: string
      taskId: string
      fence: ModelStepCheckpointFence
      now: number
    }
  | { kind: 'model_step_checkpoint_load_live'; sessionKey: string }
  | { kind: 'model_step_checkpoint_load_for_task'; sessionKey: string; taskId: string }
  | { kind: 'model_step_checkpoint_load_entries'; checkpointId: string }
  | {
      /** Unexpired attachment bytes of a checkpoint that is resumable or claimed. */
      kind: 'model_step_checkpoint_load_attachments'
      checkpointId: string
      now: number
    }
  | {
      /** Boot reaper: abandon `open`, adopt claims with live approvals, reopen other foreign claims. */
      kind: 'model_step_checkpoint_boot_reap'
      hostInstanceId: string
      now: number
    }
  | {
      /**
       * TTL: past `expires_at`, a `resumable`/`blocked` row, or a `claimed` row
       * whose lease also lapsed, → `abandoned`; terminal headers older than
       * the retention are deleted with their entries and attachments;
       * expired or orphaned attachment bytes are deleted.
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
  'model_step_checkpoint_abandon_admission',
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
  adoptApprovalClaims: Statement
  selectForeignClaims: Statement
  abandonById: Statement
  reopenClaim: Statement
  expireLive: Statement
  deleteTerminalHeaders: Statement
  ledgerKinds: Statement
  insertAttachment: Statement
  selectAttachmentById: Statement
  selectAttachments: Statement
  deleteAttachmentsOf: Statement
  deleteDeadAttachments: Statement
  deleteOfEndedSessions: Statement
  deleteOfClosedSessions: Statement
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
        source_message,
        claim_owner, claim_generation, claim_expires_at, blocked_reason, failed_at, expires_at,
        created_at, updated_at
      ) VALUES (
        @checkpoint_id, @session_key, @origin_turn_number, @origin_task_id, NULL,
        1, 'open', @provider, @model, @host_id, @principal, @loop_state, @task_budget,
        @source_message,
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
    // A blocked row may come from an older checkpoint with a null deadline.
    // Reuse the source checkpoint's configured lifetime when present; the
    // historical null case receives the original seven-day default.
    transition: db.prepare(`
      UPDATE model_step_checkpoints
      SET status = @to, version = version + 1, updated_at = @now,
          failed_at = COALESCE(@failed_at, failed_at),
          expires_at = CASE WHEN @to = 'blocked'
            THEN @now + COALESCE(expires_at - failed_at, 604800000)
            ELSE COALESCE(@expires_at, expires_at) END,
          blocked_reason = CASE WHEN @to = 'blocked' THEN @blocked_reason ELSE NULL END,
          provider = COALESCE(@provider, provider), model = COALESCE(@model, model),
          task_budget = COALESCE(@task_budget, task_budget),
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
        AND status IN ('resumable','claimed')
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
    adoptApprovalClaims: db.prepare(`
      UPDATE model_step_checkpoints
      SET claim_owner = @owner, claim_generation = claim_generation + 1,
          claim_expires_at = (
            SELECT CAST(p.expires_at * 1000 AS INTEGER)
            FROM pending_approvals p JOIN sessions sess ON sess.id = p.session_id
            WHERE sess.session_key = model_step_checkpoints.session_key
              AND p.task_id = model_step_checkpoints.continuation_task_id
              AND sess.active_task_id = p.task_id AND sess.state = 'awaiting_approval'
              AND p.expires_at > @now / 1000
            LIMIT 1
          ), updated_at = @now
      WHERE status = 'claimed' AND claim_owner != @owner
        AND EXISTS (
          SELECT 1 FROM pending_approvals p JOIN sessions sess ON sess.id = p.session_id
          WHERE sess.session_key = model_step_checkpoints.session_key
            AND p.task_id = model_step_checkpoints.continuation_task_id
            AND sess.active_task_id = p.task_id AND sess.state = 'awaiting_approval'
            AND p.expires_at > @now / 1000
        )
    `),
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
             OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= @now
                 AND NOT EXISTS (
                   SELECT 1 FROM pending_approvals p JOIN sessions sess ON sess.id = p.session_id
                   WHERE sess.session_key = model_step_checkpoints.session_key
                     AND p.task_id = model_step_checkpoints.continuation_task_id
                     AND sess.active_task_id = p.task_id AND sess.state = 'awaiting_approval'
                     AND p.expires_at > @now / 1000
                 )))
    `),
    // Entries and attachments go with the header (ON DELETE CASCADE).
    deleteTerminalHeaders: db.prepare(`
      DELETE FROM model_step_checkpoints
      WHERE status IN ('completed','abandoned') AND updated_at <= @cutoff
    `),
    ledgerKinds: db.prepare(`
      SELECT kind, tool_call_id, payload FROM model_step_checkpoint_entries
      WHERE checkpoint_id = ? AND kind IN ('message','tool_dispatch','tool_result')
    `),
    insertAttachment: db.prepare(`
      INSERT INTO model_step_checkpoint_attachments
        (checkpoint_id, attachment_id, digest_hex, size_bytes, bytes, expires_at, created_at)
      VALUES (@checkpoint_id, @attachment_id, @digest_hex, @size_bytes, @bytes, @expires_at, @now)
      ON CONFLICT(checkpoint_id, attachment_id) DO NOTHING
    `),
    selectAttachmentById: db.prepare(`
      SELECT attachment_id, digest_hex, size_bytes, bytes, expires_at
      FROM model_step_checkpoint_attachments
      WHERE checkpoint_id = @checkpoint_id AND attachment_id = @attachment_id
    `),
    selectAttachments: db.prepare(`
      SELECT a.attachment_id, a.digest_hex, a.size_bytes, a.bytes, a.expires_at
      FROM model_step_checkpoint_attachments a
      JOIN model_step_checkpoints c ON c.checkpoint_id = a.checkpoint_id
      WHERE a.checkpoint_id = @checkpoint_id AND a.expires_at > @now
        AND c.status IN ('resumable','claimed')
      ORDER BY a.attachment_id
    `),
    deleteAttachmentsOf: db.prepare(
      'DELETE FROM model_step_checkpoint_attachments WHERE checkpoint_id = ?'
    ),
    // Bytes are needed only while a checkpoint can still continue.
    deleteDeadAttachments: db.prepare(`
      DELETE FROM model_step_checkpoint_attachments
      WHERE expires_at <= @now OR checkpoint_id IN (
        SELECT checkpoint_id FROM model_step_checkpoints
        WHERE status NOT IN ('resumable','claimed')
      )
    `),
    // Same predicates as `sweepEndedSessions` / `sweepClosedSessions`: the
    // header has no FK to `sessions`, so its rows go in the same transaction.
    deleteOfEndedSessions: db.prepare(`
      DELETE FROM model_step_checkpoints WHERE session_key IN (
        SELECT session_key FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?
      )
    `),
    deleteOfClosedSessions: db.prepare(`
      DELETE FROM model_step_checkpoints WHERE session_key IN (
        SELECT session_key FROM sessions
        WHERE end_reason IS NOT NULL AND ended_at IS NOT NULL AND ended_at < ?
      )
    `),
  }
  statementCache.set(db, prepared)
  return prepared
}

/**
 * Tool ledger of a checkpoint. A dispatch with a recorded result is
 * `confirmed`; a dispatch without one is `unknown` (its effect may have
 * happened). Assistant messages also record the calls the model announced;
 * any such call without a dispatch is `notDispatched`.
 */
function ledger(s: Statements, checkpointId: string): ModelStepCheckpointToolLedger {
  const rows = s.ledgerKinds.all(checkpointId) as Array<{
    kind: ModelStepCheckpointEntryKind
    tool_call_id: string | null
    payload: string
  }>
  const announced = new Set<string>()
  const dispatched = new Set<string>()
  const resulted = new Set<string>()
  for (const row of rows) {
    if (row.kind === 'message') {
      const message = JSON.parse(row.payload) as {
        role?: string
        tool_calls?: Array<{ id?: string }> | null
      }
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (typeof call.id === 'string') announced.add(call.id)
        }
      }
      continue
    }
    if (row.tool_call_id === null) continue
    if (row.kind === 'tool_dispatch') dispatched.add(row.tool_call_id)
    else resulted.add(row.tool_call_id)
  }
  let unknown = 0
  for (const id of dispatched) if (!resulted.has(id)) unknown += 1
  let notDispatched = 0
  for (const id of announced) if (!dispatched.has(id)) notDispatched += 1
  return { confirmed: resulted.size, unknown, notDispatched }
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
  const s = statements(db)
  s.retireLiveBySession.run({ session_key: sessionKey, now })
  s.deleteDeadAttachments.run({ now })
}

/**
 * Deletes the checkpoints of the sessions a retention sweep is about to
 * delete. Call inside that sweep's transaction, before the session DELETE.
 */
export function deleteModelStepCheckpointsOfSweptSessions(
  db: Database,
  sweep: { kind: 'ended' | 'closed'; cutoff: number }
): number {
  const s = statements(db)
  const statement = sweep.kind === 'ended' ? s.deleteOfEndedSessions : s.deleteOfClosedSessions
  return statement.run(sweep.cutoff).changes
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
    provider: null,
    model: null,
    // Completion keeps the budget the checkpoint already holds.
    task_budget: null,
  })
  if (result.changes !== 1) {
    throw new Error('model-step checkpoint fence mismatch on completion')
  }
  s.deleteAttachmentsOf.run(fence.checkpointId)
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
          source_message: op.header.sourceMessage,
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
      if (
        (op.provider === undefined) !== (op.model === undefined) ||
        (op.provider !== undefined && (op.to !== 'resumable' || !op.provider || !op.model))
      ) {
        throw new Error(
          'model-step checkpoint served pair requires a complete resumable transition'
        )
      }
      if (op.attachments !== undefined && op.to !== 'resumable') {
        throw new Error('model-step checkpoint attachments are written only with resumable')
      }
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
            provider: op.provider ?? null,
            model: op.model ?? null,
            task_budget: op.taskBudget ?? null,
          }).changes
          if (changed === 1) {
            if (op.to === 'resumable') {
              for (const attachment of op.attachments ?? []) {
                if (!Number.isSafeInteger(attachment.expiresAt) || attachment.expiresAt <= op.now) {
                  throw new Error(
                    `model-step checkpoint attachment ${attachment.attachmentId} has an invalid or expired deadline`
                  )
                }
                const existing = s.selectAttachmentById.get({
                  checkpoint_id: op.fence.checkpointId,
                  attachment_id: attachment.attachmentId,
                }) as ModelStepCheckpointAttachmentRow | undefined
                if (existing) {
                  if (
                    existing.digest_hex !== attachment.digestHex ||
                    existing.size_bytes !== attachment.bytes.byteLength ||
                    existing.expires_at !== attachment.expiresAt ||
                    Buffer.compare(Buffer.from(existing.bytes), Buffer.from(attachment.bytes)) !== 0
                  ) {
                    throw new Error(
                      `model-step checkpoint attachment ${attachment.attachmentId} conflicts with its first capture`
                    )
                  }
                  continue
                }
                s.insertAttachment.run({
                  checkpoint_id: op.fence.checkpointId,
                  attachment_id: attachment.attachmentId,
                  digest_hex: attachment.digestHex,
                  size_bytes: attachment.bytes.byteLength,
                  bytes: Buffer.from(
                    attachment.bytes.buffer,
                    attachment.bytes.byteOffset,
                    attachment.bytes.byteLength
                  ),
                  expires_at: attachment.expiresAt,
                  now: op.now,
                })
              }
            } else if (op.to !== 'claimed') {
              s.deleteAttachmentsOf.run(op.fence.checkpointId)
            }
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

    case 'model_step_checkpoint_abandon_admission': {
      const tx = db.transaction(() => {
        const changed = db
          .prepare(
            `UPDATE model_step_checkpoints
                SET status = 'abandoned', version = version + 1,
                    claim_expires_at = NULL, updated_at = @now
              WHERE checkpoint_id = @checkpoint_id AND session_key = @session_key
                AND continuation_task_id = @task_id AND status = 'claimed'
                AND claim_owner = @owner AND claim_generation = @generation`
          )
          .run({
            checkpoint_id: op.fence.checkpointId,
            session_key: op.sessionKey,
            task_id: op.taskId,
            owner: op.fence.owner,
            generation: op.fence.generation,
            now: op.now,
          }).changes
        if (changed !== 1) return { applied: false, resetSession: false }
        const resetSession =
          db
            .prepare(
              `UPDATE sessions
                SET state = 'idle', active_task_id = NULL, active_trace_context = NULL
              WHERE session_key = ? AND active_task_id = ?
                AND state IN ('processing', 'awaiting_approval')`
            )
            .run(op.sessionKey, op.taskId).changes === 1
        if (resetSession) {
          db.prepare(
            `DELETE FROM pending_approvals
              WHERE task_id = ? AND session_id =
                (SELECT id FROM sessions WHERE session_key = ?)`
          ).run(op.taskId, op.sessionKey)
        }
        return { applied: true, resetSession }
      })
      return tx.immediate()
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
        // C9 — the periodic sweep abandons an expired non-terminal row; a claim
        // that arrives before the sweep must answer exactly the same way
        // instead of resurrecting it. A claimed row whose lease is still alive
        // keeps replaying: the in-flight continuation owns it, header expiry or
        // not.
        const nonTerminal =
          header.status === 'resumable' ||
          header.status === 'claimed' ||
          header.status === 'blocked'
        const approvalAlive =
          header.status === 'claimed' &&
          db
            .prepare(
              `SELECT 1 FROM pending_approvals p
               JOIN sessions sess ON sess.id = p.session_id
               WHERE sess.session_key = ? AND p.task_id = ?
                 AND sess.active_task_id = p.task_id
                 AND sess.state = 'awaiting_approval' AND p.expires_at > ? / 1000
               LIMIT 1`
            )
            .get(header.session_key, header.continuation_task_id, op.now) !== undefined
        const leaseAlive =
          header.status === 'claimed' &&
          ((header.claim_expires_at !== null && header.claim_expires_at > op.now) || approvalAlive)
        if (
          nonTerminal &&
          header.expires_at !== null &&
          header.expires_at <= op.now &&
          !leaseAlive
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
          if (leaseAlive) {
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

    case 'model_step_checkpoint_load_for_task': {
      const header = db
        .prepare(
          `SELECT * FROM model_step_checkpoints
           WHERE session_key = ? AND continuation_task_id = ?
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(op.sessionKey, op.taskId) as ModelStepCheckpointRow | undefined
      return header ? snapshot(s, header) : null
    }

    case 'model_step_checkpoint_load_entries':
      return s.selectEntries.all(op.checkpointId) as ModelStepCheckpointEntryRow[]

    case 'model_step_checkpoint_load_attachments':
      return s.selectAttachments.all({
        checkpoint_id: op.checkpointId,
        now: op.now,
      }) as ModelStepCheckpointAttachmentRow[]

    case 'model_step_checkpoint_boot_reap': {
      const tx = db.transaction(() => {
        const open = s.selectOpen.all() as Array<{ checkpoint_id: string }>
        for (const row of open) s.abandonById.run({ checkpoint_id: row.checkpoint_id, now: op.now })
        s.adoptApprovalClaims.run({ owner: op.hostInstanceId, now: op.now })
        const foreign = s.selectForeignClaims.all(op.hostInstanceId) as Array<{
          checkpoint_id: string
        }>
        for (const row of foreign)
          s.reopenClaim.run({ checkpoint_id: row.checkpoint_id, now: op.now })
        s.deleteDeadAttachments.run({ now: op.now })
        return { abandoned: open.length, reopened: foreign.length }
      })
      return tx.immediate()
    }

    case 'model_step_checkpoint_sweep': {
      const tx = db.transaction(() => {
        const expired = s.expireLive.run({ now: op.now }).changes
        const purgedCheckpoints = s.deleteTerminalHeaders.run({
          cutoff: op.now - op.terminalRetentionMs,
        }).changes
        const purgedAttachments = s.deleteDeadAttachments.run({ now: op.now }).changes
        return { expired, purgedCheckpoints, purgedAttachments }
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
