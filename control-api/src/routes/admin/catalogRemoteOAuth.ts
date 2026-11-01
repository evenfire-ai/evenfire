/**
 * Pure rules for remote-OAuth connectors offered by the registry catalog: which
 * entries belong to the subtype, how their `mcp_server_meta.oauth` block is
 * validated, whose presentation metadata is trusted, the canonical McpServer
 * name of each install slot, and which fields make up the identity of an
 * installed catalog instance. No I/O: every route that touches the subtype
 * resolves it through these functions, so there is a single implementation.
 */
import { createHash } from 'node:crypto'
import type { RegistrationMode } from '../../oauth/discovery.js'
import { mergeAnnotationsForReplace } from '../../services/annotationMerge.js'
import type { RegistryEntry } from '../../services/registryClient.js'
import { OFFICIAL_EVENFIRE_SCOPES, registryNameSlug } from './registryNaming.js'

export type RemoteOAuthGrantScope = 'user' | 'context'
export type RemoteOAuthRegistration = 'cimd' | 'dcr' | 'pre-registered'
export type RemoteOAuthVerificationStatus = 'verified' | 'untested' | 'known-issue'

export const REMOTE_OAUTH_GRANT_SCOPES: readonly RemoteOAuthGrantScope[] = ['user', 'context']
export const REMOTE_OAUTH_REGISTRATIONS: readonly RemoteOAuthRegistration[] = [
  'cimd',
  'dcr',
  'pre-registered',
]
export const REMOTE_OAUTH_VERIFICATION_STATUSES: readonly RemoteOAuthVerificationStatus[] = [
  'verified',
  'untested',
  'known-issue',
]

/** The same `.length` bounds the registry enforces when the block is published. */
export const REMOTE_OAUTH_SETUP_GUIDE_MAX_LENGTH = 4000
export const REMOTE_OAUTH_CONSOLE_URL_MAX_LENGTH = 512
export const REMOTE_OAUTH_VERIFICATION_NOTE_MAX_LENGTH = 500

/**
 * Presentation-only keys of the block. They never widen trust or pick the install
 * mode, so they are honored only on curator entries and on valid blocks.
 */
export const REMOTE_OAUTH_PRESENTATION_KEYS = [
  'verification',
  'setupGuide',
  'providerConsoleUrl',
] as const

export interface RemoteOAuthVerification {
  status: RemoteOAuthVerificationStatus
  checkedAt?: string
  note?: string
}

export interface RemoteOAuthCatalogBlock {
  source: 'remote'
  allowedGrantScopes: RemoteOAuthGrantScope[]
  scopes?: string[]
  authorizationServerHint?: string
  expectedRegistration: RemoteOAuthRegistration
  providerConsoleUrl?: string
  setupGuide?: string
  verification?: RemoteOAuthVerification
}

/**
 * Stable, short reason codes. Callers surface them as the `reason` of a
 * `catalog_entry_invalid` response, so renaming one is an API change.
 */
export type RemoteOAuthInvalidReason =
  | 'not_mcp_server'
  | 'not_remote_server'
  | 'oauth_block_missing'
  | 'oauth_source_not_remote'
  | 'oauth_provider_not_allowed'
  | 'remote_endpoint_missing'
  | 'remote_endpoint_not_https'
  | 'allowed_grant_scopes_invalid'
  | 'scopes_invalid'
  | 'authorization_server_hint_invalid'
  | 'expected_registration_invalid'
  | 'verification_invalid'
  | 'verification_note_required'
  | 'setup_guide_invalid'
  | 'setup_guide_too_long'
  | 'provider_console_url_not_https'
  | 'provider_console_url_invalid'
  | 'setup_guide_required'
  | 'provider_console_url_required'

/**
 * Reasons that mean "this entry is not a remote-OAuth connector at all", as opposed
 * to "it is one, but its block is broken". Routes answer them differently.
 */
export const NOT_REMOTE_OAUTH_REASONS: ReadonlySet<RemoteOAuthInvalidReason> = new Set([
  'not_mcp_server',
  'not_remote_server',
  'oauth_block_missing',
  'oauth_source_not_remote',
])

