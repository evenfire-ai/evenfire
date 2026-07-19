import type { DbClient } from '../../../db.js'

export type RetentionGrain =
  | 'agent_run'
  | 'administrative'
  | 'infrastructure_telemetry'
  | 'infrastructure_cost'
  | 'approval_prompt'

export type RetentionResult = {
  eventsDeleted: number
  costsDeleted: number
  promptsDeleted: number
  saturatedGrains: readonly RetentionGrain[]
}

const MAX_ROWS_PER_WAKE_TRANSACTION = 1_000
const RETENTION_GRAINS_PER_WAKE = 5
const FAIR_SHARE_ROWS_PER_GRAIN = Math.floor(
  MAX_ROWS_PER_WAKE_TRANSACTION / RETENTION_GRAINS_PER_WAKE
)

async function pruneExpiredEvents(
  db: DbClient,
  family: 'agent_run' | 'administrative' | 'infrastructure_telemetry',
  limit: number
): Promise<{ deleted: number; saturated: boolean }> {
  const result = await db.query(
    'SELECT event_id FROM governed_trace_prune_expired_events($1, $2)',
    [family, limit]
  )
  const deleted = result.rowCount ?? 0
  return { deleted, saturated: deleted === limit }
}

async function pruneExpiredCosts(
  db: DbClient,
  limit: number
): Promise<{ deleted: number; saturated: boolean }> {
  const result = await db.query('SELECT id FROM governed_trace_prune_expired_costs($1)', [limit])
  const deleted = result.rowCount ?? 0
  return { deleted, saturated: deleted === limit }
}

async function pruneExpiredPrompts(
  db: DbClient,
  limit: number
): Promise<{ deleted: number; saturated: boolean }> {
  const result = await db.query(
    'SELECT approval_request_id FROM governed_trace_prune_expired_prompts($1)',
    [limit]
  )
  const deleted = result.rowCount ?? 0
  return { deleted, saturated: deleted === limit }
}

export async function runRetentionBatch(db: DbClient, _now = new Date()): Promise<RetentionResult> {
  const grains: Array<{
    grain: RetentionGrain
    prune(limit: number): Promise<{ deleted: number; saturated: boolean }>
  }> = [
    { grain: 'agent_run', prune: limit => pruneExpiredEvents(db, 'agent_run', limit) },
    {
      grain: 'administrative',
      prune: limit => pruneExpiredEvents(db, 'administrative', limit),
    },
    {
      grain: 'infrastructure_telemetry',
      prune: limit => pruneExpiredEvents(db, 'infrastructure_telemetry', limit),
    },
    { grain: 'infrastructure_cost', prune: limit => pruneExpiredCosts(db, limit) },
    { grain: 'approval_prompt', prune: limit => pruneExpiredPrompts(db, limit) },
  ]

  const deletedByGrain = new Map<RetentionGrain, number>()
  let remainingBudget = MAX_ROWS_PER_WAKE_TRANSACTION
  let saturated = new Set<RetentionGrain>()

  async function runPass(candidates: typeof grains): Promise<void> {
    const nextSaturated = new Set<RetentionGrain>()
    for (const entry of candidates) {
      if (remainingBudget === 0) {
        nextSaturated.add(entry.grain)
        continue
      }
      const limit = Math.min(FAIR_SHARE_ROWS_PER_GRAIN, remainingBudget)
      const result = await entry.prune(limit)
      if (result.deleted < 0 || result.deleted > limit) {
        throw new Error(`retention grain ${entry.grain} exceeded its bounded delete budget`)
      }
      deletedByGrain.set(entry.grain, (deletedByGrain.get(entry.grain) ?? 0) + result.deleted)
      remainingBudget -= result.deleted
      if (result.saturated) nextSaturated.add(entry.grain)
    }
    saturated = nextSaturated
  }

  await runPass(grains)
  while (remainingBudget > 0 && saturated.size > 0) {
    await runPass(grains.filter(entry => saturated.has(entry.grain)))
  }

  return {
    eventsDeleted:
      (deletedByGrain.get('agent_run') ?? 0) +
      (deletedByGrain.get('administrative') ?? 0) +
      (deletedByGrain.get('infrastructure_telemetry') ?? 0),
    costsDeleted: deletedByGrain.get('infrastructure_cost') ?? 0,
    promptsDeleted: deletedByGrain.get('approval_prompt') ?? 0,
    saturatedGrains: grains.map(entry => entry.grain).filter(grain => saturated.has(grain)),
  }
}
