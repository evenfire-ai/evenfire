import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { deriveOAuthEncryptionKey } from '../../oauth/encryption.js'
import { rootLogger } from '../../observability/logger.js'
import {
  type CodexOAuthDeps,
  CodexSubscriptionOAuthError,
  handleCodexBrowserCallback,
} from '../../services/codexSubscriptionOAuth.js'

const log = rootLogger.child({ module: 'auth-codex-subscription' })

function dbClient() {
  return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
}

function oauthDeps(req: {
  protocol: string
  get: (h: string) => string | undefined
}): CodexOAuthDeps {
  const origin =
    config.oauthCallbackBaseUrl && config.oauthCallbackBaseUrl.length > 0
      ? config.oauthCallbackBaseUrl.replace(/\/+$/, '')
      : `${req.protocol}://${req.get('host') ?? 'localhost'}`
  return {
    db: dbClient(),
    encryptionKey: deriveOAuthEncryptionKey(config.oauthEncryptionKey),
    fetchFn: fetch,
    clientId: config.codexOAuthClientId,
    redirectUri: `${origin}/api/v1/auth/codex-subscription/callback`,
    enabled: config.codexSubscriptionEnabled,
  }
}

export function createAuthCodexSubscriptionRouter(): Router {
  const router = Router()

  router.get(
    '/auth/codex-subscription/callback',
    asyncHandler(async (req, res) => {
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      const state = typeof req.query.state === 'string' ? req.query.state : ''
      try {
        const connection = await handleCodexBrowserCallback(oauthDeps(req), { code, state })
        res.status(200).json({
          status: connection.status,
          accountFingerprint: connection.accountFingerprint,
          credentialRevision: connection.credentialRevision,
        })
      } catch (err) {
        if (err instanceof CodexSubscriptionOAuthError) {
          const status = err.code === 'disabled' ? 404 : 400
          log.warn({ event: 'codex_oauth_callback_denied', code: err.code }, 'callback denied')
          res.status(status).json({ error: err.code })
          return
        }
        throw err
      }
    })
  )

  return router
}
