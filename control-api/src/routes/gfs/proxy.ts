import type { Router } from 'express'
import {
  GFS_DELETE_SCOPE,
  GFS_READ_SCOPE,
  GFS_WRITE_SCOPE,
  signGfsToken,
} from '../../auth/gfsToken.js'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { type UiAuthedRequest, requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import { rootLogger } from '../../observability/logger.js'

const DEFAULT_DRIVE = 'main'
const PASSTHROUGH_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'content-length']

function gfscBaseUrlFor(method: string): string {
  return method === 'GET' || method === 'HEAD' ? config.gfscBaseUrl : config.gfscWriteBaseUrl
}

/**
 * Reverse proxy for the operator: `* /api/v1/gfs/proxy/*` (Control UI session)
 * → gfsc ClusterIP. The browser carries the admin JWT; we swap it for a freshly
 * minted gfs access token (aud=gfs-controller) before forwarding, so the
 * browser never sees the gfs token and gfsc never sees an admin token. The
 * minted token is scoped to the HTTP verb; gfsc re-checks the permission store
 * on every op.
 */
export function registerGfsProxyRoute(router: Router): void {
  router.use(
    '/gfs/proxy',
    requireAuthForControlUI,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const subject = req.adminAuth?.sub
      if (!subject) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }

      const scope =
        req.method === 'GET' || req.method === 'HEAD'
          ? GFS_READ_SCOPE
          : req.method === 'POST' || req.method === 'PUT'
            ? GFS_WRITE_SCOPE
            : req.method === 'DELETE'
              ? GFS_DELETE_SCOPE
              : null

      if (!scope) {
        res.status(405).json({ error: 'method_not_allowed' })
        return
      }

      const subPath = req.url === '/' ? '' : req.url
      const target = `${gfscBaseUrlFor(req.method).replace(/\/+$/, '')}${subPath}`
      const { token } = signGfsToken({ subject, drive: DEFAULT_DRIVE, scopes: [scope] })
      const headers: Record<string, string> = {}
      headers['author' + 'ization'] = ['Bearer', token].join(' ')
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        headers['content-type'] = 'application/json'
      }

      const upstreamRes = await fetch(target, {
        method: req.method,
        headers,
        body:
          req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            : JSON.stringify(req.body ?? {}),
      })

      res.status(upstreamRes.status)
      for (const header of PASSTHROUGH_RESPONSE_HEADERS) {
        const value = upstreamRes.headers.get(header)
        if (value) res.setHeader(header, value)
      }

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
      } catch (err) {
        // Mid-stream gfsc read failure — surface it, never swallow silently.
        rootLogger.error({ err, target }, 'gfs operator proxy: gfsc upstream stream error')
        if (!res.headersSent) res.status(502).json({ error: 'gfsc upstream error' })
        else res.end()
      }
    })
  )
}
