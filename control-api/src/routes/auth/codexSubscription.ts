import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { K8sGateway } from '../../k8s.js'
import { deriveOAuthEncryptionKey } from '../../oauth/encryption.js'
import { rootLogger } from '../../observability/logger.js'
import { llmAllowlistConfigMapWriteFailuresTotal } from '../../observability/metrics.js'
import {
  type CodexCatalogTransport,
  createCodexCatalogTransportFromEnv,
} from '../../services/codexSubscriptionCatalog.js'
import {
  type CodexOAuthDeps,
  CodexSubscriptionOAuthError,
  handleCodexBrowserCallback,
  runCodexCatalogSync,
} from '../../services/codexSubscriptionOAuth.js'
import {
  buildCodexBrowserRedirectUri,
  buildCodexBrowserReturnLocation,
  resolveCodexCallbackControlUiBaseUrl,
} from '../../services/codexSubscriptionRedirectUri.js'
import { publishAllowedModelsConfigMapAfterGrantChange } from '../../services/llmAllowedModelsConfigMap.js'
import { codexOAuthCallbackRateLimits } from '../workflows/shared/rateLimit.js'

const log = rootLogger.child({ module: 'auth-codex-subscription' })

function dbClient() {
  return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
}

function oauthDeps(req: {
  protocol: string
  get: (h: string) => string | undefined
}): CodexOAuthDeps {
  const controlUiOrigin = resolveCodexCallbackControlUiBaseUrl({
    configuredBaseUrl: config.controlUiBaseUrl,
    forwardedHost: req.get('x-forwarded-host'),
    forwardedProto: req.get('x-forwarded-proto'),
    originHeader: req.get('origin'),
  })
  return {
    db: dbClient(),
    encryptionKey: deriveOAuthEncryptionKey(config.oauthEncryptionKey),
    fetchFn: fetch,
    clientId: config.codexOAuthClientId,
    redirectUri: buildCodexBrowserRedirectUri(controlUiOrigin),
    enabled: config.codexSubscriptionEnabled,
  }
}

function redirectToCodexSurface(
  res: { redirect: (status: number, location: string) => void },
  outcome: string
) {
  res.redirect(303, buildCodexBrowserReturnLocation(outcome))
}

export function createAuthCodexSubscriptionRouter(
  gateway?: K8sGateway,
  catalogTransport: CodexCatalogTransport = createCodexCatalogTransportFromEnv()
): Router {
  const router = Router()

  router.get(
    '/auth/codex-subscription/callback',
    ...codexOAuthCallbackRateLimits(),
    asyncHandler(async (req, res) => {
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      const state = typeof req.query.state === 'string' ? req.query.state : ''
      try {
        const connection = await handleCodexBrowserCallback(oauthDeps(req), { code, state })
        await runCodexCatalogSync(
          { ...oauthDeps(req), connectionKey: connection.connectionKey },
          connection.connectionKey,
          catalogTransport
        )
        try {
          await publishAllowedModelsConfigMapAfterGrantChange(gateway?.llmAllowedModelsConfigMap())
        } catch (err) {
          llmAllowlistConfigMapWriteFailuresTotal.inc({ phase: 'mutation' })
          log.error(
            { err, event: 'codex_allowed_models_cm_write_failed' },
            'Codex callback persisted but the runtime ConfigMap was not updated'
          )
        }
        redirectToCodexSurface(res, 'connected')
      } catch (err) {
        if (err instanceof CodexSubscriptionOAuthError) {
          log.warn({ event: 'codex_oauth_callback_denied', code: err.code }, 'callback denied')
          if (err.code === 'disabled') {
            res.status(404).json({ error: err.code })
            return
          }
          redirectToCodexSurface(res, err.code)
          return
        }
        throw err
      }
    })
  )

  return router
}
