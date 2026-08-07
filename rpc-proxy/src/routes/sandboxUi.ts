import { Request, Response, Router } from 'express'
import httpProxy from 'http-proxy'
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import { config } from '../config.js'
import { AuthedRequest, requireRpcAuth, requireScope } from '../middleware/auth.js'
import { emitSessionMint, emitViewRequest } from '../observability/sandboxUiAudit.js'
import { normalizeViewPath } from '../services/sandboxUiPath.js'
import { listSandboxUiApps, lookupSandboxUiRegistry } from '../services/sandboxUiRegistry.js'
import {
  buildSandboxUiSetCookie,
  createSandboxUiSession,
  verifySandboxUiSession,
} from '../services/sandboxUiSession.js'
import { recipeGoneHtml, recipeUpdatingHtml } from '../views/sandboxUiStatus.js'
import { parseCookies } from './desktopProxy.js'

/**
 * POST /api/v1/sandbox-ui/:recipeNs/:recipeName/session
 *
 * Mints the per-recipe UI session cookie that the `view/*` reverse proxy
 * consumes. Auth chain:
 *
 *   1. `requireRpcAuth` — RPC JWT (RS256, iss=control-api, aud=rpc-proxy).
 *   2. `requireScope('sandbox:ui:view')` — issued by control-api when the
 *      user has at least one UI-bearing recipe in their allowlist.
 *   3. Per-recipe ACL — the registry client passes `forUser=<sub>` and only
 *      includes `forTeam=<teamId>` for team-scoped RPC tokens. Teamless tokens
 *      are re-checked against direct user grants. A non-allowlisted user gets
 *      403 even if their token carries the scope (the scope is a coarse "this
 *      user has at least one UI" gate; the per-recipe ACL is authoritative).
 *
 * Status mapping:
 *   204  — cookie minted, Set-Cookie sent
 *   401  — RPC JWT invalid/expired (handled by middleware)
 *   403  — caller lacks `sandbox:ui:view` (middleware) OR not in recipe ACL
 *   404  — recipe missing or has no `ui:` block
 *   409  — recipe found but not yet `active`
 *   500  — registry lookup failed
 */
// Returns true when the client clearly prefers HTML (Accept header includes
// text/html) and false when they explicitly prefer JSON. Browsers sending
// no Accept default to true so the WebContentsView always renders the
// status page; programmatic callers that send `Accept: application/json`
// (curl, the desktop app's debug surface) get the JSON shape.
function prefersHtml(req: Request): boolean {
  const accept = String(req.headers.accept ?? '').toLowerCase()
  if (!accept) return true
  if (accept.includes('application/json')) return false
  return accept.includes('text/html') || accept.includes('*/*')
}

function respondGone(req: Request, res: Response, recipeNs: string, recipeName: string): void {
  res.status(410)
  if (prefersHtml(req)) {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.send(recipeGoneHtml(recipeNs, recipeName))
    return
  }
  res.json({ error: 'recipe_gone' })
}

function respondUpdating(
  req: Request,
  res: Response,
  recipeNs: string,
  recipeName: string,
  reason: string
): void {
  res.status(503)
  if (prefersHtml(req)) {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    // Encourage the desktop app's WebContentsView to retry after a short
    // delay. The HTML page also has a meta refresh fallback.
    res.setHeader('retry-after', '5')
    res.send(recipeUpdatingHtml(recipeNs, recipeName, reason))
    return
  }
  res.json({ error: 'recipe_updating', reason })
}

function teamIdForSandboxUiRegistry(req: AuthedRequest): string | undefined {
  const auth = req.auth
  return auth?.accessScope === 'team' && auth.teamId ? auth.teamId : undefined
}

// Response security headers. CSP is the hard floor; no per-recipe relax.
// frame-ancestors 'none' would normally block embedding, but the desktop
// app embeds via an Electron WebContentsView which uses Chromium's native
// rendering — the policy is enforced inside the view's own browsing
// context, not against an outer iframe.
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';" +
    " img-src 'self' data:; font-src 'self' data:; connect-src 'self';" +
    " frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(),' +
    ' magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

