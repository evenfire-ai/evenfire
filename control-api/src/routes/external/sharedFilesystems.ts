import { Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { K8sGateway } from '../../k8s.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import {
  listActiveContextIds,
  partitionAccessValues,
} from '../../services/directory/accessReconciliation.js'
import { getTeamContexts, getUserContexts } from '../../services/directory/index.js'
import { K8sNotFoundError } from '../../services/resourceService.js'
import { WFC_BROWSING_READ_SCOPE, signWfcBrowsingToken } from '../../utils/auth/wfcBrowsingToken.js'
import { wfcServiceUrl } from '../../utils/wfcServiceUrl.js'

/**
 * Read-only end-user access to SharedFileSystems referenced by a Context.
 *
 *   GET  /external/contexts/:contextId/shared-filesystems
 *        → list of { name, mountPath, phase, pvcName? } for SFS attached to
 *          the Context. Caller must have access to the Context (user-direct
 *          or via current team). Returns 403 otherwise.
 *
 *   GET|HEAD /external/contexts/:contextId/shared-filesystems/:sfsName/proxy/*
 *        → reverse proxy to the per-SFS workspace-files-controller. Methods
 *          other than GET/HEAD return 405; uploads, replaces, mkdirs, moves,
 *          and deletes are rejected at this layer regardless of what the
 *          client asks for.
 */

type ContextSharedFileSystemRef = { name?: string; mountPath?: string }
type ContextSharedFileSystemStatus = {
  name?: string
  mountPath?: string
  phase?: string
  pvcName?: string
  message?: string
}

type ContextResource = {
  spec?: { sharedFileSystems?: ContextSharedFileSystemRef[] }
  status?: { sharedFileSystems?: ContextSharedFileSystemStatus[] }
}

type SharedFilesystemsRequestCache = {
  accessibleContextIds?: Promise<Set<string>>
  contexts?: Map<string, Promise<ContextResource>>
}

class ContextAccessReconciliationError extends Error {
  constructor(cause: unknown) {
    super('Context access reconciliation is unavailable')
    this.name = 'ContextAccessReconciliationError'
    this.cause = cause
  }
}

async function loadAccessibleContextIds(
  gateway: K8sGateway,
  userId: string,
  teamId: string | null
): Promise<Set<string>> {
  const accessible = new Set<string>()
  let activeContextIds: string[]
  try {
    activeContextIds = await listActiveContextIds(gateway)
  } catch (err) {
    console.warn('[external/shared-filesystems] context reconciliation failed:', err)
    throw new ContextAccessReconciliationError(err)
  }
  const userCtx = await getUserContexts(userId)
  const userContextIds = partitionAccessValues(userCtx.contextIds, activeContextIds).active
  for (const id of userContextIds) {
    accessible.add(id)
  }
  if (teamId && teamId.trim()) {
    const teamCtx = await getTeamContexts(teamId.trim())
    const teamContextIds = partitionAccessValues(teamCtx.contextIds, activeContextIds).active
    for (const id of teamContextIds) {
      accessible.add(id)
    }
  }
  return accessible
}

function requestCache(res: { locals: Record<string, unknown> }): SharedFilesystemsRequestCache {
  const key = 'externalSharedFilesystems'
  const locals = res.locals as Record<string, SharedFilesystemsRequestCache | undefined>
  locals[key] ??= {}
  return locals[key]
}

function loadAccessibleContextIdsForRequest(
  gateway: K8sGateway,
  req: ExternalAuthedRequest,
  res: { locals: Record<string, unknown> }
): Promise<Set<string>> {
  const cache = requestCache(res)
  const claims = req.externalAuth!
  cache.accessibleContextIds ??= loadAccessibleContextIds(gateway, claims.userId, claims.teamId)
  return cache.accessibleContextIds
}

async function resolveAccessibleContextIdsForRequest(
  gateway: K8sGateway,
  req: ExternalAuthedRequest,
  res: {
    locals: Record<string, unknown>
    status: (code: number) => { json: (body: unknown) => void }
  }
): Promise<Set<string> | null> {
  try {
    return await loadAccessibleContextIdsForRequest(gateway, req, res)
  } catch (err) {
    if (!(err instanceof ContextAccessReconciliationError)) throw err
    res.status(503).json({ error: 'context_reconciliation_unavailable' })
    return null
  }
}