export type RemoteOAuthParseResult =
  | { valid: true; block: RemoteOAuthCatalogBlock; url: string }
  | { valid: false; reason: RemoteOAuthInvalidReason }

/** The fields of a registry row (`SELECT *` from `entries`) these rules read. */
export type CatalogEntryInput = Pick<RegistryEntry, 'name'> &
  Partial<
    Pick<
      RegistryEntry,
      'entry_type' | 'server_mode' | 'mcp_server_meta' | 'owner_type' | 'owner_id'
    >
  >

export type RemoteOAuthResolution =
  | { valid: true }
  | { valid: false; reason: RemoteOAuthInvalidReason | string }

/** What a non-curator remote-OAuth entry gains on resolution: who published it. */
export type ResolvedRemoteOAuthEntry<T extends CatalogEntryInput> = T & {
  remoteOAuth: RemoteOAuthResolution
  publisher?: string | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oauthBlockOf(entry: CatalogEntryInput): Record<string, unknown> | null {
  const meta = entry.mcp_server_meta
  if (!isPlainObject(meta)) return null
  const oauth = meta.oauth
  return isPlainObject(oauth) ? oauth : null
}

/**
 * The console link is rendered from the raw string, but `new URL()` repairs input
 * before it can be inspected: it reads `https:host` and `https:\\host` as
 * `https://host`, drops tabs and newlines, and punycodes Unicode hosts. So the raw
 * form is pinned first, with the same rules the registry applies at publish:
 * - printable ASCII only (an internationalized host must arrive as punycode, which
 *   rules out homoglyph, bidi and zero-width tricks);
 * - a literal `https://` followed directly by the host;
 * - no `\` anywhere: WHATWG reads it as `/` and RFC 3986 parsers do not, so
 *   `https://a.com\@evil.com/` names a different host depending on the parser;
 * - none of `" ' < > \` { } | ^`: the string is rendered raw, and these would let
 *   it break out of an HTML attribute or open a tag;
 * - no `@` in the raw authority: an empty userinfo (`https://@host`) parses to an
 *   empty username, so the parsed credentials check alone misses it;
 * - no `%` in the raw authority: `new URL()` percent-decodes the host, so
 *   `https://%65vil.com` opens evil.com while the raw string reads otherwise.
 *
 * Reason codes: a malformed string (non-ASCII, a `\` or a forbidden character
 * anywhere, a `%` in the host) is `_invalid`; a missing `https://` prefix, any
 * userinfo, or a string `new URL()` will not parse as https is `_not_https`. A
 * credentialed URL keeps `_not_https`, the code it returned before the raw `@`
 * check existed.
 */
const CONSOLE_URL_ASCII_RE = /^[\x21-\x7E]+$/
const CONSOLE_URL_PREFIX_RE = /^https:\/\/[^/\\]/
const CONSOLE_URL_AUTHORITY_RE = /^https:\/\/([^/?#]*)/
const CONSOLE_URL_UNSAFE_RE = /["'<>`{}|^]/

function providerConsoleUrlReason(value: unknown): RemoteOAuthInvalidReason | null {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > REMOTE_OAUTH_CONSOLE_URL_MAX_LENGTH ||
    !CONSOLE_URL_ASCII_RE.test(value)
  ) {
    return 'provider_console_url_invalid'
  }
  if (!CONSOLE_URL_PREFIX_RE.test(value)) return 'provider_console_url_not_https'
  if (value.includes('\\') || CONSOLE_URL_UNSAFE_RE.test(value)) {
    return 'provider_console_url_invalid'
  }
  const authority = CONSOLE_URL_AUTHORITY_RE.exec(value)![1]
  if (authority.includes('@')) return 'provider_console_url_not_https'
  if (authority.includes('%')) return 'provider_console_url_invalid'
  if (!isHttpsUrl(value)) return 'provider_console_url_not_https'
  return null
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
}

/**
 * The subtype discriminator, shared by every guard that must keep these entries
 * out of the generic registry lanes. It looks at `oauth.source` alone on purpose:
 * an entry that also carries `provider`, or a wrong `entry_type`/`server_mode`,
 * must still be caught here (and then rejected as invalid) instead of falling
 * through to the generic install path.
 */
export function isRemoteOAuthEntry(entry: CatalogEntryInput): boolean {
  return oauthBlockOf(entry)?.source === 'remote'
}

/**
 * Semantic validation of a remote-OAuth entry. The registry already checks shape
 * and bounds when the block is published; the cross-field rules live only here.
 *
 * `trusted` is the provenance of the entry. A curator `pre-registered` entry must
 * ship the setup guide and the provider console link, because the wizard depends
 * on them. An untrusted entry has had those keys stripped before validation, so
 * requiring them would make every org `pre-registered` entry uninstallable.
 */
export function parseRemoteOAuthCatalogBlock(
  entry: CatalogEntryInput,
  opts: { trusted: boolean }
): RemoteOAuthParseResult {
  const invalid = (reason: RemoteOAuthInvalidReason): RemoteOAuthParseResult => ({
    valid: false,
    reason,
  })

  if (entry.entry_type !== 'mcp-server') return invalid('not_mcp_server')
  if (entry.server_mode !== 'remote') return invalid('not_remote_server')
  const oauth = oauthBlockOf(entry)
  if (!oauth) return invalid('oauth_block_missing')
  if (oauth.source !== 'remote') return invalid('oauth_source_not_remote')
  // `provider` selects the baked-provider install lane; a block carrying both
  // would be claimed by two incompatible flows.
  if (oauth.provider !== undefined) return invalid('oauth_provider_not_allowed')

  const endpoints = (entry.mcp_server_meta as Record<string, unknown>).remoteEndpoints
  const first = Array.isArray(endpoints) ? endpoints[0] : undefined
  if (!isPlainObject(first) || typeof first.url !== 'string' || first.url === '') {
    return invalid('remote_endpoint_missing')
  }
  if (!isHttpsUrl(first.url)) return invalid('remote_endpoint_not_https')

  const grantScopes = oauth.allowedGrantScopes
  if (
    !Array.isArray(grantScopes) ||
    grantScopes.length === 0 ||
    !grantScopes.every(s => REMOTE_OAUTH_GRANT_SCOPES.includes(s as RemoteOAuthGrantScope)) ||
    new Set(grantScopes).size !== grantScopes.length
  ) {
    return invalid('allowed_grant_scopes_invalid')
  }

  if (
    oauth.scopes !== undefined &&
    !(Array.isArray(oauth.scopes) && oauth.scopes.every(s => typeof s === 'string'))
  ) {
    return invalid('scopes_invalid')
  }

  if (
    oauth.authorizationServerHint !== undefined &&
    typeof oauth.authorizationServerHint !== 'string'
  ) {
    return invalid('authorization_server_hint_invalid')
  }

  if (!REMOTE_OAUTH_REGISTRATIONS.includes(oauth.expectedRegistration as RemoteOAuthRegistration)) {
    return invalid('expected_registration_invalid')
  }

  let verification: RemoteOAuthVerification | undefined
  if (oauth.verification !== undefined) {
    const v = oauth.verification
    if (
      !isPlainObject(v) ||
      !REMOTE_OAUTH_VERIFICATION_STATUSES.includes(v.status as RemoteOAuthVerificationStatus) ||
      (v.checkedAt !== undefined && typeof v.checkedAt !== 'string') ||
      (v.note !== undefined &&
        (typeof v.note !== 'string' || v.note.length > REMOTE_OAUTH_VERIFICATION_NOTE_MAX_LENGTH))
    ) {
      return invalid('verification_invalid')
    }
    // A "known issue" badge without the explanation would tell the admin
    // something is wrong without saying what.
    if (v.status === 'known-issue' && (typeof v.note !== 'string' || v.note.trim() === '')) {
      return invalid('verification_note_required')
    }
    verification = {
      status: v.status as RemoteOAuthVerificationStatus,
      ...(typeof v.checkedAt === 'string' ? { checkedAt: v.checkedAt } : {}),
      ...(typeof v.note === 'string' ? { note: v.note } : {}),
    }
  }

  if (oauth.setupGuide !== undefined) {
    if (typeof oauth.setupGuide !== 'string' || oauth.setupGuide === '') {
      return invalid('setup_guide_invalid')
    }
    if (oauth.setupGuide.length > REMOTE_OAUTH_SETUP_GUIDE_MAX_LENGTH) {
      return invalid('setup_guide_too_long')
    }
  }

  if (oauth.providerConsoleUrl !== undefined) {
    const consoleUrlReason = providerConsoleUrlReason(oauth.providerConsoleUrl)
    if (consoleUrlReason) return invalid(consoleUrlReason)
  }

  const expectedRegistration = oauth.expectedRegistration as RemoteOAuthRegistration
  if (opts.trusted && expectedRegistration === 'pre-registered') {
    if (oauth.setupGuide === undefined) return invalid('setup_guide_required')
    if (oauth.providerConsoleUrl === undefined) return invalid('provider_console_url_required')
  }

  const block: RemoteOAuthCatalogBlock = {
    source: 'remote',
    allowedGrantScopes: [...(grantScopes as RemoteOAuthGrantScope[])],
    expectedRegistration,
    ...(oauth.scopes !== undefined ? { scopes: [...(oauth.scopes as string[])] } : {}),
    ...(oauth.authorizationServerHint !== undefined
      ? { authorizationServerHint: oauth.authorizationServerHint as string }
      : {}),
    ...(oauth.providerConsoleUrl !== undefined
      ? { providerConsoleUrl: oauth.providerConsoleUrl as string }
      : {}),
    ...(oauth.setupGuide !== undefined ? { setupGuide: oauth.setupGuide as string } : {}),
    ...(verification ? { verification } : {}),
  }
  return { valid: true, block, url: first.url }
}

/**
 * Whether the registration mode discovery resolved differs from the one a catalog
 * entry expects. Without a client of its own, discovery reports a pre-registered-only
 * AS as `manual`, which is exactly what an entry expecting `pre-registered` describes.
 * Shared with the catalog seed script, which refuses to publish a drifting entry.
 */
export function catalogRegistrationDrifts(
  expected: RemoteOAuthRegistration,
  detected: RegistrationMode
): boolean {
  const normalizedDetected = detected === 'manual' ? 'pre-registered' : detected
  return normalizedDetected !== expected
}

/**
 * Whether the entry was published by the catalog curator. Positive and
 * fail-closed: anything not proven curator is treated as an ordinary org entry.
 *
 * The scope is a trustworthy signal because the registry enforces it: only a
 * curator client may publish under a reserved scope. An unscoped name does not
 * qualify even though only a curator-class client can publish one: that class
 * also covers the platform's own control-api clients, so an unscoped entry is not
 * proof of a curated publish, and the hook trust rule draws the same line.
 * `owner_id` is not compared because it is a per-database UUID control-api does
 * not know; it is only required to be present so legacy rows with a null owner
 * never qualify.
 */
export function isCuratorEntry(entry: CatalogEntryInput): boolean {
  if (entry.owner_type !== 'org') return false
  if (typeof entry.owner_id !== 'string' || entry.owner_id === '') return false
  const scope = parseRegistryEntryName(entry.name)?.scope
  return typeof scope === 'string' && OFFICIAL_EVENFIRE_SCOPES.includes(scope)
}

/**
 * The registry's own name grammar. Provenance is only as trustworthy as the
 * name it is read from, so anything the registry would not have accepted as a
 * name (leading whitespace or invisible characters, a scope without `@`, path
 * segments) is not parsed leniently: it simply does not qualify.
 */
const UNSCOPED_ENTRY_NAME_RE = /^[a-z0-9][a-z0-9-]{2,62}$/
const SCOPED_ENTRY_NAME_RE = /^@([a-z0-9][a-z0-9_-]{0,62})\/[a-z0-9][a-z0-9-]{2,62}$/

function parseRegistryEntryName(name: unknown): { scope: string | null } | null {
  if (typeof name !== 'string') return null
  if (UNSCOPED_ENTRY_NAME_RE.test(name)) return { scope: null }
  const m = SCOPED_ENTRY_NAME_RE.exec(name)
  return m ? { scope: `@${m[1]}` } : null
}

function withoutPresentationKeys(oauth: Record<string, unknown>): Record<string, unknown> {
  const out = { ...oauth }
  for (const key of REMOTE_OAUTH_PRESENTATION_KEYS) delete out[key]
  return out
}

function withOAuthBlock<T extends CatalogEntryInput>(entry: T, oauth: Record<string, unknown>): T {
  return {
    ...entry,
    mcp_server_meta: { ...(entry.mcp_server_meta as Record<string, unknown>), oauth },
  }
}

function priorInvalidResolution(entry: CatalogEntryInput): RemoteOAuthResolution | null {
  const prior = (entry as { remoteOAuth?: unknown }).remoteOAuth
  if (!isPlainObject(prior) || prior.valid !== false) return null
  return { valid: false, reason: typeof prior.reason === 'string' ? prior.reason : 'invalid' }
}

/**
 * The single resolution every catalog read and catalog install applies to a
 * remote-OAuth entry: decide provenance, drop presentation metadata that is not
 * trusted, validate, and attach the verdict as `remoteOAuth`.
 *
 * - Not a remote-OAuth entry: returned as is (the same reference).
 * - Non-curator: `verification`, `setupGuide` and `providerConsoleUrl` are removed
 *   before validation (any org can publish a "verified" badge or a guide that
 *   links to its own site), and `publisher` names the scope it came from.
 * - Invalid block: presentation metadata is removed even on a curator entry, so a
 *   broken entry never shows a badge or a guide.
 *
 * The returned `oauth` block is rebuilt from the validated fields only (an
 * allowlist), never by deleting keys from the raw one: a near-miss key such as
 * `SetupGuide` or `setup_guide` would survive a denylist and could be picked up
 * by a lenient reader downstream. An invalid block is reduced to `{ source }`,
 * which keeps the subtype recognisable to every guard but carries nothing else.
 *
 * Idempotent. Stripping removes exactly the keys an invalid verdict may depend on,
 * so a second pass could otherwise turn an invalid entry valid; a `valid: false`
 * verdict already on the entry is therefore kept. Only a negative verdict is
 * honored from the input: a `valid: true` is always recomputed, so an input can
 * never make itself installable.
 *
 * Never mutates its input.
 */
export function resolveRemoteOAuthEntry<T extends CatalogEntryInput>(
  entry: T
): T | ResolvedRemoteOAuthEntry<T> {
  if (!isRemoteOAuthEntry(entry)) return entry
  const oauth = oauthBlockOf(entry) as Record<string, unknown>
  const trusted = isCuratorEntry(entry)

  const visibleOAuth = trusted ? { ...oauth } : withoutPresentationKeys(oauth)
  const candidate = withOAuthBlock(entry, visibleOAuth)
  const parsed = parseRemoteOAuthCatalogBlock(candidate, { trusted })
  const verdict: RemoteOAuthResolution =
    priorInvalidResolution(entry) ??
    (parsed.valid ? { valid: true } : { valid: false, reason: parsed.reason })

  // `parsed.block` already lacks the presentation keys of an untrusted entry,
  // because it was parsed from the stripped candidate.
  const resolvedOAuth: Record<string, unknown> =
    verdict.valid && parsed.valid ? { ...parsed.block } : { source: oauth.source }
  const resolved: ResolvedRemoteOAuthEntry<T> = {
    ...withOAuthBlock(entry, resolvedOAuth),
    remoteOAuth: verdict,
  }
  // Read from the registry grammar, not a lenient prefix match, so a malformed
  // name such as `@evenfire/../x` is never presented as published by `@evenfire`.
  if (!trusted) resolved.publisher = parseRegistryEntryName(entry.name)?.scope ?? null
  return resolved
}

/** Alias under the name the routes describe the operation by. */
export const stripUntrustedRemoteOAuthMetadata = resolveRemoteOAuthEntry

/**
 * Canonical McpServer name of a catalog install slot. It never depends on the
 * entry version, so a new version never opens a second slot, and two installs of
 * the same slot race for one name that the K8s create arbitrates. The hash is
 * required because distinct names collapse under the slug (`@acme/x` and
 * `acme-x` both slug to `acme-x`). The slug is capped at
 * 40 characters, which keeps the name at 55 at most, so the 63-character trim can
 * never cut into the hash.
 */
export function deriveCatalogRemoteServerName(
  catalogId: string,
  grantScope: RemoteOAuthGrantScope
): string {
  if (grantScope !== 'user' && grantScope !== 'context') {
    throw new Error(`invalid grant scope: ${String(grantScope)}`)
  }
  const slug = registryNameSlug(catalogId)
  const scopeTag = grantScope === 'user' ? 'u' : 'c'
  const hash = createHash('sha256').update(`${catalogId}:${grantScope}`).digest('hex').slice(0, 8)
  return `mcp-${slug}-${scopeTag}-${hash}`.slice(0, 63).replace(/-$/, '')
}

/**
 * Comparison form of a remote MCP base URL: lowercase scheme and host (the URL
 * parser does both), no default port, no trailing slash. Only for comparing; the
 * value persisted on the CR is always the literal URL from the catalog entry.
 * Returns null when the input does not parse as a URL or carries credentials.
 */
export function normalizeRemoteBaseUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // A base URL never legitimately carries credentials; refusing to normalize it
  // makes any comparison against it fail.
  if (parsed.username !== '' || parsed.password !== '') return null
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`
}

/** The parts of an McpServer CR the identity rules read. */
export interface McpServerLike {
  metadata?: { annotations?: Record<string, string> } | null
  spec?: Record<string, unknown> | null
}

const CATALOG_ID_ANNOTATION = 'clerum.io/catalog-id'
const CATALOG_VERSION_ANNOTATION = 'clerum.io/catalog-version'

function specOAuth(cr: McpServerLike): Record<string, unknown> | undefined {
  const oauth = cr.spec?.oauth
  return isPlainObject(oauth) ? oauth : undefined
}

/**
 * An McpServer installed from the catalog as a remote-OAuth connector. Only the
 * annotation counts: catalog ids with a scope cannot be label values, and the
 * catalog install path writes the annotation.
 */
export function isCatalogRemoteOAuthInstance(cr: McpServerLike): boolean {
  const catalogId = cr.metadata?.annotations?.[CATALOG_ID_ANNOTATION]
  return typeof catalogId === 'string' && catalogId !== '' && specOAuth(cr)?.source === 'remote'
}

export type CatalogInstanceIdentityField =
  | 'spec.remote.baseUrl'
  | 'spec.transport.url'
  | 'spec.oauth.source'
  | 'spec.oauth.grantScope'
  | 'spec.oauth.id'
  | 'spec.oauth.authorizationEndpoint'
  | 'spec.oauth.tokenEndpoint'
  | 'spec.oauth.registrationEndpoint'
  | 'spec.oauth.resource'
  | `metadata.annotations.${typeof CATALOG_ID_ANNOTATION}`
  | `metadata.annotations.${typeof CATALOG_VERSION_ANNOTATION}`

function nested(cr: McpServerLike, key: 'remote' | 'transport', field: string): unknown {
  const block = cr.spec?.[key]
  return isPlainObject(block) ? block[field] : undefined
}

const OAUTH_IDENTITY_FIELDS = [
  'source',
  'grantScope',
  'id',
  'authorizationEndpoint',
  'tokenEndpoint',
  'registrationEndpoint',
  'resource',
] as const

/**
 * Identity fields of a catalog instance that a full replace from `currentCr` to
 * `nextCr` would change. Scopes and egress bindings are deliberately absent: they
 * stay editable, as they are on a manually installed connector.
 *
 * Annotations are compared after the same merge the replace applies, because a
 * replace never drops a platform `clerum.io/*` key the caller did not name: a
 * body with no annotation map keeps them all, and a map that omits them keeps
 * them too. Only a key the body sets to a different value counts as a change.
 */
export function catalogInstanceIdentityChanges(
  currentCr: McpServerLike,
  nextCr: McpServerLike
): CatalogInstanceIdentityField[] {
  const changes: CatalogInstanceIdentityField[] = []
  if (nested(currentCr, 'remote', 'baseUrl') !== nested(nextCr, 'remote', 'baseUrl')) {
    changes.push('spec.remote.baseUrl')
  }
  if (nested(currentCr, 'transport', 'url') !== nested(nextCr, 'transport', 'url')) {
    changes.push('spec.transport.url')
  }
  const currentOAuth = specOAuth(currentCr)
  const nextOAuth = specOAuth(nextCr)
  for (const field of OAUTH_IDENTITY_FIELDS) {
    if (currentOAuth?.[field] !== nextOAuth?.[field]) changes.push(`spec.oauth.${field}`)
  }

  const currentAnnotations = currentCr.metadata?.annotations ?? undefined
  const effectiveNext = mergeAnnotationsForReplace(
    currentAnnotations,
    nextCr.metadata?.annotations ?? undefined
  )
  for (const key of [CATALOG_ID_ANNOTATION, CATALOG_VERSION_ANNOTATION] as const) {
    if (currentAnnotations?.[key] !== effectiveNext?.[key])
      changes.push(`metadata.annotations.${key}`)
  }
  return changes
}

/**
 * Whether a full replace from `currentCr` to `nextCr` turns a CR that is not a
 * catalog remote-OAuth instance into one. Judged on the state the replace would
 * store (annotations merged as the replace merges them), because the identity can
 * arrive in either half: catalog annotations added to a manual remote-OAuth
 * connector, or `oauth.source: remote` added to a CR that already carries a
 * catalog id. Only the catalog install saga may create that identity.
 */
export function becomesCatalogRemoteOAuthInstance(
  currentCr: McpServerLike,
  nextCr: McpServerLike
): boolean {
  if (isCatalogRemoteOAuthInstance(currentCr)) return false
  return isCatalogRemoteOAuthInstance({
    metadata: {
      annotations: mergeAnnotationsForReplace(
        currentCr.metadata?.annotations ?? undefined,
        nextCr.metadata?.annotations ?? undefined
      ),
    },
    spec: nextCr.spec,
  })
}

/** What occupies one install slot (catalog entry × grant scope) of a remote-OAuth entry. */
export type RemoteOAuthSlotState =
  | {
      kind: 'instance'
      serverName: string
      version: string
      /** False when the CR carries the catalog id under a name other than the slot's. */
      canonical: boolean
      /** Being deleted: the slot frees up only once the CR is gone. */
      terminating: boolean
    }
  /** The slot's canonical name is taken by a CR that was not installed into this slot. */
  | { kind: 'foreign'; serverName: string }

export type RemoteOAuthSlots = Record<
  string,
  Partial<Record<RemoteOAuthGrantScope, RemoteOAuthSlotState>>
>

export interface ManualRemoteOAuthServer {
  serverName: string
  baseUrl: string
  grantScope: RemoteOAuthGrantScope
}

/** The parts of a listed McpServer the slot classification reads. */
export interface ListedMcpServer {
  metadata?: {
    name?: string
    deletionTimestamp?: string
    annotations?: Record<string, string>
  } | null
  spec?: Record<string, unknown> | null
}

function crGrantScope(cr: ListedMcpServer): RemoteOAuthGrantScope {
  // The apiserver defaults a missing grantScope to `user`.
  return specOAuth(cr)?.grantScope === 'context' ? 'context' : 'user'
}

/** A remote-discovered OAuth McpServer, catalog instance or manual. */
export function isRemoteOAuthServer(cr: ListedMcpServer): boolean {
  return specOAuth(cr)?.source === 'remote'
}

/**
 * Install state of remote-OAuth connectors, derived from the listed McpServers and
 * the catalog entries being shown. No I/O and no registry call per entry.
 *
 * - A catalog instance fills the slot of its catalog id and grant scope. If two CRs
 *   claim one slot (only reachable by writing the annotation by hand), the one with
 *   the canonical name wins, otherwise the first by name, so the answer is stable.
 * - `foreign`: for every grant scope a valid entry allows, a slot nobody filled whose
 *   canonical name is taken by some other McpServer. Installing would only collide
 *   on that name, so the slot is reported as occupied instead of free.
 * - `manual`: remote-OAuth servers without a catalog id (installed by URL).
 * - A CR whose catalog id is not a name the registry accepts is left out of slots
 *   and of `manual`: it still counts in `serverNames`, so a slot it squats is foreign.
 *
 * `entries` are expected to be already resolved (`resolveRemoteOAuthEntry`): only
 * entries marked valid are evaluated for `foreign`, and their allowed grant scopes
 * are read from the validated block.
 */
export function classifyRemoteOAuthSlots(
  servers: readonly ListedMcpServer[],
  entries: readonly CatalogEntryInput[]
): { remoteOAuthSlots: RemoteOAuthSlots; manualRemoteOAuth: ManualRemoteOAuthServer[] } {
  // Keyed by strings read from annotations and registry rows: a Map, so no key can
  // reach an object prototype however it is spelled.
  const slots = new Map<string, Partial<Record<RemoteOAuthGrantScope, RemoteOAuthSlotState>>>()
  const manual: ManualRemoteOAuthServer[] = []
  const serverNames = new Set<string>()

  const sorted = [...servers].sort((a, b) =>
    String(a.metadata?.name ?? '').localeCompare(String(b.metadata?.name ?? ''))
  )
  for (const cr of sorted) {
    const serverName = String(cr.metadata?.name ?? '').trim()
    if (!serverName) continue
    serverNames.add(serverName)
    if (!isRemoteOAuthServer(cr)) continue
    const grantScope = crGrantScope(cr)
    if (!isCatalogRemoteOAuthInstance(cr)) {
      const baseUrl = nested(cr, 'remote', 'baseUrl')
      manual.push({
        serverName,
        baseUrl: typeof baseUrl === 'string' ? baseUrl : '',
        grantScope,
      })
      continue
    }
    const annotations = cr.metadata?.annotations ?? {}
    const catalogId = annotations[CATALOG_ID_ANNOTATION] as string
    // No catalog slot exists for a name the registry would not have accepted, so a
    // hand-written annotation such as `__proto__` is not classified at all.
    if (parseRegistryEntryName(catalogId) === null) continue
    const canonical = serverName === deriveCatalogRemoteServerName(catalogId, grantScope)
    let bySlot = slots.get(catalogId)
    if (!bySlot) slots.set(catalogId, (bySlot = {}))
    const current = bySlot[grantScope]
    if (current?.kind === 'instance' && (current.canonical || !canonical)) continue
    bySlot[grantScope] = {
      kind: 'instance',
      serverName,
      version: annotations[CATALOG_VERSION_ANNOTATION] ?? '',
      canonical,
      terminating: Boolean(cr.metadata?.deletionTimestamp),
    }
  }

  for (const entry of entries) {
    if (!isRemoteOAuthEntry(entry)) continue
    const resolution = (entry as { remoteOAuth?: RemoteOAuthResolution }).remoteOAuth
    if (resolution?.valid !== true) continue
    if (parseRegistryEntryName(entry.name) === null) continue
    const allowed = oauthBlockOf(entry)?.allowedGrantScopes
    if (!Array.isArray(allowed)) continue
    for (const grantScope of REMOTE_OAUTH_GRANT_SCOPES) {
      if (!allowed.includes(grantScope)) continue
      const bySlot = slots.get(entry.name)
      if (bySlot?.[grantScope]) continue
      const canonicalName = deriveCatalogRemoteServerName(entry.name, grantScope)
      if (!serverNames.has(canonicalName)) continue
      const foreign: RemoteOAuthSlotState = { kind: 'foreign', serverName: canonicalName }
      if (bySlot) bySlot[grantScope] = foreign
      else slots.set(entry.name, { [grantScope]: foreign })
    }
  }

  // Object.fromEntries defines own properties, so serializing the Map cannot invoke
  // an inherited setter either.
  return { remoteOAuthSlots: Object.fromEntries(slots), manualRemoteOAuth: manual }
}
