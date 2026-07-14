/**
 * npm-style client for the centralized Clerum registry-api.
 *
 * Distinct from registryClient.ts (the OCI-style multi-registry pull client
 * used by recipe reconciliation). This module is the WRC side of the registry
 * decoupling — machine access to /@scope%2Fname (packument), /@scope%2Fname/:version
 * (version manifest), /-/v1/search, and /@scope%2Fname/report-install.
 *
 * OAuth2 client_credentials machine auth (scopes registry:read + registry:report).
 * No X-On-Behalf-Of: WRC operates as the cluster, not on behalf of any user.
 *
 * Used by WRC reconciler to fetch entry metadata + report install events for
 * download counts. Best-effort: report failures never throw.
 */
import { randomUUID } from 'node:crypto'

// ── Read-path timeout ────────────────────────────────────────────────────────
// A brief registry (origin/tunnel) hiccup must not hang the reconciler. Bound
// every READ-path fetch (token mint, getEntry, getEntryVersion, search) with
// AbortSignal.timeout so a stalled connection fails fast as a retriable
// transient. The report-install POST (a write) deliberately gets NO timeout.
const READ_TIMEOUT_MS = 5_000

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClerumRegistryEnv {
  url: string
  authEnabled: boolean
  clientId?: string
  clientSecret?: string
}

/** Packument: top-level package document returned by GET /:name. */
export interface EntryPackument {
  name: string
  'dist-tags': Record<string, string>
  versions: Record<string, EntryVersionManifest>
  description?: string
  // Free-form additional fields are tolerated.
  [key: string]: unknown
}

/** Version manifest: returned by GET /:name/:version. */
export interface EntryVersionManifest {
  name: string
  version: string
  image?: string
  description?: string
  // Free-form additional fields are tolerated.
  [key: string]: unknown
}

/** Single result item from /-/v1/search. */
export interface SearchResult {
  name: string
  version?: string
  description?: string
  // Free-form additional fields are tolerated.
  [key: string]: unknown
}

export interface SearchResponse {
  results: SearchResult[]
  total: number
}

export interface SearchParams {
  query?: string
  limit?: number
  offset?: number
}

// ── OAuth2 client_credentials token cache ─────────────────────────────────────
// WRC's reconciler is one-per-cluster so a single module-level cached token
// serves the whole process. Refreshed ~30s before expiry so we never hit 401
// from expiry in the steady state.
let cached: { token: string; expiresAt: number; scope: string } | null = null

/**
 * @visibleForTesting — test-only helper. Do NOT call from production code.
 * Resets the module-level OAuth2 token cache so each test starts clean.
 */
export function __resetTokenCacheForTests(): void {
  cached = null
}

function defaultEnv(): ClerumRegistryEnv {
  return {
    url: process.env.CLERUM_REGISTRY_URL ?? '',
    authEnabled: process.env.CLERUM_REGISTRY_AUTH_ENABLED === 'true',
    clientId: process.env.CLERUM_REGISTRY_CLIENT_ID,
    clientSecret: process.env.CLERUM_REGISTRY_CLIENT_SECRET,
  }
}

function resolveEnv(env?: ClerumRegistryEnv): ClerumRegistryEnv {
  return env ?? defaultEnv()
}

/**
 * Mint (or return cached) OAuth2 access token via client_credentials.
 *
 * - When `authEnabled=false` and no creds, returns "" (auth-off / minikube path).
 * - When `authEnabled=true` but creds missing, throws.
 * - Refreshes ~30s before expiry.
 */
export async function mintToken(envOverride?: ClerumRegistryEnv): Promise<string> {
  const env = resolveEnv(envOverride)
  const now = Date.now()
  if (cached && now < cached.expiresAt - 30_000) return cached.token

  const id = env.clientId
  const secret = env.clientSecret

  if (!id || !secret) {
    if (!env.authEnabled) return ''
    throw new Error(
      'workflow-recipes: CLERUM_REGISTRY_CLIENT_ID and CLERUM_REGISTRY_CLIENT_SECRET are required when auth is enabled'
    )
  }

  // Token mint is a read-side prerequisite for every catalog read, so it
  // carries the read timeout. (POST, but an idempotent credential exchange.)
  const res = await fetch(`${env.url}/oauth/token`, {
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
    // bad client secret.
    if (res.status >= 500) {
      throw new Error(
        `workflow-recipes: registry token endpoint unavailable (origin/tunnel): ${res.status} ${body}`
      )
    }
    throw new Error(`workflow-recipes: registry credential rejected: ${res.status} ${body}`)
  }
  const json = (await res.json()) as {
    access_token: string
    expires_in: number
    scope: string
  }
  // Clamp expires_in to [60s, 3600s]. Without an upper bound, a malicious or
  // misconfigured registry could pin a stale token in cache effectively forever
  // (or until process restart). 1 hour is well above the producer's 10-minute
  // default and gives slack for misconfig without giving up the safety net.
  const MAX_TTL = 3600
  const MIN_TTL = 60
  const clampedTtl = Math.max(MIN_TTL, Math.min(MAX_TTL, json.expires_in))
  cached = {
    token: json.access_token,
    expiresAt: now + clampedTtl * 1000,
    scope: json.scope,
  }
  return cached.token
}

/**
 * authedFetch attaches the Bearer token (when authEnabled and a token is
 * available) and handles a single 401 retry by evicting the cache.
 *
 * `path` is relative to the registry base URL, e.g. '/api/v1/entries?limit=10'.
 */
export async function authedFetch(
  path: string,
  init: RequestInit = {},
  envOverride?: ClerumRegistryEnv
): Promise<Response> {
  const env = resolveEnv(envOverride)
  // READ paths (GET) get a timeout so a stalled origin/tunnel fails fast as a
  // transient. The report-install write (POST) passes no signal — it must not
  // be silently abandoned mid-write.
  const isGet = (init.method ?? 'GET').toUpperCase() === 'GET'
  const send = async (): Promise<Response> => {
    const token = await mintToken(env)
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    }
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(`${env.url}${path}`, {
      ...init,
      headers,
      ...(isGet ? { signal: AbortSignal.timeout(READ_TIMEOUT_MS) } : {}),
    })
  }
  let res = await send()
  if (res.status === 401 && env.authEnabled) {
    cached = null
    res = await send()
  }
  return res
}

