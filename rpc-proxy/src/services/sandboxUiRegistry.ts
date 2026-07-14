import { config } from '../config.js'
import { emitRegistryLookup } from '../observability/sandboxUiAudit.js'

/**
 * Sandbox-UI registry client. Calls control-api's
 * `GET /internal/sandbox-ui/registry/:ns/:name` to resolve a `(recipeNs,
 * recipeName)` tuple to the upstream Service it should reverse-proxy to.
 *
 * "No SSRF" guarantee: rpc-proxy MUST NOT proxy to a client-supplied URL.
 * The desktop client supplies only `(recipeNs, recipeName)`; this client
 * is the only place where rpc-proxy resolves that to a Service. Even
 * though control-api always returns `namespace: "sandbox-ui"`, rpc-proxy
 * still double-checks here (defence-in-depth against a registry bug).
 *
 * 5s TTL cache. Both positive AND negative results are cached so a
 * recipe-not-found / not-ready answer doesn't hammer control-api at the
 * user's click rate. The TTL is short enough that a recipe deploying →
 * active transition is reflected on the next click.
 */

export type RegistryService = {
  name: string
  namespace: string
  port: number
}

export type RegistryEntry = {
  appRef: string
  service: RegistryService
  ready: boolean
  title?: string
  icon?: string
  defaultPath: string
}

type RegistryLookupValue =
  | { kind: 'ok'; entry: RegistryEntry }
  | { kind: 'not_found' }
  | { kind: 'not_ready'; reason: string }
  | { kind: 'forbidden' }
  | { kind: 'misconfigured'; reason: 'port_not_allowed'; port: number }
  | { kind: 'error'; status: number }

export type RegistryLookupResult = RegistryLookupValue & { cacheHit: boolean }

