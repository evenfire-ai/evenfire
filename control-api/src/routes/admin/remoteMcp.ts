import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { config } from '../../config.js'
import { type DbClient, type DbTransactionClient, pool, withTransaction } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { extractK8sError } from '../../http/k8sError.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { RFC1123_RE } from '../../http/rfc1123.js'
import { validateOAuthEndpointUrl } from '../../http/validateMcpServerSpec.js'
import { K8sGateway } from '../../k8s.js'
import { type UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { buildCimdDocument } from '../../oauth/cimd.js'
import { MAX_CLIENT_ID_LENGTH, isCimdClientId } from '../../oauth/cimdIdentity.js'
import {
  type DcrDeps,
  type DcrMintHandle,
  buildDcrRequest,
  registerDynamicClient,
  verifyDcrRedirectUris,
} from '../../oauth/dcr.js'
import { bestEffortRfc7592Delete } from '../../oauth/dcrCleanup.js'
import {
  type DiscoveryResult,
  advertisesIssBinding,
  discoverRemoteOAuth,
  registrationModeInputs,
  selectRegistrationMode,
} from '../../oauth/discovery.js'
import { discoveryHttpStatus } from '../../oauth/discoveryHttpStatus.js'
import {
  type DynamicClientKey,
  PENDING_TTL_MS,
  type UpsertDynamicClientInput,
  bindDynamicClientToResource,
  classifyExistingDynamicClient,
  deleteDynamicClientOwnedByInstall,
  getDynamicClient,
  insertDynamicClientPending,
  isDynamicClientIdRegistered,
  reclaimOrphanDynamicClient,
} from '../../oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../../oauth/encryption.js'
import { probeMcpTransport } from '../../oauth/mcpTransportProbe.js'
import {
  InvalidRemoteRedirectUriInputError,
  type RemoteCallbackVariant,
  buildRemoteRedirectUri,
  isValidRemoteServerNameSegment,
  remoteCallbackVariant,
} from '../../oauth/remoteCallback.js'
import { rootLogger } from '../../observability/logger.js'
import { attachServerToContext } from '../../services/contextAllowlist.js'
import { K8sNotFoundError } from '../../services/resourceService.js'
import type { SecretSnapshot } from '../../services/secretRepository.js'
import type { ResourcePreconditions } from '../../types.js'
import { normalizeConfiguredOrigin } from '../external/oauthCallback.js'

/**
 * Admin "C-install" routes for the remote MCP-OAuth carril (spec 02 C1.5, DEC-12).
 *
 * Two routes, mounted under `/admin/*` (so `requireAuthForControlUI` already
 * authenticated the caller as a control-ui admin):
 *
 *   POST /admin/mcp-servers/remote/discover  — dry-run: kernel-guard the URL, run
 *     RFC 9728→8414 discovery, probe the MCP transport (a tokenless `initialize`), and
 *     return the "Detected" prefill + `transport` verdict for the C5 wizard. No writes.
 *   POST /admin/mcp-servers/remote           — transactional install saga: re-run
 *     discovery server-side (D-4: discover only at install, then pin), probe the MCP
 *     transport as a hard gate (a provably-dead 404/405 path is a 400
 *     `transport_unreachable` BEFORE any AS mint or K8s write), then create the Secret
 *     (confidential only) + McpServer CR + attach to the Context, with compensating
 *     rollback that preserves the original error.
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

/**
 * A minted DCR client is being abandoned without an RFC 7592 handle: it stays
 * registered at the AS. Logged the same way on every abandon path, so an abandoned
 * install is never mistaken for a cleaned-up one.
 */
function logDcrRevokeLocalOnly(serverName: string, hasRegistrationClientUri: boolean): void {
  log.info(
    { event: 'remote_oauth_dcr_revoke_local_only', serverName, hasRegistrationClientUri },
    'dcr revoke skipped: no RFC 7592 management handle, the minted client remains at the AS'
  )
}

// `discoveryHttpStatus` moved to `oauth/discoveryHttpStatus.js` (H-5) so the remote
// and generic discover endpoints share one mapping. Re-exported here so existing
// importers (and the mapping's own test) keep resolving it from this module.
export { discoveryHttpStatus }

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
  clientId: z.string().min(1).max(MAX_CLIENT_ID_LENGTH).optional(),
  clientSecret: z.string().min(1).optional(),
  grantScope: z.enum(['user', 'context']).optional(),
})

type InstallBody = z.infer<typeof installBodySchema>

/**
 * Fenced-delete preconditions from a just-created object, or undefined when the
 * apiserver response carried no complete identity. A rollback bound by
 * uid+resourceVersion cannot raze a homonymous object that a concurrent
 * uninstall+reinstall recreated in the compensation window — the fenced pattern
 * the baked carril (`registry.ts`) and uninstall (`resources.ts`) already use.
 */
function resourcePreconditionsFrom(resource: unknown): ResourcePreconditions | undefined {
  const metadata = (resource as { metadata?: { uid?: unknown; resourceVersion?: unknown } } | null)
    ?.metadata
  const uid = metadata?.uid
  const resourceVersion = metadata?.resourceVersion
  if (typeof uid !== 'string' || !uid || typeof resourceVersion !== 'string' || !resourceVersion) {
    return undefined
  }
  return { uid, resourceVersion }
}

