import { Request, Response, Router } from 'express'
import httpProxy from 'http-proxy'
import { authorizeActionV2 } from '../actionAuthorityV2.js'
import { config } from '../config.js'
import { AuthedRequest, extractAuthToken, requireRpcAuth } from '../middleware/auth.js'
import { requireScope } from '../middleware/auth.js'
import { bindRouteActionV2 } from '../routeActionBindingV2.js'
import { startActiveViewLease } from '../services/activeViewLease.js'
import { DesktopSessionService } from '../services/desktopSessionService.js'
import { tokenDeclaresV2, verifyUserDelegationV2 } from '../userDelegationV2.js'

const sessionService = new DesktopSessionService()

const DESKTOP_UPSTREAM_BLOCKED_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-evenfire-action-delegation',
])

export function stripDesktopEdgeCredentials(headers: Request['headers']): void {
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase()
    if (
      DESKTOP_UPSTREAM_BLOCKED_HEADERS.has(normalized) ||
      normalized.startsWith('x-clerum-edge-')
    ) {
      delete headers[name]
    }
  }
}

function isV2ViewRequest(req: AuthedRequest): boolean {
  return Boolean(req.userDelegationV2 && req.authorizedActionV2)
}

function requireV2Delegation(req: AuthedRequest, res: Response, next: () => void): void {
  if (!isV2ViewRequest(req)) {
    res.status(401).json({ error: 'v2_delegation_required' })
    return
  }
  next()
}

function v2ViewAuthority(req: AuthedRequest, res: Response, next: () => void): void {
  if (!tokenDeclaresV2(extractAuthToken(req))) {
    next()
    return
  }
  requireRpcAuth(req, res, () => requireScope('desktop:view')(req, res, next))
}

function v2OrLegacyHostAllowed(req: AuthedRequest, hostRef: string): boolean {
  return isV2ViewRequest(req) || Boolean(req.auth?.hostRefs.includes(hostRef))
}

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

      if (!v2OrLegacyHostAllowed(req, hostRef)) {
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

  const openOrReconnect = async (req: AuthedRequest, res: Response): Promise<void> => {
    const { hostRef } = req.params

    if (!v2OrLegacyHostAllowed(req, hostRef)) {
      res.status(403).json({ error: 'hostRef not permitted by JWT' })
      return
    }

    // HCC remains readiness-only. The earlier v2 checkpoint is the sole
    // authorization producer; this call cannot widen host authority.
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
        typeof status.status !== 'string' ||
        (status.hostRef && status.hostRef !== hostRef)
      ) {
        res.status(502).json({ error: 'Malformed HCC response' })
        return
      }
      if (status.status !== 'running') {
        res.status(503).json({ error: 'Desktop not running' })
        return
      }
    } catch {
      res.status(502).json({ error: 'Failed to reach HCC' })
      return
    }

    if (!isV2ViewRequest(req)) {
      const cookie = sessionService.createSession(hostRef, req.auth!.sub)
      const secureAttr = process.env.NODE_ENV === 'production' ? '; Secure' : ''
      res.setHeader('Set-Cookie', [
        `${sessionService.getCookieName()}=${cookie}; Path=/api/v1/desktop/${hostRef}; HttpOnly; SameSite=Strict${secureAttr}; Max-Age=${Math.floor(sessionService.getMaxAgeMs() / 1000)}`,
      ])
    }
    res.json({ ok: true, hostRef })
  }

  router.post(
    '/desktop/:hostRef/session',
    requireRpcAuth,
    requireScope('desktop:view'),
    async (req: AuthedRequest, res: Response) => {
      await openOrReconnect(req, res)
    }
  )

  router.post(
    '/desktop/:hostRef/reconnect',
    requireRpcAuth,
    requireScope('desktop:view'),
    requireV2Delegation,
    async (req: AuthedRequest, res: Response) => {
      await openOrReconnect(req, res)
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

  router.all('/desktop/:hostRef/view/*', v2ViewAuthority, (req: Request, res: Response) => {
    const { hostRef } = req.params
    const authed = req as AuthedRequest
    const v2Request = isV2ViewRequest(authed)

    if (!v2Request) {
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
    }

    // Proxy to desktop pod
    const target = `http://${hostRef}.${config.hostNamespace}.svc.cluster.local:${config.desktopPort}`
    const path = req.params[0] || ''
    req.url = `/${path}${req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`
    const lease = v2Request
      ? startActiveViewLease(authed.authorizedActionV2!, { onDenied: () => res.destroy() })
      : null
    res.once('close', () => lease?.close())
    res.once('finish', () => lease?.close())
    stripDesktopEdgeCredentials(req.headers)
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

function rejectUpgrade(socket: import('net').Socket, status: number): void {
  socket.write(
    `HTTP/1.1 ${status} ${status === 503 ? 'Service Unavailable' : 'Unauthorized'}\r\n\r\n`
  )
  socket.destroy()
}

async function handleV2DesktopUpgrade(
  req: Request,
  socket: import('net').Socket,
  head: Buffer,
  hostRef: string,
  path: string
): Promise<void> {
  const claims = verifyUserDelegationV2(extractAuthToken(req))
  if (!claims) {
    rejectUpgrade(socket, 401)
    return
  }
  try {
    const bound = bindRouteActionV2(
      {
        route: { path: '/desktop/:hostRef/view/*' },
        method: 'GET',
        params: { hostRef },
        query: {},
        body: undefined,
      } as unknown as AuthedRequest,
      claims
    )
    const authorized = await authorizeActionV2(claims, bound)
    const lease = startActiveViewLease(authorized, { onDenied: () => socket.destroy() })
    socket.once('close', () => lease.close())
    socket.once('error', () => lease.close())
    const target = `ws://${hostRef}.${config.hostNamespace}.svc.cluster.local:${config.desktopPort}`
    req.url = `/${path}`
    stripDesktopEdgeCredentials(req.headers)
    proxy.ws(req, socket, head, { target })
  } catch {
    // A malformed binding, denial, stale authority, or checkpoint outage must
    // all fail before an upstream desktop connection is attempted.
    rejectUpgrade(socket, 403)
  }
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

  if (tokenDeclaresV2(extractAuthToken(req))) {
    void handleV2DesktopUpgrade(req, socket, head, hostRef, path)
    return true
  }

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
  stripDesktopEdgeCredentials(req.headers)
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
