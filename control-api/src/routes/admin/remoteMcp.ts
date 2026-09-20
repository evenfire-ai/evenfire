import { Router } from 'express'
import { z } from 'zod'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { extractK8sError } from '../../http/k8sError.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { RFC1123_RE } from '../../http/rfc1123.js'
import { validateOAuthEndpointUrl } from '../../http/validateMcpServerSpec.js'
import { K8sGateway } from '../../k8s.js'
import { type UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../../oauth/discovery.js'
import { rootLogger } from '../../observability/logger.js'
import { K8sNotFoundError } from '../../services/resourceService.js'

/**
 * Admin "C-install" routes for the remote MCP-OAuth carril (spec 02 C1.5, DEC-12).
 *
 * Two routes, mounted under `/admin/*` (so `requireAuthForControlUI` already
 * authenticated the caller as a control-ui admin):
 *
 *   POST /admin/mcp-servers/remote/discover  — dry-run: kernel-guard the URL, run
 *     RFC 9728→8414 discovery, return the "Detected" prefill for the C5 wizard. No
 *     writes.
 *   POST /admin/mcp-servers/remote           — transactional install saga: re-run
 *     discovery server-side (D-4: discover only at install, then pin), create the
 *     Secret (confidential only) + McpServer CR + attach to the Context, with
 *     compensating rollback that preserves the original error.
 *
 * The written `spec.oauth` remote shape is the C3 CRD contract (see
 * {@link buildRemoteOAuthSpec}). It is NOT admissible by the current CRD — C3
 * legalizes `remote`×`oauth` — so this route's LIVE admission only works after C3.
 * Until then the saga is unit-tested against a mocked K8sGateway.
 *
 * The engine (discovery, kernel §4) is C1; DCR (RFC 7591) lands in C2 — a DCR-mode
 * install is rejected here with a clear message.
 */

const BASE = '/admin/mcp-servers/remote'

const log = rootLogger.child({ module: 'admin-remote-mcp' })

const discoverBodySchema = z.object({
  baseUrl: z.string().min(1),
})

// Install body: serverName + contextRef + baseUrl + registration mode. A
// pre-registered confidential client also carries clientId/clientSecret.
const installBodySchema = z.object({
  serverName: z.string().min(1),
  contextRef: z.string().min(1),
  baseUrl: z.string().min(1),
  mode: z.enum(['cimd', 'pre-registered', 'dcr']),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  grantScope: z.enum(['user', 'context']).optional(),
})

type InstallBody = z.infer<typeof installBodySchema>

function isValidK8sName(name: string): boolean {
  return RFC1123_RE.test(name) && name.length <= 253
}

/**
 * The `spec.oauth` remote shape written to the CR — the C3 contract. Uses a distinct
 * `source: 'remote'` discriminator instead of the closed 8-provider `provider` enum
 * (D-10.3): a discovered remote client is NOT a baked provider. Endpoints are the
 * pinned values discovery kernel-guarded; quirks (D-8) come from metadata. A
 * confidential client references its Secret via `clientIdRef`/`clientSecretRef`
 * (same nested ref shape as the baked carril); a public (CIMD) client carries no ref.
 */
export interface RemoteOAuthClientSecretRef {
  name: string
  key: string
}

export interface RemoteOAuthSpec {
  /** Discriminator for the remote-discovered carril — never the baked `provider` enum. */
  source: 'remote'
  clientMode: 'public' | 'confidential'
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  issuer: string
  /** RFC 8707 value sent in authorize + token requests. */
  resource: string
  /** RFC 9207 issuer to validate the callback `iss` against (present only when advertised). */
  issForCallback?: string
  grantScope: 'user' | 'context'
  scopes: string[]
  /** D-8: token in the body, not the Authorization header. */
  bearerInBody: boolean
  /** D-8: fail-closed — false means never attempt a refresh. */
  supportsRefresh: boolean
  clientIdRef?: RemoteOAuthClientSecretRef
  clientSecretRef?: RemoteOAuthClientSecretRef
}

function derivedScopes(result: DiscoveryResult): string[] {
  return result.prm.scopes_supported ?? result.as.scopes_supported ?? []
}

function buildRemoteOAuthSpec(
  result: DiscoveryResult,
  opts: {
    clientMode: 'public' | 'confidential'
    grantScope: 'user' | 'context'
    clientSecretName?: string
  }
): RemoteOAuthSpec {
  const oauth: RemoteOAuthSpec = {
    source: 'remote',
    clientMode: opts.clientMode,
    authorizationEndpoint: result.endpoints.authorization,
    tokenEndpoint: result.endpoints.token,
    issuer: result.issuer,
    resource: result.resource,
    grantScope: opts.grantScope,
    scopes: derivedScopes(result),
    bearerInBody: result.quirks.bearerInBody,
    supportsRefresh: result.quirks.supportsRefresh,
  }
  if (result.endpoints.registration) oauth.registrationEndpoint = result.endpoints.registration
  if (result.issForCallback) oauth.issForCallback = result.issForCallback
  if (opts.clientMode === 'confidential' && opts.clientSecretName) {
    oauth.clientIdRef = { name: opts.clientSecretName, key: 'client_id' }
    oauth.clientSecretRef = { name: opts.clientSecretName, key: 'client_secret' }
  }
  return oauth
}

const REMOTE_MCP_EGRESS_PROXY_IMAGE =
  process.env.CONTROL_API_REMOTE_MCP_EGRESS_PROXY_IMAGE || 'clerum/nginx-egress-proxy:0.1.0'
const REMOTE_MCP_PROXY_PORT = 3000
const DELETE_SETTLE_TIMEOUT_MS = 10_000
const DELETE_SETTLE_POLL_MS = 250

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Poll until a best-effort delete settles to a 404, so a re-install cannot 409. */
async function waitForDeletion(readCurrent: () => Promise<unknown>, label: string): Promise<void> {
  const deadline = Date.now() + DELETE_SETTLE_TIMEOUT_MS
  while (Date.now() <= deadline) {
    try {
      await readCurrent()
    } catch (err) {
      if (extractK8sError(err)?.status === 404 || err instanceof K8sNotFoundError) return
      throw err
    }
    await sleep(DELETE_SETTLE_POLL_MS)
  }
  throw new Error(`Timed out waiting for ${label} deletion`)
}

export function createAdminRemoteMcpRouter(gateway: K8sGateway): Router {
  const router = Router()

  // ── POST /admin/mcp-servers/remote/discover — dry-run, no writes ──────────
  router.post(
    `${BASE}/discover`,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const parsed = discoverBodySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'baseUrl is required' })
        return
      }
      const { baseUrl } = parsed.data

      // Kernel §4: the admin-typed URL is untrusted input of origin — validate before
      // any fetch (discovery also kernel-guards internally, but a clean 400 here gives
      // the wizard immediate, field-level feedback).
      const kernelErrors = await validateOAuthEndpointUrl(baseUrl, 'baseUrl')
      if (kernelErrors.length > 0) {
        res.status(400).json({ error: kernelErrors[0].message, errors: kernelErrors })
        return
      }

      const outcome = await discoverRemoteOAuth(baseUrl, { logger: log })
      if (!outcome.ok) {
        log.warn({ discovery: outcome.error.kind }, 'remote discovery (dry-run) failed')
        res.status(400).json({ error: 'discovery_failed', detail: outcome.error })
        return
      }

      const r = outcome.result
      res.status(200).json({
        detected: {
          registrationMode: r.registrationMode,
          // DCR is not available until C2 — surfaced, not failed (spec C1.5).
          ...(r.registrationMode === 'dcr'
            ? {
                dcr: {
                  available: false,
                  message: 'requires DCR (not available until C2)',
                },
              }
            : {}),
          endpoints: r.endpoints,
          resource: r.resource,
          issuer: r.issuer,
          ...(r.issForCallback ? { issForCallback: r.issForCallback } : {}),
          scopes: derivedScopes(r),
          quirks: r.quirks,
        },
      })
    })
  )

  // ── POST /admin/mcp-servers/remote — transactional install saga ───────────
  router.post(
    BASE,
    // Namespace is server-determined; strip/audit any caller-supplied value.
    enforceNamespace(config.mcpServersNamespace),
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const parsed = installBodySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', detail: parsed.error.issues })
        return
      }
      const body: InstallBody = parsed.data

      if (!isValidK8sName(body.serverName)) {
        res.status(400).json({
          error: 'invalid serverName: must be a valid K8s name (RFC 1123 label, max 253 chars)',
        })
        return
      }
      if (!isValidK8sName(body.contextRef)) {
        res.status(400).json({ error: 'invalid contextRef' })
        return
      }

      // DCR lands in C2 — reject clearly rather than half-install.
      if (body.mode === 'dcr') {
        res.status(400).json({
          error: 'dcr_not_available',
          message: 'dynamic client registration is not yet available (lands in C2)',
        })
        return
      }

      let clientMode: 'public' | 'confidential'
      if (body.mode === 'pre-registered') {
        if (!body.clientId || !body.clientSecret) {
          res.status(400).json({
            error: 'pre-registered confidential client requires clientId and clientSecret',
          })
          return
        }
        clientMode = 'confidential'
      } else {
        // CIMD → public client, no secret.
        clientMode = 'public'
      }

      // Kernel §4 on the admin-typed baseUrl (explicit 400 before discovery).
      const kernelErrors = await validateOAuthEndpointUrl(body.baseUrl, 'baseUrl')
      if (kernelErrors.length > 0) {
        res.status(400).json({ error: kernelErrors[0].message, errors: kernelErrors })
        return
      }

      // D-4: re-run discovery SERVER-SIDE at install and pin the result — never trust
      // the client-passed prefill as authoritative. Discovery kernel-guards baseUrl +
      // every discovered endpoint internally before returning them.
      const outcome = await discoverRemoteOAuth(
        body.baseUrl,
        { logger: log },
        { hasPreRegisteredClient: clientMode === 'confidential' }
      )
      if (!outcome.ok) {
        log.warn({ discovery: outcome.error.kind }, 'remote install discovery failed')
        res.status(400).json({ error: 'discovery_failed', detail: outcome.error })
        return
      }
      const discovery = outcome.result

      // CIMD-mode install requires the AS to actually support the public CIMD carril.
      if (clientMode === 'public' && discovery.registrationMode !== 'cimd') {
        if (discovery.registrationMode === 'dcr') {
          res.status(400).json({
            error: 'dcr_not_available',
            message:
              'this authorization server requires dynamic client registration, not yet available (C2)',
          })
          return
        }
        res.status(400).json({
          error: 'mode_unsupported',
          message: `authorization server does not support CIMD (detected mode: ${discovery.registrationMode})`,
        })
        return
      }

      const targetNs = config.mcpServersNamespace
      const serverName = body.serverName
      const contextRef = body.contextRef
      const grantScope = body.grantScope ?? 'user'

      const managedLabels: Record<string, string> = {
        'clerum.io/managed-by': 'control-api',
        'clerum.io/server-mode': 'remote',
      }

      // Build the McpServer spec. transport routes through the HCC nginx egress proxy
      // (D-2); the pinned oauth block is the C3 CRD contract.
      const upstreamPath = new URL(body.baseUrl).pathname || '/'
      const clientSecretName =
        clientMode === 'confidential' ? `${serverName}-oauth-client` : undefined

      const oauthSpec = buildRemoteOAuthSpec(discovery, {
        clientMode,
        grantScope,
        clientSecretName,
      })

      const mcpServerSpec: Record<string, unknown> = {
        image: REMOTE_MCP_EGRESS_PROXY_IMAGE,
        contextRef,
        enabled: true,
        managed: true,
        transport: {
          type: 'streamableHttp',
          port: REMOTE_MCP_PROXY_PORT,
          url: `http://${serverName}.${targetNs}.svc.cluster.local:${REMOTE_MCP_PROXY_PORT}${upstreamPath}`,
        },
        remote: { baseUrl: body.baseUrl },
        // Bicondicional (D-10): remote+oauth MUST carry auth.type:'oauth'.
        auth: { type: 'oauth' },
        oauth: oauthSpec,
        // The proxy egresses to the remote MCP host; NetworkPolicy is generated from this.
        egressBindings: [
          {
            egressClass: 'exact-host',
            dns: new URL(body.baseUrl).hostname,
            port: 443,
            protocol: 'TCP',
          },
        ],
      }

      // ── Saga step 1: create the client Secret (confidential only) ─────────
      let secretCreated = false
      if (clientMode === 'confidential' && clientSecretName) {
        try {
          await gateway.createSecret({
            name: clientSecretName,
            namespace: targetNs,
            type: 'Opaque',
            labels: managedLabels,
            stringData: {
              client_id: body.clientId as string,
              client_secret: body.clientSecret as string,
            },
          })
        } catch (err) {
          const k8sErr = extractK8sError(err)
          if (k8sErr) {
            res.status(k8sErr.status).json({ error: `Secret creation failed: ${k8sErr.message}` })
            return
          }
          throw err
        }
        secretCreated = true
        // Names-only audit: never echo the secret material.
        log.info(
          {
            event: 'remote_oauth_secret_created',
            secretName: clientSecretName,
            namespace: targetNs,
          },
          'remote oauth client secret created'
        )
      }

      // ── Saga step 2: create the McpServer CR (rollback Secret on failure) ──
      try {
        await gateway.createResource(
          'mcpservers',
          { metadata: { name: serverName, labels: managedLabels }, spec: mcpServerSpec },
          targetNs
        )
      } catch (err) {
        if (secretCreated && clientSecretName) {
          try {
            await gateway.deleteSecret(clientSecretName, targetNs)
          } catch {
            // Best-effort rollback; preserve the original CR-create error.
          }
        }
        const k8sErr = extractK8sError(err)
        if (k8sErr) {
          res.status(k8sErr.status).json({ error: k8sErr.message })
          return
        }
        throw err
      }

      // ── Saga step 3: attach to the Context allowlist (rollback CR+Secret) ──
      try {
        const ctx = (await gateway.getResource('contexts', contextRef)) as {
          spec?: Record<string, unknown> & { contextId?: string; mcpServers?: string[] }
        }
        const existing: string[] = ctx.spec?.mcpServers ?? []
        if (!existing.includes(serverName)) {
          await gateway.updateResource('contexts', contextRef, {
            spec: {
              ...ctx.spec,
              contextId: ctx.spec?.contextId ?? contextRef,
              mcpServers: [...existing, serverName],
            } as Record<string, unknown>,
          })
        }
      } catch (err) {
        try {
          await gateway.deleteResource('mcpservers', serverName, targetNs)
          await waitForDeletion(
            () => gateway.getResource('mcpservers', serverName, targetNs),
            `McpServer/${serverName}`
          )
        } catch {
          // Best-effort rollback; preserve the original attach error.
        }
        if (secretCreated && clientSecretName) {
          try {
            await gateway.deleteSecret(clientSecretName, targetNs)
            await waitForDeletion(
              () => gateway.getSecret(clientSecretName, targetNs),
              `Secret/${clientSecretName}`
            )
          } catch {
            // Best-effort rollback; preserve the original attach error.
          }
        }
        const k8sErr = extractK8sError(err)
        const notFound = err instanceof K8sNotFoundError
        const message =
          k8sErr?.message ||
          (notFound
            ? `context "${contextRef}" not found`
            : err instanceof Error
              ? err.message
              : 'Failed to update Context allowlist')
        res
          .status(k8sErr?.status ?? (notFound ? 404 : 500))
          .json({ error: `Context allowlist update failed: ${message}` })
        return
      }

      log.info(
        {
          event: 'remote_oauth_server_installed',
          serverName,
          namespace: targetNs,
          contextRef,
          clientMode,
          registrationMode: discovery.registrationMode,
        },
        'remote oauth mcp server installed'
      )

      // Names-only summary — never echo the secret material or the pinned tokens.
      res.status(201).json({
        serverName,
        namespace: targetNs,
        contextRef,
        contextUpdated: true,
        clientMode,
        registrationMode: discovery.registrationMode,
        ...(clientSecretName ? { clientSecretName } : {}),
      })
    })
  )

  return router
}