// ── npm-style API ────────────────────────────────────────────────────────────

/**
 * Encode an entry name for use in a URL path.
 *
 * Scoped names like `@acme/my-mcp` become `%40acme%2Fmy-mcp` (npm convention),
 * so the slash is part of the single path segment rather than a subpath.
 */
function encodeEntryName(name: string): string {
  return encodeURIComponent(name)
}

/**
 * GET /:name — fetch the full packument for an entry.
 *
 * Returns `null` on 404 (entry not found).
 * Throws on other non-2xx responses.
 */
export async function getEntry(
  name: string,
  envOverride?: ClerumRegistryEnv
): Promise<EntryPackument | null> {
  const res = await authedFetch(`/${encodeEntryName(name)}`, { method: 'GET' }, envOverride)
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`workflow-recipes: getEntry(${name}) failed: ${res.status} ${body}`)
  }
  return (await res.json()) as EntryPackument
}

/**
 * GET /:name/:version — fetch a single version manifest.
 *
 * Returns `null` on 404 (entry or version not found).
 * Throws on other non-2xx responses.
 */
export async function getEntryVersion(
  name: string,
  version: string,
  envOverride?: ClerumRegistryEnv
): Promise<EntryVersionManifest | null> {
  const res = await authedFetch(
    `/${encodeEntryName(name)}/${encodeURIComponent(version)}`,
    { method: 'GET' },
    envOverride
  )
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `workflow-recipes: getEntryVersion(${name}@${version}) failed: ${res.status} ${body}`
    )
  }
  return (await res.json()) as EntryVersionManifest
}

/**
 * GET /-/v1/search — npm-style search across the registry.
 */
export async function searchEntries(
  params: SearchParams,
  envOverride?: ClerumRegistryEnv
): Promise<SearchResponse> {
  const query = new URLSearchParams()
  if (params.query !== undefined) query.set('q', params.query)
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.offset !== undefined) query.set('offset', String(params.offset))

  const qs = query.toString()
  const path = qs ? `/-/v1/search?${qs}` : `/-/v1/search`

  const res = await authedFetch(path, { method: 'GET' }, envOverride)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`workflow-recipes: searchEntries failed: ${res.status} ${body}`)
  }
  const json = (await res.json()) as Partial<SearchResponse>
  return {
    results: json.results ?? [],
    total: json.total ?? json.results?.length ?? 0,
  }
}

/**
 * POST /:name/report-install — best-effort install telemetry.
 *
 * The registry requires `correlationId` + `version` (the correlationId scopes
 * idempotency for the install row). Callers may supply their own correlation id
 * to keep reporter-side retries idempotent; otherwise we mint one per call.
 *
 * Never throws: telemetry must not break reconciliation. Network failures and
 * non-2xx responses are swallowed so callers can fire-and-forget.
 */
export interface ReportInstallOptions {
  correlationId?: string
  clusterFingerprint?: string
  success?: boolean
}

export async function reportInstall(
  name: string,
  version: string,
  envOverride?: ClerumRegistryEnv,
  options: ReportInstallOptions = {}
): Promise<void> {
  try {
    await authedFetch(
      `/${encodeEntryName(name)}/report-install`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correlationId: options.correlationId ?? randomUUID(),
          version,
          clusterFingerprint: options.clusterFingerprint,
          success: options.success,
        }),
      },
      envOverride
    )
  } catch (err) {
    // Best-effort: never throw so install reporting cannot break callers.
    // Log loud enough for ops to notice persistent failures (registry down,
    // misconfigured creds, NetworkPolicy denial).
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[WR-Registry] reportInstall(${name}@${version}) failed (swallowed): ${msg}`)
  }
}