// Headers we strip from the inbound request before sending to the upstream
// recipe Service. The cookie carries our auth and must not leak; the
// Authorization header could carry an RPC JWT we don't want forwarded; any
// X-Clerum-* from the client is impersonation-shaped — we reset and inject
// our own.
const REQUEST_HEADER_BLOCKLIST = new Set(['cookie', 'authorization'])

function stripClientHeaders(headers: NodeJS.Dict<string | string[]>): void {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    if (REQUEST_HEADER_BLOCKLIST.has(lower) || lower.startsWith('x-clerum-')) {
      delete headers[name]
    }
  }
}

function setProxyReqHeader(proxyReq: ClientRequest, name: string, value: string): void {
  // Use both the express-style API (removeHeader/setHeader) so http-proxy's
  // own Host re-injection isn't bypassed.
  try {
    proxyReq.setHeader(name, value)
  } catch {
    // ClientRequest can no longer mutate headers if write() already started;
    // for our onProxyReq hook we always run before the body is forwarded, so
    // this catch is defensive only.
  }
}

/**
 * Rewrite a 3xx Location header:
 *   relative          → /api/v1/sandbox-ui/<ns>/<name>/view/<resolved>
 *   same-origin abs   → same prefix
 *   off-origin abs    → null (caller drops the redirect; serves a 200 with
 *                       an explanatory page in a follow-up)
 *
 * Returns the rewritten Location, or null when the redirect should be
 * dropped entirely. Returns the input unchanged when there's nothing to
 * rewrite (e.g. fragment-only).
 */
export function rewriteLocationHeader(
  rawLocation: string,
  recipeNs: string,
  recipeName: string,
  upstreamHost: string
): string | null {
  const trimmed = rawLocation.trim()
  if (!trimmed) return trimmed

  // Same-origin absolute (the upstream Service's own host/port). Strip the
  // scheme+host and re-prefix.
  const sameOriginPrefix = `http://${upstreamHost}`
  if (trimmed.startsWith(sameOriginPrefix)) {
    const rest = trimmed.slice(sameOriginPrefix.length) || '/'
    return prefixWithViewBase(rest, recipeNs, recipeName)
  }

  // Off-origin absolute: drop. The desktop app receives a 200 with an
  // explanatory page (follow-up).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
    return null
  }

  // Relative redirect — re-prefix with the view base.
  return prefixWithViewBase(trimmed, recipeNs, recipeName)
}

function prefixWithViewBase(pathAndQuery: string, recipeNs: string, recipeName: string): string {
  const base = `/api/v1/sandbox-ui/${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}/view`
  // Relative to the current request? For 3xx Location resolution we punt to
  // simple "absolute path => prepend base, path-rooted => same" — anything
  // truly relative is rare in practice and the upstream typically emits
  // absolute paths.
  if (pathAndQuery.startsWith('/')) return `${base}${pathAndQuery}`
  return `${base}/${pathAndQuery}`
}

const sandboxUiProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  // Disable WS — sandbox-ui v1 explicitly rejects WebSocket upgrades. This
  // is belt-and-suspenders alongside the 426 short-circuit at the route
  // entry; if anything bypassed the route check, http-proxy still won't
  // upgrade.
  ws: false,
  xfwd: false,
})

sandboxUiProxy.on('error', (err, _req, res) => {
  console.error('[SandboxUI] Proxy error:', err.message)
  if (res && 'writeHead' in res && typeof res.writeHead === 'function') {
    const r = res as unknown as Response
    if (!r.headersSent) {
      r.status(502).json({ error: 'sandbox_ui_upstream_error' })
    }
  }
})