function loadContextForRequest(
  gateway: K8sGateway,
  res: { locals: Record<string, unknown> },
  contextId: string,
  namespace: string
): Promise<ContextResource> {
  const cache = requestCache(res)
  cache.contexts ??= new Map()
  const cacheKey = `${namespace}/${contextId}`
  let promise = cache.contexts.get(cacheKey)
  if (!promise) {
    promise = gateway.getResource('contexts', contextId, namespace) as Promise<ContextResource>
    cache.contexts.set(cacheKey, promise)
  }
  return promise
}

function hasUnsafeProxySubPath(rawSubPath: string): boolean {
  let candidate = rawSubPath
  for (let i = 0; i < 3; i += 1) {
    if (candidate.includes('..')) return true
    let decoded: string
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      return true
    }
    if (decoded === candidate) return false
    candidate = decoded
  }
  try {
    return decodeURIComponent(candidate).includes('..')
  } catch {
    return true
  }
}

/**
 * #592 CWE-209: map a SharedFileSystem phase to a fixed, end-user-safe message.
 * The end-user API NEVER echoes the raw `status.conditions[].message` (or the
 * Context's per-ref message), which can contain K8s/API-server internals,
 * scheduler/kubelet text, or registry paths. Operators still get the detailed
 * condition message from the CRD status via admin RBAC.
 */
function curatedSfsMessage(phase: string | null | undefined): string | null {
  switch (phase) {
    case 'Provisioning':
    case 'Initializing':
      return 'Provisioning storage…'
    case 'Degraded':
      return 'Storage is degraded; contact an administrator.'
    case 'Failed':
      return 'Storage provisioning failed; contact an administrator.'
    default:
      // Ready / Mounted / unknown → no message.
      return null
  }
}

