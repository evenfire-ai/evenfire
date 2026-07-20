import type { DbClient } from '../db.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type WorkflowRunBinding = {
  runId: string
  recipeNamespace: string
  recipeName: string
  phase: string
  actorType: string
  actorId: string | null
  teamId: string | null
  usageTeamId: string | null
  startedAt: Date | string | null
  completedAt: Date | string | null
  approvalRequestId: string | null
  durationMs: number | string | null
}

type WorkflowRunBindingSource = 'live' | 'archive' | null

type StoredWorkflowRunBinding = {
  binding: WorkflowRunBinding
  source: WorkflowRunBindingSource
}

type WorkflowRunBindingRow = Record<string, unknown>

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function timestamp(value: unknown): Date | string | null {
  return value instanceof Date || typeof value === 'string' ? value : null
}

function durationMs(value: unknown): number | string | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null
}

function source(value: unknown): WorkflowRunBindingSource {
  return value === 'live' || value === 'archive' ? value : null
}

function distinctRunIds(runIds: readonly string[]): string[] {
  return Array.from(
    new Set(runIds.filter(runId => UUID_PATTERN.test(runId)).map(runId => runId.toLowerCase()))
  )
}

function bindingFromRow(row: WorkflowRunBindingRow): WorkflowRunBinding {
  return {
    runId: requiredString(row.run_id).toLowerCase(),
    recipeNamespace: requiredString(row.recipe_namespace),
    recipeName: requiredString(row.recipe_name),
    phase: requiredString(row.phase),
    actorType: requiredString(row.actor_type),
    actorId: nullableString(row.actor_id),
    teamId: nullableString(row.team_id),
    usageTeamId: nullableString(row.usage_team_id),
    startedAt: timestamp(row.started_at),
    completedAt: timestamp(row.completed_at),
    approvalRequestId: nullableString(row.approval_request_id),
    durationMs: durationMs(row.duration_ms),
  }
}

export class WorkflowRunBindingRepository {
  constructor(private readonly db: Pick<DbClient, 'query'>) {}

  async resolve(runId: string): Promise<WorkflowRunBinding | null> {
    const normalizedRunId = distinctRunIds([runId])[0]
    if (!normalizedRunId) return null

    return (await this.resolveMany([normalizedRunId])).get(normalizedRunId) ?? null
  }

  async resolveMany(runIds: readonly string[]): Promise<Map<string, WorkflowRunBinding>> {
    const requestedRunIds = distinctRunIds(runIds)
    if (requestedRunIds.length === 0) return new Map()

    const result = await this.db.query(WORKFLOW_RUN_BINDINGS_SQL, [requestedRunIds])
    const bindings = new Map<string, StoredWorkflowRunBinding>()
    const requestedRunIdSet = new Set(requestedRunIds)

    for (const row of result.rows as WorkflowRunBindingRow[]) {
      const binding = bindingFromRow(row)
      if (!requestedRunIdSet.has(binding.runId)) continue

      const candidateSource = source(row.source)
      const existing = bindings.get(binding.runId)
      if (!existing || (candidateSource === 'live' && existing.source !== 'live')) {
        bindings.set(binding.runId, { binding, source: candidateSource })
      }
    }

    return new Map(Array.from(bindings, ([runId, stored]) => [runId, stored.binding]))
  }
}

const WORKFLOW_RUN_BINDINGS_SQL = `WITH requested(run_id) AS (
  SELECT DISTINCT unnest($1::uuid[]) AS run_id
), live AS (
  SELECT
    wr.run_id::text AS run_id,
    wr.recipe_namespace,
    wr.recipe_name,
    wr.phase,
    wr.actor_type,
    wr.actor_id::text AS actor_id,
    wr.team_id::text AS team_id,
    wr.usage_team_id,
    wr.started_at,
    wr.completed_at,
    wr.approval_request_id::text AS approval_request_id,
    CASE
      WHEN wr.started_at IS NOT NULL AND wr.completed_at IS NOT NULL
      THEN (EXTRACT(EPOCH FROM (wr.completed_at - wr.started_at)) * 1000)::bigint
      ELSE NULL
    END AS duration_ms,
    'live'::text AS source
  FROM workflow_runs wr
  INNER JOIN requested r ON r.run_id = wr.run_id
), archive AS (
  SELECT
    wra.run_id::text AS run_id,
    wra.recipe_namespace,
    wra.recipe_name,
    wra.final_phase AS phase,
    wra.triggerer_actor_type AS actor_type,
    CASE
      WHEN wra.triggerer_actor_type = 'admin' THEN wra.triggerer_admin_user_id::text
      ELSE wra.triggerer_user_id::text
    END AS actor_id,
    wra.triggerer_team_id::text AS team_id,
    wra.usage_team_id,
    wra.started_at,
    wra.completed_at,
    NULL::text AS approval_request_id,
    wra.duration_ms,
    'archive'::text AS source
  FROM workflow_runs_audit wra
  INNER JOIN requested r ON r.run_id = wra.run_id
)
SELECT * FROM live
UNION ALL
SELECT archive.*
FROM archive
WHERE NOT EXISTS (
  SELECT 1 FROM live WHERE live.run_id = archive.run_id
)`
