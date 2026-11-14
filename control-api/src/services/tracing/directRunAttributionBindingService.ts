import { createHash } from 'node:crypto'
import type { DbClient } from '../../db.js'
import { recordGovernedTraceOperationalError } from '../../observability/metrics.js'
import { stableStringify } from '../../utils/stableStringify.js'

export type DirectRunBindingOrigin = 'direct_chat' | 'channel_event' | 'api'

export type VerifiedDirectRunBindingInput = {
  runId: string
  hostRef: string
  /**
   * The namespace control-api verified the Host in, or null for a binding whose
   * writer does not verify one (channel runs). Stored so agent file activity can
   * be attributed only to a run bound for exactly `<namespace>/<hostRef>` (D14).
   */
  hostNamespace: string | null
  sessionId: string
  origin: DirectRunBindingOrigin
  identityIssuer: string
  actorHumanSub: string
  userId: string | null
  teamId: string | null
}

export type DirectRunBindingResult = {
  runId: string
  status: 'created' | 'existing'
  createdAt: string
}

export class DirectRunBindingConflictError extends Error {
  readonly status = 409
  readonly statusCode = 409
  readonly code = 'direct_run_binding_conflict'

  constructor() {
    super('run id is already bound to different immutable attribution facts')
    this.name = 'DirectRunBindingConflictError'
  }
}

/**
 * The digest that makes a re-bind idempotent. `hostNamespace` is deliberately
 * NOT part of it: rpc-proxy reuses a run id on a client retry, so during a
 * rolling deploy a first bind by an old pod and the retry on a new pod would
 * compute different digests and the retry would fail the user's message with
 * `direct_run_binding_conflict`. Two binds of one run id with different
 * namespaces require two control-api deployments with different
 * `CONTROL_API_HOSTS_NAMESPACE` on one database, which is not a supported
 * topology.
 */
function bindingSha256(input: VerifiedDirectRunBindingInput): string {
  return createHash('sha256')
    .update(
      stableStringify({
        runId: input.runId.toLowerCase(),
        hostRef: input.hostRef,
        sessionId: input.sessionId,
        origin: input.origin,
        identityIssuer: input.identityIssuer,
        actorHumanSub: input.actorHumanSub,
        userId: input.userId,
        teamId: input.teamId,
      })
    )
    .digest('hex')
}

export class DirectRunAttributionBindingService {
  constructor(
    private readonly transaction: <T>(work: (db: DbClient) => Promise<T>) => Promise<T>,
    private readonly recordOperationalError = recordGovernedTraceOperationalError
  ) {}

  async bind(input: VerifiedDirectRunBindingInput): Promise<DirectRunBindingResult> {
    const runId = input.runId.toLowerCase()
    const digest = bindingSha256({ ...input, runId })
    try {
      return await this.transaction(async db => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [runId])
        const inserted = await db.query(
          `INSERT INTO governed_run_attribution_bindings
           (run_id, host_ref, host_namespace, session_id, origin, identity_issuer, actor_human_sub,
            user_id, team_id, binding_sha256)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9::uuid, $10)
         ON CONFLICT (run_id) DO NOTHING
         RETURNING created_at`,
          [
            runId,
            input.hostRef,
            input.hostNamespace,
            input.sessionId,
            input.origin,
            input.identityIssuer,
            input.actorHumanSub,
            input.userId,
            input.teamId,
            digest,
          ]
        )
        if ((inserted.rowCount ?? 0) === 1) {
          const row = inserted.rows[0] as { created_at: string | Date }
          return { runId, status: 'created', createdAt: new Date(row.created_at).toISOString() }
        }
        const existing = await db.query(
          `SELECT binding_sha256, created_at
             FROM governed_run_attribution_bindings
            WHERE run_id = $1::uuid`,
          [runId]
        )
        const row = existing.rows[0] as
          | { binding_sha256: string; created_at: string | Date }
          | undefined
        if (!row || row.binding_sha256 !== digest) throw new DirectRunBindingConflictError()
        return { runId, status: 'existing', createdAt: new Date(row.created_at).toISOString() }
      })
    } catch (error) {
      this.recordOperationalError(
        'agent_run',
        error instanceof DirectRunBindingConflictError
          ? 'attribution_binding_conflict'
          : 'attribution_binding_unavailable'
      )
      throw error
    }
  }
}
