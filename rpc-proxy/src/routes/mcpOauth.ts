import { Response, Router } from 'express'
import { config } from '../config.js'
import { AuthedRequest, requireRpcAuth, requireScope } from '../middleware/auth.js'

/**
 * POST /api/v1/mcp-oauth/:mcpServerName/authorize-url
 *
 * Desktop "Connect <server>" surface (U5 reactive OAuth). After a tool-call
 * against an OAuth mcp-server returns `connect_required`, the desktop main
 * process calls this to mint a fresh provider authorize-URL, then
 * `shell.openExternal`s it so the user consents in the OS browser.
 *
 * Auth chain:
 *   1. `requireRpcAuth` — RPC JWT (RS256, iss=control-api, aud=rpc-proxy).
 *   2. `requireScope('mcp:server:invoke')` — the SAME capability the desktop
 *      already holds to invoke mcp tools (rpc.ts). Connecting is a precondition
 *      of invoking, so no new scope is issued (would be a token-issuance change
 *      in control-api).
 *
 * rpc-proxy forwards IDENTITY only. control-api owns the server→context
 * resolution and the Context-membership rule (D4, one source of truth); this
 * route never resolves a server's Context on its own. The `userId` is taken
 * from `req.auth.sub`, never the body. An optional body `{ contextId? }` is
 * forwarded for control-api to cross-check against the server's authoritative
 * `spec.contextRef`.
 *
 * Error propagation from control-api's internal mint endpoint:
 *   - 401 → rpc-proxy↔control-api service-token misconfig (control-api answers
 *     401 on a bad/absent service token) → coerce to 502 so the user does not
 *     read it as their own credential failure;
 *   - 403 → legitimate `context_membership_denied` → propagate verbatim;
 *   - 404 (`server_not_found`) / 400 (`not_oauth_server`, `context_mismatch`,
 *     `server_missing_context`) / 503 (`integration_not_configured`) →
 *     propagate verbatim;
 *   - 200 → `{ authorizeUrl }`.
 */

// DNS-1123 subdomain — the shape a k8s resource name takes.
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
function isValidK8sName(name: string): boolean {
  return name.length > 0 && name.length <= 253 && K8S_NAME_RE.test(name)
}

export function createMcpOauthRouter(): Router {
  const router = Router()

  router.post(
    '/mcp-oauth/:mcpServerName/authorize-url',
    requireRpcAuth,
    requireScope('mcp:server:invoke'),
    async (req: AuthedRequest, res: Response) => {
      const { mcpServerName } = req.params
      if (!isValidK8sName(mcpServerName)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const userId = req.auth!.sub
      const contextId =
        typeof req.body?.contextId === 'string' && req.body.contextId.trim().length > 0
          ? String(req.body.contextId).trim()
          : undefined

      const upstreamUrl = `${config.controlApiBaseUrl.replace(/\/+$/, '')}/internal/mcp-oauth/authorize-url`
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
            mcpServerName,
            userId, // from req.auth.sub — never the body
            ...(contextId ? { contextId } : {}),
          }),
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        })
      } catch {
        res.status(502).json({ error: 'control_api_unreachable' })
        return
      }

      // 401 = service-token misconfig (control-api's requireInternalToken /
      // requireInternalService both answer 401). Do NOT surface as the user's
      // own auth failure. 403 IS a legitimate membership denial → propagate.
      if (upstream.status === 401) {
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

      // Forward the upstream JSON error verbatim.
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(upstreamText)
    }
  )

  // ── DELETE /api/v1/mcp-oauth/:mcpServerName/grant ─────────────────────────
  //
  // Desktop "Disconnect <server>" surface (spec 11 U4). Revokes the caller's
  // OAuth grant for an mcp-server. Same auth chain as the authorize-URL mint:
  //   1. `requireRpcAuth` — RPC JWT.
  //   2. `requireScope('mcp:server:invoke')` — the SAME capability the desktop
  //      already holds to connect/invoke; revoking is the inverse of connecting,
  //      so no new scope is issued.
  //
  // rpc-proxy forwards IDENTITY only. control-api owns server→context
  // resolution and the per-flavor authorization (user: own grant; context:
  // Context membership) — this route never resolves a server's Context. The
  // `userId` is `req.auth.sub`, never the body. An optional `{ contextId? }` is
  // forwarded for control-api to cross-check against the server's authoritative
  // `spec.contextRef`.
  //
  // Error propagation mirrors the authorize-URL route exactly:
  //   - 401 → rpc-proxy↔control-api service-token misconfig → coerce to 502 so
  //     the user does not read it as their own credential failure;
  //   - 403 → legitimate `context_membership_denied` → propagate verbatim;
  //   - 404 (`server_not_found`) / 400 (`not_oauth_server`, `context_mismatch`,
  //     `server_missing_context`, `invalid_request`) → propagate verbatim;
  //   - 204 → success (idempotent; empty body).
  router.delete(
    '/mcp-oauth/:mcpServerName/grant',
    requireRpcAuth,
    requireScope('mcp:server:invoke'),
    async (req: AuthedRequest, res: Response) => {
      const { mcpServerName } = req.params
      if (!isValidK8sName(mcpServerName)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const userId = req.auth!.sub
      const contextId =
        typeof req.body?.contextId === 'string' && req.body.contextId.trim().length > 0
          ? String(req.body.contextId).trim()
          : undefined

      const upstreamUrl = `${config.controlApiBaseUrl.replace(/\/+$/, '')}/internal/mcp-oauth/grant`
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
            mcpServerName,
            userId, // from req.auth.sub — never the body
            ...(contextId ? { contextId } : {}),
          }),
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        })
      } catch {
        res.status(502).json({ error: 'control_api_unreachable' })
        return
      }

      // 401 = service-token misconfig — do NOT surface as the user's own auth
      // failure. 403 IS a legitimate membership denial → propagate.
      if (upstream.status === 401) {
        res.status(502).json({ error: 'control_api_auth_failed' })
        return
      }

      // Success: control-api answers 204 (no body). Forward it verbatim.
      if (upstream.ok) {
        res.status(upstream.status).end()
        return
      }

      // Forward the upstream JSON error verbatim.
      const upstreamText = await upstream.text().catch(() => '')
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(upstreamText)
    }
  )

  return router
}
