#!/usr/bin/env node
/**
 * Publishes the curated remote-OAuth connectors of remote-oauth-catalog.json to the
 * Evenfire registry as `@evenfire/<name>`, with the evenfire-curator credential.
 *
 * Usage:
 *   node scripts/registry/seed-remote-oauth.mjs [--dry-run] [--only <name>] [--allow-drift]
 *
 *   --dry-run      validate every entry and run /discover against its URL; publish nothing
 *   --only <name>  handle a single entry (bare name or @evenfire/<name>)
 *   --allow-drift  publish even when the detected registration mode differs from
 *                  expectedRegistration (the entry should then get a new version)
 *
 * Environment (secrets only through env, never argv; none of them is ever printed):
 *   CONTROL_API_URL        control-api origin used for validation (…/api/v1 is appended)
 *   CONTROL_API_TOKEN      admin session token of that control-api (sent as its session cookie)
 *   SEED_ENTRA_TENANT_AUTHORITY
 *                          only for entries with authorizationServerHint entra-v2:
 *                          https://login.microsoftonline.com/<tenant-id>/v2.0
 *   REGISTRY_URL           registry origin (no default on purpose; not needed with --dry-run)
 *   CURATOR_CLIENT_ID / CURATOR_CLIENT_SECRET
 *                          evenfire-curator client credentials (not needed with --dry-run)
 *
 * WARNING: there is a single registry for dev and prod. The channel of what this
 * publishes depends on the `environment` the curator client is registered with:
 * `dev` publishes `experimental` (only dev callers see it until promoted), `prod`
 * publishes `stable` (prod sees it the same day). Check it first with
 * `evenfire-registry/scripts/curate.sh whoami`. Published versions are immutable:
 * a wrong entry is fixed only by publishing a new version.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const CURATOR_SCOPE = '@evenfire'
export const CATALOG_PATH = fileURLToPath(new URL('./remote-oauth-catalog.json', import.meta.url))
const USER_AGENT = 'evenfire-seed-remote-oauth/1'
const ADMIN_SESSION_COOKIE = 'control_ui_admin_session'
const REQUEST_TIMEOUT_MS = 30_000

const ITEM_KEYS = new Set([
  'name',
  'version',
  'description',
  'category',
  'url',
  'allowedGrantScopes',
  'scopes',
  'authorizationServerHint',
  'expectedRegistration',
  'providerConsoleUrl',
  'setupGuide',
  'verification',
])
const SEMVER_RE = /^\d+\.\d+\.\d+$/

/** A failure after which publishing anything else would only do more damage. */
class StopRunError extends Error {}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Parses a service base URL from the environment before any request is made.
 * Credentials in the URL are refused (fetch would send them and error messages
 * would echo them), and plain http is only accepted on loopback, for local tests.
 * Returns the origin plus path without a trailing slash; errors name only the origin.
 */
