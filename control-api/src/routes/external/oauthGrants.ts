import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { type OAuthOwnerKind, deleteOAuthGrant, listUserOAuthGrants } from '../../oauth/store.js'

function dbClient() {
  return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
}

/**
 * The exact wire shape Profile UI parses (frozen contract, spec 04 U2). Built by
 * an explicit allowlist — never a blind spread of the store row — so a new
 * `UserGrantSummary` column can never leak to the browser as public API.
 * `recipeNamespace`/`recipeName` keep their historical names (additive change:
 * only `ownerKind` + optional `mcpServerName` are new), so the recipe parsing in
 * profile-ui keeps working unchanged.
 */
interface GrantView {
  ownerKind: OAuthOwnerKind
  recipeNamespace: string
  recipeName: string
  oauthClientId: string
  provider: string
  background: boolean
  updatedAt: string
  mcpServerName?: string
}

/**
 * User-facing OAuth grant management (Profile UI → external-rest-api → here).
 *
 * Identity comes ONLY from the verified session token (req.externalAuth.userId);
 * a user can only ever see or revoke their own grants. Revocation is fail-closed:
 * the per-user broker returns 404 after the row is deleted.
 *
 * [SEC] userId is never taken from body or path params.
 */
export function createExternalOauthGrantsRouter(): Router {
  const router = Router()
  const externalOauthGrantsRateLimits = createExternalClientRateLimiters(
    'oauth-grants',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )

  // GET /external/oauth/grants
  // Returns all grants for the authenticated user.
  router.get(
    '/external/oauth/grants',
    ...externalOauthGrantsRateLimits,
    requireValidExternalSessionToken,
    (req: ExternalAuthedRequest, res, next) => {
      void (async () => {
        try {
          const userId = req.externalAuth?.userId
          if (!userId) {
            res.status(401).json({ error: 'Unauthorized' })
            return
          }
          // 'all' — surface both recipe and mcp-server owned grants; the client
          // routes each DELETE by its ownerKind.
          const grants = await listUserOAuthGrants(dbClient(), userId, 'all')
          res.status(200).json({
            grants: grants.map((g): GrantView => {
              const view: GrantView = {
                ownerKind: g.ownerKind,
                recipeNamespace: g.recipeNamespace,
                recipeName: g.recipeName,
                oauthClientId: g.oauthClientId,
                provider: g.provider,
                background: g.background,
                updatedAt: g.updatedAt.toISOString(),
              }
              if (g.mcpServerName !== undefined) view.mcpServerName = g.mcpServerName
              return view
            }),
          })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // DELETE /external/oauth/grants/:recipeNamespace/:recipeName/:oauthClientId?ownerKind=
  // Revokes one grant for the authenticated user. Idempotent: 204 whether or not a
  // row existed (no information leak). `ownerKind` (default 'recipe') routes the
  // delete to the recipe or mcp-server domain.
  //
  // The revocation deletes ONLY this user's grant row (deleteOAuthGrant). It does
  // NOT delete `dynamic_clients` (per-server-CR, shared across users); that
  // teardown lives in the server-CR uninstall (DEC-R2 §3 / aligns with H-3).
  router.delete(
    '/external/oauth/grants/:recipeNamespace/:recipeName/:oauthClientId',
    ...externalOauthGrantsRateLimits,
    requireValidExternalSessionToken,
    (req: ExternalAuthedRequest, res, next) => {
      void (async () => {
        try {
          const userId = req.externalAuth?.userId
          if (!userId) {
            res.status(401).json({ error: 'Unauthorized' })
            return
          }
          const ownerKindRaw =
            req.query.ownerKind === undefined ? 'recipe' : String(req.query.ownerKind)
          if (ownerKindRaw !== 'recipe' && ownerKindRaw !== 'mcpserver') {
            res.status(400).json({ error: 'invalid_request' })
            return
          }
          const ownerKind: OAuthOwnerKind = ownerKindRaw
          // Force the owner namespace server-side by ownerKind (D-2, invariant 7),
          // mirroring the internal lane (internal/oauth.ts): never trust the
          // path-supplied namespace for the delete coordinate. The delete stays
          // scoped to the session userId, so a user can only ever revoke their own
          // grant, and only within the correct owner namespace.
          const recipeNamespace =
            ownerKind === 'mcpserver' ? config.mcpServersNamespace : config.sandboxNamespace
          await deleteOAuthGrant(dbClient(), {
            grantKind: 'user',
            ownerKind,
            recipeNamespace,
            recipeName: String(req.params.recipeName),
            userId,
            oauthClientId: String(req.params.oauthClientId),
          })
          res.status(204).end()
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
