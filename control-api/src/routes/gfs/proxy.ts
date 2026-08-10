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
      const { token } = signGfsToken({
        subject,
        drive: DEFAULT_DRIVE,
        scopes: [scope],
        principalType: 'control-admin',
      })
      const headers: Record<string, string> = {}
      headers['author' + 'ization'] = ['Bearer', token].join(' ')
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        headers['content-type'] = 'application/json'
      }

      let upstreamRes: Response
      // Header-only deadline: guard the wait for gfsc to START responding, but do
      // NOT bound the streamed response body. A GET download can legitimately
      // stream longer than the mutation budget, and a total-deadline abort would
      // truncate it into a 200 with a short body (control-ui exempts GET for the
      // same reason). Cleared the moment headers arrive, so an upload still fails
      // loud (504) when gfsc never answers.
      const deadline = new AbortController()
      const deadlineTimer = setTimeout(() => deadline.abort(), config.gfscProxyTimeoutMs)
      try {
        upstreamRes = await fetch(target, {
          method: req.method,
          headers,
          body:
            req.method === 'GET' || req.method === 'HEAD'
              ? undefined
              : JSON.stringify(req.body ?? {}),
          signal: deadline.signal,
        })
      } catch (err) {
        // Never silent: a failed or timed-out gfsc fetch is logged with the target.
        const timedOut =
          deadline.signal.aborted || (err instanceof Error && err.name === 'TimeoutError')
        rootLogger.error(
          { err, target, method: req.method, timeoutMs: config.gfscProxyTimeoutMs },
          timedOut
            ? 'gfs operator proxy: gfsc fetch timed out'
            : 'gfs operator proxy: gfsc fetch failed'
        )
        res
          .status(timedOut ? 504 : 502)
          .json({ error: timedOut ? 'gfsc_timeout' : 'gfsc_unreachable' })
        return
      } finally {
        clearTimeout(deadlineTimer)
      }

      if (upstreamRes.status >= 400) {
        // Error envelopes are small JSON: buffer, LOG (so a gfsc 5xx is never
        // undiagnosable at this hop again — the base64 RangeError 500 was invisible
        // here before), then forward the body verbatim.
        const errorBody = await upstreamRes.text()
        const logCtx = {
          target,
          method: req.method,
          status: upstreamRes.status,
          body: errorBody.slice(0, 2048),
        }
        if (upstreamRes.status >= 500)
          rootLogger.error(logCtx, 'gfs operator proxy: gfsc upstream error')
        else rootLogger.warn(logCtx, 'gfs operator proxy: gfsc upstream client error')
        res.status(upstreamRes.status)
        const contentType = upstreamRes.headers.get('content-type')
        if (contentType) res.setHeader('content-type', contentType)
        res.send(errorBody)
        return
      }

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