/** The server-assigned `metadata.uid`, or undefined when the response carried none. */
function resourceUidFrom(resource: unknown): string | undefined {
  const uid = (resource as { metadata?: { uid?: unknown } } | null)?.metadata?.uid
  return typeof uid === 'string' && uid ? uid : undefined
}

/**
 * The uid of a live McpServer with this name, or undefined when none exists. A live
 * CR owns the name: the reclaim/classify path treats a conflict against a live uid as
 * `in-use` regardless of the persisted row's state. A 404 is "no live CR" (undefined);
 * any other read error propagates (fail closed, not "assume free").
 */
async function readLiveMcpServerUid(
  gateway: K8sGateway,
  name: string,
  namespace: string
): Promise<string | undefined> {
  try {
    return resourceUidFrom(await gateway.getResource('mcpservers', name, namespace))
  } catch (err) {
    if (err instanceof K8sNotFoundError || extractK8sError(err)?.status === 404) return undefined
    throw err
  }
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

export function buildRemoteOAuthSpec(
  result: DiscoveryResult,
  opts: {
    clientMode: 'public' | 'confidential'
    grantScope: 'user' | 'context'
    /** Set for pre-registered confidential (K8s Secret name); mutually exclusive with dynamicClientId. */
    clientSecretName?: string
    /** Set for DCR (AS-assigned client_id); mirrored to `oauth.id`. Omits Secret refs. */
    dynamicClientId?: string
    /** CIMD public: the platform self-URL client_id (from `cimd.ts`) — DEC-23 backfill. */
    cimdClientId?: string
    /** Pre-registered confidential: operator-supplied plaintext client_id — DEC-23 backfill. */
    preRegisteredClientId?: string
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
  //
  // DEC-23 backfill: EVERY remote mode carries `oauth.id` (the public client_id) so
  // the resolver keys grants uniformly. DCR uses the AS assignment; CIMD-public the
  // platform self-URL; pre-registered the operator's plaintext client_id.
  if (opts.dynamicClientId) {
    oauth.id = opts.dynamicClientId
  } else if (opts.clientMode === 'confidential' && opts.clientSecretName) {
    oauth.clientIdRef = { name: opts.clientSecretName, key: 'client_id' }
    oauth.clientSecretRef = { name: opts.clientSecretName, key: 'client_secret' }
    if (opts.preRegisteredClientId) oauth.id = opts.preRegisteredClientId
  } else if (opts.cimdClientId) {
    oauth.id = opts.cimdClientId
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

/**
 * The callback variant an install from this discovery result writes. Derived from the
 * `spec.oauth` block the install builds — not from the discovery fields directly — so
 * the install and the runtime (which reads the block back from the CR) share one
 * derivation. The builder options do not influence the variant.
 */
function callbackVariantOf(discovery: DiscoveryResult): RemoteCallbackVariant {
  return remoteCallbackVariant(
    buildRemoteOAuthSpec(discovery, { clientMode: 'public', grantScope: 'user' })
  )
}

/**
 * The AS offers CIMD to a public client and would resolve to it, but for the missing
 * RFC 9207 advertisement. Evaluated through the real mode selector so the answer can
 * never disagree with discovery.
 */
function cimdBlockedOnlyByMissingIssBinding(discovery: DiscoveryResult): boolean {
  if (advertisesIssBinding(discovery.as)) return false
  const withIssBinding = {
    ...registrationModeInputs(discovery.as, { hasPreRegisteredClient: false }),
    issBindingSupported: true,
  }
  return selectRegistrationMode(withIssBinding) === 'cimd'
}

// Stand-ins handed to the redirect-URI builder to render a template; they are replaced
// by placeholders, so the prefix the operator copies still comes from the one builder.
const TEMPLATE_SERVER_NAME = 'server-name'
const TEMPLATE_INSTALL_NONCE = '00000000-0000-0000-0000-000000000000'

export interface RemoteCallbackPreview {
  /**
   * Whether a public callback base URL is configured (for `per-server`, one that is a
   * bare origin). `false` blocks only a `per-server` install (503); a `shared` install
   * still proceeds, falling back to the request Host at consent, and simply has no URI
   * to show here.
   */
  configured: boolean
  variant: RemoteCallbackVariant
  /**
   * The redirect URI an install would register. Per-server URIs carry the literal
   * placeholders `{serverName}` and, for DCR, `{installId}` (minted at install time).
   */
  redirectUriTemplate?: string
}

/** The `/discover` view of the callback an install from this result would use. */
function previewRemoteCallback(discovery: DiscoveryResult): RemoteCallbackPreview {
  const variant = callbackVariantOf(discovery)
  const origin = normalizeConfiguredOrigin(config.oauthCallbackBaseUrl)
  if (origin === null) return { configured: false, variant }
  if (variant === 'shared') {
    return {
      configured: true,
      variant,
      redirectUriTemplate: buildRemoteRedirectUri({ origin, variant: 'shared' }),
    }
  }
  const dcr = discovery.registrationMode === 'dcr'
  const suffix = dcr
    ? `/${TEMPLATE_SERVER_NAME}/${TEMPLATE_INSTALL_NONCE}`
    : `/${TEMPLATE_SERVER_NAME}`
  let uri: string
  try {
    uri = dcr
      ? buildRemoteRedirectUri({
          origin,
          variant,
          mode: 'dcr',
          serverName: TEMPLATE_SERVER_NAME,
          installNonce: TEMPLATE_INSTALL_NONCE,
        })
      : buildRemoteRedirectUri({
          origin,
          variant,
          mode: 'pre-registered',
          serverName: TEMPLATE_SERVER_NAME,
        })
  } catch (err) {
    // A configured base URL that is not a bare origin cannot anchor a per-server URI.
    if (err instanceof InvalidRemoteRedirectUriInputError) return { configured: false, variant }
    throw err
  }
  return {
    configured: true,
    variant,
    redirectUriTemplate: `${uri.slice(0, -suffix.length)}${dcr ? '/{serverName}/{installId}' : '/{serverName}'}`,
  }
}

/** Hostnames of the AS endpoints an install would trust (shown before a per-server install). */
function asEndpointHostsOf(discovery: DiscoveryResult): {
  authorization: string
  token: string
  registration?: string
} {
  const { authorization, token, registration } = discovery.endpoints
  return {
    authorization: new URL(authorization).hostname,
    token: new URL(token).hostname,
    ...(registration ? { registration: new URL(registration).hostname } : {}),
  }
}

export type PreRegisteredClientIdConflict = 'cimd_client' | 'remote_server' | 'dynamic_client'

/**
 * Why a pre-registered client_id cannot back a per-server install, or null. A
 * per-server client must belong to exactly one server: its one registered redirect URI
 * is what binds its codes to that server, and a client shared with another server (or
 * one of our DCR clients, or the platform CIMD identity, which lists the shared
 * callback) would let the AS deliver a code for one server to another. Check-then-create
 * without a fence: an admin-only action on a confidential client, where a lost race
 * still leaves each server with its own redirect URI.
 */
async function preRegisteredClientIdConflict(
  gateway: K8sGateway,
  db: DbClient,
  namespace: string,
  clientId: string
): Promise<PreRegisteredClientIdConflict | null> {
  if (isCimdClientId(clientId)) return 'cimd_client'
  const servers = (await gateway.listResource('mcpservers', namespace)) as Array<{
    spec?: { oauth?: { source?: unknown; id?: unknown } }
  }>
  if (servers.some(s => s?.spec?.oauth?.source === 'remote' && s.spec.oauth.id === clientId)) {
    return 'remote_server'
  }
  if (await isDynamicClientIdRegistered(db, { serverNamespace: namespace, clientId })) {
    return 'dynamic_client'
  }
  return null
}

const REMOTE_MCP_EGRESS_PROXY_IMAGE =
  process.env.CONTROL_API_REMOTE_MCP_EGRESS_PROXY_IMAGE || 'clerum/nginx-egress-proxy:0.1.0'
const REMOTE_MCP_PROXY_PORT = 3000
const DELETE_SETTLE_TIMEOUT_MS = 10_000
const DELETE_SETTLE_POLL_MS = 250

/**
 * Production default for the DCR orphan-reclaim transaction. Wraps `withTransaction`
 * so the binding is only accessed when a reclaim actually runs — not at router
 * creation, which suites that partial-mock db.js would break.
 */
function defaultRunInTransaction<T>(work: (tx: DbTransactionClient) => Promise<T>): Promise<T> {
  return withTransaction(work)
}

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
  /**
   * Injectable discovery function (test seam only). Production leaves it undefined
   * and the real `discoverRemoteOAuth` (real IP-pinned network) is used; tests stub
   * it to drive a specific `DiscoveryOutcome` (e.g. a `fetch_failed`) with no network.
   */
  discover?: typeof discoverRemoteOAuth
  /**
   * Injectable MCP transport probe (test seam only). Production leaves it undefined and
   * the real {@link probeMcpTransport} (real IP-pinned POST `initialize`) is used; tests
   * inject one derived from the real producer to drive a specific probe outcome offline.
   */
  probe?: typeof probeMcpTransport
  /**
   * Injectable transaction runner (test seam only). Production leaves it undefined and
   * `withTransaction` (module pool) is used. The DCR orphan reclaim opens a transaction
   * for its `SELECT … FOR UPDATE` + CAS; a test injects a runner bound to its in-memory
   * db so the reclaim runs against the same store as the rest of the saga.
   */
  runInTransaction?: <T>(work: (tx: DbTransactionClient) => Promise<T>) => Promise<T>
}

export function createAdminRemoteMcpRouter(
  gateway: K8sGateway,
  deps: AdminRemoteMcpDeps = {}
): Router {
  const router = Router()
  const db: DbClient = deps.db ?? pool
  const encryptionKey = deps.encryptionKey ?? deriveOAuthEncryptionKey(config.oauthEncryptionKey)
  const dcrDeps: DcrDeps = deps.dcr ?? { logger: log }
  const discover = deps.discover ?? discoverRemoteOAuth
  const probe = deps.probe ?? probeMcpTransport
  // Defer the `withTransaction` binding to CALL time (only the DCR reclaim uses it).
  // Referencing it here at router-creation would break the many suites that
  // partial-mock db.js without a `withTransaction` export.
  const runInTransaction = deps.runInTransaction ?? defaultRunInTransaction

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

      const outcome = await discover(baseUrl, { logger: log })
      if (!outcome.ok) {
        log.warn({ discovery: outcome.error.kind }, 'remote discovery (dry-run) failed')
        res
          .status(discoveryHttpStatus(outcome.error))
          .json({ error: 'discovery_failed', detail: outcome.error })
        return
      }

      const r = outcome.result

      // Probe the MCP transport (issue 26-09-25): OAuth metadata alone can resolve on a
      // path whose `initialize` 404s (Vercel serves MCP at `/`). Detect surfaces this
      // early (+ a canonical-URL suggestion) without blocking the dry-run.
      const transport = await probe(baseUrl, { logger: log })
      if (transport.status === 'dead') {
        log.warn(
          {
            event: 'remote_discover_transport_unreachable',
            httpStatus: transport.httpStatus,
            hasSuggestion: Boolean(transport.suggestedBaseUrl),
          },
          'remote discover: MCP transport unreachable at the typed path'
        )
      }

      const callback = previewRemoteCallback(r)
      res.status(200).json({
        transport,
        callback,
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
          // Without `iss` the same-site rule is all that ties these hosts to the
          // issuer, and it cannot tell two hosts of one registrable domain apart; the
          // operator sees them before trusting them.
          ...(callback.variant === 'per-server' ? { asEndpointHosts: asEndpointHostsOf(r) } : {}),
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

      // The server name becomes a segment of its per-server redirect URI, so it is held
      // to the same rule the callback route applies to that segment.
      if (!isValidRemoteServerNameSegment(body.serverName)) {
        res.status(400).json({
          error: 'invalid serverName: must be a valid K8s name (RFC 1123 label, max 63 chars)',
        })
        return
      }
      if (!RFC1123_RE.test(body.contextRef)) {
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

      // Pre-check: a name already taken by a LIVE McpServer is rejected before any
      // discovery or AS mint, so we never register a throwaway client at the AS for a
      // name we cannot use. This is NOT the fence — a CR could still appear between here
      // and the persist (TOCTOU); the pending INSERT's ON CONFLICT below is the fence.
      const nameInUseUid = await readLiveMcpServerUid(
        gateway,
        body.serverName,
        config.mcpServersNamespace
      )
      if (nameInUseUid !== undefined) {
        log.warn(
          { event: 'remote_install_server_name_in_use', serverName: body.serverName },
          'remote install rejected: an McpServer with this name already exists'
        )
        res.status(409).json({ error: 'server_name_in_use' })
        return
      }

      // D-4: re-run discovery SERVER-SIDE at install and pin the result — never trust
      // the client-passed prefill as authoritative. Discovery kernel-guards baseUrl +
      // every discovered endpoint internally before returning them.
      const outcome = await discover(
        body.baseUrl,
        { logger: log },
        { hasPreRegisteredClient: body.mode === 'pre-registered' }
      )
      if (!outcome.ok) {
        log.warn({ discovery: outcome.error.kind }, 'remote install discovery failed')
        res
          .status(discoveryHttpStatus(outcome.error))
          .json({ error: 'discovery_failed', detail: outcome.error })
        return
      }
      const discovery = outcome.result

      // Reject `bearerInBody` at admission instead of persisting a CR the runtime
      // cannot honor. mcp-host always sends the token in the Authorization header
      // (body injection is deferred, see `mcp/client.ts`), so a resource that only
      // accepts the token in the body (`bearer_methods_supported:["body"]` without
      // `"header"`, e.g. SEMrush) would install "green" and then fail every tool
      // call with no signal. Fail closed here until body injection exists.
      if (discovery.quirks.bearerInBody) {
        log.warn(
          { event: 'remote_oauth_bearer_in_body_unsupported', serverName: body.serverName },
          'remote install rejected: resource requires bearer token in body, unsupported by the runtime'
        )
        res.status(400).json({
          error: 'bearer_in_body_unsupported',
          message:
            'this resource requires the bearer token in the request body, which is not yet supported',
        })
        return
      }

      // The requested mode must match what server-side discovery actually resolved
      // (D-4: discovery is authoritative). CIMD ⇒ AS must offer CIMD; DCR ⇒ AS must
      // offer a registration endpoint (registrationMode 'dcr').
      if (body.mode === 'cimd' && discovery.registrationMode !== 'cimd') {
        if (cimdBlockedOnlyByMissingIssBinding(discovery)) {
          const fallbackMode = discovery.registrationMode === 'dcr' ? 'dcr' : 'pre-registered'
          res.status(400).json({
            error: 'mode_unsupported',
            message: `this authorization server supports CIMD but not RFC 9207; install with mode "${fallbackMode}"`,
          })
          return
        }
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

      // Hard gate (issue 26-09-25): probe the MCP transport BEFORE any AS mint or K8s
      // write. A provably-dead path (404/405 `initialize`) means the operator typed a
      // URL that passes OAuth discovery but has no MCP transport — install would only
      // fail later at mcp-host. `inconclusive` never blocks (fail-open on the signal).
      const transportProbe = await probe(body.baseUrl, { logger: log })
      if (transportProbe.status === 'dead') {
        log.warn(
          {
            event: 'remote_install_transport_unreachable',
            serverName: body.serverName,
            httpStatus: transportProbe.httpStatus,
            hasSuggestion: Boolean(transportProbe.suggestedBaseUrl),
          },
          'remote install blocked: MCP transport unreachable at the typed path'
        )
        res.status(400).json({
          error: 'transport_unreachable',
          detail: {
            probedUrl: transportProbe.probedUrl,
            httpStatus: transportProbe.httpStatus,
            ...(transportProbe.suggestedBaseUrl
              ? { suggestedBaseUrl: transportProbe.suggestedBaseUrl }
              : {}),
          },
        })
        return
      }
      if (transportProbe.status === 'inconclusive') {
        log.warn(
          {
            event: 'remote_install_transport_inconclusive',
            serverName: body.serverName,
            reason: transportProbe.reason,
            httpStatus: transportProbe.httpStatus,
          },
          'remote install: MCP transport probe inconclusive, continuing'
        )
      }

      // Callback variant, fixed before any AS registration or write: the shared callback
      // when the AS returns `iss` (RFC 9207), otherwise a redirect URI of this server's
      // own, which is then the only mix-up defence.
      const callbackVariant = callbackVariantOf(discovery)

      // Defensive: mode selection never resolves CIMD without RFC 9207, and the mode
      // check above rejects a CIMD request against such an AS. Kept so a regression
      // there can never install the platform CIMD identity — which lists only the
      // shared callback — onto a server with no issuer binding.
      if (body.mode === 'cimd' && callbackVariant !== 'shared') {
        log.warn(
          { event: 'remote_oauth_issuer_binding_unsupported', serverName: body.serverName },
          'remote install rejected: cimd requires an authorization server that advertises RFC 9207'
        )
        res.status(422).json({
          error: 'issuer_binding_required',
          message:
            'the authorization server does not advertise RFC 9207 (authorization_response_iss_parameter_supported); a CIMD install requires it',
        })
        return
      }

      // Minted before anything else that needs it: a DCR client registers a redirect
      // URI carrying this nonce, and every saga compensation deletes only the row that
      // carries it, so a concurrent install/reinstall of the same name that reclaimed
      // the row is never destroyed (R3-H1).
      const installId = randomUUID()

      // The effective redirect URI. Per-server fails closed without a configured public
      // origin: falling back to the request Host (as the shared callback still does)
      // would register a URI the AS compares byte-for-byte against whatever Host the
      // admin happened to use. Shared keeps its historical handling: DCR and CIMD
      // require the origin below, pre-registered resolves it at consent.
      const callbackOrigin = normalizeConfiguredOrigin(config.oauthCallbackBaseUrl)
      let redirectUri: string | undefined
      if (callbackVariant === 'per-server') {
        try {
          if (callbackOrigin === null) throw new InvalidRemoteRedirectUriInputError('no origin')
          redirectUri =
            body.mode === 'dcr'
              ? buildRemoteRedirectUri({
                  origin: callbackOrigin,
                  variant: 'per-server',
                  mode: 'dcr',
                  serverName: body.serverName,
                  installNonce: installId,
                })
              : buildRemoteRedirectUri({
                  origin: callbackOrigin,
                  variant: 'per-server',
                  mode: 'pre-registered',
                  serverName: body.serverName,
                })
        } catch (err) {
          if (!(err instanceof InvalidRemoteRedirectUriInputError)) throw err
          log.error(
            { event: 'remote_oauth_per_server_callback_unconfigured', serverName: body.serverName },
            'per-server remote install requires a configured public callback base URL (bare origin)'
          )
          res.status(503).json({ error: 'callback_base_url_unconfigured' })
          return
        }
      } else if (callbackOrigin !== null) {
        redirectUri = buildRemoteRedirectUri({ origin: callbackOrigin, variant: 'shared' })
      }

      if (body.mode === 'pre-registered' && callbackVariant === 'per-server') {
        const conflict = await preRegisteredClientIdConflict(
          gateway,
          db,
          config.mcpServersNamespace,
          body.clientId as string
        )
        if (conflict !== null) {
          log.warn(
            { event: 'remote_install_client_id_in_use', serverName: body.serverName, conflict },
            'remote pre-registered install rejected: client_id already backs another client'
          )
          res.status(409).json({
            error: 'oauth_client_id_in_use',
            conflict,
            message:
              'this client_id already backs another client; register a separate OAuth client for this server',
          })
          return
        }
      }

      // Client mode: pre-registered/CIMD are fixed by the mode; DCR derives it from
      // the AS auth methods (public iff `none`, else confidential) — NOT the body.
      const clientMode: 'public' | 'confidential' =
        body.mode === 'pre-registered'
          ? 'confidential'
          : body.mode === 'dcr'
            ? deriveDcrClientMode(discovery)
            : 'public'

      // For DCR the AS is the final authority on the auth method and may downgrade a
      // confidential request to public. The EFFECTIVE mode — set from the registration
      // outcome below — is what we persist and write to the CR; `clientMode` above is
      // only the a-priori derivation used to shape the request. For non-DCR modes they
      // coincide.
      let effectiveClientMode: 'public' | 'confidential' = clientMode

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
          await deleteDynamicClientOwnedByInstall(db, dynamicClientKey, installId)
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
          logDcrRevokeLocalOnly(serverName, Boolean(dcrRegistrationClientUri))
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

        // The client registers exactly the redirect URI built above; a DCR client also
        // needs it on the shared callback, so fail closed if no origin is configured.
        if (redirectUri === undefined) {
          log.error(
            { event: 'remote_oauth_dcr_callback_unconfigured', serverName },
            'dcr install requires a configured public callback base URL'
          )
          res.status(503).json({ error: 'callback_base_url_unconfigured' })
          return
        }

        const dcrRequest = buildDcrRequest(discovery, {
          clientMode,
          redirectUris: [redirectUri],
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
            dcrError.minted
          ) {
            if (dcrError.registrationClientUri && dcrError.registrationAccessToken) {
              await bestEffortRfc7592Delete(
                dcrDeps,
                dcrError.registrationClientUri,
                dcrError.registrationAccessToken
              )
            } else {
              logDcrRevokeLocalOnly(serverName, Boolean(dcrError.registrationClientUri))
            }
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
            minted: _m,
            ...safeDetail
          } = dcrError as typeof dcrError & Partial<DcrMintHandle>
          res.status(400).json({ error: 'dcr_registration_failed', detail: safeDetail })
          return
        }

        const registration = dcrOutcome.response
        // Honor the AS-assigned auth method end to end: a confidential→public
        // downgrade persists (and writes the CR) as a public client.
        effectiveClientMode = dcrOutcome.effectiveClientMode
        // Capture the RFC 7592 mint handle BEFORE the local persist. If the persist
        // throws (pool exhausted, transient, or an encryption error), the client is
        // already minted at the AS, and `dcrRegistered` has NOT flipped yet — so the
        // saga rollback would skip it and orphan a (often confidential) client at the
        // AS. Compensate here explicitly (DEC-18).
        const mintedRegistrationClientUri = registration.registration_client_uri
        const mintedRegistrationAccessToken = registration.registration_access_token
        // Best-effort RFC 7592 revocation of the client WE just minted (handle in
        // memory). Used on every path that abandons this install after the mint.
        const revokeMintedClient = async (): Promise<void> => {
          if (mintedRegistrationClientUri && mintedRegistrationAccessToken) {
            await bestEffortRfc7592Delete(
              dcrDeps,
              mintedRegistrationClientUri,
              mintedRegistrationAccessToken
            )
            return
          }
          logDcrRevokeLocalOnly(serverName, Boolean(mintedRegistrationClientUri))
        }
        // Refuse a client we cannot trust to redirect only to this installation, before
        // anything is persisted. Per-server: the registered URI is the mix-up defence, so
        // the AS must report exactly the one we asked for. Any variant: a client_id equal
        // to the platform CIMD identity would be indistinguishable from that shared
        // client downstream.
        const redirectCheck = verifyDcrRedirectUris({
          variant: callbackVariant,
          requested: dcrRequest.redirect_uris,
          response: registration,
        })
        const rejection = !redirectCheck.ok
          ? redirectCheck.reason
          : isCimdClientId(registration.client_id)
            ? 'client_id_is_cimd_identity'
            : null
        if (rejection !== null) {
          await revokeMintedClient()
          log.warn(
            {
              event: 'remote_oauth_dcr_registration_rejected',
              serverName,
              variant: callbackVariant,
              reason: rejection,
            },
            'dcr registration response rejected; revoked the minted client'
          )
          res.status(400).json({ error: 'dcr_registration_failed', detail: { kind: rejection } })
          return
        }

        // A public client carries no secret; never persist one the AS may have echoed
        // alongside a `none` downgrade.
        const dcrCredentials: UpsertDynamicClientInput = {
          ...dynamicClientKey,
          issuer: discovery.issuer,
          clientId: registration.client_id,
          clientMode: effectiveClientMode,
          clientSecret:
            effectiveClientMode === 'confidential' ? registration.client_secret : undefined,
          registrationAccessToken: registration.registration_access_token,
          registrationClientUri: registration.registration_client_uri,
          clientIdIssuedAtSec: registration.client_id_issued_at,
          clientSecretExpiresAtSec: registration.client_secret_expires_at,
        }

        const persistFailed503 = async (err: unknown): Promise<void> => {
          // Local delete removes ONLY our row (idempotent; it may never have landed);
          // the pinned RFC 7592 DELETE is the courtesy revocation at the AS. Both
          // best-effort — neither must mask the persist failure we report.
          try {
            await deleteDynamicClientOwnedByInstall(db, dynamicClientKey, installId)
          } catch {
            // Best-effort local revocation; the row may not exist.
          }
          await revokeMintedClient()
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
        }

        // Claim the name with a PENDING row. ON CONFLICT DO NOTHING NEVER clobbers a
        // live server's credentials (the R3-H1 fix, replacing the old upsert) — a
        // conflict means the name is already owned, and we classify who owns it.
        let owned: boolean
        try {
          owned = (
            await insertDynamicClientPending(db, encryptionKey, { ...dcrCredentials, installId })
          ).inserted
        } catch (err) {
          await persistFailed503(err)
          return
        }

        if (!owned) {
          // Any throw inside this conflict-resolution block (a transient k8s error from
          // the live-uid re-read, a DB error on the row re-read, or a failure of the
          // reclaim tx) must still revoke the client we just minted — otherwise a
          // confidential client is orphaned at the AS. Mirrors the revoke-on-abort
          // discipline of persistFailed503 and every explicit return below.
          try {
            // Someone already holds the name. `existing` is always the LAST row read,
            // and the live-uid read happens only after it: an owner that creates its CR
            // and binds between the two is then seen as `in-use`, and one that binds
            // after the K8s read breaks the reclaim's cr_uid guard. Reading K8s first
            // would classify a just-bound live row as an orphan and revoke its client.
            let existing = await getDynamicClient(db, encryptionKey, dynamicClientKey)
            if (!existing) {
              // The row was deleted between our INSERT-conflict and this read (a teardown
              // in the gap). Retry the claim once.
              try {
                owned = (
                  await insertDynamicClientPending(db, encryptionKey, {
                    ...dcrCredentials,
                    installId,
                  })
                ).inserted
              } catch (err) {
                await persistFailed503(err)
                return
              }
              if (!owned) existing = await getDynamicClient(db, encryptionKey, dynamicClientKey)
            }

            if (!owned) {
              if (!existing) {
                // Still conflicting yet unreadable — cannot classify; fail safe as taken.
                await revokeMintedClient()
                res.status(409).json({ error: 'server_name_in_use' })
                return
              }
              // A live CR owns the name unconditionally (also covers a CR that appeared
              // since the pre-check).
              const liveCrUid = await readLiveMcpServerUid(gateway, serverName, targetNs)
              const klass = classifyExistingDynamicClient(
                {
                  installId: existing.installId ?? null,
                  crUid: existing.crUid ?? null,
                  ageMs: existing.ageMs,
                },
                { pendingTtlMs: PENDING_TTL_MS, liveCrUid }
              )
              if (klass === 'in-use' || klass === 'in-progress') {
                await revokeMintedClient()
                log.warn(
                  { event: 'remote_install_dcr_name_conflict', serverName, conflict: klass },
                  'remote dcr install rejected: name already owned'
                )
                res.status(409).json({
                  error: klass === 'in-use' ? 'server_name_in_use' : 'install_in_progress',
                })
                return
              }
              // reclaimable: take over the orphan/legacy row only if it is still exactly
              // the one we observed (id + install_id + cr_uid).
              const reclaim = await reclaimOrphanDynamicClient(
                encryptionKey,
                {
                  key: dynamicClientKey,
                  newCredentials: dcrCredentials,
                  newInstallId: installId,
                  observed: existing,
                },
                runInTransaction
              )
              if (!reclaim.reclaimed) {
                // The row changed since we read it: another saga reclaimed it, its owner
                // bound it, or it was deleted.
                await revokeMintedClient()
                res.status(409).json({ error: 'install_in_progress' })
                return
              }
              // We own the row now. Best-effort revoke the OLD client we superseded.
              if (reclaim.oldHandle) {
                await bestEffortRfc7592Delete(
                  dcrDeps,
                  reclaim.oldHandle.registrationClientUri,
                  reclaim.oldHandle.registrationAccessToken
                )
              }
            }
          } catch (err) {
            await revokeMintedClient()
            throw err
          }
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
            clientMode: effectiveClientMode,
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

      // DEC-23 backfill of `oauth.id` for the non-DCR modes (DCR already carries it
      // via `dcrClientId`). CIMD reuses the platform self-URL client_id published by
      // `cimd.ts` (never re-derived); pre-registered mirrors the operator's
      // plaintext client_id (non-secret, already stored in the Secret in clear).
      let cimdClientId: string | undefined
      let preRegisteredClientId: string | undefined
      if (body.mode === 'cimd') {
        const cimdOrigin = normalizeConfiguredOrigin(config.oauthCallbackBaseUrl)
        if (cimdOrigin === null) {
          log.error(
            { event: 'remote_oauth_cimd_callback_unconfigured', serverName },
            'cimd install requires a configured public callback base URL'
          )
          res.status(503).json({ error: 'callback_base_url_unconfigured' })
          return
        }
        cimdClientId = buildCimdDocument(cimdOrigin).client_id
      } else if (body.mode === 'pre-registered') {
        preRegisteredClientId = body.clientId as string
      }

      const oauthSpec = buildRemoteOAuthSpec(discovery, {
        clientMode: effectiveClientMode,
        grantScope,
        clientSecretName,
        ...(dcrClientId ? { dynamicClientId: dcrClientId } : {}),
        ...(cimdClientId ? { cimdClientId } : {}),
        ...(preRegisteredClientId ? { preRegisteredClientId } : {}),
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
      // Fenced rollback (P1): capture the created objects' server identities so
      // every compensating delete is bound by uid+resourceVersion. A by-name
      // delete would raze a Secret/CR that a concurrent uninstall+reinstall of
      // the same serverName recreated between the create and the rollback.
      let createdClientSecretSnapshot: SecretSnapshot | null = null
      let createdServerPreconditions: ResourcePreconditions | undefined
      let createdServerUid: string | undefined
      if (effectiveClientMode === 'confidential' && clientSecretName) {
        try {
          createdClientSecretSnapshot = await gateway.createSecret({
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
        const createdServer = await gateway.createResource(
          'mcpservers',
          { metadata: { name: serverName, labels: managedLabels }, spec: mcpServerSpec },
          targetNs
        )
        createdServerPreconditions = resourcePreconditionsFrom(createdServer)
        createdServerUid = resourceUidFrom(createdServer)
      } catch (err) {
        if (createdClientSecretSnapshot && clientSecretName) {
          try {
            await gateway.deleteSecret(clientSecretName, targetNs, {
              uid: createdClientSecretSnapshot.uid,
              resourceVersion: createdClientSecretSnapshot.resourceVersion,
            })
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

      // ── Saga step 2b (DCR only): bind the pending row to the created CR's uid ──
      // Only DCR wrote a dynamic_clients row; other modes skip this. Binding seals the
      // row to the McpServer's metadata.uid so a later teardown/reclaim can fence by the
      // exact installation. A missing uid or a lost bind means the row is no longer ours
      // — compensate the CR (fenced) and this install rather than leave a dangling row.
      if (body.mode === 'dcr' && dcrRegistered) {
        const rollbackCreatedServer = async (): Promise<void> => {
          try {
            await gateway.deleteResource(
              'mcpservers',
              serverName,
              targetNs,
              createdServerPreconditions
            )
            await waitForDeletion(
              () => gateway.getResource('mcpservers', serverName, targetNs),
              `McpServer/${serverName}`
            )
          } catch {
            // Best-effort rollback; preserve the reported failure.
          }
        }
        if (createdServerUid === undefined) {
          // Without a uid the row can never be bound (it would strand as pending and be
          // reclaimed by the TTL). Compensate now instead of leaving that residue.
          await rollbackCreatedServer()
          await rollbackDynamicClient()
          log.error(
            { event: 'remote_oauth_dcr_bind_no_uid', serverName, namespace: targetNs },
            'dcr bind aborted: created McpServer carried no metadata.uid'
          )
          res.status(503).json({ error: 'dcr_bind_failed' })
          return
        }
        let bound: boolean
        try {
          ;({ bound } = await bindDynamicClientToResource(
            db,
            dynamicClientKey,
            installId,
            createdServerUid
          ))
        } catch (err) {
          // A thrown bind (DB error) would otherwise strand the created CR, the pending
          // row and the minted AS client at once. Compensate all three, like steps 2/3.
          await rollbackCreatedServer()
          await rollbackDynamicClient()
          throw err
        }
        if (!bound) {
          // The pending row was reclaimed out from under us (TTL expired mid-saga): the
          // reclaimer now owns the name. Roll back OUR CR; `rollbackDynamicClient` deletes
          // only rows with OUR install_id (0 now — the reclaim rewrote it) and revokes our
          // minted client, so the reclaimer's row is untouched.
          await rollbackCreatedServer()
          await rollbackDynamicClient()
          log.warn(
            { event: 'remote_oauth_dcr_install_superseded', serverName, namespace: targetNs },
            'dcr install superseded: the pending row was reclaimed before bind'
          )
          res.status(503).json({ error: 'install_superseded' })
          return
        }
      }

      // ── Saga step 3: attach to the Context allowlist (rollback CR+Secret) ──
      try {
        await attachServerToContext(gateway, { name: contextRef }, serverName)
      } catch (err) {
        try {
          await gateway.deleteResource(
            'mcpservers',
            serverName,
            targetNs,
            createdServerPreconditions
          )
          await waitForDeletion(
            () => gateway.getResource('mcpservers', serverName, targetNs),
            `McpServer/${serverName}`
          )
        } catch {
          // Best-effort rollback; preserve the original attach error.
        }
        if (createdClientSecretSnapshot && clientSecretName) {
          try {
            await gateway.deleteSecret(clientSecretName, targetNs, {
              uid: createdClientSecretSnapshot.uid,
              resourceVersion: createdClientSecretSnapshot.resourceVersion,
            })
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
          clientMode: effectiveClientMode,
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
        clientMode: effectiveClientMode,
        registrationMode: discovery.registrationMode,
        callbackVariant,
        // What the AS must hold for consent to work — the operator registers it for a
        // pre-registered client. Absent only for a shared pre-registered install with no
        // configured origin, whose URI is resolved from the request at consent.
        ...(redirectUri ? { redirectUri } : {}),
        ...(clientSecretName ? { clientSecretName } : {}),
      })
    })
  )

  return router
}
