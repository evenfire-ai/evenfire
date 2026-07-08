import { Request, Response, Router } from 'express'
import httpProxy from 'http-proxy'
import { config } from '../config.js'
import { AuthedRequest, requireRpcAuth } from '../middleware/auth.js'
import { requireScope } from '../middleware/auth.js'
import { DesktopSessionService } from '../services/desktopSessionService.js'

const sessionService = new DesktopSessionService()

/**
 * Issues a desktop session cookie after validating the caller's JWT
 * and confirming via HCC that the target desktop is running.
 * POST /api/v1/desktop/:hostRef/session
 * Body: (none)
 * Requires: RPC auth with desktop:view scope and hostRef in JWT hostRefs
 */
/**
 * Returns desktop status by proxying to HCC.
 * GET /api/v1/desktop/:hostRef
 * Requires: RPC auth with desktop:view scope and hostRef in JWT hostRefs
 */
function createStatusRoute(): Router {
  const router = Router()

  router.get(
    '/desktop/:hostRef',
    requireRpcAuth,
    requireScope('desktop:view'),
    async (req: AuthedRequest, res: Response) => {
      const { hostRef } = req.params

      if (!req.auth!.hostRefs.includes(hostRef)) {
        res.status(403).json({ error: 'hostRef not permitted by JWT' })
        return
      }

      try {
        const hccRes = await fetch(
          `${config.hccBaseUrl}/api/v1/desktop/${encodeURIComponent(hostRef)}`,
          {
            method: 'GET',
            headers: config.desktopApiToken
              ? { authorization: `Bearer ${config.desktopApiToken}` }
              : {},
            signal: AbortSignal.timeout(config.upstreamTimeoutMs),
          }
        )
        if (!hccRes.ok) {
          res.status(502).json({ error: 'HCC status check failed' })
          return
        }
        const status = (await hccRes.json()) as {
          status: string
          hostRef?: string
          message?: string
        }
        if (
          typeof status !== 'object' ||
          status === null ||
          typeof (status as any).status !== 'string'
        ) {
          res.status(502).json({ error: 'Malformed HCC response' })
          return
        }
        res.json({ status: status.status, hostRef, message: status.message })
      } catch (err) {
        console.error('[DesktopProxy] HCC status check error:', err)
        res.status(502).json({ error: 'Failed to reach HCC' })
      }
    }
  )

  return router
}

function createSessionRoute(): Router {
  const router = Router()

  router.post(
    '/desktop/:hostRef/session',
    requireRpcAuth,
    requireScope('desktop:view'),
    async (req: AuthedRequest, res: Response) => {
      const { hostRef } = req.params

      // Enforce JWT hostRef allowlist
      if (!req.auth!.hostRefs.includes(hostRef)) {
        res.status(403).json({ error: 'hostRef not permitted by JWT' })
        return
      }

      // Check HCC: is the desktop actually running?
      try {
        const hccRes = await fetch(
          `${config.hccBaseUrl}/api/v1/desktop/${encodeURIComponent(hostRef)}`,
          {
            method: 'GET',
            headers: config.desktopApiToken
              ? { authorization: `Bearer ${config.desktopApiToken}` }
              : {},
            signal: AbortSignal.timeout(config.upstreamTimeoutMs),
          }
        )
        if (!hccRes.ok) {
          res.status(502).json({ error: 'HCC readiness check failed' })
          return
        }
        const status = (await hccRes.json()) as { status: string; hostRef?: string }
        if (
          typeof status !== 'object' ||
          status === null ||
          typeof (status as any).status !== 'string'
        ) {
          res.status(502).json({ error: 'Malformed HCC response' })
          return
        }
        if (status.hostRef && status.hostRef !== hostRef) {
          res.status(502).json({ error: 'HCC returned status for unexpected hostRef' })
          return
        }
        if (status.status !== 'running') {
          res.status(503).json({ error: 'Desktop not running' })
          return
        }
      } catch (err) {
        console.error('[DesktopProxy] HCC readiness check error:', err)
        res.status(502).json({ error: 'Failed to reach HCC' })
        return
      }

      // Issue session cookie. Secure is set in production (HTTPS only) and skipped
      // in dev/test where the desktop app talks to rpc-proxy over plain HTTP.
      const cookie = sessionService.createSession(hostRef, req.auth!.sub)
      const secureAttr = process.env.NODE_ENV === 'production' ? '; Secure' : ''
      res.setHeader('Set-Cookie', [
        `${sessionService.getCookieName()}=${cookie}; Path=/api/v1/desktop/${hostRef}; HttpOnly; SameSite=Strict${secureAttr}; Max-Age=${Math.floor(sessionService.getMaxAgeMs() / 1000)}`,
      ])
      res.json({ ok: true, hostRef })
    }
  )

  return router
}

