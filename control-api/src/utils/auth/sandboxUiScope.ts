import { config } from '../../config.js'
import { DbClient } from '../../db.js'
import { K8sGateway } from '../../k8s.js'
import { rootLogger } from '../../observability/logger.js'
import { sandboxUiTeamGrantsCte } from './sandboxUiGrantSql.js'

const logger = rootLogger.child({ module: 'sandbox-ui-scope' })

interface RecipeShape {
  metadata?: { name?: string; namespace?: string }
  spec?: { ui?: unknown }
}

/**
 * Decides whether to grant `sandbox:ui:view` to a user at RPC token issuance.
 *
 * Returns true iff the user has at least one direct trigger grant or active
 * current-team trigger grant that points at a recipe carrying a `spec.ui`
 * block. The two pieces of state — trigger grants (DB) and recipe shape (K8s
 * CRD) — live in different stores, so we materialize the intersection at
 * issuance rather than denormalizing into the DB.
 *
 * The K8s list is bounded by the count of WorkflowRecipes in
 * `sandbox-recipes` (small, single-digit-to-low-hundreds). The DB query is
 * a single round-trip with the UI-bearing recipe set passed via
 * `unnest($2::text[], $3::text[])` so the planner can treat it as a small
 * IN-list without quadratic placeholder generation.
 *
 * Returns false on K8s/DB failure — callers that flip this to "grant" on
 * error would over-permission users when the registry is broken; the
 * registry endpoint itself is the authoritative gate downstream, so a
 * missing `sandbox:ui:view` only affects whether rpc-proxy attempts a
 * session-mint.
 */
export async function userHasUiBearingRecipeAccess(
  userId: string,
  gateway: K8sGateway,
  db: DbClient,
  currentTeamId?: string | null
): Promise<boolean> {
  const trimmed = userId.trim()
  if (!trimmed) return false
  const teamId = currentTeamId?.trim() || null

  let raw: unknown
  // Mirrors resolveWorkflowTriggerGrant's direct-user-session semantics while
  // staying in one DB round-trip for token issuance; keep grant sources in sync.
  try {
    raw = await gateway.listResource('workflowrecipes', config.sandboxNamespace)
  } catch (err) {
    logger.warn({ err }, 'Sandbox UI scope recipe listing failed')
    return false
  }
  // Defensive: a misbehaving gateway / mock can return non-array; treat as
  // "no UI-bearing recipes" rather than blow up the token-issuance path.
  if (!Array.isArray(raw)) return false
  const recipes = raw as RecipeShape[]

  const uiBearing = recipes.filter(
    r => r.spec?.ui !== undefined && r.metadata?.name && r.metadata?.namespace
  )
  if (uiBearing.length === 0) return false

  const namespaces = uiBearing.map(r => r.metadata!.namespace!)
  const names = uiBearing.map(r => r.metadata!.name!)

  try {
    const result = await db.query(
      `WITH ui_recipes(recipe_namespace, recipe_name) AS (
         SELECT * FROM unnest($3::text[], $4::text[])
       ),
       direct_grants AS (
         SELECT 1
         FROM user_workflow_triggers uwt
         JOIN ui_recipes ui
           ON ui.recipe_namespace = uwt.recipe_namespace
          AND ui.recipe_name = uwt.recipe_name
         WHERE uwt.user_id = $1
       ),
       ${sandboxUiTeamGrantsCte('exists')}
       SELECT 1 FROM direct_grants
       UNION ALL
       SELECT 1 FROM team_grants
       LIMIT 1`,
      [trimmed, teamId, namespaces, names]
    )
    return (result.rowCount ?? 0) > 0
  } catch (err) {
    logger.warn({ err, hasCurrentTeam: teamId !== null }, 'Sandbox UI scope DB access check failed')
    return false
  }
}
