import { type NextFunction, type Request, type Response, Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { K8sGateway } from '../../k8s.js'
import {
  type CallbackTarget,
  type McpServerOAuthReader,
  type McpServerOAuthSubject,
  REMOTE_CALLBACK_CLIENT_SEGMENT,
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
  handleOAuthCallback,
} from '../../oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../../oauth/encryption.js'
import { integrationNotConfigured, isSecretNotFound } from '../../oauth/integrationNotConfigured.js'
import {
  type McpServerOAuthSpecInput,
  resolveServerOAuthSubject,
} from '../../oauth/mcpServerOAuthSpec.js'
import { isValidInstallNonce, isValidRemoteServerNameSegment } from '../../oauth/remoteCallback.js'
import { getUserMemberContexts } from '../../services/access/contextMembership.js'
import { K8sNotFoundError } from '../../services/resourceService.js'

/**
 * OAuth callback receiver. Hit directly by provider redirects — no Clerum
 * cookie, no Bearer token. Authentication is the signed `state` parameter
 * (HMAC-bound to recipeNs/recipeName/userId/oauthClientId at authorize-URL
 * issuance, re-verified here).
 *
 * Spec §9.9 / Decision 20.
 */
export function createOAuthCallbackRouter(gateway: K8sGateway): Router {
  const router = Router()
  const encryptionKey = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

  const recipeReader: RecipeReader = {
    async read(name, namespace): Promise<RecipeWithOAuthClients | null> {
      try {
        return (await gateway.getResource(
          'workflowrecipes',
          name,
          namespace
        )) as RecipeWithOAuthClients
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          throw new RecipeNotFoundError(`recipe ${namespace}/${name} not found`)
        }
        throw err
      }
    },
  }

  const secretReader: SecretReader = {
    async read(name, namespace): Promise<Record<string, string>> {
      try {
        const raw = (await gateway.getSecret(name, namespace)) as {
          data?: Record<string, string>
        }
        const decoded: Record<string, string> = {}
        for (const [k, v] of Object.entries(raw.data ?? {})) {
          decoded[k] = Buffer.from(v, 'base64').toString('utf8')
        }
        return decoded
      } catch (err) {
        if (isSecretNotFound(err)) {
          throw new SecretNotFoundError(`secret ${namespace}/${name} not found`)
        }
        throw err
      }
    },
  }

  // U5: resolve an OAuth McpServer subject when the signed state carries
  // `subjectKind:'mcp'`. Reads the CR from the mcp-servers namespace (the
  // authoritative source of oauthClientId / grantScope / contextRef — never the
  // state) and surfaces the namespace so grant persistence + Secret reads stay
  // pinned to it.
  const mcpServerReader: McpServerOAuthReader = {
    async read(mcpServerName): Promise<McpServerOAuthSubject | null> {
      let server: McpServerOAuthSpecInput
      try {
        server = (await gateway.getResource(
          'mcpservers',
          mcpServerName,
          config.mcpServersNamespace
        )) as McpServerOAuthSpecInput
      } catch (err) {
        if (err instanceof K8sNotFoundError) return null
        throw err
      }
      const resolved = resolveServerOAuthSubject(server, 'consent')
      if (!resolved) return null
      // `resolved.crUid` seals grants written by this consent to the CR's identity:
      // the uid is the apiserver's, unique per object, so a same-name reinstall's
      // teardown never purges this installation's grant and its readers never see it.
      return { namespace: config.mcpServersNamespace, ...resolved }
    },
  }

  async function completeCallback(
    req: Request,
    res: Response,
    next: NextFunction,
    target: CallbackTarget
  ): Promise<unknown> {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      const state = typeof req.query.state === 'string' ? req.query.state : ''
      if (!code || !state) {
        return res.status(400).json({ error: 'missing_code_or_state' })
      }
      // The desktop deep link and the not-configured body name the integration by the
      // URL's client id; the remote callbacks have none, so both variants report the
      // reserved `remote` (the desktop routes remote consents by `mcpServerName`).
      const integrationId = target.kind === 'client' ? target.id : REMOTE_CALLBACK_CLIENT_SEGMENT

      const result = await handleOAuthCallback(
        // `iss` goes through raw: each remote variant decides how a malformed value reads.
        { target, code, state, iss: req.query.iss },
        {
          db: { query: (text, values) => pool.query(text, values) },
          recipeReader,
          secretReader,
          mcpServerReader,
          // Shared-identity mcp bootstrap requires the consenting user to be a
          // member of the server's Context (defence in depth). Membership follows
          // agent access, the same reader as the authorize-URL mint (#989).
          userContextsReader: userId => getUserMemberContexts(gateway, userId),
          fetchFn: (input, init) => fetch(input, init),
          stateSecret: config.oauthStateHmacSecret,
          encryptionKey,
        }
      )

      switch (result.kind) {
        case 'ok':
          return res
            .status(200)
            .type('html')
            .send(
              renderSuccessHtml(result.provider, integrationId, {
                backgroundRequested: result.backgroundRequested,
                backgroundEnabled: result.backgroundEnabled,
                source: result.source,
                // From the signed state, never from the URL segment.
                mcpServerName: result.mcpServerName,
              })
            )
        case 'invalid_state':
          return res.status(400).json({ error: 'invalid_state', reason: result.reason })
        case 'issuer_mismatch':
          // RFC 9207 mix-up defence — no issuer echo. 400, consistent with the
          // sibling invalid_state mapping.
          return res.status(400).json({ error: 'issuer_mismatch' })
        case 'issuer_binding_required':
          // RFC 9207 mix-up defence, absence case: the remote server pinned no
          // issuer at install, so the shared remote callback cannot attribute the
          // code. Fail closed — same 400 class, distinct error for operator triage.
          return res.status(400).json({ error: 'issuer_binding_required' })
        case 'callback_base_url_unconfigured':
          return res.status(503).json({ error: 'callback_base_url_unconfigured' })
        case 'unknown_oauth_client':
          return res.status(400).json({ error: 'unknown_oauth_client' })
        case 'recipe_not_found':
          return res.status(404).json({ error: 'recipe_not_found' })
        case 'server_not_found':
          return res.status(404).json({ error: 'server_not_found' })
        case 'server_missing_context':
          return res.status(400).json({ error: 'server_missing_context' })
        case 'context_membership_denied':
          return res.status(403).json({ error: 'context_membership_denied' })
        case 'remote_oauth_spec_incoherent':
          return res
            .status(409)
            .json({ error: 'remote_oauth_spec_incoherent', reason: result.reason })
        case 'secret_missing':
          return res.status(503).json(integrationNotConfigured(integrationId, result.secret))
        case 'unsupported_provider':
          return res.status(500).json({ error: 'unsupported_provider', provider: result.provider })
        case 'provider_token_exchange_failed':
          return res
            .status(502)
            .json({ error: 'provider_token_exchange_failed', status: result.status })
        case 'provider_response_invalid':
          return res.status(502).json({ error: 'provider_response_invalid', detail: result.detail })
      }
    } catch (err) {
      next(err)
    }
  }

  // Per-server remote callback, for an AS that does not return RFC 9207 `iss`: the URI
  // itself binds the code to one server (and, for DCR, one installation). Public like
  // its sibling — authentication is the signed state plus that binding. The segments
  // are re-validated here with the same rules the public gateway applies: this route is
  // also reachable without the gateway, and an unvalidated segment must never reach
  // the handler.
  router.get('/oauth-callback/remote/:serverName/:installNonce?', (req, res, next) => {
    const { serverName, installNonce } = req.params as {
      serverName: string
      installNonce?: string
    }
    if (
      !isValidRemoteServerNameSegment(serverName) ||
      (installNonce !== undefined && !isValidInstallNonce(installNonce))
    ) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    void completeCallback(req, res, next, {
      kind: 'remote-per-server',
      serverName,
      installNonce,
      // Configured origin only: a per-server URI anchored on the request Host would
      // differ from the one registered at the AS whenever the Host differs.
      origin: normalizeConfiguredOrigin(config.oauthCallbackBaseUrl),
    })
  })

  // `/oauth-callback/<oauthClientId>`: one registered redirect URI per provider client,
  // stable across recipe versions — the recipe (namespace, name) is recovered from the
  // signed state, and both authorize-url minters only sign sandbox-namespace states.
  // The reserved `remote` segment is the shared callback of every remote server whose
  // AS returns RFC 9207 `iss`.
  router.get('/oauth-callback/:oauthClientId', (req, res, next) => {
    const { oauthClientId } = req.params
    const target: CallbackTarget =
      oauthClientId === REMOTE_CALLBACK_CLIENT_SEGMENT
        ? {
            kind: 'remote-shared',
            origin: resolveCallbackOrigin(req, config.oauthCallbackBaseUrl),
          }
        : {
            kind: 'client',
            id: oauthClientId,
            redirectUri: buildPublicCallbackUrl(req, oauthClientId, config.oauthCallbackBaseUrl),
          }
    void completeCallback(req, res, next, target)
  })

  return router
}

