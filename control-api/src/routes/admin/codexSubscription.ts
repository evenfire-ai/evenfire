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
  listCodexCatalogModels,
  listOfferedCodexModelsForAssignment,
  pickCodexGrantModel,
  setCodexCatalogModelEnabled,
  syncCodexSubscriptionCatalog,
} from '../../services/codexSubscriptionCatalog.js'
import {
  CODEX_UNASSIGNED_CONNECTION_KEY,
  CodexSubscriptionInvalidConnectionKeyError,
  assertCodexConnectionKey,
  createNamedCodexSubscriptionConnection,
  generateCodexConnectionKey,
  getSafeCodexSubscriptionConnection,
  listSafeCodexSubscriptionConnections,
  loadCodexSubscriptionSecrets,
  normalizeCodexConnectionKey,
  updateCodexSubscriptionConnectionMetadata,
} from '../../services/codexSubscriptionConnection.js'
import {
  type CodexOAuthDeps,
  CodexSubscriptionOAuthError,
  ensureFreshCodexAccessToken,
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
import { publishAllowedModelsConfigMapAfterGrantChange } from '../../services/llmAllowedModelsConfigMap.js'
import { K8sConflictError } from '../../services/resourceService.js'
import {
  adminCodexReadRateLimits,
  adminCodexWriteRateLimits,
} from '../workflows/shared/rateLimit.js'
import { createHostValidationDeps, validateHostSpec } from './hostSpecValidation.js'
import {
  type HostSpecIncoherenceToleratedEvent,
  emitHostSpecIncoherenceTolerated,
} from './hostWriteGateAudit.js'
import type { StaleModelWarning } from './staleModelWarning.js'

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
  const raw = typeof req.params?.key === 'string' ? req.params.key.trim() : ''
  if (!raw) return normalizeCodexConnectionKey(raw)
  return assertCodexConnectionKey(raw)
}

function parseIntent(value: unknown): CodexSubscriptionOAuthIntent {
  return value === 'reconnect' || value === 'replace' ? value : 'connect'
}