export function createSandboxUiSessionRouter(): Router {
  const router = Router()

  // GET /api/v1/sandbox-ui/apps
  // List of UI-bearing recipes the requesting user has ACL access to.
  // The Desktop App's app picker hits this on tab open / focus.
  router.get(
    '/sandbox-ui/apps',
    requireRpcAuth,
    requireScope('sandbox:ui:view'),
    async (req: AuthedRequest, res: Response) => {
      const userId = req.auth!.sub
      const teamId = teamIdForSandboxUiRegistry(req)
      const result = await listSandboxUiApps(userId, teamId)
      if (result.kind === 'error') {
        res.status(result.status === 502 ? 502 : 500).json({ error: 'apps_lookup_failed' })
        return
      }
      res.status(200).json({ apps: result.apps })
    }
  )

  router.post(
    '/sandbox-ui/:recipeNs/:recipeName/session',
    requireRpcAuth,
    requireScope('sandbox:ui:view'),
    async (req: AuthedRequest, res: Response) => {
      const { recipeNs, recipeName } = req.params
      const userId = req.auth!.sub
      const teamId = teamIdForSandboxUiRegistry(req)

      const result = await lookupSandboxUiRegistry(recipeNs, recipeName, userId, teamId)
      switch (result.kind) {
        case 'not_found':
          emitSessionMint({ outcome: 'not_found', userId, recipeNs, recipeName })
          res.status(404).json({ error: 'recipe_not_found' })
          return
        case 'forbidden':
          emitSessionMint({ outcome: 'forbidden', userId, recipeNs, recipeName })
          res.status(403).json({ error: 'recipe_acl_denied' })
          return
        case 'not_ready':
          emitSessionMint({
            outcome: 'not_ready',
            userId,
            recipeNs,
            recipeName,
            reason: result.reason,
          })
          res.status(409).json({ error: 'recipe_not_ready', reason: result.reason })
          return
        case 'misconfigured':
          emitSessionMint({
            outcome: 'misconfigured',
            userId,
            recipeNs,
            recipeName,
            reason: result.reason,
          })
          res.status(502).json({ error: result.reason, port: result.port })
          return
        case 'error':
          emitSessionMint({ outcome: 'error', userId, recipeNs, recipeName })
          res.status(500).json({ error: 'registry_lookup_failed' })
          return
        case 'ok':
          break
      }

      // Readiness implies "Service exists + Endpoints non-empty +
      // recipe.status.phase == active". For v1 we trust the registry's
      // `ready: true` (which reflects phase=active); the Endpoints probe
      // would add a per-mint K8s round-trip and the view/* path surfaces
      // transient empty-Endpoints as a styled "updating" 503 anyway. So
      // `ok` from the registry is sufficient.
      const cookie = createSandboxUiSession(userId, recipeNs, recipeName)
      const setCookie = buildSandboxUiSetCookie(cookie, recipeNs, recipeName)
      res.setHeader('Set-Cookie', [setCookie])
      res.status(204).end()
      emitSessionMint({ outcome: 'ok', userId, recipeNs, recipeName })
    }
  )

  // POST /api/v1/sandbox-ui/:ns/:name/oauth/authorize-url
  //
  // Desktop main process calls this when the embed clicks
  // `clerum://oauth?clientId=…`. We:
  //   1. Verify the user has ACL access to the recipe (registry lookup
  //      with `forUser`, same gate as `/session`).
  //   2. Construct the redirect_uri the provider will see (control-api's
  //      public callback URL).
  //   3. Forward to control-api's internal `/internal/sandbox-ui/oauth/
  //      authorize-url` with the user identity asserted in the body.
  //   4. Return `{ authorizeUrl }`; the desktop app `shell.openExternal`s
  //      it so the user completes OAuth in the OS browser.
  //
  // 401/403 from control-api means rpc-proxy↔control-api auth is
  // misconfigured — coerce to 502 so the user does not interpret it as
  // their own credential failure.
  router.post(
    '/sandbox-ui/:recipeNs/:recipeName/oauth/authorize-url',
    requireRpcAuth,
    requireScope('sandbox:ui:view'),
    async (req: AuthedRequest, res: Response) => {
      const { recipeNs, recipeName } = req.params
      const userId = req.auth!.sub
      const teamId = teamIdForSandboxUiRegistry(req)
      const oauthClientId =
        typeof req.body?.oauthClientId === 'string' ? String(req.body.oauthClientId).trim() : ''
      if (!oauthClientId) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const background = req.body?.background === true

      const acl = await lookupSandboxUiRegistry(recipeNs, recipeName, userId, teamId)
      switch (acl.kind) {
        case 'not_found':
          res.status(404).json({ error: 'recipe_not_found' })
          return
        case 'forbidden':
          res.status(403).json({ error: 'recipe_acl_denied' })
          return
        case 'not_ready':
          res.status(409).json({ error: 'recipe_not_ready', reason: acl.reason })
          return
        case 'misconfigured':
          res.status(502).json({ error: acl.reason, port: acl.port })
          return
        case 'error':
          res.status(502).json({ error: 'registry_lookup_failed' })
          return
        case 'ok':
          break
      }

      // Stable redirect URI — only the oauthClientId, never the recipe instance —
      // so it matches the single redirect URI registered with the provider and
      // survives recipe version bumps. control-api recovers recipeNs/recipeName from
      // the signed state on the callback. MUST stay byte-for-byte identical to
      // control-api's buildPublicCallbackUrl (the provider compares redirect_uri on
      // the token exchange).
      const redirectUri =
        `${config.oauthCallbackBaseUrl}/api/v1/oauth-callback/` + encodeURIComponent(oauthClientId)

      const upstreamUrl = `${config.controlApiBaseUrl.replace(/\/+$/, '')}/internal/sandbox-ui/oauth/authorize-url`
      // The `Response` import at top of this file is Express's `Response`;
      // explicitly reach for the global fetch-Response type for the upstream
      // call's return so the discriminated checks below type-check.
      let upstream: globalThis.Response
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.controlApiServiceToken}`,
            'x-service-token': config.controlApiServiceName,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            recipeNs,
            recipeName,
            oauthClientId,
            userId, // from req.auth.sub — never the body
            redirectUri,
            background,
          }),
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        })
      } catch {
        res.status(502).json({ error: 'control_api_unreachable' })
        return
      }

      // Service-token misconfig: do not surface as 401/403 to the user.
      if (upstream.status === 401 || upstream.status === 403) {
        res.status(502).json({ error: 'control_api_auth_failed' })
        return
      }

      const upstreamText = await upstream.text().catch(() => '')

      if (upstream.ok) {
        let parsed: unknown
        try {
          parsed = JSON.parse(upstreamText)
        } catch {
          parsed = null
        }
        const authorizeUrl = (parsed as { authorizeUrl?: unknown } | null)?.authorizeUrl
        if (typeof authorizeUrl !== 'string' || !authorizeUrl) {
          res.status(502).json({ error: 'control_api_invalid_response' })
          return
        }
        res.status(200).json({ authorizeUrl })
        return
      }

      // Forward the upstream JSON error verbatim — control-api's discriminated
      // results (recipe_not_found, unknown_oauth_client, unsupported_provider,
      // integration_not_configured at 503 [unified "Deferred Credentials"
      // contract — Phase 1], invalid_recipe_namespace) are all useful to
      // surface.
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(upstreamText)
    }
  )

  // POST /api/v1/sandbox-ui/:ns/:name/oauth/token
  //
  // Embed-side fetch from inside the WebContentsView. Cookie-authed (same
  // origin, SameSite=Strict). The recipe's UI Service typically calls this
  // by passing the embed's `Authorization: Bearer <token>` through to
  // server-side third-party API calls, OR the embed's JS fetches the
  // token and includes it in subsequent fetches to its own backend.
  //
  // The cookie's claims pin (recipeNs, recipeName) — `verifySandboxUiSession`
  // re-checks the URL path against the cookie binding, same as `view/*`.
  // userId comes from the cookie's `sub`; only `oauthClientId` is in the
  // body so a malicious page that somehow stole the cookie can still only
  // act as the bound user.
  //
  // 401/403 from control-api means rpc-proxy↔control-api auth is misconfig
  // — coerce to 502 (don't surface as 401 to the embed which would imply
  // the user's session is bad).
  router.post(
    '/sandbox-ui/:recipeNs/:recipeName/oauth/token',
    async (req: Request, res: Response) => {
      const { recipeNs, recipeName } = req.params

      const cookies = parseCookies(req.headers.cookie ?? '')
      const cookieValue = cookies[config.sandboxUiCookieName]
      if (!cookieValue) {
        res.status(401).json({ error: 'sandbox_ui_session_required' })
        return
      }
      const claims = verifySandboxUiSession(cookieValue, recipeNs, recipeName)
      if (!claims) {
        res.status(401).json({ error: 'sandbox_ui_session_invalid' })
        return
      }

      const oauthClientId =
        typeof req.body?.oauthClientId === 'string' ? String(req.body.oauthClientId).trim() : ''
      if (!oauthClientId) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }

      const upstreamUrl = `${config.controlApiBaseUrl.replace(/\/+$/, '')}/internal/sandbox-ui/oauth/token`
      let upstream: globalThis.Response
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.controlApiServiceToken}`,
            'x-service-token': config.controlApiServiceName,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            recipeNs,
            recipeName,
            oauthClientId,
            userId: claims.sub,
          }),
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        })
      } catch {
        res.status(502).json({ error: 'control_api_unreachable' })
        return
      }

      if (upstream.status === 401 || upstream.status === 403) {
        res.status(502).json({ error: 'control_api_auth_failed' })
        return
      }

      const upstreamText = await upstream.text().catch(() => '')

      if (upstream.ok) {
        let parsed: unknown
        try {
          parsed = JSON.parse(upstreamText)
        } catch {
          parsed = null
        }
        const accessToken = (parsed as { accessToken?: unknown } | null)?.accessToken
        const expiresAt = (parsed as { expiresAt?: unknown } | null)?.expiresAt
        if (typeof accessToken !== 'string' || !accessToken) {
          res.status(502).json({ error: 'control_api_invalid_response' })
          return
        }
        res.status(200).json({
          accessToken,
          expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
        })
        return
      }

      // Pass through control-api's discriminated errors — no_grant (404),
      // recipe_not_found (404), unknown_oauth_client (400),
      // unsupported_provider (400), integration_not_configured (503 —
      // unified "Deferred Credentials" contract, Phase 1), refresh_failed
      // (502).
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(upstreamText)
    }
  )

  // DELETE /api/v1/sandbox-ui/:ns/:name/oauth/grant
  //
  // Embed-side disconnect. Cookie-authed; the cookie's claims pin
  // (recipeNs, recipeName, userId) so a stolen cookie can only delete
  // its bound user's grants. Idempotent — 204 even when no grant
  // existed (avoids leaking which (recipe, oauthClient) pairs a user
  // has connected).
  //
  // Provider-side revocation is intentionally not attempted here; the
  // local row is dropped, and the access token continues to work at
  // the provider until natural expiry. A future addition could thread
  // a best-effort buildRevokeRequest adapter call before delete.
  router.delete(
    '/sandbox-ui/:recipeNs/:recipeName/oauth/grant',
    async (req: Request, res: Response) => {
      const { recipeNs, recipeName } = req.params

      const cookies = parseCookies(req.headers.cookie ?? '')
      const cookieValue = cookies[config.sandboxUiCookieName]
      if (!cookieValue) {
        res.status(401).json({ error: 'sandbox_ui_session_required' })
        return
      }
      const claims = verifySandboxUiSession(cookieValue, recipeNs, recipeName)
      if (!claims) {
        res.status(401).json({ error: 'sandbox_ui_session_invalid' })
        return
      }

      const oauthClientId =
        typeof req.body?.oauthClientId === 'string' ? String(req.body.oauthClientId).trim() : ''
      if (!oauthClientId) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }

      const upstreamUrl = `${config.controlApiBaseUrl.replace(/\/+$/, '')}/internal/sandbox-ui/oauth/grant`
      let upstream: globalThis.Response
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${config.controlApiServiceToken}`,
            'x-service-token': config.controlApiServiceName,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            recipeNs,
            recipeName,
            oauthClientId,
            userId: claims.sub,
          }),
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        })
      } catch {
        res.status(502).json({ error: 'control_api_unreachable' })
        return
      }

      if (upstream.status === 401 || upstream.status === 403) {
        res.status(502).json({ error: 'control_api_auth_failed' })
        return
      }

      if (upstream.status === 204) {
        res.status(204).end()
        return
      }

      const upstreamText = await upstream.text().catch(() => '')
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(upstreamText)
    }
  )

  // ANY /api/v1/sandbox-ui/:recipeNs/:recipeName/view/*
  router.all('/sandbox-ui/:recipeNs/:recipeName/view/*', async (req: Request, res: Response) => {
    const { recipeNs, recipeName } = req.params

    // WebSocket upgrades are rejected outright in v1. The Express layer
    // hits this BEFORE any proxy work, so the upstream never sees the
    // upgrade attempt.
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
    if (upgrade === 'websocket') {
      res.status(426).json({
        code: 'websocket_not_supported',
        message: 'WebSockets are not supported in v1.',
      })
      return
    }

    // Cookie auth ONLY: RPC JWT is ignored if present. The cookie's
    // recipeNs/recipeName claim must match the URL path —
    // verifySandboxUiSession enforces that.
    const cookies = parseCookies(req.headers.cookie ?? '')
    const cookieValue = cookies[config.sandboxUiCookieName]
    if (!cookieValue) {
      res.status(401).json({ error: 'sandbox_ui_session_required' })
      return
    }
    const claims = verifySandboxUiSession(cookieValue, recipeNs, recipeName)
    if (!claims) {
      res.status(401).json({ error: 'sandbox_ui_session_invalid' })
      return
    }

    // Path normalisation BEFORE the registry lookup, so a malicious path
    // can't reach the upstream even when the registry cache is warm.
    const tail = (req.params as Record<string, unknown>)[0]
    const tailString = typeof tail === 'string' ? tail : ''
    const normalised = normalizeViewPath(tailString)
    if (normalised === null) {
      res.status(400).json({ error: 'invalid_path' })
      return
    }

    // Registry lookup is user-agnostic here — the cookie already proves
    // the user is allowed (it was minted only after control-api's ACL
    // check at session-mint time). Cookie has a 5min TTL; in that
    // window an admin removing the user from the recipe ACL won't
    // immediately revoke an existing view session, by design — a 5 min
    // revocation lag is acceptable.
    const lookup = await lookupSandboxUiRegistry(recipeNs, recipeName)
    if (lookup.kind === 'not_found') {
      // Registry says "no such app" → 410 Gone. Browser-y clients (the
      // WebContentsView) get a styled HTML page; explicit JSON callers
      // (programmatic deep-links / debugging tools) still get the JSON
      // shape.
      respondGone(req, res, recipeNs, recipeName)
      return
    }
    if (lookup.kind === 'not_ready') {
      // Styled "updating" page that auto-refreshes every 5s. Future work
      // holds the response open under SSE for up to 10s before falling
      // through so a quick rolling deploy doesn't bounce the user through
      // a status page.
      respondUpdating(req, res, recipeNs, recipeName, lookup.reason)
      return
    }
    if (lookup.kind === 'forbidden') {
      // Should not happen here (we passed no forUser), but guard for the
      // type checker and a future refactor.
      res.status(403).json({ error: 'recipe_acl_denied' })
      return
    }
    if (lookup.kind === 'misconfigured') {
      // Recipe declares a `ui.port` outside the platform allow-list. The
      // CRD lets `1-65535` through; rpc-proxy is the choke point. Surface
      // a distinct error code so a recipe author who sees this gets a
      // pointer to the actual cause instead of a generic
      // "registry_lookup_failed".
      res.status(502).json({ error: lookup.reason, port: lookup.port })
      return
    }
    if (lookup.kind === 'error') {
      res.status(502).json({ error: 'registry_lookup_failed' })
      return
    }

    const svc = lookup.entry.service
    const upstreamHost = `${svc.name}.${svc.namespace}.svc.cluster.local:${svc.port}`
    const target = `http://${upstreamHost}`

    // Splice the normalised path back into the request URL so http-proxy
    // forwards exactly the path we vetted, plus the original query string.
    const queryIndex = req.originalUrl.indexOf('?')
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : ''
    req.url = `${normalised}${query}`

    // Per-request hook to inject identity headers and strip client-supplied
    // shadow headers. http-proxy fires onProxyReq once with the
    // ClientRequest. We layer a one-shot listener via the proxy's `proxyReq`
    // event scoped to this request via res.on('finish') cleanup.
    const onProxyReq = (
      proxyReq: ClientRequest,
      innerReq: IncomingMessage,
      _innerRes: ServerResponse
    ): void => {
      if (innerReq !== req) return
      // The headers map http-proxy hands to the upstream comes from req.headers;
      // mutate proxyReq directly to strip and inject.
      for (const headerName of proxyReq.getHeaderNames()) {
        const lower = headerName.toLowerCase()
        if (REQUEST_HEADER_BLOCKLIST.has(lower) || lower.startsWith('x-clerum-')) {
          try {
            proxyReq.removeHeader(headerName)
          } catch {
            // Same defensive note as setProxyReqHeader.
          }
        }
      }
      setProxyReqHeader(proxyReq, 'x-clerum-user', claims.sub)
      setProxyReqHeader(proxyReq, 'x-clerum-recipe', `${recipeNs}/${recipeName}`)
    }

    const onProxyRes = (
      proxyRes: IncomingMessage,
      innerReq: IncomingMessage,
      _innerRes: ServerResponse
    ): void => {
      if (innerReq !== req) return
      // 3xx Location rewriting.
      const status = proxyRes.statusCode ?? 0
      if (status >= 300 && status < 400 && proxyRes.headers.location) {
        const raw = String(proxyRes.headers.location)
        const rewritten = rewriteLocationHeader(raw, recipeNs, recipeName, upstreamHost)
        if (rewritten === null) {
          // Off-origin redirect is dropped — for v1 we strip the Location
          // and let the upstream's 3xx body render (typically empty). A
          // follow-up may swap in a styled "external link" page.
          delete proxyRes.headers.location
          // Coerce to 200 so the desktop view doesn't honour the dangling
          // 3xx — the cookie's path scope would not have matched the
          // off-origin host anyway, but a 3xx without Location is broken.
          proxyRes.statusCode = 200
        } else {
          proxyRes.headers.location = rewritten
        }
      }
      // Response security headers (CSP / Permissions-Policy / X-CTO /
      // Referrer-Policy / X-Frame-Options). Set unconditionally; the
      // upstream's own values are overridden — this is the "hard floor"
      // applied to every sandbox UI regardless of recipe author intent.
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        proxyRes.headers[name] = value
      }
    }

    sandboxUiProxy.once('proxyReq', onProxyReq)
    sandboxUiProxy.once('proxyRes', onProxyRes)
    // If the request ends without firing (e.g. an early proxy error), make
    // sure the listeners are detached AND the view-request emit fires
    // exactly once with the final status code.
    let auditEmitted = false
    const cleanup = (): void => {
      sandboxUiProxy.off('proxyReq', onProxyReq)
      sandboxUiProxy.off('proxyRes', onProxyRes)
      if (auditEmitted) return
      auditEmitted = true
      emitViewRequest({
        userId: claims.sub,
        recipeNs,
        recipeName,
        status: res.statusCode,
        path: normalised,
        method: req.method,
      })
    }
    res.on('close', cleanup)
    res.on('finish', cleanup)

    // Strip the cookie/authorization/x-clerum-* headers from the inbound
    // request map BEFORE http-proxy clones them onto the outbound request.
    stripClientHeaders(req.headers as NodeJS.Dict<string | string[]>)

    sandboxUiProxy.web(req, res, { target })
  })

  return router
}