type CacheEntry = {
  // What the next caller would see if served from cache. `cacheHit` is
  // re-stamped per access so callers always observe the current freshness.
  result: RegistryLookupValue
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function cacheKey(ns: string, name: string, forUser?: string, forTeam?: string): string {
  const suffixes: string[] = []
  if (forUser) suffixes.push(`u:${forUser}`)
  if (forTeam) suffixes.push(`t:${forTeam}`)
  return suffixes.length > 0 ? `${ns}/${name}|${suffixes.join('|')}` : `${ns}/${name}`
}

function now(): number {
  return Date.now()
}

/** Test helper — clears the in-memory cache between unit tests. */
export function _clearSandboxUiRegistryCache(): void {
  cache.clear()
}

function controlApiBaseUrl(): string {
  return config.controlApiBaseUrl.replace(/\/+$/, '')
}

function controlApiHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${config.controlApiServiceToken}`,
    'x-service-token': config.controlApiServiceName,
    accept: 'application/json',
  }
}

/**
 * Validate a 200 response body against the registry contract. Returns the
 * parsed entry or null if the shape is wrong (treated as a 500-class error
 * by the caller — control-api should not have produced this).
 */
function parseEntry(raw: unknown, expectedNamespace: string): RegistryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const appRef = typeof obj.appRef === 'string' ? obj.appRef : ''
  const ready = obj.ready === true
  const svcRaw = obj.service
  if (!svcRaw || typeof svcRaw !== 'object') return null
  const svc = svcRaw as Record<string, unknown>
  const name = typeof svc.name === 'string' ? svc.name.trim() : ''
  const namespace = typeof svc.namespace === 'string' ? svc.namespace.trim() : ''
  const port = typeof svc.port === 'number' ? svc.port : NaN
  if (!appRef || !name || !namespace || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  // Defence-in-depth: even if control-api had a bug and returned a
  // namespace other than the configured sandbox-ui ns, refuse to proxy.
  // (The port allow-list check is policy, not shape — it lives in
  // fetchUncached so the surfaced error code can be `port_not_allowed`
  // instead of the generic `registry_lookup_failed`.)
  if (namespace !== expectedNamespace) {
    return null
  }
  return {
    appRef,
    service: { name, namespace, port },
    ready,
    title: typeof obj.title === 'string' ? obj.title : undefined,
    icon: typeof obj.icon === 'string' ? obj.icon : undefined,
    defaultPath: typeof obj.defaultPath === 'string' && obj.defaultPath ? obj.defaultPath : '/',
  }
}

async function fetchUncached(
  ns: string,
  name: string,
  forUser: string | undefined,
  forTeam: string | undefined
): Promise<RegistryLookupValue> {
  const base = `${controlApiBaseUrl()}/internal/sandbox-ui/registry/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`
  const params = new URLSearchParams()
  if (forUser) params.set('forUser', forUser)
  if (forTeam) params.set('forTeam', forTeam)
  const query = params.toString()
  const url = query ? `${base}?${query}` : base

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: controlApiHeaders(),
    })
  } catch {
    return { kind: 'error', status: 502 }
  }

  if (response.status === 404) {
    return { kind: 'not_found' }
  }
  if (response.status === 409) {
    let reason = 'recipe not ready'
    try {
      const body = (await response.json()) as { reason?: unknown }
      if (typeof body?.reason === 'string' && body.reason.length > 0) reason = body.reason
    } catch {
      // Body parse failure on a 409 is non-fatal — keep the generic reason.
    }
    return { kind: 'not_ready', reason }
  }
  // 403 is the user-ACL denial signal (only fires when forUser is set). When
  // the request had NO forUser query string a 403 from control-api means the
  // service-token auth failed — coerce to 500 like 401, since that's a
  // configuration issue, not a user-facing one.
  if (response.status === 403) {
    return forUser ? { kind: 'forbidden' } : { kind: 'error', status: 500 }
  }
  if (response.status === 401) {
    // Auth misconfig between rpc-proxy and control-api — bubble up as a
    // 500-class error so the caller serves a clean 500, not a 401 the user
    // would interpret as their own credentials being wrong.
    return { kind: 'error', status: 500 }
  }
  if (!response.ok) {
    return { kind: 'error', status: response.status }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'error', status: 500 }
  }
  const entry = parseEntry(body, config.sandboxUiNamespace)
  if (!entry) {
    return { kind: 'error', status: 500 }
  }
  // Defence-in-depth port allow-list. Recipe authors control `ui.port` via
  // the CRD (1-65535); the platform admin pins which of those values
  // rpc-proxy is allowed to forward to via the
  // RPC_PROXY_SANDBOX_UI_ALLOWED_PORTS env var. A non-allow-listed port
  // surfaces with its own discriminant so callers can return the distinct
  // `port_not_allowed` error code (much easier to debug than a generic
  // `registry_lookup_failed`).
  if (!config.sandboxUiAllowedPorts.has(entry.service.port)) {
    return { kind: 'misconfigured', reason: 'port_not_allowed', port: entry.service.port }
  }
  return { kind: 'ok', entry }
}

/**
 * Look up a recipe in the sandbox-ui registry, optionally bound to a specific
 * user.
 *
 * - `forUser` undefined: registry-only resolution (used by /apps walker).
 * - `forUser` set: control-api additionally checks the user has a direct
 *   trigger grant or an active `forTeam` trigger grant; a non-allowlisted
 *   user produces `kind: "forbidden"`.
 *
 * The 5s TTL cache is keyed by `(ns, name, forUser, forTeam)` so the
 * user-bound, team-bound, and user-agnostic answers do not poison each other.
 */
export async function lookupSandboxUiRegistry(
  ns: string,
  name: string,
  forUser?: string,
  forTeam?: string
): Promise<RegistryLookupResult> {
  const startedAt = now()
  const key = cacheKey(ns, name, forUser, forTeam)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > startedAt) {
    emitRegistryLookup({
      recipeNs: ns,
      recipeName: name,
      forUser,
      cacheHit: true,
      kind: cached.result.kind,
      durationMs: 0,
    })
    return { ...cached.result, cacheHit: true }
  }

  const result = await fetchUncached(ns, name, forUser, forTeam)
  cache.set(key, {
    result,
    expiresAt: now() + config.sandboxUiRegistryCacheTtlMs,
  })
  emitRegistryLookup({
    recipeNs: ns,
    recipeName: name,
    forUser,
    cacheHit: false,
    kind: result.kind,
    durationMs: now() - startedAt,
  })
  return { ...result, cacheHit: false }
}

/**
 * List every UI-bearing recipe the user is in the allowlist for.
 * Wraps control-api's `GET /internal/sandbox-ui/apps?forUser=<userId>`.
 *
 * Not cached — the discovery list changes when an admin grants/revokes ACL
 * or a recipe lands/disappears, and the user's app picker is fired on tab
 * focus / open, so a stale cache is more likely to mislead than a fresh
 * round-trip is to be a bottleneck.
 */
export type AppEntry = {
  appRef: string
  title?: string
  icon?: string
  defaultPath: string
  ready: boolean
  phase: string | null
  updatedAt: string | null
}

export type AppsLookupResult = { kind: 'ok'; apps: AppEntry[] } | { kind: 'error'; status: number }

function parseApp(raw: unknown): AppEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const appRef = typeof obj.appRef === 'string' ? obj.appRef : ''
  if (!appRef) return null
  return {
    appRef,
    title: typeof obj.title === 'string' ? obj.title : undefined,
    icon: typeof obj.icon === 'string' ? obj.icon : undefined,
    defaultPath: typeof obj.defaultPath === 'string' && obj.defaultPath ? obj.defaultPath : '/',
    ready: obj.ready === true,
    phase: typeof obj.phase === 'string' ? obj.phase : null,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : null,
  }
}

export async function listSandboxUiApps(
  forUser: string,
  forTeam?: string
): Promise<AppsLookupResult> {
  if (!forUser) return { kind: 'error', status: 400 }
  const params = new URLSearchParams({ forUser })
  if (forTeam) params.set('forTeam', forTeam)
  const url = `${controlApiBaseUrl()}/internal/sandbox-ui/apps?${params.toString()}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: controlApiHeaders(),
    })
  } catch {
    return { kind: 'error', status: 502 }
  }
  if (response.status === 401 || response.status === 403) {
    // Service-token misconfig — see fetchUncached for the same coercion.
    return { kind: 'error', status: 500 }
  }
  if (!response.ok) {
    return { kind: 'error', status: response.status }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'error', status: 500 }
  }
  const rawApps = (body as { apps?: unknown }).apps
  if (!Array.isArray(rawApps)) return { kind: 'error', status: 500 }
  const apps: AppEntry[] = []
  for (const raw of rawApps) {
    const parsed = parseApp(raw)
    if (parsed) apps.push(parsed)
  }
  return { kind: 'ok', apps }
}
