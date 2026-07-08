import { Router } from 'express'
import { Readable } from 'node:stream'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { K8sGateway } from '../../k8s.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { K8sNotFoundError } from '../../services/resourceService.js'
import {
  WFC_BROWSING_SCOPES,
  type WfcBrowsingScope,
  signWfcBrowsingToken,
} from '../../utils/auth/wfcBrowsingToken.js'
import { wfcServiceUrl } from '../../utils/wfcServiceUrl.js'

/**
 * Admin endpoints for SharedFileSystem CRDs and the per-SharedFileSystem
 * workspace-files-controller (wfc) Service that fronts each PVC.
 *
 *   GET  /admin/shared-filesystems                       — list (mcp-host ns)
 *   GET  /admin/shared-filesystems/:name                 — single CRD + status
 *   POST /admin/shared-filesystems/:name/token           — mint browsing JWT
 *   *    /admin/shared-filesystems/:name/proxy/<path...> — reverse proxy to wfc
 *
 * v1 policy: ALL writes go through here, and ALL writes require admin auth
 * (the existing requireAuthForControlUI gate lives in app.ts on /admin/*).
 * Per-team/per-context RBAC is deferred to v2 — see the spec rationale.
 *
 * The proxy keeps the per-SFS wfc reachable only from the control-plane
 * namespace, so HCC's wfc-<hash>-ingress NetworkPolicy can lock the wfc to
 * `app=control-api` only.
 */

function parseRequestedBrowsingScopes(input: unknown): WfcBrowsingScope[] | null {
  if (input === undefined) return null
  if (!Array.isArray(input) || input.length === 0) return null

  const allowed = new Set<string>(WFC_BROWSING_SCOPES)
  const seen = new Set<string>()
  const scopes: WfcBrowsingScope[] = []
  for (const entry of input) {
    if (typeof entry !== 'string' || !allowed.has(entry) || seen.has(entry)) {
      return null
    }
    seen.add(entry)
    scopes.push(entry as WfcBrowsingScope)
  }
  return scopes
}

