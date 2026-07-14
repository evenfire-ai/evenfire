import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { K8sGateway } from '../../k8s.js'
import { requireInternalService } from '../../middleware/internalServiceAuth.js'
import { K8sNotFoundError } from '../../services/resourceService.js'
import { resolveWorkflowTriggerGrant } from '../../services/workflows/workflowTriggerGrantResolver.js'
import { isSandboxUiTeamId, sandboxUiTeamGrantsCte } from '../../utils/auth/sandboxUiGrantSql.js'

/**
 * Sandbox UI registry — server-side resolution of `(recipeNs, recipeName)` to
 * the upstream Service that fronts a recipe's UI workload. rpc-proxy is the
 * sole caller (the "no SSRF" guarantee: the desktop client never names the
 * upstream — it names the recipe, and control-api authoritatively names the
 * service).
 *
 * Status semantics:
 *   200 — recipe is `active`, has a `spec.ui` block, and (when forUser is
 *         provided) the user has a direct trigger grant or active-current-team
 *         trigger grant for it
 *   403 — `forUser` was provided and the user is NOT in the allowlist
 *         (returned only after we have already confirmed the recipe exists
 *         AND has a UI; presence is leaked but the same is true of every
 *         workflow-approval flow the user has access to)
 *   404 — recipe missing, in a non-canonical namespace, or no `ui:` block
 *   409 — recipe found but not routable yet. Three transient sub-states,
 *         distinguished by the `code` field:
 *           - "phase_not_active": WRC hasn't marked the recipe active.
 *           - "service_endpoints_missing": Service/Endpoints not present yet.
 *           - "endpoints_not_ready": Endpoints exists but no Ready addresses
 *             (pod still starting, crash-looping, or being replaced).
 *         All three are "ask again later" from rpc-proxy's perspective.
 *   422 — recipe is active but its UI binding is invalid (the referenced
 *         workload has no port, or `spec.ui.port` disagrees with it).
 *         Terminal from rpc-proxy's perspective: do not retry, surface as
 *         "misconfigured" to the operator.
 *
 * The 404/409 split lets rpc-proxy distinguish "this recipe will never have a
 * UI" (cache, fail fast on subsequent session-mints) from "ask again later"
 * (do not cache; surface a transient "starting up" UI to the user). The two
 * endpoint-readiness sub-codes under 409 give the desktop client a meaningful
 * "Starting up..." signal instead of letting a session-mint succeed against
 * an unroutable target and surface as a generic proxy failure.
 *
 * `forUser` is optional so the same endpoint serves both the rpc-proxy
 * session-mint precheck (user-bound) and view proxy refreshes (user-agnostic;
 * the short-lived sandbox-ui cookie was minted only after this ACL gate).
 * When rpc-proxy supplies `forTeam`, control-api verifies that team grant
 * through active membership instead of trusting the query string alone.
 */

const PLURAL = 'workflowrecipes' as const

interface UiSpec {
  workloadRef: string
  port: number
  title?: string
  icon?: string
  defaultPath?: string
}

interface WorkloadShape {
  id?: string
  port?: number
  transport?: unknown
}

interface RecipeShape {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
  }
  spec?: { ui?: UiSpec; workloads?: WorkloadShape[] }
  status?: {
    phase?: string
    workloadInstances?: Record<string, string>
    lastReconciledAt?: string
  }
}

/**
 * The K8s Service WRC creates for a workload uses `workload.port` as both
 * `port` and `targetPort` (see workflow-recipes/src/reconciler/
 * resourceBuilder.ts → buildService). `spec.ui.port` is a separate field
 * authored alongside the workload reference. Two independent fields naming
 * the same thing means a recipe can be admitted with `ui.port=8080`,
 * `workloads[ui.workloadRef].port=3000`, become `active`, and hand the
 * Desktop App a port the Service does not listen on.
 *
 * The CRD enforces `ui.workloadRef` exists (R15) and constrains the UI
 * workload's shape (R16), but does NOT currently assert
 * `workloads[ui.workloadRef].port == ui.port`. This function is the
 * runtime guard: the referenced workload's `port` is the single source of
 * truth (it is what the Service actually listens on), and we reject any
 * recipe where the two fields disagree or the workload omits a port.
 */
function resolveUiUpstreamPort(
  recipe: RecipeShape
): { ok: true; port: number } | { ok: false; reason: string } {
  const ui = recipe.spec?.ui
  if (!ui) return { ok: false, reason: 'no_ui_block' }
  const workload = (recipe.spec?.workloads ?? []).find(w => w.id === ui.workloadRef)
  if (!workload || typeof workload.port !== 'number') {
    return { ok: false, reason: 'ui_workload_port_missing' }
  }
  if (workload.port !== ui.port) {
    return { ok: false, reason: 'ui_port_mismatch' }
  }
  return { ok: true, port: workload.port }
}

