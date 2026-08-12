import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { K8sGateway } from '../../k8s.js'
import {
  type McpServerOAuthReader,
  type McpServerOAuthSubject,
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
import { getUserContexts } from '../../services/directory/index.js'
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
      const resolved = resolveServerOAuthSubject(server)
      if (!resolved) return null
      return { namespace: config.mcpServersNamespace, ...resolved }
    },
  }

  // Stable callback path: only the oauthClientId rides the URL (one registered
  // redirect URI per provider client). The recipe (namespace, name) is recovered
  // from the signed state inside handleOAuthCallback, so the URI no longer churns
  // per recipe instance / catalog version. No namespace check is needed here: the
  // recipe namespace comes from the unforgeable state, and both authorize-url
  // minters only sign sandbox-namespace states.
  router.get('/oauth-callback/:oauthClientId', async (req, res, next) => {
    try {
      const { oauthClientId } = req.params
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      const state = typeof req.query.state === 'string' ? req.query.state : ''

      if (!code || !state) {
        return res.status(400).json({ error: 'missing_code_or_state' })
      }

      const redirectUri = buildPublicCallbackUrl(req, oauthClientId, config.oauthCallbackBaseUrl)

      const result = await handleOAuthCallback(
        { oauthClientId, code, state, redirectUri },
        {
          db: { query: (text, values) => pool.query(text, values) },
          recipeReader,
          secretReader,
          mcpServerReader,
          // Shared-identity mcp bootstrap requires the consenting user to be a
          // member of the server's Context (defence in depth).
          userContextsReader: getUserContexts,
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
              renderSuccessHtml(result.provider, oauthClientId, {
                backgroundRequested: result.backgroundRequested,
                backgroundEnabled: result.backgroundEnabled,
                source: result.source,
              })
            )
        case 'invalid_state':
          return res.status(400).json({ error: 'invalid_state', reason: result.reason })
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
        case 'secret_missing':
          return res.status(503).json(integrationNotConfigured(oauthClientId, result.secret))
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
  })

  return router
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
  const origin =
    configuredBaseUrl && configuredBaseUrl.length > 0
      ? configuredBaseUrl.replace(/\/+$/, '')
      : `${req.protocol}://${req.get('host') ?? 'localhost'}`
  return `${origin}/api/v1/oauth-callback/${encodeURIComponent(oauthClientId)}`
}

export function renderSuccessHtml(
  provider: string,
  oauthClientId: string,
  opts?: { backgroundRequested?: boolean; backgroundEnabled?: boolean; source?: 'mcp' }
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
