import { createHash } from 'node:crypto'
import { type DbClient, pool } from '../db.js'
import { stableStringify } from '../utils/stableStringify.js'
import { consumeApprovalForTrigger } from './userApprovalRequestService.js'

export type WorkflowRunPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Canceled'

export type WorkflowRunActorType = 'user' | 'admin' | 'autonomous' | 'scheduled'

export interface WorkflowRunRow {
  run_id: string
  recipe_namespace: string
  recipe_name: string
  phase: WorkflowRunPhase
  actor_type: WorkflowRunActorType
  team_id: string | null
  usage_team_id: string | null
  actor_id: string | null
  idempotency_key: string | null
  trigger_source: string
  inputs: Record<string, unknown> | null
  intermediate_parameters: Record<string, unknown> | null
  output_overrides: Record<string, unknown> | null
  child_recipe_name: string | null
  child_recipe_namespace: string | null
  owner_instance_id: string | null
  max_duration_seconds: number | null
  ttl_seconds_after_finished: number | null
  approval_request_id: string | null
  idempotency_payload_hash: string | null
  started_at: string | null
  completed_at: string | null
  last_reconciled_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateRunInput {
  recipe_namespace: string
  recipe_name: string
  actor_type: WorkflowRunActorType
  team_id?: string | null
  usage_team_id?: string | null
  actor_id: string | null
  idempotency_key: string | null
  trigger_source: string
  inputs?: Record<string, unknown> | null
  intermediate_parameters?: Record<string, unknown> | null
  output_overrides?: Record<string, unknown> | null
  max_duration_seconds?: number | null
  ttl_seconds_after_finished?: number | null
}

export interface CreateApprovedRunInput extends CreateRunInput {
  approval_request_id: string
  idempotency_payload_hash: string
  approval_caller_key: string
  correlation_id: string
}

export interface CreateRunResult {
  row: WorkflowRunRow
  created: boolean
}

export class WorkflowRunIdempotencyConflictError extends Error {
  constructor(message = 'Idempotency-Key was reused with a different workflow trigger payload') {
    super(message)
    this.name = 'WorkflowRunIdempotencyConflictError'
  }
}

type WorkflowApprovalTriggerRunIntentRow = {
  triggerNamespace: string
  triggerName: string
  callerKey: string
  actorType: WorkflowRunActorType
  actorId: string | null
  teamId: string | null
  usageTeamId: string | null
  triggerSource: string
  idempotencyKey: string
  inputs: Record<string, unknown> | null
  intermediateParameters: Record<string, unknown> | null
  outputOverrides: Record<string, unknown> | null
  maxDurationSeconds: number | null
  ttlSecondsAfterFinished: number | null
  idempotencyPayloadHash: string
}

function getDb(db?: DbClient): DbClient {
  return db ?? pool
}

async function resolveApprovedRunInputFromIntent(
  client: DbClient,
  input: CreateApprovedRunInput
): Promise<CreateApprovedRunInput> {
  const intent = await client.query(
    `SELECT wati.trigger_namespace AS "triggerNamespace",
            wati.trigger_name AS "triggerName",
            wati.trigger_caller_key AS "callerKey",
            watri.actor_type AS "actorType",
            watri.actor_id AS "actorId",
            watri.team_id AS "teamId",
            watri.usage_team_id AS "usageTeamId",
            watri.trigger_source AS "triggerSource",
            watri.idempotency_key AS "idempotencyKey",
            watri.inputs,
            watri.intermediate_parameters AS "intermediateParameters",
            watri.output_overrides AS "outputOverrides",
            watri.max_duration_seconds AS "maxDurationSeconds",
            watri.ttl_seconds_after_finished AS "ttlSecondsAfterFinished",
            watri.idempotency_payload_hash AS "idempotencyPayloadHash"
       FROM workflow_approval_trigger_run_intents watri
       JOIN workflow_approval_trigger_intents wati
         ON wati.approval_request_id = watri.approval_request_id
      WHERE watri.approval_request_id = $1`,
    [input.approval_request_id]
  )

  // Legacy approvals created before typed run intents still rely on the
  // caller-provided fallback payload for idempotency and attribution.
  if ((intent.rowCount ?? 0) === 0) return input

  const row = intent.rows[0] as WorkflowApprovalTriggerRunIntentRow
  if (
    row.triggerNamespace !== input.recipe_namespace ||
    row.triggerName !== input.recipe_name ||
    row.callerKey !== input.approval_caller_key ||
    row.idempotencyKey !== input.idempotency_key
  ) {
    throw new WorkflowRunIdempotencyConflictError()
  }

  return {
    ...input,
    actor_type: row.actorType,
    actor_id: row.actorId,
    team_id: row.teamId,
    usage_team_id: row.usageTeamId,
    trigger_source: row.triggerSource,
    inputs: row.inputs ?? null,
    intermediate_parameters: row.intermediateParameters ?? null,
    output_overrides: row.outputOverrides ?? null,
    max_duration_seconds: row.maxDurationSeconds,
    ttl_seconds_after_finished: row.ttlSecondsAfterFinished,
    idempotency_payload_hash: row.idempotencyPayloadHash,
  }
}

export function computeWorkflowRunPayloadHash(params: {
  recipeNamespace: string
  recipeName: string
  actorType: WorkflowRunActorType
  actorId: string | null
  idempotencyKey: string
  triggerSource: string
  approvalRequestId: string
  callerKey: string
  inputs?: Record<string, unknown> | null
  intermediateParameters?: Record<string, unknown> | null
  outputOverrides?: Record<string, unknown> | null
}): string {
  const canonical = stableStringify({
    recipeNamespace: params.recipeNamespace,
    recipeName: params.recipeName,
    actorType: params.actorType,
    actorId: params.actorId ?? null,
    idempotencyKey: params.idempotencyKey,
    triggerSource: params.triggerSource,
    approvalRequestId: params.approvalRequestId,
    callerKey: params.callerKey,
    inputs: params.inputs ?? {},
    intermediateParameters: params.intermediateParameters ?? null,
    outputOverrides: params.outputOverrides ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Insert a new run OR return the existing one when the idempotency key matches.
 *
 * Idempotency is recipe-scoped via UNIQUE index `idx_wr_idempotency`
 * (recipe_namespace, recipe_name, idempotency_key) WHERE idempotency_key IS NOT NULL.
 * If `idempotency_key` is null, the caller always gets a new run.
 */
export async function createRun(input: CreateRunInput, db?: DbClient): Promise<CreateRunResult> {
  const client = getDb(db)

  const inserted = await client.query(
    `INSERT INTO workflow_runs (
       recipe_namespace, recipe_name, phase, actor_type, team_id, usage_team_id, actor_id,
       idempotency_key, trigger_source, inputs, intermediate_parameters,
       output_overrides, max_duration_seconds, ttl_seconds_after_finished
     )
     VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (recipe_namespace, recipe_name, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.recipe_namespace,
      input.recipe_name,
      input.actor_type,
      input.team_id ?? null,
      input.usage_team_id ?? input.team_id ?? null,
      input.actor_id,
      input.idempotency_key,
      input.trigger_source,
      input.inputs ?? null,
      input.intermediate_parameters ?? null,
      input.output_overrides ?? null,
      input.max_duration_seconds ?? null,
      input.ttl_seconds_after_finished ?? null,
    ]
  )

  if (inserted.rowCount && inserted.rowCount > 0) {
    return { row: inserted.rows[0] as WorkflowRunRow, created: true }
  }

  // Conflict path: row already exists for this (recipe_ns, recipe_name, key).
  if (!input.idempotency_key) {
    throw new Error('workflowRunService.createRun: unexpected conflict with NULL idempotency_key')
  }
  const existing = await client.query(
    `SELECT * FROM workflow_runs
     WHERE recipe_namespace = $1 AND recipe_name = $2 AND idempotency_key = $3`,
    [input.recipe_namespace, input.recipe_name, input.idempotency_key]
  )
  if (!existing.rowCount) {
    throw new Error('workflowRunService.createRun: conflict row vanished between INSERT and SELECT')
  }
  return { row: existing.rows[0] as WorkflowRunRow, created: false }
}

/** Atomic approval consumption + run creation for mcp-host-control triggers. */
export async function createApprovedRun(input: CreateApprovedRunInput): Promise<CreateRunResult> {
  if (!input.idempotency_key) {
    throw new Error('createApprovedRun requires a non-empty idempotency_key')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const runInput = await resolveApprovedRunInputFromIntent(client, input)

    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
      `workflow_run:${runInput.recipe_namespace}:${runInput.recipe_name}:${runInput.idempotency_key}`,
    ])

    const existing = await client.query(
      `SELECT * FROM workflow_runs
        WHERE recipe_namespace = $1
          AND recipe_name = $2
          AND idempotency_key = $3
        FOR UPDATE`,
      [runInput.recipe_namespace, runInput.recipe_name, runInput.idempotency_key]
    )

    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0] as WorkflowRunRow
      if (
        row.idempotency_payload_hash !== runInput.idempotency_payload_hash ||
        row.approval_request_id !== runInput.approval_request_id ||
        row.actor_id !== runInput.actor_id
      ) {
        throw new WorkflowRunIdempotencyConflictError()
      }
      await client.query('COMMIT')
      return { row, created: false }
    }

    const consumedApproval = await consumeApprovalForTrigger(
      {
        approvalRequestId: runInput.approval_request_id,
        recipeNamespace: runInput.recipe_namespace,
        recipeName: runInput.recipe_name,
        callerKey: runInput.approval_caller_key,
        correlationId: runInput.correlation_id,
      },
      client
    )

    const inserted = await client.query(
      `INSERT INTO workflow_runs (
         recipe_namespace, recipe_name, phase, actor_type, team_id, usage_team_id, actor_id,
         idempotency_key, trigger_source, inputs, intermediate_parameters,
         output_overrides, max_duration_seconds, ttl_seconds_after_finished, approval_request_id,
         idempotency_payload_hash
       )
       VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        runInput.recipe_namespace,
        runInput.recipe_name,
        runInput.actor_type,
        runInput.team_id ?? consumedApproval.teamId ?? null,
        runInput.usage_team_id ?? runInput.team_id ?? consumedApproval.teamId ?? null,
        runInput.actor_id,
        runInput.idempotency_key,
        runInput.trigger_source,
        runInput.inputs ?? null,
        runInput.intermediate_parameters ?? null,
        runInput.output_overrides ?? null,
        runInput.max_duration_seconds ?? null,
        runInput.ttl_seconds_after_finished ?? null,
        runInput.approval_request_id,
        runInput.idempotency_payload_hash,
      ]
    )

    if (!inserted.rowCount) {
      throw new Error('createApprovedRun: insert returned no rows')
    }

    await client.query('COMMIT')
    return { row: inserted.rows[0] as WorkflowRunRow, created: true }
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* preserve original error */
    }
    throw error
  } finally {
    client.release()
  }
}

/** Look up a single run by run_id. Returns null when not found. */
export async function getRun(runId: string, db?: DbClient): Promise<WorkflowRunRow | null> {
  const client = getDb(db)
  const result = await client.query(`SELECT * FROM workflow_runs WHERE run_id = $1`, [runId])
  if (!result.rowCount) return null
  return result.rows[0] as WorkflowRunRow
}

export async function updateRunPhase(
  runId: string,
  phase: WorkflowRunPhase,
  db?: DbClient
): Promise<WorkflowRunRow | null> {
  const client = getDb(db)
  const terminal = phase === 'Succeeded' || phase === 'Failed' || phase === 'Canceled'
  const result = await client.query(
    `UPDATE workflow_runs
     SET phase = $1,
         completed_at = CASE WHEN $2 THEN now() ELSE completed_at END,
         updated_at = now()
     WHERE run_id = $3
     RETURNING *`,
    [phase, terminal, runId]
  )
  if (!result.rowCount) return null
  return result.rows[0] as WorkflowRunRow
}

export async function listRunsByRecipe(
  recipeNamespace: string,
  recipeName: string,
  limit: number,
  db?: DbClient
): Promise<WorkflowRunRow[]> {
  const client = getDb(db)
  const result = await client.query(
    `SELECT * FROM workflow_runs
     WHERE recipe_namespace = $1 AND recipe_name = $2
     ORDER BY created_at DESC,
              started_at DESC NULLS LAST
     LIMIT $3`,
    [recipeNamespace, recipeName, limit]
  )
  return result.rows as WorkflowRunRow[]
}
