import { pool } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import {
  listTeamWorkflowGrants,
  listWorkflowGrants,
  setTeamWorkflowGrants,
  setWorkflowGrants,
} from '../directory/index.js'
import { findRecipeNamespace, isRecipeNamespaceAllowed } from './workflowRecipeAccessService.js'

const MAX_GRANTS_PER_RECIPE = 500

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export class WorkflowGrantHttpError extends Error {
  status: number
  body: Record<string, unknown>

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error || 'workflow_grant_error'))
    this.name = 'WorkflowGrantHttpError'
    this.status = status
    this.body = body
  }
}

async function ensureRecipeExists(gateway: K8sGateway, ns: string, name: string): Promise<void> {
  if (!isRecipeNamespaceAllowed(ns)) {
    throw new WorkflowGrantHttpError(404, { error: `Recipe ${ns}/${name} not found` })
  }
  const found = await findRecipeNamespace(gateway, name, ns)
  if (!found || found.ns !== ns) {
    throw new WorkflowGrantHttpError(404, { error: `Recipe ${ns}/${name} not found` })
  }
}

export async function listWorkflowRecipeGrants(gateway: K8sGateway, ns: string, name: string) {
  await ensureRecipeExists(gateway, ns, name)
  return listWorkflowGrants(ns, name)
}

export async function listWorkflowRecipeTeamGrants(gateway: K8sGateway, ns: string, name: string) {
  await ensureRecipeExists(gateway, ns, name)
  return listTeamWorkflowGrants(ns, name)
}

export async function replaceWorkflowRecipeGrants(params: {
  gateway: K8sGateway
  recipeNamespace: string
  recipeName: string
  operatorUserId: string
  rawUserIds: unknown
}) {
  const { gateway, recipeNamespace: ns, recipeName: name } = params
  await ensureRecipeExists(gateway, ns, name)

  const rawIds = Array.isArray(params.rawUserIds) ? params.rawUserIds : null
  if (rawIds === null) {
    throw new WorkflowGrantHttpError(400, { error: 'Body must be { userIds: string[] }' })
  }

  const normalized = rawIds.map(v => String(v).trim())
  for (const id of normalized) {
    if (!isUuid(id)) {
      throw new WorkflowGrantHttpError(400, { error: `Invalid userId format: "${id}"` })
    }
  }
  const unique = [...new Set(normalized.map(id => id.toLowerCase()))]

  if (unique.length > MAX_GRANTS_PER_RECIPE) {
    throw new WorkflowGrantHttpError(400, {
      error: `Cannot grant more than ${MAX_GRANTS_PER_RECIPE} users per recipe`,
      received: unique.length,
    })
  }

  if (unique.length > 0) {
    const existing = await pool.query(
      `SELECT id::text AS id FROM users WHERE id = ANY($1::uuid[])`,
      [unique]
    )
    const foundIds = new Set(existing.rows.map(r => String((r as { id: string }).id)))
    const missing = unique.filter(id => !foundIds.has(id))
    if (missing.length > 0) {
      throw new WorkflowGrantHttpError(404, { error: 'One or more userIds not found', missing })
    }
  }

  return setWorkflowGrants(ns, name, unique, params.operatorUserId)
}

export async function replaceWorkflowRecipeTeamGrants(params: {
  gateway: K8sGateway
  recipeNamespace: string
  recipeName: string
  operatorUserId: string
  rawTeamIds: unknown
}) {
  const { gateway, recipeNamespace: ns, recipeName: name } = params
  await ensureRecipeExists(gateway, ns, name)

  const rawIds = Array.isArray(params.rawTeamIds) ? params.rawTeamIds : null
  if (rawIds === null) {
    throw new WorkflowGrantHttpError(400, { error: 'Body must be { teamIds: string[] }' })
  }

  const normalized = rawIds.map(v => String(v).trim())
  for (const id of normalized) {
    if (!isUuid(id)) {
      throw new WorkflowGrantHttpError(400, { error: `Invalid teamId format: "${id}"` })
    }
  }
  const unique = [...new Set(normalized.map(id => id.toLowerCase()))]

  if (unique.length > MAX_GRANTS_PER_RECIPE) {
    throw new WorkflowGrantHttpError(400, {
      error: `Cannot grant more than ${MAX_GRANTS_PER_RECIPE} teams per recipe`,
      received: unique.length,
    })
  }

  if (unique.length > 0) {
    const existing = await pool.query(
      `SELECT id::text AS id FROM teams WHERE id = ANY($1::uuid[])`,
      [unique]
    )
    const foundIds = new Set(existing.rows.map(r => String((r as { id: string }).id)))
    const missing = unique.filter(id => !foundIds.has(id))
    if (missing.length > 0) {
      throw new WorkflowGrantHttpError(404, { error: 'One or more teamIds not found', missing })
    }
  }

  return setTeamWorkflowGrants(ns, name, unique, params.operatorUserId)
}

