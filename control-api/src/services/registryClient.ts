/**
 * Registry Client — fetches entries from Clerum Registry service.
 * Managed deployments use CLERUM_REGISTRY_AUTH_ENABLED plus env-provided
 * client credentials. Self-hosted deployments become Bearer-authenticated when
 * their claimed registry_connection row holds machine credentials.
 */
import { config } from '../config.js'
import { rootLogger } from '../observability/logger.js'
import { resolveMachineCreds } from './registryConnectionDb.js'
import { getRegistryIdentityCacheGeneration } from './registryIdentityCache.js'

export { invalidateRegistryIdentityCaches } from './registryIdentityCache.js'

const API_BASE = `${config.registryUrl}/api/v1`

const logger = rootLogger.child({ module: 'registry-client' })

// ── Read-path timeouts ───────────────────────────────────────────────────────
// A 1–2s registry (origin/tunnel) hiccup must not surface as a user-visible
// marketplace 500. Bound every READ-path fetch with AbortSignal.timeout so a
// stalled connection fails fast (as a retriable transient) instead of hanging
// the request. Token / search / getEntry / categories get the short budget;
// bundle downloads (larger payloads) get a longer one. Write paths
// (publish / report-install / artifacts / PUT / DELETE) deliberately get NO
// timeout — they are not idempotent and must not be silently abandoned mid-write.
const READ_TIMEOUT_MS = 5_000
const BUNDLE_TIMEOUT_MS = 10_000

/**
 * True when `err` is an aborted/timed-out fetch (AbortSignal.timeout fires an
 * `AbortError`/`TimeoutError`). Treated as a retriable transient by the GET
 * retry-once path below and surfaced as a transient, not a hard failure.
 */
function isTransientFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.name === 'TimeoutError'
}

// ── OAuth2 client_credentials token cache ────────────────────────────────────
// control-api is one-per-cluster; a single cached token serves the whole
// process. Refreshed ~30s before expiry so we never hit 401 from expiry in
// the steady state. On a real 401 (e.g. registry key rotation), authedFetch
// evicts the cache and retries once.
let cached: { token: string; expiresAt: number; generation: number } | null = null

// ── Catalog cache (declared here so __resetTokenCacheForTests can clear it;
// populated/consumed by withReadThroughCache below). ─────────────────────────
const STALE_WHILE_ERROR_TTL_MS = 45_000

// Read-through TTL: within this window the default catalog search and the
// category list are served from process memory WITHOUT a live cross-cluster
// registry round trip (the dominant marketplace-load latency). Kept short so an
// admin sees publishes/edits promptly; mutating calls also bust it explicitly.
const CATALOG_CACHE_TTL_MS = 15_000

// The two hot read paths the marketplace lands on. Shared so the cache writes
// (withReadThroughCache) and the invalidation (invalidateCatalogCaches) can
// never drift on the key strings.
const CATALOG_CACHE_KEYS = {
  search: 'search:default-catalog',
  categories: 'categories',
} as const

interface CacheEntry<T> {
  value: T
  ts: number
}

const swrCache = new Map<string, CacheEntry<unknown>>()

export function __resetTokenCacheForTests(): void {
  cached = null
  swrCache.clear()
}

