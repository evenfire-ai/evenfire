import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { K8sGateway } from '../../k8s.js'
import { deriveOAuthEncryptionKey } from '../../oauth/encryption.js'
import { rootLogger } from '../../observability/logger.js'
import {
  type CodexCatalogTransport,
  createCodexCatalogTransportFromEnv,
  listCodexCatalogModels,
  syncCodexSubscriptionCatalog,
} from '../../services/codexSubscriptionCatalog.js'
import {
  CodexSubscriptionInvalidConnectionKeyError,
  assertCodexConnectionKey,
  createNamedCodexSubscriptionConnection,
  listSafeCodexSubscriptionConnections,
  loadCodexSubscriptionSecrets,
  normalizeCodexConnectionKey,
} from '../../services/codexSubscriptionConnection.js'
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
  redirectUri = resolveBrowserRedirectUri(req),
  connectionKey?: string
): CodexOAuthDeps {
  return {
    db: dbClient(),
    encryptionKey: deriveOAuthEncryptionKey(config.oauthEncryptionKey),
    fetchFn: fetch,
    clientId: config.codexOAuthClientId,
    redirectUri,
    enabled: config.codexSubscriptionEnabled,
    connectionKey: normalizeCodexConnectionKey(connectionKey),
  }
}

function keyFromReq(req: { params?: { key?: string } }): string {
  return normalizeCodexConnectionKey(req.params?.key)
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
        : err.code === 'replacement_required' || err.code === 'fingerprint_in_use'
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

function slugFromDisplayName(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
  return slug || `codex-${Date.now().toString(36)}`
}

function hostConnectionRef(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object') return null
  const model = (spec as { model?: { provider?: string; connectionRef?: string } }).model
  if (!model || model.provider !== 'codex-subscription') return null
  return normalizeCodexConnectionKey(model.connectionRef)
}

export function createAdminCodexSubscriptionRouter(
  catalogTransport: CodexCatalogTransport = createCodexCatalogTransportFromEnv(),
  gateway?: K8sGateway
): Router {
  const router = Router()

  async function assignedHostsFor(connectionKey: string): Promise<Array<{ name: string }>> {
    if (!gateway) return []
    try {
      const hosts = (await gateway.listResource('hosts', config.hostsNamespace)) as Array<{
        metadata?: { name?: string }
        spec?: unknown
      }>
      return hosts
        .filter(host => hostConnectionRef(host.spec) === connectionKey)
        .map(host => ({ name: String(host.metadata?.name ?? '') }))
        .filter(host => host.name)
    } catch (err) {
      log.warn({ event: 'codex_assigned_hosts_list_failed', err }, 'failed to list assigned hosts')
      return []
    }
  }

  async function withAssignedHosts<T extends { connectionKey: string }>(connection: T) {
    return {
      ...connection,
      assignedHosts: await assignedHostsFor(connection.connectionKey),
    }
  }

  const getConnectionHandler = asyncHandler(async (req, res) => {
    try {
      const connection = await getCodexSubscriptionConnection(
        oauthDeps(req, resolveBrowserRedirectUri(req), keyFromReq(req))
      )
      res.status(200).json(await withAssignedHosts(connection))
    } catch (err) {
      sendOAuthError(res, err)
    }
  })

  const browserStartHandler = asyncHandler(async (req, res) => {
    try {
      const redirectUri = resolveBrowserRedirectUri(req)
      if (isPublicCodexCliClient(config.codexOAuthClientId)) {
        throw new CodexSubscriptionOAuthError(
          'browser_oauth_unregistered',
          'browser OAuth requires a deployment-registered OpenAI client'
        )
      }
      const started = await startCodexBrowserConnect(
        oauthDeps(req, redirectUri, keyFromReq(req)),
        parseIntent(req.body?.intent)
      )
      res.status(200).json(started)
    } catch (err) {
      sendOAuthError(res, err)
    }
  })

  const deviceStartHandler = asyncHandler(async (req, res) => {
    try {
      const started = await startCodexDeviceConnect(
        oauthDeps(req, resolveBrowserRedirectUri(req), keyFromReq(req)),
        parseIntent(req.body?.intent)
      )
      res.status(200).json(started)
    } catch (err) {
      sendOAuthError(res, err)
    }
  })

  const devicePollHandler = asyncHandler(async (req, res) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : ''
      const result = await pollCodexDevice(
        oauthDeps(req, resolveBrowserRedirectUri(req), keyFromReq(req)),
        state
      )
      res.status(200).json(result)
    } catch (err) {
      sendOAuthError(res, err)
    }
  })

  const refreshHandler = asyncHandler(async (req, res) => {
    try {
      const connection = await refreshCodexSubscriptionConnection(
        oauthDeps(req, resolveBrowserRedirectUri(req), keyFromReq(req))
      )
      res.status(200).json(connection)
    } catch (err) {
      sendOAuthError(res, err)
    }
  })

  const catalogSyncHandler = asyncHandler(async (req, res) => {
    try {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      const db = dbClient()
      const connectionKey = normalizeCodexConnectionKey(
        typeof req.params.key === 'string' ? req.params.key : undefined
      )
      const secrets = await loadCodexSubscriptionSecrets(
        db,
        deriveOAuthEncryptionKey(config.oauthEncryptionKey),
        connectionKey
      )
      if (!secrets?.accessToken) {
        res.status(404).json({ error: 'no_grant' })
        return
      }
      const synced = await syncCodexSubscriptionCatalog(db, catalogTransport, secrets.accessToken, {
        connectionKey,
      })
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

  const revokeHandler = asyncHandler(async (req, res) => {
    try {
      const connection = await revokeCodexSubscription(
        oauthDeps(req, resolveBrowserRedirectUri(req), keyFromReq(req))
      )
      res.status(200).json(await withAssignedHosts(connection))
    } catch (err) {
      sendOAuthError(res, err)
    }
  })

  router.get(`${BASE}/connection`, getConnectionHandler)
  router.post(`${BASE}/browser/start`, browserStartHandler)
  router.post(`${BASE}/device/start`, deviceStartHandler)
  router.get(`${BASE}/device/poll`, devicePollHandler)
  router.post(`${BASE}/refresh`, refreshHandler)
  router.post(`${BASE}/catalog/sync`, catalogSyncHandler)
  router.post(`${BASE}/revoke`, revokeHandler)
  router.get(`${BASE}/connections/:key`, getConnectionHandler)
  router.post(`${BASE}/connections/:key/browser/start`, browserStartHandler)
  router.post(`${BASE}/connections/:key/device/start`, deviceStartHandler)
  router.get(`${BASE}/connections/:key/device/poll`, devicePollHandler)
  router.post(`${BASE}/connections/:key/refresh`, refreshHandler)
  router.post(`${BASE}/connections/:key/catalog/sync`, catalogSyncHandler)
  router.post(`${BASE}/connections/:key/revoke`, revokeHandler)

  router.get(
    `${BASE}/connections`,
    asyncHandler(async (_req, res) => {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      const rows = await listSafeCodexSubscriptionConnections(dbClient())
      const connections = []
      for (const row of rows) {
        connections.push(await withAssignedHosts(row))
      }
      res.status(200).json({ connections })
    })
  )

  router.post(
    `${BASE}/connections`,
    asyncHandler(async (req, res) => {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      try {
        const displayName =
          typeof req.body?.displayName === 'string' && req.body.displayName.trim()
            ? req.body.displayName.trim()
            : 'Codex subscription'
        const requestedKey =
          typeof req.body?.connectionKey === 'string' && req.body.connectionKey.trim()
            ? req.body.connectionKey.trim()
            : slugFromDisplayName(displayName)
        const created = await createNamedCodexSubscriptionConnection(dbClient(), {
          connectionKey: assertCodexConnectionKey(requestedKey),
          displayName,
        })
        res.status(201).json(await withAssignedHosts(created))
      } catch (err) {
        if (err instanceof CodexSubscriptionInvalidConnectionKeyError) {
          res.status(400).json({ error: 'invalid_connection_key' })
          return
        }
        const code = (err as { code?: string } | null)?.code
        if (code === '23505') {
          res.status(409).json({ error: 'connection_key_taken' })
          return
        }
        throw err
      }
    })
  )

  router.get(
    `${BASE}/connections/:key/models`,
    asyncHandler(async (req, res) => {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      const connection = await getCodexSubscriptionConnection(
        oauthDeps(req, resolveBrowserRedirectUri(req), keyFromReq(req))
      )
      if (!('id' in connection)) {
        res.status(200).json({ models: [] })
        return
      }
      const models = await listCodexCatalogModels(dbClient(), connection.id)
      res.status(200).json({ models })
    })
  )

  return router
}
