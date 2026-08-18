import type { DbClient } from '../../db.js'
import { pool } from '../../db.js'
import { bulkSetLinkedItems } from '../../shared/generics.js'
import {
  type ControlApiPermissionSubject,
  appendControlApiPermissionEventsInTransaction,
} from '../tracing/controlApiPermissionEvents.js'

async function appendContextAccessChanges(
  db: DbClient,
  operatorSub: string,
  subject: ControlApiPermissionSubject,
  change: { added: string[]; removed: string[] }
): Promise<void> {
  const mapChanges = (action: 'grant' | 'revoke', contextIds: string[]) =>
    contextIds.map(contextId => ({
      action,
      resourceClass: 'context_access',
      resourceRef: `context:${contextId}`,
      subject,
    }))
  await appendControlApiPermissionEventsInTransaction(db, {
    operatorSub,
    changes: [...mapChanges('grant', change.added), ...mapChanges('revoke', change.removed)],
  })
}

export async function setUserContexts(userId: string, contextIds: string[], operatorSub: string) {
  const result = await bulkSetLinkedItems(
    'user_contexts',
    'user_id',
    userId,
    'context_id',
    contextIds,
    (db, change) =>
      appendContextAccessChanges(db, operatorSub, { kind: 'user', id: userId }, change)
  )
  return { userId, contextIds: result.items }
}

export async function getUserContexts(userId: string) {
  const result = await pool.query(
    `SELECT context_id
       FROM user_contexts uc
       JOIN users u ON u.id = uc.user_id
      WHERE uc.user_id = $1
        AND u.lifecycle_state = 'active'
   ORDER BY context_id ASC`,
    [userId]
  )
  return {
    userId,
    contextIds: result.rows.map(row => String((row as { context_id: string }).context_id)),
  }
}

export async function listUsersByContext(contextId: string) {
  const resolvedContextId = contextId.trim()
  if (!resolvedContextId) return []

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, p.display_name
       FROM user_contexts uc
       JOIN users u ON u.id = uc.user_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE uc.context_id = $1
        AND u.lifecycle_state = 'active'
   ORDER BY u.email ASC`,
    [resolvedContextId]
  )

  return result.rows.map(row => ({
    id: String((row as { id: string }).id),
    email: String((row as { email: string }).email),
    name: ((row as { name?: string | null }).name ?? null) as string | null,
    displayName: ((row as { display_name?: string | null }).display_name ?? null) as string | null,
  }))
}

export async function setTeamContexts(teamId: string, contextIds: string[], operatorSub: string) {
  const result = await bulkSetLinkedItems(
    'team_contexts',
    'team_id',
    teamId,
    'context_id',
    contextIds,
    (db, change) =>
      appendContextAccessChanges(db, operatorSub, { kind: 'team', id: teamId }, change)
  )
  return { teamId, contextIds: result.items }
}

export async function getTeamContexts(teamId: string) {
  const result = await pool.query(
    `SELECT context_id
       FROM team_contexts
      WHERE team_id = $1
   ORDER BY context_id ASC`,
    [teamId]
  )
  return {
    teamId,
    contextIds: result.rows.map(row => String((row as { context_id: string }).context_id)),
  }
}

export async function listTeamContextsByTeam() {
  const result = await pool.query(
    `SELECT team_id, context_id
       FROM team_contexts
   ORDER BY team_id ASC, context_id ASC`
  )
  const byTeam: Record<string, string[]> = {}
  for (const row of result.rows) {
    const teamId = String((row as { team_id: string }).team_id)
    const contextId = String((row as { context_id: string }).context_id)
    if (!byTeam[teamId]) byTeam[teamId] = []
    byTeam[teamId].push(contextId)
  }
  return byTeam
}

export async function listTeamsByContext(contextId: string) {
  const resolvedContextId = contextId.trim()
  if (!resolvedContextId) return []

  const result = await pool.query(
    `SELECT t.id, t.name
       FROM team_contexts tc
       JOIN teams t ON t.id = tc.team_id
      WHERE tc.context_id = $1
   ORDER BY t.name ASC`,
    [resolvedContextId]
  )

  return result.rows.map(row => ({
    id: String((row as { id: string }).id),
    name: String((row as { name: string }).name),
  }))
}
