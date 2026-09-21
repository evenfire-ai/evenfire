import express from 'express'
import { rateLimitMiddleware } from '../../../../control-api/src/middleware/rateLimitMiddleware'
import { jsonBody } from '../middleware/jsonBody'

declare function login(): void

function fetch(_url: string): Promise<void> {
  return Promise.resolve()
}

function requireSandboxOAuthIdentity(_req: unknown, _res: unknown, next: () => void): void {
  next()
}

function requireSandboxOAuthAuthority(_req: unknown, _res: unknown, next: () => void): void {
  login()
  next()
}

const router = express.Router()
const controlApiBaseUrl = 'http://control-api'
const localOnlyLimiter = rateLimitMiddleware({ maxPerMinute: 10 })
router.post(
  '/sandbox-ui/:recipeNs/:recipeName/oauth/token',
  requireSandboxOAuthIdentity,
  jsonBody,
  localOnlyLimiter,
  requireSandboxOAuthAuthority,
  async (_req, res) => {
    await fetch(`${controlApiBaseUrl}/internal/sandbox-ui/oauth/token`)
    res.sendStatus(204)
  }
)
router.delete(
  '/sandbox-ui/:recipeNs/:recipeName/oauth/grant',
  requireSandboxOAuthIdentity,
  jsonBody,
  requireSandboxOAuthAuthority,
  async (_req, res) => {
    await fetch(`${controlApiBaseUrl}/internal/sandbox-ui/oauth/grant`)
    res.sendStatus(204)
  }
)

export default router
