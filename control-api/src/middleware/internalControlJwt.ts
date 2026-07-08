import { NextFunction, Request, Response } from 'express'
import {
  type InternalControlClaims,
  verifyInternalControlJwt,
} from '../utils/auth/internalControlToken.js'
import { extractBearerToken } from '../utils/extractBearerToken.js'

declare global {
  namespace Express {
    interface Request {
      internalControl?: InternalControlClaims
    }
  }
}

export function requireInternalControlJwt(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req)
  if (!token || token.length > 4096) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const claims = verifyInternalControlJwt(token)
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  req.internalControl = claims
  if (req.log) {
    req.log.info(
      {
        event: 'internal_control_jwt_authenticated',
        iss: claims.iss,
        sub: claims.sub,
        jti: claims.jti,
      },
      'internal control jwt authenticated'
    )
  }
  next()
}