/**
 * Normalize the configured public callback base URL into a bare origin (trailing
 * slashes stripped), or `null` when none is configured. This is the SAME origin
 * derivation `buildPublicCallbackUrl` uses for its configured branch; the CIMD
 * document (`oauth/cimd.ts`) reuses it so the served `client_id` / `redirect_uris`
 * share a byte-identical origin with the callback redirect. Unlike the callback,
 * CIMD callers must NOT fall back to the request Host (an AS would see the
 * internal proxy Host), so this returns `null` for them to fail closed on.
 */
export function normalizeConfiguredOrigin(configuredBaseUrl?: string): string | null {
  if (!configuredBaseUrl || configuredBaseUrl.length === 0) return null
  return configuredBaseUrl.replace(/\/+$/, '')
}

/**
 * Origin of the callback URLs that tolerate an unconfigured base URL (the per-client
 * and shared remote callbacks): the configured public base URL, else the request Host.
 */
export function resolveCallbackOrigin(
  req: { protocol: string; get: (h: string) => string | undefined },
  configuredBaseUrl?: string
): string {
  return (
    normalizeConfiguredOrigin(configuredBaseUrl) ??
    `${req.protocol}://${req.get('host') ?? 'localhost'}`
  )
}

export function buildPublicCallbackUrl(
  req: { protocol: string; get: (h: string) => string | undefined },
  oauthClientId: string,
  configuredBaseUrl?: string
): string {
  // The provider receives this URL at authorize-URL issuance time, then echoes
  // it back to us as `redirect_uri` in the token POST — the two MUST be byte
  // identical. It is STABLE — only the oauthClientId, never the recipe instance —
  // so a single redirect URI per provider client is registered once and survives
  // recipe version bumps; the recipe identity travels in the signed state.
  //
  // Behind the public proxy chain (cloudflared → external-rest-api → funnel) the
  // request Host is an internal hostname, so prefer an explicitly configured
  // public base URL (CONTROL_API_OAUTH_CALLBACK_BASE_URL). Fall back to the
  // request Host for local/dev where none is set.
  const origin = resolveCallbackOrigin(req, configuredBaseUrl)
  return `${origin}/api/v1/oauth-callback/${encodeURIComponent(oauthClientId)}`
}

