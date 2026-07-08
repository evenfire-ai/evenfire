import { RequestHandler, Router } from 'express'
import { config } from '../../../config.js'
import { K8sGateway } from '../../../k8s.js'
import { requireInternalControlJwt } from '../../../middleware/internalControlJwt.js'
import { mcpHostHttpMetrics } from '../../../middleware/mcpHostHttpMetrics.js'
import { oauthBrokerJwtIssueTotal } from '../../../observability/metrics.js'
import { K8sNotFoundError } from '../../../services/resourceService.js'
import { issueOAuthBrokerJwt } from '../../../utils/auth/oauthBrokerJwtToken.js'

// Path B, spec §9.1 — WRC obtains a recipe-bound broker token here and writes
// it to the workload's mounted Secret. Only the `wrc` provisioner may call
// this route: recipe pods live in `config.sandboxNamespace`, and broker tokens
// are a recipe-only credential (1st-party HCC hosts use the mcp-host issuance
// route instead).

interface RecipeSpec {
  spec?: { oauthClients?: Array<{ backgroundAccess?: boolean }> }
}

function hasBackgroundAccessClient(recipe: RecipeSpec): boolean {
  return (recipe.spec?.oauthClients ?? []).some(c => c.backgroundAccess === true)
}

export function createAuthRecipeOauthIssueRoutes(gateway: K8sGateway): Router {
  const router = Router()

  function issueBrokerToken(): RequestHandler {
    return (req, res, next) => {
      void (async () => {
        try {
          const provisioner = req.internalControl!
          if (provisioner.iss !== 'wrc') {
            return res.status(403).json({ error: 'invalid_provisioner_for_route' })
          }

          const recipeNamespace = String(req.params.recipeNs ?? '').trim()
          const recipeName = String(req.params.recipeName ?? '').trim()
          if (!recipeNamespace || !recipeName) {
            return res.status(400).json({ error: 'recipeNamespace and recipeName are required' })
          }

          // WRC recipes always live in sandbox-recipes — the InternalControl
          // JWT signature alone does not constrain WHICH recipe a token is
          // minted for, so pin the namespace here.
          if (recipeNamespace !== config.sandboxNamespace) {
            return res.status(403).json({ error: 'provisioner_namespace_mismatch' })
          }

          // [SEC-4] Bind issuance to recipe state, not just the provisioner's
          // signature: the recipe must exist AND declare a backgroundAccess
          // oauthClient. A leaked WRC secret cannot mint broker tokens for
          // arbitrary or non-opted-in recipes.
          let recipe: RecipeSpec
          try {
            recipe = (await gateway.getResource(
              'workflowrecipes',
              recipeName,
              recipeNamespace
            )) as RecipeSpec
          } catch (err) {
            if (err instanceof K8sNotFoundError) {
              oauthBrokerJwtIssueTotal.inc({ result: 'recipe_not_found' }, 1)
              return res.status(404).json({ error: 'recipe_not_found' })
            }
            throw err
          }

          if (!hasBackgroundAccessClient(recipe)) {
            oauthBrokerJwtIssueTotal.inc({ result: 'not_background_access' }, 1)
            return res.status(400).json({ error: 'background_access_not_enabled' })
          }

          const broker = issueOAuthBrokerJwt(recipeNamespace, recipeName)

          req.log?.info(
            {
              event: 'recipe_oauth_broker_token_issued',
              recipeNamespace,
              recipeName,
              provisioner: provisioner.iss,
              sub: provisioner.sub,
              jti: provisioner.jti,
              ttlSec: broker.expiresInSeconds,
            },
            'recipe oauth broker token issued'
          )

          return res.status(200).json({
            brokerToken: broker.token,
            expiresInSeconds: broker.expiresInSeconds,
          })
        } catch (err) {
          next(err)
        }
      })()
    }
  }

  router.post(
    '/auth/recipe-oauth/:recipeNs/:recipeName/broker-token',
    mcpHostHttpMetrics('recipe_oauth_auth_issue'),
    requireInternalControlJwt,
    issueBrokerToken()
  )

  return router
}
