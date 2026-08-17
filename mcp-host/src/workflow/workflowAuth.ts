import type { NextFunction, Request, Response } from 'express'
import { importSPKI, jwtVerify } from 'jose'
import { config } from '../config'

export interface WorkflowTokenClaims {
  sub: 'wrc' | 'coordinator'
  recipeName: string
  recipeNamespace?: string
  runId?: string
  artifactName?: string
  scopes: string[]
}

let cachedPublicKey: Awaited<ReturnType<typeof importSPKI>> | null = null
let cachedPem = ''

async function verifyWorkflowToken(token: string): Promise<WorkflowTokenClaims> {
  const publicKeyPem = config.wrcPublicKey
  if (!publicKeyPem) throw new Error('WRC public key not configured')

  if (!cachedPublicKey || cachedPem !== publicKeyPem) {
    cachedPublicKey = await importSPKI(publicKeyPem, 'RS256')
    cachedPem = publicKeyPem
  }
  const { payload } = await jwtVerify(token, cachedPublicKey, {
    algorithms: ['RS256'],
    issuer: 'clerum-wrc',
    audience: 'mcp-host',
  })

  if (
    typeof payload.sub !== 'string' ||
    !Array.isArray(payload['scopes']) ||
    typeof payload['recipeName'] !== 'string'
  ) {
    throw new Error('Invalid workflow token claims')
  }

  return {
    sub: payload.sub as 'wrc' | 'coordinator',
    recipeName: payload['recipeName'] as string,
    recipeNamespace:
      typeof payload['recipeNamespace'] === 'string'
        ? (payload['recipeNamespace'] as string)
        : undefined,
    runId: typeof payload['runId'] === 'string' ? (payload['runId'] as string) : undefined,
    artifactName:
      typeof payload['artifactName'] === 'string' ? (payload['artifactName'] as string) : undefined,
    scopes: payload['scopes'] as string[],
  }
}

export function requireWorkflowAuth(requiredScope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.enableAuth) {
      next()
      return
    }

    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing workflow auth token' })
      return
    }

    verifyWorkflowToken(header.slice(7))
      .then(claims => {
        if (!claims.scopes.includes(requiredScope)) {
          res.status(403).json({ error: `Missing scope: ${requiredScope}` })
          return
        }
        ;(req as Request & { workflowClaims: WorkflowTokenClaims }).workflowClaims = claims
        next()
      })
      .catch(() => {
        res.status(401).json({ error: 'Invalid workflow token' })
      })
  }
}

export function workflowClaims(req: Request): WorkflowTokenClaims | undefined {
  return (req as Request & { workflowClaims?: WorkflowTokenClaims }).workflowClaims
}

export function validateWorkflowBinding(
  req: Request,
  res: Response,
  options: { expectedSub?: WorkflowTokenClaims['sub'] } = {}
): WorkflowTokenClaims | null {
  if (!config.enableAuth) return workflowClaims(req) ?? ({} as WorkflowTokenClaims)

  const claims = workflowClaims(req)
  const expectedRecipe = process.env.CLERUM_WORKFLOW_RECIPE ?? ''
  const expectedNamespace = process.env.CLERUM_WORKFLOW_NAMESPACE ?? ''
  if (!claims) {
    res.status(401).json({ error: 'Missing workflow auth token' })
    return null
  }
  if (!expectedRecipe) {
    res.status(500).json({ error: 'Workflow recipe not configured' })
    return null
  }
  if (!expectedNamespace) {
    res.status(500).json({ error: 'Workflow namespace not configured' })
    return null
  }
  if (options.expectedSub && claims.sub !== options.expectedSub) {
    res.status(403).json({ error: `Endpoint requires sub: ${options.expectedSub}` })
    return null
  }
  if (claims.recipeName !== expectedRecipe) {
    res.status(403).json({ error: 'recipeName mismatch' })
    return null
  }
  if (claims.recipeNamespace !== expectedNamespace) {
    res.status(403).json({ error: 'recipeNamespace mismatch' })
    return null
  }
  return claims
}