export function parseServiceUrl(name, raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} is not a valid URL`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${name} must not carry credentials`)
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use https (got ${url.origin})`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`${name} must not carry a query or fragment (${url.origin})`)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** `@evenfire/<name>`; any other scope is refused, the same rule as curate.sh. */
export function curatorEntryName(name) {
  if (typeof name !== 'string' || name === '') throw new Error('missing name')
  if (name.startsWith(`${CURATOR_SCOPE}/`)) return name
  if (name.startsWith('@')) {
    throw new Error(
      `name '${name}' is scoped to another org; the seed only publishes to ${CURATOR_SCOPE}`
    )
  }
  return `${CURATOR_SCOPE}/${name}`
}

/** The `POST /api/v1/entries` body the registry receives for one catalog item. */
export function buildPublishBody(item) {
  const oauth = {
    source: 'remote',
    allowedGrantScopes: item.allowedGrantScopes,
    ...(item.scopes !== undefined ? { scopes: item.scopes } : {}),
    ...(item.authorizationServerHint !== undefined
      ? { authorizationServerHint: item.authorizationServerHint }
      : {}),
    expectedRegistration: item.expectedRegistration,
    ...(item.providerConsoleUrl !== undefined
      ? { providerConsoleUrl: item.providerConsoleUrl }
      : {}),
    ...(item.setupGuide !== undefined ? { setupGuide: item.setupGuide } : {}),
    verification: item.verification,
  }
  return {
    name: curatorEntryName(item.name),
    version: item.version,
    entryType: 'mcp-server',
    description: item.description,
    author: 'Evenfire',
    origin: 'human-authored',
    category: item.category,
    tags: ['remote', 'oauth'],
    // The provider runs the server; Evenfire only curates the entry.
    contentCreatorTag: 'api-owner',
    configCreatorTag: '1st-party',
    mcpServer: {
      serverMode: 'remote',
      transport: 'streamableHttp',
      remoteEndpoints: [{ url: item.url }],
      oauth,
    },
  }
}

/**
 * The columns of the registry row the publish body produces that control-api's
 * rules read. The registry stores `mcp_server_meta` as JSONB, hence the JSON
 * round-trip.
 */
export function rowFromPublishBody(body) {
  return {
    name: body.name,
    version: body.version,
    entry_type: body.entryType,
    server_mode: body.mcpServer.serverMode,
    mcp_server_meta: JSON.parse(
      JSON.stringify({
        remoteEndpoints: body.mcpServer.remoteEndpoints,
        oauth: body.mcpServer.oauth,
      })
    ),
  }
}

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value) {
  const sort = v => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map(k => [k, sort(v[k])])
      )
    }
    return v
  }
  return JSON.stringify(sort(value))
}

/**
 * Validates one catalog item before anything leaves the machine: item shape, the
 * curator scope, and the row the registry would store run through control-api's own
 * `parseRemoteOAuthCatalogBlock` as a curator entry. Returns the publish body.
 */
export function validateItem(item, rules) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { ok: false, reason: 'item is not an object' }
  }
  const unknown = Object.keys(item).filter(k => !ITEM_KEYS.has(k))
  if (unknown.length > 0) return { ok: false, reason: `unknown item keys: ${unknown.join(', ')}` }
  for (const key of ['name', 'version', 'description', 'category', 'url']) {
    if (typeof item[key] !== 'string' || item[key] === '') {
      return { ok: false, reason: `${key} must be a non-empty string` }
    }
  }
  if (!SEMVER_RE.test(item.version))
    return { ok: false, reason: 'version must be MAJOR.MINOR.PATCH' }
  // Required here although the parser treats it as optional: the seed is the only
  // writer of the badge, so every curated entry states its verification status.
  if (item.verification === undefined) return { ok: false, reason: 'verification is required' }

  let body
  try {
    body = buildPublishBody(item)
  } catch (err) {
    return { ok: false, reason: err.message }
  }
  const parsed = rules.parseRemoteOAuthCatalogBlock(rowFromPublishBody(body), { trusted: true })
  if (!parsed.valid) return { ok: false, reason: `control-api rejects the entry: ${parsed.reason}` }
  // The parser rebuilds the block from the fields it knows. Anything it dropped
  // (e.g. an unknown key under verification) would be published but never shown.
  if (canonicalJson(parsed.block) !== canonicalJson(body.mcpServer.oauth)) {
    return { ok: false, reason: 'oauth block carries fields control-api does not read' }
  }
  return { ok: true, body }
}

/**
 * Judges a `/discover` dry-run answer for an item: the MCP transport must be alive
 * at the entry URL (OAuth metadata can resolve on a path whose `initialize` 404s,
 * and a catalog install cannot fix the URL), and the detected registration mode
 * must match the entry, compared the way control-api reports catalog drift.
 */
export function evaluateDiscover(item, response, { allowDrift = false } = {}, rules) {
  const { status, body } = response
  if (status === 401) return { ok: false, reason: 'control-api rejected CONTROL_API_TOKEN (401)' }
  if (status !== 200) {
    const kind = body?.detail?.kind ? ` (${body.detail.kind})` : ''
    const error = typeof body?.error === 'string' ? `: ${body.error}` : ''
    return { ok: false, reason: `discover answered HTTP ${status}${error}${kind}` }
  }
  const transport = body?.transport
  if (transport?.status !== 'alive') {
    const http = transport?.httpStatus ? ` HTTP ${transport.httpStatus}` : ''
    const suggestion = transport?.suggestedBaseUrl
      ? `; suggested URL ${transport.suggestedBaseUrl}`
      : ''
    return {
      ok: false,
      reason: `MCP transport is ${transport?.status ?? 'unknown'} at the entry URL${http}${suggestion}`,
    }
  }
  const detected = body?.detected?.registrationMode
  if (typeof detected !== 'string') {
    return { ok: false, reason: 'discover answer carries no detected.registrationMode' }
  }
  if (rules.catalogRegistrationDrifts(item.expectedRegistration, detected)) {
    const drift = `registration drift: expected ${item.expectedRegistration}, detected ${detected}`
    if (!allowDrift)
      return { ok: false, reason: `${drift} (update the entry or pass --allow-drift)` }
    return { ok: true, warning: drift }
  }
  return { ok: true }
}

/**
 * Read-after-write: a registry without support for the `oauth` block answers the
 * publish with 2xx and drops it, and versions are immutable, so the only safe
 * answer is to compare what was stored with what was sent.
 */
export function verifyStoredEntry(body, row) {
  const meta = row?.mcp_server_meta
  if (!meta || typeof meta !== 'object' || meta.oauth === undefined || meta.oauth === null) {
    return {
      ok: false,
      reason:
        'the registry did not store mcp_server_meta.oauth (registry without remote-OAuth support?)',
    }
  }
  if (canonicalJson(meta.oauth) !== canonicalJson(body.mcpServer.oauth)) {
    return {
      ok: false,
      reason: 'stored mcp_server_meta.oauth differs from the catalog; publish a new version',
    }
  }
  const storedUrl = Array.isArray(meta.remoteEndpoints) ? meta.remoteEndpoints[0]?.url : undefined
  if (storedUrl !== body.mcpServer.remoteEndpoints[0].url) {
    return {
      ok: false,
      reason: 'stored remote endpoint differs from the catalog; publish a new version',
    }
  }
  return { ok: true }
}

async function requestJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { 'user-agent': USER_AGENT, ...(init.headers ?? {}) },
    // A redirect would replay the session cookie or the bearer token to wherever
    // the Location points; neither service redirects these calls.
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

/**
 * A thrown network error as one line. fetch puts the real reason (timeout,
 * ECONNRESET, redirect refused) in `cause`; neither carries request headers.
 */
function errorMessage(err) {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause instanceof Error ? `: ${err.cause.code ?? err.cause.message}` : ''
  return `${err.name === 'Error' ? '' : `${err.name}: `}${err.message}${cause}`
}

/** Short, secret-free summary of a registry error answer. */
function registryError(status, body) {
  const parts = [`HTTP ${status}`]
  if (typeof body?.error === 'string') parts.push(body.error)
  if (typeof body?.message === 'string') parts.push(body.message)
  if (Array.isArray(body?.details)) {
    parts.push(
      body.details
        .slice(0, 5)
        .map(d => `${d.field}: ${d.message}`)
        .join('; ')
    )
  }
  return parts.join(' ')
}

export function parseArgs(argv) {
  const flags = { dryRun: false, only: undefined, allowDrift: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--allow-drift') flags.allowDrift = true
    else if (arg === '--only') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error('--only needs an entry name')
      flags.only = value
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return flags
}

/**
 * Runs the seed. Returns the exit code; `log` receives one human-readable line per
 * event. Never logs env values.
 */
export async function runSeed({
  catalog,
  flags,
  env,
  rules,
  log = console.log,
  fetchImpl = fetch,
}) {
  if (!Array.isArray(catalog)) {
    log('[FAIL] catalog must be a JSON array')
    return 1
  }
  let items = catalog
  if (flags.only !== undefined) {
    const wanted = flags.only.startsWith(`${CURATOR_SCOPE}/`)
      ? flags.only.slice(CURATOR_SCOPE.length + 1)
      : flags.only
    items = catalog.filter(item => item?.name === wanted)
    if (items.length === 0) {
      log(`[FAIL] --only ${flags.only}: no such entry in the catalog`)
      return 2
    }
  }

  // The whole selection is validated before any network call: a broken catalog
  // must not leave half of it published.
  const validated = []
  const seen = new Set()
  let invalid = false
  for (const item of items) {
    const label = typeof item?.name === 'string' ? item.name : '(unnamed)'
    const result = validateItem(item, rules)
    if (result.ok && seen.has(result.body.name)) {
      log(`[FAIL] ${label}: duplicate entry name`)
      invalid = true
      continue
    }
    if (!result.ok) {
      log(`[FAIL] ${label}: ${result.reason}`)
      invalid = true
      continue
    }
    seen.add(result.body.name)
    validated.push({ item, body: result.body })
  }
  if (invalid) {
    log('Catalog is invalid; nothing was published.')
    return 1
  }

  const required = ['CONTROL_API_URL', 'CONTROL_API_TOKEN']
  if (!flags.dryRun) required.push('REGISTRY_URL', 'CURATOR_CLIENT_ID', 'CURATOR_CLIENT_SECRET')
  const missing = required.filter(name => !env[name])
  if (missing.length > 0) {
    log(`[FAIL] missing environment: ${missing.join(', ')}`)
    return 2
  }

  let controlApi
  let registry = ''
  try {
    controlApi = `${parseServiceUrl('CONTROL_API_URL', env.CONTROL_API_URL).replace(/\/api\/v1$/, '')}/api/v1`
    if (!flags.dryRun) registry = parseServiceUrl('REGISTRY_URL', env.REGISTRY_URL)
  } catch (err) {
    log(`[FAIL] ${err.message}`)
    return 2
  }
  let curatorToken
  let succeeded = 0
  let failed = 0

  async function mintCuratorToken() {
    const basic = Buffer.from(`${env.CURATOR_CLIENT_ID}:${env.CURATOR_CLIENT_SECRET}`).toString(
      'base64'
    )
    const res = await requestJson(fetchImpl, `${registry}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    const token = res.body?.access_token
    if (res.status !== 200 || typeof token !== 'string' || token === '') {
      throw new StopRunError(
        `could not mint the curator token at ${new URL(registry).origin}/oauth/token (HTTP ${res.status}); nothing else can be published`
      )
    }
    return token
  }

  for (const { item, body } of validated) {
    const label = `${body.name} ${body.version}`
    try {
      const discoverBody = { baseUrl: item.url }
      if (item.authorizationServerHint === 'entra-v2') {
        if (!env.SEED_ENTRA_TENANT_AUTHORITY) {
          throw new Error(
            'needs SEED_ENTRA_TENANT_AUTHORITY to run discovery against an Entra tenant'
          )
        }
        discoverBody.authorizationServer = env.SEED_ENTRA_TENANT_AUTHORITY
      }
      const discover = await requestJson(
        fetchImpl,
        `${controlApi}/admin/mcp-servers/remote/discover`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `${ADMIN_SESSION_COOKIE}=${env.CONTROL_API_TOKEN}`,
          },
          body: JSON.stringify(discoverBody),
        }
      )
      const verdict = evaluateDiscover(item, discover, flags, rules)
      if (!verdict.ok) throw new Error(verdict.reason)
      if (verdict.warning) log(`[warn] ${label}: ${verdict.warning} (allowed by --allow-drift)`)

      if (flags.dryRun) {
        succeeded++
        log(
          `[ok] ${label}: valid, transport alive, registration ${item.expectedRegistration} (dry-run)`
        )
        continue
      }

      curatorToken ??= await mintCuratorToken()
      const auth = { authorization: `Bearer ${curatorToken}` }
      let publish
      try {
        publish = await requestJson(fetchImpl, `${registry}/api/v1/entries`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (err) {
        // Without an answer the registry may have created the version anyway, and
        // nothing has proven it keeps the oauth block: same reason to stop as a
        // failed verification.
        throw new StopRunError(
          `publish outcome unknown (${errorMessage(err)}); the version may already exist and is immutable, reread it before running again`
        )
      }
      let outcome
      const fresh = publish.status === 201
      if (fresh) {
        outcome = `published (channel=${publish.body?.channel ?? 'unknown'})`
      } else if (publish.status === 409) {
        outcome = 'already published, skipped'
      } else {
        throw new Error(`publish failed: ${registryError(publish.status, publish.body)}`)
      }

      // A version this run just created and cannot verify points at the registry
      // itself (e.g. one that drops the oauth block): every further publish would
      // leave another immutable broken version, so the run stops. A skipped version
      // that fails only concerns that old version.
      const VerifyError = fresh ? StopRunError : Error
      let reread
      try {
        reread = await requestJson(
          fetchImpl,
          `${registry}/api/v1/entries/${encodeURIComponent(body.name)}/versions/${encodeURIComponent(body.version)}`,
          { method: 'GET', headers: auth }
        )
      } catch (err) {
        throw new VerifyError(
          `${outcome}, but rereading it failed (${errorMessage(err)}); the version is already published and immutable`
        )
      }
      if (reread.status !== 200) {
        throw new VerifyError(
          `${outcome}, but rereading it failed: ${registryError(reread.status, reread.body)}; the version is already published and immutable`
        )
      }
      const stored = verifyStoredEntry(body, reread.body)
      if (!stored.ok) throw new VerifyError(`${outcome}, but ${stored.reason}`)
      succeeded++
      log(`[ok] ${label}: ${outcome}; stored oauth block verified`)
    } catch (err) {
      failed++
      log(`[FAIL] ${label}: ${errorMessage(err)}`)
      if (err instanceof StopRunError) {
        log('Stopping: no further entries are published in this run.')
        break
      }
    }
  }

  const notAttempted = validated.length - succeeded - failed
  log(
    `${succeeded} succeeded, ${failed} failed, ${notAttempted} not attempted${flags.dryRun ? ' (dry-run)' : ''}.`
  )
  return failed > 0 || notAttempted > 0 ? 1 : 0
}

async function main() {
  let flags
  try {
    flags = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(
      `${err.message}\nUsage: seed-remote-oauth.mjs [--dry-run] [--only <name>] [--allow-drift]`
    )
    return 2
  }
  const { loadRemoteOAuthRules } = await import('./lib/control-api-modules.mjs')
  const rules = await loadRemoteOAuthRules()
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
  return runSeed({ catalog, flags, env: process.env, rules })
}

function invokedDirectly() {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main().then(
    code => {
      process.exitCode = code
    },
    err => {
      console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  )
}
