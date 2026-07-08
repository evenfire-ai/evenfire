import { NextFunction, Request, Response } from 'express'
import { verifyOAuthBrokerJwt } from '../utils/auth/oauthBrokerJwtToken.js'
import { extractBearerToken } from '../utils/extractBearerToken.js'

declare global {
  namespace Express {
    interface Request {
      // Recipe identity derived from a broker token's `sub` claim. [SEC-3] the
      // broker route MUST read recipe identity from here only — never from the
      // request body or URL path.
      recipe?: { namespace: string; name: string }
    }
  }
}

/**
 * Gates the recipe OAuth broker route (Path B, spec §10). Validates a broker
 * token — [SEC-2] strictly `aud === 'oauth-broker'`, scope
 * `oauth:service-token` — and populates `req.recipe` from the JWT `sub` claim.
 *
 * This is NOT `requireInternalService` and NOT the rpc-proxy gate: the bearer
 * is a per-recipe credential minted by control-api and mounted into the
 * workload pod, not a static service token.
 */
export function requireBrokerToken(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req)
  if (!token || token.length > 4096) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const claims = verifyOAuthBrokerJwt(token)
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  req.recipe = { namespace: claims.recipeNamespace, name: claims.recipeName }
  next()
}