export function createInternalSandboxUiRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    '/internal/sandbox-ui/registry/:recipeNs/:recipeName',
    requireInternalService('rpc-proxy'),
    async (req, res, next) => {
      try {
        const { recipeNs, recipeName } = req.params

        // For v1 every WorkflowRecipe lives in `sandbox-recipes`; an unknown
        // namespace is indistinguishable from "recipe not found" — collapse
        // to 404 to avoid leaking which namespaces the platform recognizes.
        if (recipeNs !== config.sandboxNamespace) {
          return res.status(404).json({ error: 'recipe_not_found' })
        }

        let recipe: RecipeShape
        try {
          recipe = (await gateway.getResource(PLURAL, recipeName, recipeNs)) as RecipeShape
        } catch (err) {
          if (err instanceof K8sNotFoundError) {
            return res.status(404).json({ error: 'recipe_not_found' })
          }
          throw err
        }

        const ui = recipe.spec?.ui
        if (!ui) {
          return res.status(404).json({ error: 'no_ui_block' })
        }

        const phase = recipe.status?.phase
        if (phase !== 'active') {
          return res.status(409).json({
            error: 'recipe_not_ready',
            code: 'phase_not_active',
            reason: `recipe phase is "${phase ?? 'unknown'}"`,
          })
        }

        // The Service WRC builds listens on the workload's port — not
        // `spec.ui.port` — so derive the routable target from the workload.
        // Reject the recipe rather than emit an unroutable Sandbox UI target
        // if the two fields disagree.
        const portResolution = resolveUiUpstreamPort(recipe)
        if (!portResolution.ok) {
          return res.status(422).json({
            error: 'recipe_ui_invalid',
            code: portResolution.reason,
          })
        }
        const upstreamPort = portResolution.port

        // Resolve the actual K8s Service name. WRC writes the deterministic
        // name into `status.workloadInstances` on first reconcile; for legacy
        // / non-workflow recipes it equals the workload id.
        const serviceName = recipe.status?.workloadInstances?.[ui.workloadRef] ?? ui.workloadRef

        // `phase=active` only proves WRC's reconciler applied successfully —
        // it doesn't prove the pod is alive or the Service has a routable
        // backend. Without this check, rpc-proxy can mint a view session
        // against a Service whose Endpoints object is empty (pod still
        // starting / crash-looping / being replaced) and the user sees a
        // generic proxy failure instead of an explicit "starting up" state.
        //
        // Run BEFORE the ACL check so system-state gates stay grouped
        // together (consistent with phase_not_active and ui_port_mismatch
        // above) and no DB query fires when nobody can route yet.
        const readyAddressCount = await gateway.getServiceReadyAddressCount(
          serviceName,
          config.sandboxUiNamespace
        )
        if (readyAddressCount === null) {
          return res.status(409).json({
            error: 'recipe_not_ready',
            code: 'service_endpoints_missing',
            reason: 'Service/Endpoints not yet present for the UI workload',
          })
        }
        if (readyAddressCount === 0) {
          return res.status(409).json({
            error: 'recipe_not_ready',
            code: 'endpoints_not_ready',
            reason: 'UI workload has no Ready endpoint addresses',
          })
        }

        // Optional per-user ACL check. Only fires when `forUser` is provided.
        // Session-mint passes the requesting user's id and current team id;
        // direct user grants and active team grants must match the trigger
        // service's direct-user-session semantics.
        const forUser = typeof req.query.forUser === 'string' ? req.query.forUser.trim() : ''
        const forTeam = typeof req.query.forTeam === 'string' ? req.query.forTeam.trim() : ''
        if (forUser) {
          const grant = await resolveWorkflowTriggerGrant({
            userId: forUser,
            currentTeamId: forTeam || null,
            recipeNamespace: recipeNs,
            recipeName,
            mode: 'direct-user-session',
          })
          if (!grant.granted) {
            return res.status(403).json({ error: 'recipe_acl_denied' })
          }
        }

        return res.status(200).json({
          appRef: `${recipeNs}/${recipeName}`,
          service: {
            name: serviceName,
            namespace: config.sandboxUiNamespace,
            port: upstreamPort,
          },
          ready: true,
          title: ui.title,
          icon: ui.icon,
          defaultPath: ui.defaultPath ?? '/',
        })
      } catch (err) {
        return next(err)
      }
    }
  )

  /**
   * Discovery endpoint that the Desktop App's sandbox UI picker hits via
   * rpc-proxy. Returns every UI-bearing recipe the requesting user can trigger
   * directly or through the active team carried by the RPC JWT.
   *
   * Query params: `forUser` (required) — the userId resolved from the RPC
   * JWT in rpc-proxy. `forTeam` is optional and is accepted only as an active
   * membership constraint in the DB join. Without forUser the endpoint cannot
   * scope the response and returns 400.
   *
   * Per-app `ready` here is the WEAKER `status.phase === "active"` signal,
   * NOT the full endpoint-routability check the /registry endpoint applies.
   * The picker only needs a hint for the starting/ready icon; the strong
   * gate runs when the user actually opens an app (rpc-proxy hits /registry
   * for session-mint and gets 409 with `endpoints_not_ready` if the Service
   * isn't actually routable). Adding an Endpoints lookup per app here would
   * cost N apiserver round-trips per picker render, which is forward work
   * if the discrepancy ever causes UX confusion.
   *
   * `updatedAt` falls back to the recipe's creationTimestamp when
   * status.lastReconciledAt is missing — UI sort order can use it as a
   * stable timestamp.
   */
  router.get(
    '/internal/sandbox-ui/apps',
    requireInternalService('rpc-proxy'),
    async (req, res, next) => {
      try {
        const forUser = typeof req.query.forUser === 'string' ? req.query.forUser.trim() : ''
        if (!forUser) {
          return res.status(400).json({ error: 'forUser_required' })
        }
        const forTeam = typeof req.query.forTeam === 'string' ? req.query.forTeam.trim() : ''
        if (forTeam && !isSandboxUiTeamId(forTeam)) {
          return res.status(400).json({ error: 'forTeam_invalid' })
        }

        // 1. K8s: list every WorkflowRecipe in sandbox-recipes that has a
        //    `spec.ui` block. The list is bounded by the count of recipes
        //    in one namespace — small in practice (single-digit to low
        //    hundreds). Bigger fleets would warrant a label index, but
        //    that is forward work.
        let recipes: RecipeShape[]
        try {
          recipes = (await gateway.listResource(
            'workflowrecipes',
            config.sandboxNamespace
          )) as RecipeShape[]
        } catch (err) {
          if (err instanceof K8sNotFoundError) return res.status(200).json({ apps: [] })
          throw err
        }
        const uiBearing = recipes.filter(
          r => r.spec?.ui && r.metadata?.name && r.metadata?.namespace
        )
        if (uiBearing.length === 0) return res.status(200).json({ apps: [] })

        // 2. DB: intersect with direct user grants and active-current-team
        //    grants in one round-trip via unnest($3::text[], $4::text[]).
        //    This mirrors resolveWorkflowTriggerGrant's direct-user-session
        //    semantics; keep both paths in sync when grant sources change.
        //    The query returns only the (ns, name) pairs the user may trigger.
        const namespaces = uiBearing.map(r => r.metadata!.namespace!)
        const names = uiBearing.map(r => r.metadata!.name!)
        const aclResult = await pool.query(
          `WITH ui_recipes(recipe_namespace, recipe_name) AS (
             SELECT * FROM unnest($3::text[], $4::text[])
           ),
           direct_grants AS (
             SELECT uwt.recipe_namespace, uwt.recipe_name
             FROM user_workflow_triggers uwt
             JOIN ui_recipes ui
               ON ui.recipe_namespace = uwt.recipe_namespace
              AND ui.recipe_name = uwt.recipe_name
             WHERE uwt.user_id = $1
           ),
           ${sandboxUiTeamGrantsCte('recipe')}
           SELECT recipe_namespace, recipe_name FROM direct_grants
           UNION
           SELECT recipe_namespace, recipe_name FROM team_grants`,
          [forUser, forTeam || null, namespaces, names]
        )
        const allowed = new Set<string>()
        for (const row of aclResult.rows as Array<{
          recipe_namespace: string
          recipe_name: string
        }>) {
          allowed.add(`${row.recipe_namespace}/${row.recipe_name}`)
        }

        // 3. Project the intersection into the picker response shape.
        const apps = uiBearing
          .filter(r => allowed.has(`${r.metadata!.namespace!}/${r.metadata!.name!}`))
          .map(r => {
            const meta = r.metadata!
            const ui = r.spec!.ui!
            const phase = typeof r.status?.phase === 'string' ? r.status.phase : null
            const normalizedPhase = phase?.trim().toLowerCase() ?? null
            return {
              appRef: `${meta.namespace!}/${meta.name!}`,
              title: ui.title,
              icon: ui.icon,
              defaultPath: ui.defaultPath ?? '/',
              phase,
              ready: normalizedPhase === 'active',
              updatedAt: r.status?.lastReconciledAt ?? meta.creationTimestamp ?? null,
            }
          })

        return res.status(200).json({ apps })
      } catch (err) {
        return next(err)
      }
    }
  )

  return router
}