export async function mintToken(envOverride?: NodeJS.ProcessEnv): Promise<string> {
  const env = envOverride ?? process.env
  const now = Date.now()
  const cacheGeneration = getRegistryIdentityCacheGeneration()
  if (cached && cached.generation === cacheGeneration && now < cached.expiresAt - 30_000)
    return cached.token

  // An explicit override is a test-only path and remains fully env-driven. In
  // production, credentials MUST come from the mode-aware resolver: managed
  // reads config/env, self-hosted reads only the claimed DB row. Reading env
  // first here would create a split brain where isRegistryAuthActive authorizes
  // the DB identity while the registry client authenticates as a stale managed
  // identity left in the pod environment.
  let id = envOverride ? env.CLERUM_REGISTRY_CLIENT_ID || '' : ''
  let secret = envOverride ? env.CLERUM_REGISTRY_CLIENT_SECRET || '' : ''
  // Single source of truth for the registry base URL — env override wins for
  // tests/minikube, else config.registryUrl (mandatory + allowlisted when auth
  // is on). resolveMachineCreds no longer carries a `url`.
  const url = env.CLERUM_REGISTRY_URL || (envOverride ? '' : config.registryUrl)

  let authEnabled = false
  if (!envOverride) {
    const resolved = await resolveMachineCreds()
    if (resolved) {
      id = resolved.clientId
      secret = resolved.clientSecret
    }
    // Derive the decision from the SAME resolution used for the credentials.
    // Managed deliberately keeps its env flag; self-hosted is active exactly
    // when the DB row yielded a complete credential pair.
    authEnabled =
      config.registryConnectionMode === 'managed' ? config.registryAuthEnabled : resolved !== null
  }

  if (!id || !secret) {
    if (!authEnabled) return '' // minikube / auth-off
    throw new Error(
      'registry machine credentials unavailable (env in managed mode, DB row in self-hosted)'
    )
  }

  // Minting a token is a read-side prerequisite for every catalog read, so it
  // carries the read timeout. (It is a POST, but an idempotent credential
  // exchange — not a state-mutating write — so bounding it is safe.)
  const res = await fetch(`${url}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text()
    // Distinguish a rejected credential (rotate the secret) from an origin /
    // tunnel outage (page on-call about reachability, do NOT rotate). A 5xx at
    // the token endpoint is the registry origin or its tunnel being down, not a
    // bad client secret — the previous identical label sent on-call to rotate
    // secrets during an outage.
    if (res.status >= 500) {
      throw new Error(`registry token endpoint unavailable (origin/tunnel): ${res.status} ${body}`)
    }
    throw new Error(`registry credential rejected: ${res.status} ${body}`)
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  const next = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
    generation: cacheGeneration,
  }
  if (getRegistryIdentityCacheGeneration() === cacheGeneration) cached = next
  return next.token
}

interface RegistrySearchParams {
  q?: string
  entryType?: string
  category?: string
  serverMode?: string
  transport?: string
  trustLevel?: string
  sort?: string
  limit?: number
  offset?: number
}

export interface RegistryEntry {
  id: string
  name: string
  version: string
  entry_type: string
  description: string
  author: string
  origin: string
  category: string
  tags: string[]
  trust_level: string
  quality_tier: string
  status: string
  server_mode: string | null
  transport: string | null
  recipe_type: string | null
  mcp_server_meta: Record<string, unknown> | null
  recipe_meta: Record<string, unknown> | null
  artifact_refs: Record<string, unknown> | null
  downloads: number
  installs: number
  created_at: string
}

interface PaginatedResponse<T> {
  data: T[]
  meta: { total: number; limit: number; offset: number }
}

/** Retriable upstream statuses for an idempotent GET (gateway/tunnel hiccups). */
const RETRIABLE_GET_STATUSES = new Set([502, 503, 504])

function jitterSleep(baseMs: number): Promise<void> {
  // ~baseMs ± up to baseMs jitter so concurrent callers don't retry in lockstep.
  const ms = baseMs + Math.floor(Math.random() * baseMs)
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function authedFetch(
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {}
): Promise<Response> {
  // READ paths get a timeout so a stalled origin/tunnel fails fast as a
  // transient. Writes (method !== GET) pass no signal and are never retried.
  const method = (init.method ?? 'GET').toUpperCase()
  const isGet = method === 'GET'
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS

  const send = async (): Promise<Response> => {
    const token = await mintToken()
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    }
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      ...(isGet ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
  }

  // For idempotent GETs we add a single bounded retry on a transient gateway
  // status (502/503/504) or a network/Abort rejection, so a 1–2s registry blip
  // is absorbed here instead of becoming a marketplace 500. Non-GET requests
  // are never retried (could double-apply a write).
  const attempt = async (allowTransientRetry: boolean): Promise<Response> => {
    let res: Response
    try {
      res = await send()
    } catch (err) {
      if (isGet && allowTransientRetry && isTransientFetchError(err)) {
        await jitterSleep(250)
        return attempt(false)
      }
      throw err
    }
    if (res.status === 401) {
      // Existing behavior: a 401 means the cached token is stale (e.g. registry
      // key rotation) — evict and retry once with a fresh mint. Orthogonal to
      // the transient-status retry below.
      cached = null
      res = await send()
    }
    if (isGet && allowTransientRetry && RETRIABLE_GET_STATUSES.has(res.status)) {
      await jitterSleep(250)
      return attempt(false)
    }
    return res
  }

  return attempt(isGet)
}

/**
 * Registry origin/gateway is unreachable (network refusal, timeout, or an
 * upstream HTTP 5xx). A clean, user-safe error the global handler forwards as a
 * 503 so the marketplace shows a clear message instead of a raw 500.
 */
export class RegistryUnavailableError extends Error {
  readonly status = 503
  readonly code = 'registry_unavailable'
  constructor(
    message = 'The registry is currently unavailable. Check the connection and try again.'
  ) {
    super(message)
    this.name = 'RegistryUnavailableError'
  }
}

async function registryFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await authedFetch(path, init)
  } catch (err) {
    // Remap ONLY genuine network/timeout signals to a clean "unavailable":
    // undici's "fetch failed" (ECONNREFUSED / DNS) surfaces as a TypeError, and
    // an Abort/Timeout that survives the single GET retry surfaces via
    // isTransientFetchError. Everything else is rethrown unchanged — critically,
    // mintToken's status-less "registry credential rejected" (a wrong-secret
    // misconfig) must keep its own signal rather than be mislabeled "unavailable".
    if (err instanceof TypeError || isTransientFetchError(err)) {
      throw new RegistryUnavailableError()
    }
    throw err
  }
  if (!res.ok) {
    const body = await res.text()
    // A persistent 401 (authedFetch already evict-retried once) is a registry
    // machine-token / integration fault — NOT the admin's control-ui session.
    // Remap to 502 (so control-ui's global 401 handler never force-logs-out the
    // admin) and carry a machine code + a user-safe message.
    if (res.status === 401) {
      throw Object.assign(new Error('The registry could not be reached.'), {
        status: 502,
        code: 'registry_integration_error',
      })
    }
    // Registry origin/gateway down — an HTTP 5xx (500/502/503/504 and Cloudflare
    // 520–524) is the dominant real-world "registry unavailable" signal (edge up,
    // origin down). Map to a clean 503. Retriable GET statuses already retried
    // once via RETRIABLE_GET_STATUSES in authedFetch before landing here.
    if (res.status >= 500) {
      throw new RegistryUnavailableError()
    }
    // Attach the upstream status so the global error handler (app.ts) forwards
    // 4xx verbatim to the API client (a registry 404 stays a 404 — the
    // e2e-registry-publish-update-remove failure class).
    throw Object.assign(new Error(`Registry ${res.status}: ${body}`), {
      status: res.status,
    })
  }
  return res.json() as Promise<T>
}

function registrySend<T>(path: string, method: string, body?: unknown): Promise<T> {
  return registryFetch<T>(path, {
    method,
    ...(body !== undefined
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  })
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams()
  for (const [key, val] of Object.entries(params)) {
    if (val != null && val !== '') qs.set(key, String(val))
  }
  const query = qs.toString()
  return query ? `?${query}` : ''
}

// ── Catalog cache ────────────────────────────────────────────────────────────
// A short-TTL read-through + last-good cache for the two hot read paths the
// marketplace lands on: the default catalog search (limit:200, no other filters)
// and the category list.
//   • Read-through (CATALOG_CACHE_TTL_MS): a fresh hit is served from memory and
//     SKIPS the live registry round trip — this removes the dominant marketplace
//     latency (a cross-cluster Cloudflare/tunnel hop) from steady-state loads.
//   • Stale-while-error (STALE_WHILE_ERROR_TTL_MS): on a fresh registry error we
//     serve the last-good value (even if stale) instead of bubbling a 500; we
//     only error when there is no cached value at all.
// The Map + TTL constants are declared near the token cache above (so the test
// reset helper can clear them). Intentionally a tiny module-level Map — no extra
// dependency, process-local, evicted on restart.

/**
 * Wrap a fetcher with read-through + stale-while-error semantics:
 * - Fresh hit (age ≤ CATALOG_CACHE_TTL_MS): return the cached value, no fetch.
 * - Miss/stale: fetch; on success cache (fresh timestamp) and return it.
 * - On error: if any cached value exists, return it (stale-while-error); the
 *   STALE_WHILE_ERROR_TTL only governs whether a fallback hit is logged as fresh
 *   vs stale, never whether it is usable. If nothing is cached, rethrow so the
 *   caller 500s.
 */
async function withReadThroughCache<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = swrCache.get(key) as CacheEntry<T> | undefined
  if (hit && Date.now() - hit.ts <= CATALOG_CACHE_TTL_MS) {
    return hit.value
  }
  try {
    const value = await fetcher()
    swrCache.set(key, { value, ts: Date.now() })
    return value
  } catch (err) {
    const cachedEntry = swrCache.get(key) as CacheEntry<T> | undefined
    if (cachedEntry) {
      const ageMs = Date.now() - cachedEntry.ts
      logger.warn(
        {
          event: 'registry_stale_while_error',
          key,
          ageMs,
          fresh: ageMs <= STALE_WHILE_ERROR_TTL_MS,
          err: err instanceof Error ? err.message : String(err),
        },
        'registry read failed; serving last-good cached value'
      )
      return cachedEntry.value
    }
    throw err
  }
}

/**
 * Bust the catalog read-through cache so the next marketplace load reflects a
 * just-applied mutation (publish / delete / metadata edit) immediately rather
 * than waiting out the TTL. Process-local: with multiple control-api replicas,
 * peers still converge within CATALOG_CACHE_TTL_MS.
 */
function invalidateCatalogCaches(): void {
  for (const key of Object.values(CATALOG_CACHE_KEYS)) swrCache.delete(key)
}

/** True for the default marketplace catalog landing query (limit:200, no filters). */
function isDefaultCatalogSearch(params: RegistrySearchParams): boolean {
  return (
    params.limit === 200 &&
    !params.q &&
    !params.entryType &&
    !params.category &&
    !params.serverMode &&
    !params.transport &&
    !params.trustLevel &&
    !params.sort &&
    !params.offset
  )
}

export async function searchEntries(
  params: RegistrySearchParams
): Promise<PaginatedResponse<RegistryEntry>> {
  const fetcher = (): Promise<PaginatedResponse<RegistryEntry>> =>
    registryFetch(`/entries${buildQuery(params as Record<string, string | number | undefined>)}`)

  // Only the default catalog landing search is cached. Filtered / paginated
  // searches stay strict so users never see a stale result set for a query they
  // typed; a blip on those still surfaces as an error, which is acceptable
  // because the landing page (the 500-prone hot path) is protected.
  if (isDefaultCatalogSearch(params)) {
    return withReadThroughCache(CATALOG_CACHE_KEYS.search, fetcher)
  }
  return fetcher()
}

export async function getEntry(name: string): Promise<RegistryEntry> {
  return registryFetch(`/entries/${encodeURIComponent(name)}`)
}

export async function getEntryVersion(name: string, version: string): Promise<RegistryEntry> {
  return registryFetch(
    `/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
  )
}