export async function allowWorkflowRecipeApprovalTeam(params: {
  gateway: K8sGateway
  recipeNamespace: string
  recipeName: string
  actorUserId: string
  teamId: string
}) {
  const { gateway, recipeNamespace: ns, recipeName: name } = params
  await ensureRecipeExists(gateway, ns, name)

  const teamId = String(params.teamId || '')
    .trim()
    .toLowerCase()
  if (!isUuid(teamId)) {
    throw new WorkflowGrantHttpError(400, { error: `Invalid teamId format: "${params.teamId}"` })
  }

  const existing = await pool.query(`SELECT id::text AS id FROM teams WHERE id = $1::uuid`, [
    teamId,
  ])
  if (existing.rowCount === 0) {
    throw new WorkflowGrantHttpError(404, { error: `Team ${teamId} not found` })
  }

  await pool.query(
    `WITH inserted AS (
       INSERT INTO workflow_recipe_allowed_teams (recipe_namespace, recipe_name, team_id)
       VALUES ($1, $2, $3::uuid)
       ON CONFLICT DO NOTHING
       RETURNING team_id
     ), audit AS (
       INSERT INTO workflow_recipe_allowed_teams_audit (
         actor_user_id, target_team_id, recipe_namespace, recipe_name, action, payload_json
       )
       SELECT $4::uuid, team_id, $1, $2, 'allow', '{}'::jsonb
         FROM inserted
     )
     SELECT team_id::text AS "teamId" FROM inserted`,
    [ns, name, teamId, params.actorUserId]
  )

  return { teamId }
}

export async function listWorkflowRecipeApprovalTeams(params: {
  gateway: K8sGateway
  recipeNamespace: string
  recipeName: string
}) {
  const { gateway, recipeNamespace: ns, recipeName: name } = params
  await ensureRecipeExists(gateway, ns, name)

  const result = await pool.query(
    `SELECT t.id::text AS id,
            t.name,
            wat.created_at AS "createdAt"
       FROM workflow_recipe_allowed_teams wat
       JOIN teams t ON t.id = wat.team_id
      WHERE wat.recipe_namespace = $1 AND wat.recipe_name = $2
   ORDER BY t.name ASC, t.id ASC`,
    [ns, name]
  )

  return result.rows.map(row => {
    const createdAt = (row as { createdAt: string | Date }).createdAt
    return {
      id: String((row as { id: string }).id),
      name: String((row as { name: string }).name),
      createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    }
  })
}

export async function revokeWorkflowRecipeApprovalTeam(params: {
  gateway: K8sGateway
  recipeNamespace: string
  recipeName: string
  actorUserId: string
  teamId: string
}) {
  const { gateway, recipeNamespace: ns, recipeName: name } = params
  await ensureRecipeExists(gateway, ns, name)

  const teamId = String(params.teamId || '')
    .trim()
    .toLowerCase()
  if (!isUuid(teamId)) {
    throw new WorkflowGrantHttpError(400, { error: `Invalid teamId format: "${params.teamId}"` })
  }

  const result = await pool.query(
    `WITH deleted AS (
       DELETE FROM workflow_recipe_allowed_teams
        WHERE recipe_namespace = $1 AND recipe_name = $2 AND team_id = $3::uuid
        RETURNING team_id
     ), audit AS (
       INSERT INTO workflow_recipe_allowed_teams_audit (
         actor_user_id, target_team_id, recipe_namespace, recipe_name, action, payload_json
       )
       SELECT $4::uuid, team_id, $1, $2, 'revoke', '{}'::jsonb
         FROM deleted
     )
     SELECT team_id::text AS "teamId" FROM deleted`,
    [ns, name, teamId, params.actorUserId]
  )

  return { teamId, removed: (result.rowCount ?? 0) > 0 }
}
