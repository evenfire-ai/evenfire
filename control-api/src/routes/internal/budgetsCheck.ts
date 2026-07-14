/**
 * Internal budget endpoints (.specs/feat-token-budgets §4.1, §5.4).
 *
 * `POST /api/v1/internal/budgets/check`   — called once per task by mcp-host to
 *   decide whether a new task may start under the configured token budgets.
 * `POST /api/v1/internal/budgets/release` — called by mcp-host on task completion
 *   to free the danger-zone reservation(s) early instead of waiting for the TTL.
 *
 * Guard: `requireMcpHostJwt` — the SAME middleware as /internal/usage/llm/events
 * (mcpHostJwtAuth.ts). It must NOT be weakened; only an mcp-host runtime token
 * (1st-party sentinel or WRC recipe) may reach these routes.
 */
import { Router } from 'express'
import { z } from 'zod'
import { config } from '../../config.js'
import { requireMcpHostJwt } from '../../middleware/mcpHostJwtAuth.js'
import {
  type BudgetCheckRequest,
  budgetCheckRequestSchema,
  evaluateBudgetCheck,
} from '../../services/budgets/check.js'
import { releaseReservation } from '../../services/budgets/reservations.js'
import type { McpHostAccessClaims } from '../../utils/auth/mcpHostJwtToken.js'

// At least one of reservationId / task_ref must identify what to release.
// reservationId is the PK of budget_pending_reservations (a UUID); requiring the
// UUID shape rejects a malformed id with a clean 400 instead of letting it reach
// Postgres and raise 22P02 → 500.
const releaseRequestSchema = z
  .object({
    reservationId: z.string().uuid().nullish(),
    task_ref: z.string().min(1).nullish(),
    // REQUIRED: the reservation is scoped to the caller's host. The route binds
    // this to `claims.hostRefs[0]` (below) and releaseReservation filters the
    // DELETE by it, so a caller can only free its OWN host's reservations.
    // `.trim()` canonicalizes to the SAME normalized value /check persisted
    // (check.ts normalize()), so the binding and the DELETE never diverge (a
    // whitespace-padded value can't pass the binding yet match 0 rows). A
    // whitespace-only value trims to '' and fails min(1) → 400.
    host_ref: z.string().trim().min(1),
  })
  .strict()
  .refine(obj => Boolean(obj.reservationId) || Boolean(obj.task_ref), {
    message: 'reservationId or task_ref is required',
  })

type BudgetCheckBindingReason =
  | 'unrecognized_token_binding'
  | 'sentinel_token_with_recipe_name'
  | 'sentinel_token_with_workflow_source'
  | 'sentinel_token_host_ref_mismatch'
  | 'recipe_token_recipe_name_mismatch'
  | 'recipe_token_non_workflow_source'
  | 'recipe_token_host_ref_mismatch'

/**
 * Bind the /check body to the JWT's namespace/host/recipe claims so a valid
 * mcp-host token cannot spoof another host's or recipe's spend. Mirrors
 * usageEvents.ts `checkClaimBinding` (per-event) for the single check request:
 *
 * - 1st-party sentinel (recipeNamespace === hostsNamespace): `recipe_name` MUST
 *   be null, `source_kind` MUST NOT be 'workflow', and `host_ref` MUST equal
 *   `claims.hostRefs[0]` (the Host CRD name HCC minted the token for).
 * - WRC recipe (recipeNamespace === sandboxNamespace): `recipe_name` MUST equal
 *   `claims.recipeName`, `source_kind` MUST be 'workflow', and `host_ref` MUST
 *   equal `claims.hostRefs[0]` (`${recipeNamespace}/${recipeName}`).
 * - Any other namespace is rejected.
 *
 * NOTE: `team_id`/`user_id` in the body are NOT bindable here — the mcp-host
 * access JWT does not carry those claims. The host_ref/recipe_name binding still
 * stops host/recipe identity spoofing and cross-host spend leakage.
 */