export async function getCredentialSchema(
  name: string,
  version: string
): Promise<Record<string, unknown>> {
  return registryFetch(
    `/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/credential-schema`
  )
}

export async function getCategories(): Promise<{ data: string[] }> {
  return withReadThroughCache(CATALOG_CACHE_KEYS.categories, () =>
    registryFetch<{ data: string[] }>('/categories')
  )
}

export async function reportInstall(
  name: string,
  correlationId: string,
  version: string,
  clusterFingerprint?: string
): Promise<{ acknowledged: boolean; stored: boolean }> {
  return registrySend(`/entries/${encodeURIComponent(name)}/report-install`, 'POST', {
    correlationId,
    version,
    clusterFingerprint,
    success: true,
  })
}

export async function downloadBundle(name: string, version: string): Promise<Buffer> {
  // Bundles are larger payloads, so they get the longer read budget.
  const res = await authedFetch(
    `/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/bundle`,
    {},
    { timeoutMs: BUNDLE_TIMEOUT_MS }
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Registry ${res.status}: ${body}`)
  }
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export async function getDigest(name: string, version: string): Promise<{ digest: string | null }> {
  return registryFetch(
    `/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/digest`
  )
}

export async function uploadArtifacts(
  name: string,
  version: string,
  artifacts: { soulMd?: string; bundle?: string }
): Promise<{ uploaded: boolean; artifact_refs: Record<string, string> }> {
  return registrySend(
    `/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/artifacts`,
    'POST',
    artifacts
  )
}

export async function updateVersionMetadata(
  name: string,
  version: string,
  fields: {
    description?: string
    tags?: string[]
    visibility?: string
    mcpServer?: {
      egressSummary?: { domains?: string[]; ports?: number[]; wideCidr?: boolean } | null
    }
  }
): Promise<RegistryEntry> {
  const result = await registrySend<RegistryEntry>(
    `/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    'PUT',
    fields
  )
  invalidateCatalogCaches()
  return result
}

