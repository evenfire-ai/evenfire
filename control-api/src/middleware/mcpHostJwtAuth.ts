import { NextFunction, Request, Response } from 'express'
import { McpHostAccessClaims, verifyMcpHostAccessJwt } from '../utils/auth/mcpHostJwtToken.js'
import { extractBearerToken } from '../utils/extractBearerToken.js'

declare global {
  namespace Express {
    interface Request {
      mcpHostJwt?: McpHostAccessClaims
    }
  }
}

export function requireMcpHostJwt(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req)
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const claims = verifyMcpHostAccessJwt(token)
  if (!claims) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  req.mcpHostJwt = claims
  next()
}