export function renderSuccessHtml(
  provider: string,
  oauthClientId: string,
  opts?: {
    backgroundRequested?: boolean
    backgroundEnabled?: boolean
    source?: 'mcp'
    mcpServerName?: string
  }
): string {
  // The user's browser hits this page on the platform's origin, not inside
  // the embed. Spec §9.9 — bounce to `clerum://oauth-completed?…` so the
  // desktop app's open-url handler dispatches the envelope. The RECIPE deep-link
  // is FROZEN: `clientId` + `provider` only, no `source`. For an mcp subject
  // (U5) we append `&source=mcp` on the SAME `oauth-completed` host so the
  // desktop dispatcher routes it to the task resume instead of the embed. The
  // clientId is built unconditionally either way (it never depends on `source`).
  const safeProvider = String(provider).replace(/[^a-z0-9-]/gi, '')
  const deepLink = new URL('clerum://oauth-completed')
  deepLink.searchParams.set('clientId', oauthClientId)
  deepLink.searchParams.set('provider', safeProvider)
  if (opts?.source === 'mcp') {
    deepLink.searchParams.set('source', 'mcp')
    // Correlation key for the desktop resume (authoritative — from the signed
    // state). Robust against concurrent suspensions of different mcp-servers.
    if (opts.mcpServerName) {
      deepLink.searchParams.set('mcpServerName', opts.mcpServerName)
    }
  }
  const deepLinkHref = htmlAttrEscape(deepLink.toString())
  // JSON.stringify gives valid JS string literal; `<` → `<` blocks
  // any chance of `</script>` injection if the URL ever carried weird input.
  const deepLinkJs = JSON.stringify(deepLink.toString()).replace(/</g, '\\u003c')

  // Background-consent status line — static text only, no untrusted interpolation.
  let backgroundStatusLine = ''
  if (opts?.backgroundEnabled) {
    backgroundStatusLine =
      '<p>✓ Background access enabled — this app can act for you in the background until you disconnect it (manage under Connected accounts).</p>\n'
  } else if (opts?.backgroundRequested && !opts.backgroundEnabled) {
    backgroundStatusLine =
      '<p>Connected, but background access could not be enabled (the provider returned no refresh token). Reconnect to try again.</p>\n'
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connected</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${deepLinkHref}">
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #555; line-height: 1.5; }
  a { color: #2563eb; }
</style>
</head>
<body>
<h1>You're connected to ${safeProvider}</h1>
${backgroundStatusLine}<p>Returning you to the app… <a href="${deepLinkHref}">Click here if nothing happens.</a></p>
<script>window.location.replace(${deepLinkJs});</script>
</body>
</html>`
}

function htmlAttrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
