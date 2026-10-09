import type { DbClient } from '../../db.js'

type BudgetContextTeamRow = Readonly<{
  context_id?: unknown
  team_id?: unknown
}>

/**
 * Resolve the evaluator's canonical team for each context. Keep the exact
 * earliest-bound-wins ordering shared by budget enforcement and access-path
 * policy binding.
 */
export async function resolveCanonicalBudgetTeamsForContexts(
  contextRefs: readonly string[],
  db: Pick<DbClient, 'query'>
): Promise<ReadonlyMap<string, string>> {
  const uniqueContextRefs = [...new Set(contextRefs.filter(Boolean))].sort()
  if (uniqueContextRefs.length === 0) return new Map()

  const result = await db.query(
    `SELECT DISTINCT ON (context_id) context_id, team_id::text AS team_id
       FROM team_contexts
      WHERE context_id = ANY($1::text[])
      ORDER BY context_id, created_at ASC, team_id ASC`,
    [uniqueContextRefs]
  )
  const teams = new Map<string, string>()
  for (const row of result.rows as BudgetContextTeamRow[]) {
    if (typeof row.context_id === 'string' && typeof row.team_id === 'string') {
      teams.set(row.context_id, row.team_id)
    }
  }
  return teams
}