function sendOAuthError(
  res: { status: (n: number) => { json: (body: unknown) => void } },
  err: unknown
) {
  if (err instanceof CodexSubscriptionInvalidConnectionKeyError) {
    res.status(400).json({ error: 'invalid_connection_key' })
    return
  }
  if (err instanceof CodexSubscriptionOAuthError) {
    const status =
      err.code === 'disabled'
        ? 404
        : err.code === 'replacement_required' ||
            err.code === 'fingerprint_in_use' ||
            err.code === 'connection_mismatch'
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

type HostRecord = {
  metadata?: { name?: string; resourceVersion?: string }
  spec?: unknown
}

type CodexAssignableHostRow = {
  name: string
  connectionRef: string
  displayName: string
  provider?: string
  model?: string
}

function hostModel(
  spec: unknown
): { provider?: string; connectionRef?: string; name?: string } | null {
  if (!spec || typeof spec !== 'object') return null
  const model = (spec as { model?: { provider?: string; connectionRef?: string; name?: string } })
    .model
  if (!model || typeof model !== 'object') return null
  return model
}

function hostModelName(spec: unknown): string {
  const name = hostModel(spec)?.name
  return typeof name === 'string' ? name.trim() : ''
}

function hostConnectionRef(spec: unknown): string | null {
  const model = hostModel(spec)
  if (!model || model.provider !== 'codex-subscription') return null
  const raw = typeof model.connectionRef === 'string' ? model.connectionRef.trim() : ''
  return raw || CODEX_UNASSIGNED_CONNECTION_KEY
}

function assignableHostFromRecord(host: HostRecord): CodexAssignableHostRow | null {
  const name = String(host.metadata?.name ?? '').trim()
  if (!name) return null
  const model = hostModel(host.spec)
  const provider = typeof model?.provider === 'string' ? model.provider.trim() : ''
  const modelName = hostModelName(host.spec)
  const connectionRef =
    provider === 'codex-subscription'
      ? hostConnectionRef(host.spec) || CODEX_UNASSIGNED_CONNECTION_KEY
      : CODEX_UNASSIGNED_CONNECTION_KEY
  return {
    name,
    connectionRef,
    displayName: name,
    ...(provider ? { provider } : {}),
    ...(modelName ? { model: modelName } : {}),
  }
}

function storedCodexConnectionRef(spec: unknown): string | null {
  const model = hostModel(spec)
  if (!model || model.provider !== 'codex-subscription') return null
  return typeof model.connectionRef === 'string' ? model.connectionRef.trim() : ''
}

export function createAdminCodexSubscriptionRouter(
  catalogTransport: CodexCatalogTransport = createCodexCatalogTransportFromEnv(),
  gateway?: K8sGateway
): Router {
  const router = Router()

  async function listHostsOrUnavailable(): Promise<HostRecord[] | null> {
    if (!gateway) return null
    try {
      return (await gateway.listResource('hosts', config.hostsNamespace)) as HostRecord[]
    } catch (err) {
      log.warn({ event: 'codex_assigned_hosts_list_failed', err }, 'failed to list assigned hosts')
      return null
    }
  }

  function hostsForConnection(hosts: HostRecord[], connectionKey: string): Array<{ name: string }> {
    return hosts
      .filter(host => hostConnectionRef(host.spec) === connectionKey)
      .map(host => ({ name: String(host.metadata?.name ?? '') }))
      .filter(host => host.name)
  }

  function collectAssignableHosts(hosts: HostRecord[]): CodexAssignableHostRow[] {
    return hosts
      .map(assignableHostFromRecord)
      .filter((row): row is CodexAssignableHostRow => Boolean(row))
  }

  async function loadHost(
    hostRef: string
  ): Promise<{ ok: true; host: HostRecord } | { ok: false; status: number; error: string }> {
    if (!gateway) return { ok: false, status: 503, error: 'hosts_unavailable' }
    try {
      const host = (await gateway.getResource(
        'hosts',
        hostRef,
        config.hostsNamespace
      )) as HostRecord
      return { ok: true, host }
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      const status = (err as { httpStatus?: number; code?: number } | null)?.httpStatus
      if (name === 'K8sNotFoundError' || status === 404) {
        return { ok: false, status: 404, error: 'host_not_found' }
      }
      log.warn(
        { event: 'codex_host_read_failed', err, hostRef },
        'failed to read host for bind/unbind'
      )
      return { ok: false, status: 503, error: 'hosts_unavailable' }
    }
  }

  async function writeHostConnectionRef(
    hostRef: string,
    host: HostRecord,
    nextConnectionRef: string
  ): Promise<
    | { ok: true; warnings: StaleModelWarning[]; model: string }
    | { ok: false; status: number; error: string; message?: string; reason?: string }
  > {
    if (!gateway) return { ok: false, status: 503, error: 'hosts_unavailable' }
    const spec =
      host.spec && typeof host.spec === 'object'
        ? { ...(host.spec as Record<string, unknown>) }
        : {}
    const model =
      spec.model && typeof spec.model === 'object'
        ? { ...(spec.model as Record<string, unknown>) }
        : {}
    model.provider = 'codex-subscription'
    model.connectionRef = nextConnectionRef
    let resolvedModel = typeof model.name === 'string' ? model.name.trim() : ''
    if (nextConnectionRef !== CODEX_UNASSIGNED_CONNECTION_KEY) {
      const offered = await listOfferedCodexModelsForAssignment(dbClient(), nextConnectionRef)
      if (offered.length === 0) {
        return {
          ok: false,
          status: 422,
          error: 'catalog_not_ready',
          message:
            'This subscription has no offered models yet. Sign in and sync the catalog before assigning agents.',
        }
      }
      const grant = await getSafeCodexSubscriptionConnection(dbClient(), nextConnectionRef)
      resolvedModel = pickCodexGrantModel(resolvedModel, offered, grant?.defaultModel)
      model.name = resolvedModel
    }
    spec.model = model
    const stored =
      host.spec && typeof host.spec === 'object'
        ? (host.spec as Record<string, unknown>)
        : undefined
    const hostRefId = { namespace: config.hostsNamespace, name: hostRef }
    const hostTolerations: HostSpecIncoherenceToleratedEvent[] = []
    const hostWarnings: StaleModelWarning[] = []
    const issue = await validateHostSpec(spec, createHostValidationDeps(pool), {
      stored,
      hostRef: hostRefId,
      ...(stored !== undefined ? { tolerations: hostTolerations, warnings: hostWarnings } : {}),
    })
    if (issue) {
      return {
        ok: false,
        status: 422,
        error: 'invalid_host_spec',
        message: issue.errors[0]?.message,
      }
    }
    try {
      await gateway.updateResource(
        'hosts',
        hostRef,
        {
          metadata: host.metadata?.resourceVersion
            ? { resourceVersion: host.metadata.resourceVersion }
            : undefined,
          spec,
        },
        config.hostsNamespace
      )
      for (const event of hostTolerations) emitHostSpecIncoherenceTolerated(event)
      return { ok: true, warnings: hostWarnings, model: resolvedModel }
    } catch (err) {
      if (err instanceof K8sConflictError) {
        return { ok: false, status: 409, error: 'conflict', reason: 'resource_changed' }
      }
      log.warn(
        { event: 'codex_host_write_failed', err, hostRef },
        'failed to write host connectionRef'
      )
      return { ok: false, status: 503, error: 'hosts_unavailable' }
    }
  }

  async function publishRuntimeAllowlist(): Promise<void> {
    await publishAllowedModelsConfigMapAfterGrantChange(gateway?.llmAllowedModelsConfigMap())
  }

  async function publishRuntimeAllowlistOrFail(res: {
    status: (n: number) => { json: (body: unknown) => void }
  }): Promise<boolean> {
    try {
      await publishRuntimeAllowlist()
      return false
    } catch (err) {
      llmAllowlistConfigMapWriteFailuresTotal.inc({ phase: 'mutation' })
      log.error(
        { err, event: 'codex_allowed_models_cm_write_failed' },
        'Codex grant change saved but the runtime ConfigMap was not updated'
      )
      res.status(503).json({
        error: 'configmap_write_failed',
        message:
          'the grant change was saved but the ConfigMap could not be updated; runtime hosts still see the previous snapshot — retry or it will reconcile on the next change/boot',
      })
      return true
    }
  }

  async function withAssignedHosts<T extends { connectionKey: string }>(
    connection: T,
    hosts?: HostRecord[] | null
  ) {
    const resolved = hosts === undefined ? await listHostsOrUnavailable() : hosts
    if (resolved === null) {
      return { ...connection, assignedHostsUnavailable: true as const }
    }
    return {
      ...connection,
      assignedHosts: hostsForConnection(resolved, connection.connectionKey),
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
      if (result.status === 'connected' && (await publishRuntimeAllowlistOrFail(res))) return
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
      if (await publishRuntimeAllowlistOrFail(res)) return
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
      const connectionKey = keyFromReq(req)
      await ensureFreshCodexAccessToken(
        oauthDeps(req, resolveBrowserRedirectUri(req), connectionKey)
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
      if (!synced.connection) {
        res.status(409).json({ error: 'stale_revision' })
        return
      }
      if (synced.outcome !== 'ready') {
        if (await publishRuntimeAllowlistOrFail(res)) return
        res.status(503).json({
          error: 'catalog_sync_failed',
          outcome: synced.outcome,
          added: synced.added,
          refreshed: synced.refreshed,
          staled: synced.staled,
          connection: synced.connection,
        })
        return
      }
      if (await publishRuntimeAllowlistOrFail(res)) return
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
      if (await publishRuntimeAllowlistOrFail(res)) return
      res.status(200).json(await withAssignedHosts(connection))
    } catch (err) {
      sendOAuthError(res, err)
    }
  })

  router.get(`${BASE}/connection`, ...adminCodexReadRateLimits(), getConnectionHandler)
  router.post(`${BASE}/browser/start`, ...adminCodexWriteRateLimits(), browserStartHandler)
  router.post(`${BASE}/device/start`, ...adminCodexWriteRateLimits(), deviceStartHandler)
  router.get(`${BASE}/device/poll`, ...adminCodexReadRateLimits(), devicePollHandler)
  router.post(`${BASE}/refresh`, ...adminCodexWriteRateLimits(), refreshHandler)
  router.post(`${BASE}/catalog/sync`, ...adminCodexWriteRateLimits(), catalogSyncHandler)
  router.post(`${BASE}/revoke`, ...adminCodexWriteRateLimits(), revokeHandler)
  router.get(`${BASE}/connections/:key`, ...adminCodexReadRateLimits(), getConnectionHandler)
  router.post(
    `${BASE}/connections/:key/browser/start`,
    ...adminCodexWriteRateLimits(),
    browserStartHandler
  )
  router.post(
    `${BASE}/connections/:key/device/start`,
    ...adminCodexWriteRateLimits(),
    deviceStartHandler
  )
  router.get(
    `${BASE}/connections/:key/device/poll`,
    ...adminCodexReadRateLimits(),
    devicePollHandler
  )
  router.post(`${BASE}/connections/:key/refresh`, ...adminCodexWriteRateLimits(), refreshHandler)
  router.post(
    `${BASE}/connections/:key/catalog/sync`,
    ...adminCodexWriteRateLimits(),
    catalogSyncHandler
  )
  router.post(`${BASE}/connections/:key/revoke`, ...adminCodexWriteRateLimits(), revokeHandler)

  router.get(
    `${BASE}/connections`,
    ...adminCodexReadRateLimits(),
    asyncHandler(async (_req, res) => {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      const rows = await listSafeCodexSubscriptionConnections(dbClient())
      const hosts = await listHostsOrUnavailable()
      const connections = []
      for (const row of rows) {
        connections.push(await withAssignedHosts(row, hosts))
      }
      if (hosts === null) {
        res.status(200).json({ connections, assignableHostsUnavailable: true })
        return
      }
      res.status(200).json({
        connections,
        assignableHosts: collectAssignableHosts(hosts),
      })
    })
  )

  router.post(
    `${BASE}/connections`,
    ...adminCodexWriteRateLimits(),
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
        if (displayName.length > 64) {
          res.status(400).json({ error: 'display_name_too_long' })
          return
        }
        const requestedKey =
          typeof req.body?.connectionKey === 'string' && req.body.connectionKey.trim()
            ? assertCodexConnectionKey(req.body.connectionKey.trim())
            : generateCodexConnectionKey()
        const created = await createNamedCodexSubscriptionConnection(dbClient(), {
          connectionKey: requestedKey,
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
    ...adminCodexReadRateLimits(),
    asyncHandler(async (req, res) => {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      const connection = await getCodexSubscriptionConnection(
        oauthDeps(req, resolveBrowserRedirectUri(req), keyFromReq(req))
      )
      if (!('id' in connection)) {
        res.status(409).json({ error: 'not_connected' })
        return
      }
      const models = await listCodexCatalogModels(dbClient(), connection.id)
      res.status(200).json({ models })
    })
  )

  router.patch(
    `${BASE}/connections/:key`,
    ...adminCodexWriteRateLimits(),
    asyncHandler(async (req, res) => {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      let connectionKey: string
      try {
        connectionKey = keyFromReq(req)
      } catch (err) {
        sendOAuthError(res, err)
        return
      }
      const hasDisplayName = typeof req.body?.displayName === 'string'
      const hasDefaultModel = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'defaultModel')
      if (!hasDisplayName && !hasDefaultModel) {
        res.status(400).json({ error: 'empty_patch' })
        return
      }
      if (hasDisplayName && req.body.displayName.trim().length > 64) {
        res.status(400).json({ error: 'display_name_too_long' })
        return
      }
      const defaultModel = hasDefaultModel
        ? typeof req.body.defaultModel === 'string'
          ? req.body.defaultModel.trim()
          : ''
        : undefined
      if (defaultModel) {
        const offered = await listOfferedCodexModelsForAssignment(dbClient(), connectionKey)
        if (!offered.includes(defaultModel)) {
          res.status(422).json({ error: 'default_model_not_offered' })
          return
        }
      }
      const updated = await updateCodexSubscriptionConnectionMetadata(dbClient(), connectionKey, {
        ...(hasDisplayName ? { displayName: req.body.displayName } : {}),
        ...(hasDefaultModel ? { defaultModel: defaultModel || null } : {}),
      })
      if (!updated) {
        res.status(404).json({ error: 'no_grant' })
        return
      }
      res.status(200).json(await withAssignedHosts(updated))
    })
  )

  router.patch(
    `${BASE}/connections/:key/models/:model`,
    ...adminCodexWriteRateLimits(),
    asyncHandler(async (req, res) => {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      let connectionKey: string
      try {
        connectionKey = keyFromReq(req)
      } catch (err) {
        sendOAuthError(res, err)
        return
      }
      if (typeof req.body?.enabled !== 'boolean') {
        res.status(400).json({ error: 'invalid_enabled' })
        return
      }
      const connection = await getSafeCodexSubscriptionConnection(dbClient(), connectionKey)
      if (!connection) {
        res.status(404).json({ error: 'no_grant' })
        return
      }
      const model = typeof req.params.model === 'string' ? req.params.model.trim() : ''
      if (!model) {
        res.status(404).json({ error: 'model_not_found' })
        return
      }
      const models = await setCodexCatalogModelEnabled(
        dbClient(),
        connection.id,
        model,
        req.body.enabled
      )
      if (!models) {
        res.status(404).json({ error: 'model_not_found' })
        return
      }
      if (await publishRuntimeAllowlistOrFail(res)) return
      res.status(200).json({ models })
    })
  )

  router.get(
    `${BASE}/assignable-hosts`,
    ...adminCodexReadRateLimits(),
    asyncHandler(async (_req, res) => {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      const hosts = await listHostsOrUnavailable()
      if (hosts === null) {
        res.status(503).json({ error: 'hosts_unavailable' })
        return
      }
      res.status(200).json({ hosts: collectAssignableHosts(hosts) })
    })
  )

  const bindUnbindHandler = (action: 'bind' | 'unbind') =>
    asyncHandler(async (req, res) => {
      if (!config.codexSubscriptionEnabled) {
        res.status(404).json({ error: 'disabled' })
        return
      }
      let connectionKey: string
      try {
        connectionKey = assertCodexConnectionKey(
          typeof req.params.key === 'string' ? req.params.key : ''
        )
      } catch (err) {
        sendOAuthError(res, err)
        return
      }
      const hostRef = typeof req.params.hostRef === 'string' ? req.params.hostRef.trim() : ''
      if (!hostRef) {
        res.status(400).json({ error: 'invalid_host_ref' })
        return
      }

      const loaded = await loadHost(hostRef)
      if (!loaded.ok) {
        res.status(loaded.status).json({ error: loaded.error })
        return
      }
      const storedRef = storedCodexConnectionRef(loaded.host.spec)
      if (storedRef === null && action === 'unbind') {
        res.status(409).json({ error: 'not_codex_host' })
        return
      }
      // Empty/missing connectionRef is unassigned, never the reserved default grant.
      // Non-Codex hosts bind as a conversion: the hub is the ops center that
      // sets provider, grant, and a seeded default model in one write.
      const currentRef = storedRef || CODEX_UNASSIGNED_CONNECTION_KEY
      const currentModel = hostModelName(loaded.host.spec)

      if (action === 'unbind') {
        if (currentRef === CODEX_UNASSIGNED_CONNECTION_KEY) {
          res.status(200).json({
            host: hostRef,
            connectionRef: CODEX_UNASSIGNED_CONNECTION_KEY,
            ...(currentModel ? { model: currentModel } : {}),
          })
          return
        }
        if (currentRef !== connectionKey) {
          res.status(409).json({ error: 'connection_mismatch' })
          return
        }
        const written = await writeHostConnectionRef(
          hostRef,
          loaded.host,
          CODEX_UNASSIGNED_CONNECTION_KEY
        )
        if (!written.ok) {
          res.status(written.status).json({
            error: written.error,
            ...(written.message ? { message: written.message } : {}),
            ...(written.reason ? { reason: written.reason } : {}),
          })
          return
        }
        res.status(200).json({
          host: hostRef,
          connectionRef: CODEX_UNASSIGNED_CONNECTION_KEY,
          ...(written.model ? { model: written.model } : {}),
          ...(written.warnings.length > 0 ? { warnings: written.warnings } : {}),
        })
        return
      }

      if (currentRef === connectionKey && currentModel) {
        res.status(200).json({
          host: hostRef,
          connectionRef: connectionKey,
          model: currentModel,
        })
        return
      }
      const written = await writeHostConnectionRef(hostRef, loaded.host, connectionKey)
      if (!written.ok) {
        res.status(written.status).json({
          error: written.error,
          ...(written.message ? { message: written.message } : {}),
          ...(written.reason ? { reason: written.reason } : {}),
        })
        return
      }
      res.status(200).json({
        host: hostRef,
        connectionRef: connectionKey,
        ...(written.model ? { model: written.model } : {}),
        ...(written.warnings.length > 0 ? { warnings: written.warnings } : {}),
      })
    })

  router.post(
    `${BASE}/connections/:key/hosts/:hostRef/unbind`,
    ...adminCodexWriteRateLimits(),
    bindUnbindHandler('unbind')
  )
  router.post(
    `${BASE}/connections/:key/hosts/:hostRef/bind`,
    ...adminCodexWriteRateLimits(),
    bindUnbindHandler('bind')
  )

  return router
}
