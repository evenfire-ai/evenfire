import { pool, withTransaction } from '../../db.js'

/**
 * Who is currently authorized to trigger a given workflow recipe.
 * Mirrors the shape returned by listUsersByAgent in agentAccess.ts.
 */
export interface WorkflowGrantUser {
  id: string
  email: string
  name: string | null
  displayName: string | null
}

export interface WorkflowGrantTeam {
  id: string
  name: string
}

/**
 * Result of {@link setWorkflowGrants}. `added` and `removed` are exposed so
 * callers can emit targeted audit logs without re-diffing against a second
 * read of the table (which would race against subsequent writes anyway).
 */
export interface SetWorkflowGrantsResult {
  userIds: string[]
  added: string[]
  removed: string[]
}

export interface SetTeamWorkflowGrantsResult {
  teamIds: string[]
  added: string[]
  removed: string[]
}

/**
 * List all users who currently have a row in `user_workflow_triggers` for this
 * recipe. Sorted by email ASC for stable UI rendering.
 */
export async function listWorkflowGrants(
  recipeNamespace: string,
  recipeName: string
): Promise<WorkflowGrantUser[]> {
  const ns = recipeNamespace.trim()
  const name = recipeName.trim()
  if (!ns || !name) return []

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, p.display_name
       FROM user_workflow_triggers uwt
       JOIN users u ON u.id = uwt.user_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE uwt.recipe_namespace = $1 AND uwt.recipe_name = $2
   ORDER BY u.email ASC`,
    [ns, name]
  )

  return result.rows.map(row => ({
    id: String((row as { id: string }).id),
    email: String((row as { email: string }).email),
    name: ((row as { name?: string | null }).name ?? null) as string | null,
    displayName: ((row as { display_name?: string | null }).display_name ?? null) as string | null,
  }))
}

/**
 * Replace the full set of users authorized to trigger a given workflow recipe.
 *
 * Concurrency model: an advisory transaction lock serializes all replace-set
 * writes for the same recipe, including the empty-set case where `FOR UPDATE`
 * has no rows to lock. The following `FOR UPDATE` still protects existing rows
 * and documents the table partition being replaced. PUTs to different recipes
 * stay parallel.
 *
 * Input expectations (enforced by the caller, not re-validated here):
 *   - `userIds` is already deduplicated and lowercase-normalized.
 *   - Every id in `userIds` exists in `users`.
 *   - `userIds.length` is bounded (caller enforces MAX_GRANTS_PER_RECIPE).
 *
 * Audit: emit one 'grant' row per added user and one 'revoke' row per removed
 * user, sharing payload_json so auditors can correlate back to the originating
 * PUT request. Deleted users are later anonymized by the audit FK.
 */
export async function setWorkflowGrants(
  recipeNamespace: string,
  recipeName: string,
  userIds: readonly string[],
  operatorUserId: string
): Promise<SetWorkflowGrantsResult> {
  const ns = recipeNamespace.trim()
  const name = recipeName.trim()
  const after = [...userIds] // assumed already deduped + normalized by caller

  return withTransaction(async db => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
      `workflow_user_grants:${ns}:${name}`,
    ])

    // FOR UPDATE locks rows matching (ns, name) for the duration of this tx.
    // PostgreSQL READ COMMITTED has no gap lock for an empty result, so the
    // advisory lock above is the serialization primitive for fresh grants.
    const beforeResult = await db.query(
      `SELECT user_id::text AS user_id
         FROM user_workflow_triggers
        WHERE recipe_namespace = $1 AND recipe_name = $2
     ORDER BY user_id ASC
        FOR UPDATE`,
      [ns, name]
    )
    const before = beforeResult.rows.map(r => String((r as { user_id: string }).user_id))

    await db.query(
      `DELETE FROM user_workflow_triggers WHERE recipe_namespace = $1 AND recipe_name = $2`,
      [ns, name]
    )

    if (after.length > 0) {
      // No ON CONFLICT: the DELETE above leaves the (ns, name) partition empty
      // for the duration of this transaction (the FOR UPDATE lock keeps
      // concurrent writers out), so unique-constraint conflicts are impossible
      // here. The caller is responsible for dedup.
      await db.query(
        `INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
         SELECT unnest($1::uuid[]), $2, $3`,
        [after, ns, name]
      )
    }

    const beforeSet = new Set(before)
    const afterSet = new Set(after)
    const added = after.filter(uid => !beforeSet.has(uid))
    const removed = before.filter(uid => !afterSet.has(uid))
    const sharedPayload = JSON.stringify({ before, after })

    // Bulk INSERT via `unnest` instead of per-user loop. With the 500-user
    // cap, a full replace could otherwise produce up to 500 sequential
    // round-trips inside the tx (each holding the FOR UPDATE row lock for
    // its duration). One INSERT per action is O(1) regardless of set size.
    if (added.length > 0) {
      await db.query(
        `INSERT INTO trigger_grants_audit (
           operator_user_id, target_user_id,
           recipe_namespace, recipe_name,
           action, payload_json
         )
         SELECT $1::uuid, unnest($2::uuid[]), $3, $4, 'grant', $5::jsonb`,
        [operatorUserId, added, ns, name, sharedPayload]
      )
    }
    if (removed.length > 0) {
      await db.query(
        `INSERT INTO trigger_grants_audit (
           operator_user_id, target_user_id,
           recipe_namespace, recipe_name,
           action, payload_json
         )
         SELECT $1::uuid, unnest($2::uuid[]), $3, $4, 'revoke', $5::jsonb`,
        [operatorUserId, removed, ns, name, sharedPayload]
      )
    }

    return { userIds: after, added, removed }
  })
}

export async function listTeamWorkflowGrants(
  recipeNamespace: string,
  recipeName: string
): Promise<WorkflowGrantTeam[]> {
  const ns = recipeNamespace.trim()
  const name = recipeName.trim()
  if (!ns || !name) return []

  const result = await pool.query(
    `SELECT t.id, t.name
       FROM team_workflow_triggers twt
       JOIN teams t ON t.id = twt.team_id
      WHERE twt.recipe_namespace = $1 AND twt.recipe_name = $2
   ORDER BY t.name ASC, t.id ASC`,
    [ns, name]
  )

  return result.rows.map(row => ({
    id: String((row as { id: string }).id),
    name: String((row as { name: string }).name),
  }))
}

export async function setTeamWorkflowGrants(
  recipeNamespace: string,
  recipeName: string,
  teamIds: readonly string[],
  actorUserId: string
): Promise<SetTeamWorkflowGrantsResult> {
  const ns = recipeNamespace.trim()
  const name = recipeName.trim()
  const after = [...teamIds]

  return withTransaction(async db => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
      `workflow_team_grants:${ns}:${name}`,
    ])

    const beforeResult = await db.query(
      `SELECT team_id::text AS team_id
         FROM team_workflow_triggers
        WHERE recipe_namespace = $1 AND recipe_name = $2
     ORDER BY team_id ASC
        FOR UPDATE`,
      [ns, name]
    )
    const before = beforeResult.rows.map(r => String((r as { team_id: string }).team_id))

    await db.query(
      `DELETE FROM team_workflow_triggers WHERE recipe_namespace = $1 AND recipe_name = $2`,
      [ns, name]
    )

    if (after.length > 0) {
      await db.query(
        `INSERT INTO team_workflow_triggers (team_id, recipe_namespace, recipe_name)
         SELECT unnest($1::uuid[]), $2, $3`,
        [after, ns, name]
      )
    }

    const beforeSet = new Set(before)
    const afterSet = new Set(after)
    const added = after.filter(id => !beforeSet.has(id))
    const removed = before.filter(id => !afterSet.has(id))
    const sharedPayload = JSON.stringify({ before, after })

    if (added.length > 0) {
      await db.query(
        `INSERT INTO team_workflow_grants_audit (
           actor_user_id, target_team_id,
           recipe_namespace, recipe_name,
           action, payload_json
         )
         SELECT $1::uuid, unnest($2::uuid[]), $3, $4, 'grant', $5::jsonb`,
        [actorUserId, added, ns, name, sharedPayload]
      )
    }
    if (removed.length > 0) {
      await db.query(
        `INSERT INTO team_workflow_grants_audit (
           actor_user_id, target_team_id,
           recipe_namespace, recipe_name,
           action, payload_json
         )
         SELECT $1::uuid, unnest($2::uuid[]), $3, $4, 'revoke', $5::jsonb`,
        [actorUserId, removed, ns, name, sharedPayload]
      )
    }

    return { teamIds: after, added, removed }
  })
}