function checkBudgetCheckClaimBinding(
  req: BudgetCheckRequest,
  claims: McpHostAccessClaims
): BudgetCheckBindingReason | null {
  const isSentinel = claims.recipeNamespace === config.hostsNamespace
  const isRecipe = claims.recipeNamespace === config.sandboxNamespace
  if (!isSentinel && !isRecipe) return 'unrecognized_token_binding'

  const expectedHostRef = claims.hostRefs[0]
  const hostRef = req.host_ref.trim()
  const recipeName =
    typeof req.recipe_name === 'string' && req.recipe_name.trim().length > 0
      ? req.recipe_name.trim()
      : null

  if (isSentinel) {
    if (recipeName) return 'sentinel_token_with_recipe_name'
    if (req.source_kind === 'workflow') return 'sentinel_token_with_workflow_source'
    if (hostRef && hostRef !== expectedHostRef) return 'sentinel_token_host_ref_mismatch'
  } else {
    if (recipeName !== claims.recipeName) return 'recipe_token_recipe_name_mismatch'
    if (req.source_kind !== 'workflow') return 'recipe_token_non_workflow_source'
    if (hostRef && hostRef !== expectedHostRef) return 'recipe_token_host_ref_mismatch'
  }
  return null
}

type ReleaseBindingReason = 'unrecognized_token_binding' | 'host_ref_mismatch'

/**
 * Bind the /release body to the JWT's namespace/host claims — a simplified
 * mirror of `checkBudgetCheckClaimBinding`. The release body carries neither
 * `recipe_name` nor `source_kind`, so the binding reduces to:
 *   - the token's namespace must be recognized (1st-party sentinel
 *     `=== hostsNamespace`, or WRC recipe `=== sandboxNamespace`); and
 *   - `host_ref` must equal `claims.hostRefs[0]` (the host/recipe the token was
 *     minted for).
 * This prevents a valid mcp-host token from releasing another host's or recipe's
 * reservation. releaseReservation additionally filters the DELETE by host_ref,
 * so this is defense-in-depth over the SQL scoping.
 */
function checkReleaseClaimBinding(
  hostRef: string,
  claims: McpHostAccessClaims
): ReleaseBindingReason | null {
  const isSentinel = claims.recipeNamespace === config.hostsNamespace
  const isRecipe = claims.recipeNamespace === config.sandboxNamespace
  if (!isSentinel && !isRecipe) return 'unrecognized_token_binding'
  if (hostRef.trim() !== claims.hostRefs[0]) return 'host_ref_mismatch'
  return null
}

export function createInternalBudgetsCheckRouter(): Router {
  const router = Router()

  router.post('/internal/budgets/check', requireMcpHostJwt, async (req, res, next) => {
    try {
      const parsed = budgetCheckRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({
          error: 'invalid_request',
          details: parsed.error.issues.map(issue => ({
            field: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        })
      }
      // Authorize (not just authenticate): bind the body to the token's claims
      // before reading any spend. requireMcpHostJwt guarantees req.mcpHostJwt.
      const binding = checkBudgetCheckClaimBinding(parsed.data, req.mcpHostJwt!)
      if (binding) {
        return res.status(403).json({ error: 'claim_binding_violation', reason: binding })
      }
      const result = await evaluateBudgetCheck(parsed.data)
      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  })

  router.post('/internal/budgets/release', requireMcpHostJwt, async (req, res, next) => {
    try {
      const parsed = releaseRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({
          error: 'invalid_request',
          details: parsed.error.issues.map(issue => ({
            field: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        })
      }
      // Authorize (not just authenticate): bind the body's host_ref to the
      // token's namespace/host claims so a valid mcp-host token cannot release
      // another host's reservation. requireMcpHostJwt guarantees req.mcpHostJwt.
      // `host_ref` is already trimmed by the schema, so the same canonical value
      // feeds both the binding and the DELETE.
      const hostRef = parsed.data.host_ref
      const binding = checkReleaseClaimBinding(hostRef, req.mcpHostJwt!)
      if (binding) {
        return res.status(403).json({ error: 'claim_binding_violation', reason: binding })
      }
      // Idempotent: releasing an already-gone (or swept) reservation deletes 0
      // rows and still returns 200. A reservation is never security-sensitive
      // state — over-releasing only re-opens the (already TTL'd) race window.
      // releaseReservation scopes the DELETE by the validated host_ref, so only
      // this host's own reservations can be freed.
      const released = await releaseReservation({
        reservationId: parsed.data.reservationId ?? null,
        taskRef: parsed.data.task_ref ?? null,
        hostRef,
      })
      return res.status(200).json({ released })
    } catch (error) {
      return next(error)
    }
  })

  return router
}