export function createExternalSharedFilesystemsRouter(gateway: K8sGateway): Router {
  const router = Router()
  const externalSharedFilesystemsRateLimits = createExternalClientRateLimiters(
    'shared-filesystems',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )
  const sfsNs = config.sharedFilesystemsNamespace
  const ctxNs = config.contextsNamespace

  router.use(
    '/external/contexts/:contextId/shared-filesystems',
    ...externalSharedFilesystemsRateLimits,
    requireValidExternalSessionToken
  )

  // Reject anything but GET/HEAD up-front so the proxy below can never be
  // coerced into forwarding a write to wfc.
  router.use(
    '/external/contexts/:contextId/shared-filesystems',
    (req: ExternalAuthedRequest, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        next()
        return
      }
      res.setHeader('Allow', 'GET, HEAD')
      res.status(405).json({ error: 'Method Not Allowed' })
    }
  )

  router.get(
    '/external/contexts/:contextId/shared-filesystems',
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const contextId = String(req.params.contextId || '').trim()
      if (!contextId) {
        res.status(400).json({ error: 'contextId is required' })
        return
      }

      const accessible = await resolveAccessibleContextIdsForRequest(gateway, req, res)
      if (!accessible) return
      if (!accessible.has(contextId)) {
        res.status(403).json({ error: 'Forbidden' })
        return
      }

      let ctx: ContextResource
      try {
        ctx = await loadContextForRequest(gateway, res, contextId, ctxNs)
      } catch (e) {
        if (e instanceof K8sNotFoundError) {
          res.status(404).json({ error: 'Context not found' })
          return
        }
        throw e
      }

      const refs = Array.isArray(ctx.spec?.sharedFileSystems) ? ctx.spec!.sharedFileSystems! : []
      const statusByName = new Map<string, ContextSharedFileSystemStatus>()
      for (const s of ctx.status?.sharedFileSystems ?? []) {
        if (s.name) statusByName.set(s.name, s)
      }

      // The Context's per-ref status array is not always populated, so fall
      // back to each SharedFileSystem CRD's own .status.phase / .status.pvcName.
      type SfsStatus = {
        phase?: string
        pvcName?: string
      }
      type SfsResource = { status?: SfsStatus }
      const validRefs = refs.filter(r => r.name && r.mountPath)
      const sfsStatusByName = new Map<string, SfsStatus>()
      await Promise.all(
        validRefs.map(async r => {
          try {
            const sfs = (await gateway.getResource(
              'sharedfilesystems',
              r.name!,
              sfsNs
            )) as SfsResource
            if (sfs.status) sfsStatusByName.set(r.name!, sfs.status)
          } catch (e) {
            if (!(e instanceof K8sNotFoundError)) throw e
          }
        })
      )

      const items = validRefs.map(r => {
        const ctxStatus = statusByName.get(r.name!)
        const sfsStatus = sfsStatusByName.get(r.name!)
        const phase = ctxStatus?.phase ?? sfsStatus?.phase ?? null
        return {
          name: r.name!,
          mountPath: r.mountPath!,
          phase,
          pvcName: ctxStatus?.pvcName ?? sfsStatus?.pvcName ?? null,
          // #592 CWE-209: the message is DERIVED from the phase, never echoed from
          // status. Raw condition/Context messages can carry K8s/API-server
          // internals (reconcile errors, scheduler/kubelet text, registry paths)
          // — those stay in the CRD status for operators (admin RBAC) but must not
          // reach this end-user-facing API. See curatedSfsMessage().
          message: curatedSfsMessage(phase),
        }
      })

      res.status(200).json({ items })
    })
  )

  // Reverse proxy to wfc — GET/HEAD only by virtue of the guard above.
  router.use(
    '/external/contexts/:contextId/shared-filesystems/:sfsName/proxy',
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const claims = req.externalAuth!
      const contextId = String(req.params.contextId || '').trim()
      const sfsName = String(req.params.sfsName || '').trim()
      if (!contextId || !sfsName) {
        res.status(400).json({ error: 'contextId and sfsName are required' })
        return
      }

      // Authorise: caller must have access to the Context, AND the requested
      // SFS must actually be referenced by that Context. Without the second
      // check, a user with access to context A could browse any SFS in the
      // cluster by name.
      const accessible = await resolveAccessibleContextIdsForRequest(gateway, req, res)
      if (!accessible) return
      if (!accessible.has(contextId)) {
        res.status(403).json({ error: 'Forbidden' })
        return
      }

      let ctx: ContextResource
      try {
        ctx = await loadContextForRequest(gateway, res, contextId, ctxNs)
      } catch (e) {
        if (e instanceof K8sNotFoundError) {
          res.status(404).json({ error: 'Context not found' })
          return
        }
        throw e
      }
      const referencesSfs = (ctx.spec?.sharedFileSystems ?? []).some(r => r.name === sfsName)
      if (!referencesSfs) {
        res.status(404).json({ error: 'SharedFileSystem not attached to context' })
        return
      }

      // Confirm the SFS exists AND is Ready before minting a token routed at it.
      // #592: if the wfc isn't serving yet (PVC unbound / pod not ready), fail
      // fast with an actionable 503 instead of letting the fetch below return a
      // raw 502 from a dead upstream.
      let sfsResource: { status?: { phase?: string } }
      try {
        sfsResource = (await gateway.getResource('sharedfilesystems', sfsName, sfsNs)) as {
          status?: { phase?: string }
        }
      } catch (e) {
        if (e instanceof K8sNotFoundError) {
          res.status(404).json({ error: 'SharedFileSystem not found' })
          return
        }
        throw e
      }
      const sfsPhase = sfsResource.status?.phase
      if (sfsPhase !== 'Ready') {
        res.status(503).json({ error: 'sharedfilesystem_not_ready', phase: sfsPhase ?? null })
        return
      }

      const rawSubPath = req.url || '/'
      if (hasUnsafeProxySubPath(rawSubPath)) {
        res.status(400).json({ error: 'invalid_path' })
        return
      }

      const upstream = wfcServiceUrl(sfsName, sfsNs)
      const subPath = rawSubPath === '/' ? '' : rawSubPath
      const target = `${upstream}${subPath}`

      const { token: browsingToken } = signWfcBrowsingToken({
        subject: claims.email || claims.userId,
        sharedFileSystem: sfsName,
        sharedFileSystemNamespace: sfsNs,
        scopes: [WFC_BROWSING_READ_SCOPE],
      })
      const headers: Record<string, string> = {
        authorization: `Bearer ${browsingToken}`,
      }

      const upstreamRes = await fetch(target, {
        method: req.method,
        headers,
      })

      res.status(upstreamRes.status)
      const upstreamCt = upstreamRes.headers.get('content-type')
      if (upstreamCt) res.setHeader('content-type', upstreamCt)
      const upstreamCd = upstreamRes.headers.get('content-disposition')
      if (upstreamCd) res.setHeader('content-disposition', upstreamCd)
      const upstreamCl = upstreamRes.headers.get('content-length')
      if (upstreamCl) res.setHeader('content-length', upstreamCl)

      if (!upstreamRes.body) {
        res.end()
        return
      }
      const reader = upstreamRes.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) res.write(Buffer.from(value))
        }
        res.end()
      } catch {
        if (!res.headersSent) res.status(502).json({ error: 'wfc upstream error' })
        else res.end()
      }
    })
  )

  return router
}
