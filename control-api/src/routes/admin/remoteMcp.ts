import { Router } from 'express'
import { z } from 'zod'
import { config } from '../../config.js'
import { type DbClient, pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { extractK8sError } from '../../http/k8sError.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { pinnedFetch } from '../../http/pinnedFetch.js'
import { RFC1123_RE } from '../../http/rfc1123.js'
import { validateOAuthEndpointUrl } from '../../http/validateMcpServerSpec.js'
import { K8sGateway } from '../../k8s.js'
import { type UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { REMOTE_CALLBACK_PATH } from '../../oauth/cimd.js'
import {
  type DcrDeps,
  type DcrMintHandle,
  buildDcrRequest,
  registerDynamicClient,
} from '../../oauth/dcr.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../../oauth/discovery.js'
import {
  type DynamicClientKey,
  deleteDynamicClient,
  upsertDynamicClient,
} from '../../oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../../oauth/encryption.js'
import { rootLogger } from '../../observability/logger.js'
import { K8sNotFoundError } from '../../services/resourceService.js'
import { normalizeConfiguredOrigin } from '../external/oauthCallback.js'

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
 * The engine (discovery, kernel §4) is C1; DCR (RFC 7591) is C2: a DCR-mode install
 * registers a dynamic client against the AS (`dcr.ts`), persists its credentials in
 * the encrypted `dynamic_clients` store (`dynamicClientStore.ts`) as saga step 0,
 * and — for DCR-confidential — keeps the secret in that store rather than a K8s
 * Secret (DEC-8). Registration is compensated (local delete + best-effort RFC 7592
 * DELETE) if a later saga step fails.
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
  /**
   * AS-assigned client_id, set ONLY for the DCR branch (mirrors the
   * `dynamic_clients` row; C4 keys grant resolution by `oauth.id`). Omitted for
   * CIMD/pre-registered in this phase — CIMD's `id` backfill is C3 (DEC-18, R0/F5).
   */
  id?: string
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
    /** Set for pre-registered confidential (K8s Secret name); mutually exclusive with dynamicClientId. */
    clientSecretName?: string
    /** Set for DCR (AS-assigned client_id); mirrored to `oauth.id`. Omits Secret refs. */
    dynamicClientId?: string
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
  // C4 discriminator (DEC-18): Secret refs present ⇒ read the secret from the K8s
  // Secret (pre-registered). No refs + clientMode 'confidential' + `id` set ⇒ read
  // the secret from the encrypted `dynamic_clients` store (DCR). The two sources
  // are mutually exclusive per install mode, so we set at most one here.
  if (opts.dynamicClientId) {
    oauth.id = opts.dynamicClientId
  } else if (opts.clientMode === 'confidential' && opts.clientSecretName) {
    oauth.clientIdRef = { name: opts.clientSecretName, key: 'client_id' }
    oauth.clientSecretRef = { name: opts.clientSecretName, key: 'client_secret' }
  }
  return oauth
}

/**
 * DCR client mode is derived from the AS metadata, NOT the operator body: a public
 * client when the AS lists `none` in `token_endpoint_auth_methods_supported`, else
 * confidential (`client_secret_post`). The registration RESPONSE is the final
 * authority on the auth method (fail-closed in `registerDynamicClient`).
 */
function deriveDcrClientMode(result: DiscoveryResult): 'public' | 'confidential' {
  const methods = result.as.token_endpoint_auth_methods_supported
  return Array.isArray(methods) && methods.includes('none') ? 'public' : 'confidential'
}

const DCR_TIMEOUT_MS = 15_000

/**
 * Best-effort RFC 7592 client-delete against the AS's management endpoint, so a
 * dynamic client we minted but then failed to fully install does not linger at the
 * AS. Single-hop pinned DELETE with the registration bearer; any failure is
 * swallowed (the local `deleteDynamicClient` is the reliable revocation, this is
 * courtesy cleanup). Never logs the bearer.
 */
async function bestEffortRfc7592Delete(
  dcrDeps: DcrDeps,
  registrationClientUri: string,
  registrationAccessToken: string
): Promise<void> {
  try {
    await pinnedFetch(registrationClientUri, 'spec.oauth.registrationClientUri', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${registrationAccessToken}` },
      resolveDns: dcrDeps.resolveDns,
      transport: dcrDeps.transport,
      timeoutMs: DCR_TIMEOUT_MS,
    })
  } catch {
    // Best-effort; the local store delete is the reliable revocation.
  }
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

/**
 * Injectable dependencies for the DCR saga (test seam). Production leaves them
 * undefined: `db` defaults to the core `pool`, `encryptionKey` is derived from
 * config, and `dcr` uses the real `node:https` pinned transport. Tests inject an
 * in-memory `db` and a `PinnedTransport` stub so the saga runs with zero network.
 */
export interface AdminRemoteMcpDeps {
  db?: DbClient
  encryptionKey?: Buffer
  dcr?: DcrDeps
}

export function createAdminRemoteMcpRouter(
  gateway: K8sGateway,
  deps: AdminRemoteMcpDeps = {}
): Router {
  const router = Router()
  const db: DbClient = deps.db ?? pool
  const encryptionKey = deps.encryptionKey ?? deriveOAuthEncryptionKey(config.oauthEncryptionKey)
  const dcrDeps: DcrDeps = deps.dcr ?? { logger: log }

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
          // DCR is available in C2. Echo the resolved client mode (derived from the
          // AS auth methods, not the operator) + supportsRefresh so the C5 wizard can
          // prefill the confirm step.
          ...(r.registrationMode === 'dcr'
            ? {
                dcr: {
                  available: true,
                  clientMode: deriveDcrClientMode(r),
                  supportsRefresh: r.quirks.supportsRefresh,
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

      // A pre-registered install must carry the operator-supplied credentials up
      // front (they become the K8s Secret). CIMD/DCR carry none here.
      if (body.mode === 'pre-registered' && (!body.clientId || !body.clientSecret)) {
        res.status(400).json({
          error: 'pre-registered confidential client requires clientId and clientSecret',
        })
        return
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
        { hasPreRegisteredClient: body.mode === 'pre-registered' }
      )
      if (!outcome.ok) {
        log.warn({ discovery: outcome.error.kind }, 'remote install discovery failed')
        res.status(400).json({ error: 'discovery_failed', detail: outcome.error })
        return
      }
      const discovery = outcome.result

      // The requested mode must match what server-side discovery actually resolved
      // (D-4: discovery is authoritative). CIMD ⇒ AS must offer CIMD; DCR ⇒ AS must
      // offer a registration endpoint (registrationMode 'dcr').
      if (body.mode === 'cimd' && discovery.registrationMode !== 'cimd') {
        if (discovery.registrationMode === 'dcr') {
          res.status(400).json({
            error: 'mode_unsupported',
            message:
              'this authorization server requires dynamic client registration; install with mode "dcr"',
          })
          return
        }
        res.status(400).json({
          error: 'mode_unsupported',
          message: `authorization server does not support CIMD (detected mode: ${discovery.registrationMode})`,
        })
        return
      }
      if (body.mode === 'dcr' && discovery.registrationMode !== 'dcr') {
        res.status(400).json({
          error: 'mode_unsupported',
          message: `authorization server does not offer dynamic client registration (detected mode: ${discovery.registrationMode})`,
        })
        return
      }

      // Client mode: pre-registered/CIMD are fixed by the mode; DCR derives it from
      // the AS auth methods (public iff `none`, else confidential) — NOT the body.
      const clientMode: 'public' | 'confidential' =
        body.mode === 'pre-registered'
          ? 'confidential'
          : body.mode === 'dcr'
            ? deriveDcrClientMode(discovery)
            : 'public'

      const targetNs = config.mcpServersNamespace
      const serverName = body.serverName
      const contextRef = body.contextRef
      const grantScope = body.grantScope ?? 'user'

      const managedLabels: Record<string, string> = {
        'clerum.io/managed-by': 'control-api',
        'clerum.io/server-mode': 'remote',
      }

      // ── Saga step 0 (DCR only): register a dynamic client against the AS and
      // persist its credentials in the encrypted store BEFORE any K8s writes. The
      // registration endpoint was kernel-validated during discovery and is re-pinned
      // by the POST. Compensated by `rollbackDynamicClient` if a later step fails.
      const dynamicClientKey: DynamicClientKey = {
        ownerKind: 'mcpserver',
        serverNamespace: targetNs,
        serverName,
      }
      let dcrRegistered = false
      let dcrClientId: string | undefined
      let dcrRegistrationClientUri: string | undefined
      let dcrRegistrationAccessToken: string | undefined
      const rollbackDynamicClient = async (): Promise<void> => {
        if (!dcrRegistered) return
        try {
          await deleteDynamicClient(db, dynamicClientKey)
        } catch {
          // Best-effort local revocation; preserve the original saga error.
        }
        if (dcrRegistrationClientUri && dcrRegistrationAccessToken) {
          await bestEffortRfc7592Delete(
            dcrDeps,
            dcrRegistrationClientUri,
            dcrRegistrationAccessToken
          )
        } else {
          // AS returned no RFC 7592 management endpoint — local delete is all we can do.
          log.info(
            { event: 'remote_oauth_dcr_rollback_local_only', serverName, namespace: targetNs },
            'dcr rollback: no RFC 7592 registration_client_uri, local store delete only'
          )
        }
      }

      if (body.mode === 'dcr') {
        // Cheap read-only precheck so a bad contextRef does not mint a throwaway
        // client at the AS. The attach step re-reads and remains authoritative.
        try {
          await gateway.getResource('contexts', contextRef)
        } catch (err) {
          const k8sErr = extractK8sError(err)
          const notFound = err instanceof K8sNotFoundError
          if (notFound || k8sErr?.status === 404) {
            res.status(404).json({ error: `context "${contextRef}" not found` })
            return
          }
          throw err
        }

        const registrationEndpoint = discovery.endpoints.registration
        if (!registrationEndpoint) {
          res.status(400).json({
            error: 'mode_unsupported',
            message: 'authorization server advertised no registration endpoint',
          })
          return
        }

        // redirect_uris single source of truth: the CIMD remote callback (never a
        // re-hardcoded path). Fail closed if no public callback origin is configured.
        const origin = normalizeConfiguredOrigin(config.oauthCallbackBaseUrl)
        if (origin === null) {
          log.error(
            { event: 'remote_oauth_dcr_callback_unconfigured', serverName },
            'dcr install requires a configured public callback base URL'
          )
          res.status(503).json({ error: 'callback_base_url_unconfigured' })
          return
        }

        const dcrRequest = buildDcrRequest(discovery, {
          clientMode,
          redirectUris: [`${origin}${REMOTE_CALLBACK_PATH}`],
          scopes: derivedScopes(discovery),
        })
        const dcrOutcome = await registerDynamicClient(dcrDeps, registrationEndpoint, dcrRequest)
        if (!dcrOutcome.ok) {
          const dcrError = dcrOutcome.error
          // Minted-but-rejected: a 2xx that assigned a real client_id we cannot use
          // (un-presentable auth method, or confidential without a secret). The client
          // exists at the AS but we abort — clean it up (DEC-18) before failing. Only
          // these variants carry the handle; non-2xx errors mint nothing.
          if (
            (dcrError.kind === 'auth_method_unsupported' || dcrError.kind === 'invalid_response') &&
            dcrError.registrationClientUri &&
            dcrError.registrationAccessToken
          ) {
            await bestEffortRfc7592Delete(
              dcrDeps,
              dcrError.registrationClientUri,
              dcrError.registrationAccessToken
            )
          }
          if (dcrError.kind === 'auth_method_unsupported') {
            log.warn(
              { event: 'remote_oauth_dcr_auth_method_unsupported', serverName },
              'dcr registration assigned an un-presentable auth method'
            )
            res.status(400).json({ error: 'auth_method_unsupported' })
            return
          }
          log.warn(
            { event: 'remote_oauth_dcr_failed', serverName, dcr: dcrError.kind },
            'dynamic client registration failed'
          )
          // Strip the RFC 7592 mint handle before echoing: the registration_access_token
          // is an AS management bearer and must never reach the response body or a log.
          const {
            registrationAccessToken: _t,
            registrationClientUri: _u,
            ...safeDetail
          } = dcrError as typeof dcrError & Partial<DcrMintHandle>
          res.status(400).json({ error: 'dcr_registration_failed', detail: safeDetail })
          return
        }

        const registration = dcrOutcome.response
        // Capture the RFC 7592 mint handle BEFORE the local persist. If the persist
        // throws (pool exhausted, transient, or an encryption error), the client is
        // already minted at the AS, and `dcrRegistered` has NOT flipped yet — so the
        // saga rollback would skip it and orphan a (often confidential) client at the
        // AS. Compensate here explicitly (DEC-18).
        const mintedRegistrationClientUri = registration.registration_client_uri
        const mintedRegistrationAccessToken = registration.registration_access_token
        try {
          await upsertDynamicClient(db, encryptionKey, {
            ...dynamicClientKey,
            issuer: discovery.issuer,
            clientId: registration.client_id,
            clientMode,
            clientSecret: registration.client_secret,
            registrationAccessToken: registration.registration_access_token,
            registrationClientUri: registration.registration_client_uri,
            clientIdIssuedAtSec: registration.client_id_issued_at,
            clientSecretExpiresAtSec: registration.client_secret_expires_at,
          })
        } catch (err) {
          // Local delete is idempotent (the row may never have landed); the pinned
          // RFC 7592 DELETE is the courtesy revocation at the AS. Both best-effort —
          // neither must mask the persist failure we report.
          try {
            await deleteDynamicClient(db, dynamicClientKey)
          } catch {
            // Best-effort local revocation; the row may not exist.
          }
          if (mintedRegistrationClientUri && mintedRegistrationAccessToken) {
            await bestEffortRfc7592Delete(
              dcrDeps,
              mintedRegistrationClientUri,
              mintedRegistrationAccessToken
            )
          }
          // Names-only: never echo the persist error body (may carry secret material).
          log.error(
            {
              event: 'remote_oauth_dcr_persist_failed',
              serverName,
              namespace: targetNs,
              errName: err instanceof Error ? err.name : 'unknown',
            },
            'dcr client persist failed after AS registration; ran best-effort cleanup'
          )
          // 503: transient/server-side (DB), not a client error.
          res.status(503).json({ error: 'dcr_persist_failed' })
          return
        }
        dcrRegistered = true
        dcrClientId = registration.client_id
        dcrRegistrationClientUri = registration.registration_client_uri
        dcrRegistrationAccessToken = registration.registration_access_token
        // Names-only audit: never echo client_secret, registration_access_token, or
        // even the client_id value here.
        log.info(
          {
            event: 'remote_oauth_dynamic_client_registered',
            serverName,
            namespace: targetNs,
            clientMode,
            hasRegistrationClientUri: Boolean(dcrRegistrationClientUri),
          },
          'remote oauth dynamic client registered'
        )
      }

      // Build the McpServer spec. transport routes through the HCC nginx egress proxy
      // (D-2); the pinned oauth block is the C3 CRD contract.
      const upstreamPath = new URL(body.baseUrl).pathname || '/'
      // A K8s Secret is created ONLY for pre-registered confidential clients. A
      // DCR-confidential client's secret lives in the encrypted store (DEC-8), so it
      // never gets a Secret name and never references one on the CR.
      const clientSecretName =
        body.mode === 'pre-registered' ? `${serverName}-oauth-client` : undefined

      const oauthSpec = buildRemoteOAuthSpec(discovery, {
        clientMode,
        grantScope,
        clientSecretName,
        ...(dcrClientId ? { dynamicClientId: dcrClientId } : {}),
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
        // Compensate a DCR registration made in step 0 (local delete + best-effort 7592).
        await rollbackDynamicClient()
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
        // Compensate a DCR registration made in step 0 (local delete + best-effort 7592).
        await rollbackDynamicClient()
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