/**
 * Creates the HTTP proxy for WebSocket upgrade and HTTP forwarding.
 * Target: {hostRef}.{hostNamespace}.svc.cluster.local:{desktopPort}
 */
function createDesktopHttpProxy(): httpProxy {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
    xfwd: true,
  })

  proxy.on(
    'error',
    (
      err: Error,
      _req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse | import('node:net').Socket
    ) => {
      console.error('[DesktopProxy] Proxy error:', err.message)
      if (res && 'writeHead' in res && typeof res.writeHead === 'function') {
        ;(res as unknown as Response).status(502).json({ error: 'Desktop proxy error' })
      }
    }
  )

  return proxy
}

const proxy = createDesktopHttpProxy()

/**
 * Desktop proxy route for HTTP requests.
 * GET /api/v1/desktop/:hostRef/view/*
 * Auth: session cookie (set by POST /session above)
 */
function createViewRoute(): Router {
  const router = Router()

  router.all('/desktop/:hostRef/view/*', (req: Request, res: Response) => {
    const { hostRef } = req.params

    // Validate session cookie
    const cookies = parseCookies(req.headers.cookie || '')
    const cookieValue = cookies[sessionService.getCookieName()]
    if (!cookieValue) {
      res.status(401).json({ error: 'Desktop session required' })
      return
    }
    const session = sessionService.validateSession(cookieValue)
    if (!session || session.hostRef !== hostRef) {
      res.status(401).json({ error: 'Invalid desktop session' })
      return
    }

    // Proxy to desktop pod
    const target = `http://${hostRef}.${config.hostNamespace}.svc.cluster.local:${config.desktopPort}`
    const path = req.params[0] || ''
    req.url = `/${path}${req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`
    proxy.web(req, res, { target })
  })

  return router
}

export function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=')
    if (name) result[name.trim()] = rest.join('=').trim()
  }
  return result
}

/**
 * Handle WebSocket upgrade for desktop VNC stream.
 * Called from main.ts on 'upgrade' event.
 */
export function handleDesktopUpgrade(
  req: Request,
  socket: import('net').Socket,
  head: Buffer
): boolean {
  const url = req.url || ''
  const match = url.match(/^\/api\/v1\/desktop\/([^/]+)\/view\/(.*)/)
  if (!match) return false

  const hostRef = match[1]
  const path = match[2] || ''

  // Validate via session cookie
  const cookies = parseCookies(req.headers.cookie || '')
  const cookieValue = cookies[sessionService.getCookieName()]
  if (!cookieValue) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return true
  }
  const session = sessionService.validateSession(cookieValue)
  if (!session || session.hostRef !== hostRef) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return true
  }

  const target = `ws://${hostRef}.${config.hostNamespace}.svc.cluster.local:${config.desktopPort}`
  req.url = `/${path}`
  proxy.ws(req, socket, head, { target })
  return true
}

export function createDesktopRouter(): Router {
  const router = Router()
  router.use(createStatusRoute())
  router.use(createSessionRoute())
  router.use(createViewRoute())
  return router
}