export async function deleteVersion(name: string, version: string): Promise<{ deleted: boolean }> {
  const result = await registrySend<{ deleted: boolean }>(
    `/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    'DELETE'
  )
  invalidateCatalogCaches()
  return result
}

export async function publishEntry(body: Record<string, unknown>): Promise<unknown> {
  const result = await registrySend('/entries', 'POST', body)
  invalidateCatalogCaches()
  return result
}

// ── Org self-service (grants + owned entries) ─────────────────────────────────
// These proxy the registry's per-org owner surface (delivered by the machine-
// grant + owner-entries registry PRs). Unlike registryFetch, this helper:
//   • is 204/empty-aware (revokes return 204 with no body — res.json() would 500),
//   • throws a RegistryProxyError carrying BOTH the upstream status AND the parsed
//     { error: <code> } body, so the admin route can forward it verbatim to the UI
//     (status alone can't disambiguate self_grant / grantee_reserved / plugin_public,
//     all 400). Mirrors routes/admin/workflows/grants.routes.ts's typed passthrough.
// Built on authedFetch (machine Bearer + 401-evict-retry), same as registryFetch.

/** Upstream registry error carrying the status + parsed body for verbatim proxy forwarding. */
export class RegistryProxyError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`Registry ${status}`)
    this.name = 'RegistryProxyError'
  }
}

async function orgRegistryFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, init)
  if (!res.ok) {
    // A persistent 401 (authedFetch already evict-retried once) is a machine-token /
    // integration fault, NOT the admin's session — remap to 502 at the transport so
    // every caller is protected and control-ui never force-logs-out on it. A 403
    // (e.g. tenant client lacks registry:grant) is a real authz signal, forwarded verbatim.
    if (res.status === 401) {
      throw new RegistryProxyError(502, { error: 'registry_integration_error' })
    }
    const text = await res.text()
    let body: unknown
    try {
      // Preserve the registry's typed { error:<code> } body verbatim; a non-JSON error
      // body (HTML gateway page, plaintext) collapses to a synthetic code rather than
      // reflecting arbitrary upstream markup as the machine-readable error.
      body = text ? JSON.parse(text) : { error: `registry_${res.status}` }
    } catch {
      body = { error: `registry_${res.status}` }
    }
    throw new RegistryProxyError(res.status, body)
  }
  // Empty body (204 or any empty 2xx) → undefined. A non-empty non-JSON 2xx body is an
  // integration fault, surfaced as a typed 502 rather than a raw SyntaxError → 500.
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new RegistryProxyError(502, { error: 'registry_integration_error' })
  }
}

export async function createOrgGrant(
  orgName: string,
  input: { pluginName: string; granteeOrg: string; actingUserId: string }
): Promise<unknown> {
  return orgRegistryFetch(`/org/${encodeURIComponent(orgName)}/grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function listOrgGrants(orgName: string): Promise<unknown> {
  return orgRegistryFetch(`/org/${encodeURIComponent(orgName)}/grants`)
}

export async function revokeOrgGrant(
  orgName: string,
  grantId: string,
  actingUserId: string
): Promise<void> {
  await orgRegistryFetch(
    `/org/${encodeURIComponent(orgName)}/grants/${encodeURIComponent(grantId)}${buildQuery({
      actingUserId,
    })}`,
    { method: 'DELETE' }
  )
}

export async function listGrantedToMe(orgName: string): Promise<unknown> {
  return orgRegistryFetch(`/org/${encodeURIComponent(orgName)}/granted-to-me`)
}

export async function listOrgEntries(
  orgName: string,
  params?: { limit?: number; offset?: number }
): Promise<unknown> {
  return orgRegistryFetch(
    `/org/${encodeURIComponent(orgName)}/entries${buildQuery({
      limit: params?.limit,
      offset: params?.offset,
    })}`
  )
}

// ── Publish scope (who is this control-api, and where do its publishes land) ──
// Resolved from the registry's /whoami (the registry maps our machine OAuth
// client to its bound org / curator status). The module-level cache is scoped to
// the current registry identity generation and is invalidated when the local
// registry connection row or credentials change.

export interface PublishScope {
  curator: boolean
  orgName: string | null
  scope: string | null
}

let _scopeCache: { generation: number; scope: PublishScope } | null = null

export async function whoami(): Promise<{
  clientId?: string
  orgName: string | null
  curator: boolean
}> {
  // registryFetch already prefixes /api/v1 and attaches the machine OAuth Bearer.
  return registryFetch('/whoami')
}

export async function resolvePublishScope(opts?: { force?: boolean }): Promise<PublishScope> {
  const cacheGeneration = getRegistryIdentityCacheGeneration()
  if (_scopeCache && _scopeCache.generation === cacheGeneration && !opts?.force)
    return _scopeCache.scope
  const w = await whoami()
  const scope = {
    curator: w.curator,
    orgName: w.orgName,
    // Curator publishes stay unscoped (the registry maps them to @clerum).
    // Org-bound clients MUST scope to their own org or the registry 400s
    // (scope_required), so we derive the @<org> prefix here.
    scope: w.curator || !w.orgName ? null : `@${w.orgName}`,
  }
  if (getRegistryIdentityCacheGeneration() === cacheGeneration) {
    _scopeCache = { generation: cacheGeneration, scope }
  }
  return scope
}

export function __resetScopeCacheForTests(): void {
  _scopeCache = null
}

/**
 * Prefix a publish name with the caller's org scope when org-bound.
 *
 * Org-bound clients (curator:false) must publish into their own org with a
 * scoped `@<org>/<name>` or the registry 400s (scope_required). Curator clients
 * (scope:null) publish unscoped and the registry maps them to the @clerum bridge
 * — so we leave their name untouched. An already-@-scoped name is respected
 * as-is, and a non-string / undefined name is returned unchanged.
 */
export function applyPublishScope(
  name: string | undefined,
  scope: PublishScope
): string | undefined {
  if (scope.scope && typeof name === 'string' && !name.startsWith('@')) {
    return `${scope.scope}/${name}`
  }
  return name
}
