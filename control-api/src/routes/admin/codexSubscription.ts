import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { deriveOAuthEncryptionKey } from '../../oauth/encryption.js'
import { rootLogger } from '../../observability/logger.js'
import {
  type CodexCatalogTransport,
  createCodexCatalogTransportFromEnv,
  syncCodexSubscriptionCatalog,
} from '../../services/codexSubscriptionCatalog.js'
import { loadCodexSubscriptionSecrets } from '../../services/codexSubscriptionConnection.js'
import {
  type CodexOAuthDeps,
  CodexSubscriptionOAuthError,
  getCodexSubscriptionConnection,
  pollCodexDevice,
  refreshCodexSubscriptionConnection,
  revokeCodexSubscription,
  startCodexBrowserConnect,
  startCodexDeviceConnect,
} from '../../services/codexSubscriptionOAuth.js'
import type { CodexSubscriptionOAuthIntent } from '../../services/codexSubscriptionOAuthState.js'
import {
  buildCodexBrowserRedirectUri,
  isPublicCodexCliClient,
  resolveCodexControlUiBaseUrl,
} from '../../services/codexSubscriptionRedirectUri.js'

const log = rootLogger.child({ module: 'admin-codex-subscription' })
const BASE = '/admin/llm/providers/codex-subscription'

function dbClient() {
  return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
}

function resolveBrowserRedirectUri(req: { get: (h: string) => string | undefined }): string {
  const controlUiOrigin = resolveCodexControlUiBaseUrl(config.controlUiBaseUrl, req.get('origin'))
  return buildCodexBrowserRedirectUri(controlUiOrigin)
}

function oauthDeps(
  req: {
    get: (h: string) => string | undefined
  },
  redirectUri = resolveBrowserRedirectUri(req)
): CodexOAuthDeps {
  return {
    db: dbClient(),
    encryptionKey: deriveOAuthEncryptionKey(config.oauthEncryptionKey),
    fetchFn: fetch,
    clientId: config.codexOAuthClientId,
    redirectUri,
    enabled: config.codexSubscriptionEnabled,
  }
}

function parseIntent(value: unknown): CodexSubscriptionOAuthIntent {
  return value === 'reconnect' || value === 'replace' ? value : 'connect'
}

function sendOAuthError(
  res: { status: (n: number) => { json: (body: unknown) => void } },
  err: unknown
) {
  if (err instanceof CodexSubscriptionOAuthError) {
    const status =
      err.code === 'disabled'
        ? 404
        : err.code === 'replacement_required'
          ? 409
          : err.code === 'refresh_in_flight' || err.code === 'stale_revision'
            ? 409
            : err.code === 'not_connected' || err.code === 'no_grant'
              ? 404
              : 400
    log.warn(
      { event: 'codex_oauth_admin_denied', code: err.code },
      'Codex subscription OAuth denied'
    )
    res.status(status).json({ error: err.code })
    return
  }
  throw err
}

export function createAdminCodexSubscriptionRouter(
  catalogTransport: CodexCatalogTransport = createCodexCatalogTransportFromEnv()
): Router {
  const router = Router()

  router.get(
    `${BASE}/connection`,
    asyncHandler(async (req, res) => {
      try {
        const connection = await getCodexSubscriptionConnection(oauthDeps(req))
        res.status(200).json(connection)
      } catch (err) {
        sendOAuthError(res, err)
      }
    })
  )

  router.post(
    `${BASE}/browser/start`,
    asyncHandler(async (req, res) => {
      try {
        const redirectUri = resolveBrowserRedirectUri(req)
        if (isPublicCodexCliClient(config.codexOAuthClientId)) {
          throw new CodexSubscriptionOAuthError(
            'browser_oauth_unregistered',
            'browser OAuth requires a deployment-registered OpenAI client'
          )
        }
        const started = await startCodexBrowserConnect(
          oauthDeps(req, redirectUri),
          parseIntent(req.body?.intent)
        )
        res.status(200).json(started)
      } catch (err) {
        sendOAuthError(res, err)
      }
    })
  )

  router.post(
    `${BASE}/device/start`,
    asyncHandler(async (req, res) => {
      try {
        const started = await startCodexDeviceConnect(oauthDeps(req), parseIntent(req.body?.intent))
        res.status(200).json(started)
      } catch (err) {
        sendOAuthError(res, err)
      }
    })
  )

  router.get(
    `${BASE}/device/poll`,
    asyncHandler(async (req, res) => {
      try {
        const state = typeof req.query.state === 'string' ? req.query.state : ''
        const result = await pollCodexDevice(oauthDeps(req), state)
        res.status(200).json(result)
      } catch (err) {
        sendOAuthError(res, err)
      }
    })
  )

  router.post(
    `${BASE}/refresh`,
    asyncHandler(async (req, res) => {
      try {
        const connection = await refreshCodexSubscriptionConnection(oauthDeps(req))
        res.status(200).json(connection)
      } catch (err) {
        sendOAuthError(res, err)
      }
    })
  )

  router.post(
    `${BASE}/catalog/sync`,
    asyncHandler(async (req, res) => {
      try {
        if (!config.codexSubscriptionEnabled) {
          res.status(404).json({ error: 'disabled' })
          return
        }
        const db = dbClient()
        const secrets = await loadCodexSubscriptionSecrets(
          db,
          deriveOAuthEncryptionKey(config.oauthEncryptionKey)
        )
        if (!secrets?.accessToken) {
          res.status(404).json({ error: 'no_grant' })
          return
        }
        const synced = await syncCodexSubscriptionCatalog(db, catalogTransport, secrets.accessToken)
        res.status(200).json({
          outcome: synced.outcome,
          added: synced.added,
          refreshed: synced.refreshed,
          staled: synced.staled,
          connection: synced.connection,
        })
      } catch (err) {
        sendOAuthError(res, err)
      }
    })
  )

  router.post(
    `${BASE}/revoke`,
    asyncHandler(async (req, res) => {
      try {
        const connection = await revokeCodexSubscription(oauthDeps(req))
        res.status(200).json(connection)
      } catch (err) {
        sendOAuthError(res, err)
      }
    })
  )

  return router
}