export function createAdminSharedFilesystemsRouter(gateway: K8sGateway): Router {
  const router = Router()
  const ns = config.sharedFilesystemsNamespace

  router.get(
    '/admin/shared-filesystems',
    asyncHandler(async (_req, res) => {
      const items = await gateway.listResource('sharedfilesystems', ns)
      res.status(200).json({ items })
    })
  )

  router.get(
    '/admin/shared-filesystems/:name',
    asyncHandler(async (req, res) => {
      try {
        const sfs = await gateway.getResource('sharedfilesystems', req.params.name, ns)
        res.status(200).json(sfs)
      } catch (e) {
        if (e instanceof K8sNotFoundError) {
          res.status(404).json({ error: 'SharedFileSystem not found' })
          return
        }
        throw e
      }
    })
  )

  // Create a SharedFileSystem CRD. The reconciler in HCC takes over from there
  // (PVC → wfc Deployment with a seeding initContainer → Service → NetworkPolicies).
  router.post(
    '/admin/shared-filesystems',
    asyncHandler(async (req, res) => {
      const b = (req.body ?? {}) as {
        name?: string
        size?: string
        accessModes?: string[]
        storageClassName?: string
        directories?: string[]
        retainOnDelete?: boolean
        security?: { runAsUser?: number; runAsGroup?: number; fsGroup?: number }
      }
      if (!b.name || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(b.name)) {
        res.status(400).json({
          error:
            'metadata.name is required and must be a DNS-1123 label (lowercase letters/digits/-).',
        })
        return
      }
      const spec: Record<string, unknown> = {}
      if (b.size) spec.size = b.size
      if (b.accessModes && b.accessModes.length > 0) spec.accessModes = b.accessModes
      if (b.storageClassName) spec.storageClassName = b.storageClassName
      if (b.directories && b.directories.length > 0) spec.directories = b.directories
      if (typeof b.retainOnDelete === 'boolean') spec.retainOnDelete = b.retainOnDelete
      if (b.security && Object.keys(b.security).length > 0) spec.security = b.security

      try {
        const created = await gateway.createResource(
          'sharedfilesystems',
          { metadata: { name: b.name }, spec },
          ns
        )
        res.status(201).json(created)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/already exists/i.test(msg)) {
          res.status(409).json({ error: `SharedFileSystem "${b.name}" already exists` })
          return
        }
        throw e
      }
    })
  )

  router.delete(
    '/admin/shared-filesystems/:name',
    asyncHandler(async (req, res) => {
      try {
        await gateway.deleteResource('sharedfilesystems', req.params.name, ns)
        res.status(204).end()
      } catch (e) {
        if (e instanceof K8sNotFoundError) {
          res.status(404).json({ error: 'SharedFileSystem not found' })
          return
        }
        throw e
      }
    })
  )

  router.post(
    '/admin/shared-filesystems/:name/token',
    asyncHandler(async (req: UiAuthedRequest, res) => {
      // Confirm the SharedFileSystem actually exists before we mint a token
      // for a name that has no wfc behind it. This avoids handing out tokens
      // that are valid-looking but route nowhere.
      try {
        await gateway.getResource('sharedfilesystems', req.params.name, ns)
      } catch (e) {
        if (e instanceof K8sNotFoundError) {
          res.status(404).json({ error: 'SharedFileSystem not found' })
          return
        }
        throw e
      }

      const subject = req.adminAuth?.sub ?? 'admin'
      const requestedScopes = parseRequestedBrowsingScopes(req.body?.scopes)
      if (req.body?.scopes !== undefined && !requestedScopes) {
        res.status(400).json({ error: 'invalid_wfc_browsing_scopes' })
        return
      }
      const { token, expiresInSeconds } = signWfcBrowsingToken({
        subject,
        sharedFileSystem: req.params.name,
        sharedFileSystemNamespace: ns,
        scopes: requestedScopes ?? undefined,
      })
      res.status(200).json({
        token,
        expiresInSeconds,
        serviceUrl: wfcServiceUrl(req.params.name, ns),
        audience: config.wfcJwtAudience,
      })
    })
  )

  // Reverse proxy to wfc-<hash>.mcp-host.svc:8086. The browser sends the
  // admin JWT (the same one the rest of /admin/* needs); we swap it for a
  // freshly-minted browsing JWT bound to this SharedFileSystem before
  // forwarding. The browser never sees the wfc token, and the wfc never
  // sees an admin token — each side gets the audience it expects.
  router.use(
    '/admin/shared-filesystems/:name/proxy',
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const upstream = wfcServiceUrl(req.params.name, ns)
      const subPath = req.url === '/' ? '' : req.url
      const target = `${upstream}${subPath}`

      const subject = req.adminAuth?.sub ?? 'admin'
      const { token: browsingToken } = signWfcBrowsingToken({
        subject,
        sharedFileSystem: req.params.name,
        sharedFileSystemNamespace: ns,
      })
      const headers: Record<string, string> = {
        authorization: `Bearer ${browsingToken}`,
      }
      const ct = req.header('content-type')
      if (ct) headers['content-type'] = ct
      // Express auto-decodes JSON bodies; we re-stringify when forwarding.
      const isReadOnly = req.method === 'GET' || req.method === 'HEAD'
      let body: BodyInit | undefined
      if (!isReadOnly) {
        if (ct?.includes('application/json')) {
          body = JSON.stringify(req.body ?? {})
        } else {
          // Multipart and other stream bodies must still be readable here. If a
          // future body parser consumes them before this proxy, fail clearly
          // instead of forwarding an empty write to the wfc.
          if (req.destroyed || req.readableEnded || !req.readable) {
            res.status(400).json({ error: 'Request body is no longer readable' })
            return
          }
          body = Readable.toWeb(req) as unknown as BodyInit
        }
      }

      const upstreamRes = await fetch(target, {
        method: req.method,
        headers,
        body,
        // Required for piping a Node Readable as fetch body; harmless otherwise.
        // @ts-expect-error — duplex is a Node fetch extension not in the lib types.
        duplex: 'half',
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
      // Pipe the upstream stream straight to the response.
      const reader = upstreamRes.body.getReader()
      const pump = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) res.write(Buffer.from(value))
        }
        res.end()
      }
      try {
        await pump()
      } catch {
        if (!res.headersSent) res.status(502).json({ error: 'wfc upstream error' })
        else res.end()
      }
    })
  )

  return router
}
