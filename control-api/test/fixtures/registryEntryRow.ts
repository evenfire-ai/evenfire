/**
 * A registry `entries` row as control-api receives it.
 *
 * What this mirrors, from evenfire-registry:
 * - `createEntry` (`src/services/entryService.ts`): the `mcp_server_meta` field
 *   list, the owner binding by name scope, and the INSERT column list. The row
 *   goes through a JSON round-trip because `mcp_server_meta` is a JSONB column
 *   (undefined keys vanish) and the response is JSON. Search (`SELECT e.*`) and
 *   the entry/version GETs return that row unchanged, and `registryClient` passes
 *   it through untouched.
 * - The publish validation that matters for this block (`validationService.ts`):
 *   the name grammar, `mcpServer.oauth` only with `serverMode: remote`, and
 *   `validateRemoteOAuthMeta` (closed keys, enums, bounds, the console URL rule).
 *
 * What it does not mirror: org rows come from a fixed list instead of
 * `registry_orgs`, ids are random UUIDs, and the columns the publish body sets
 * but these rules never read (description, tags, ...) have fixed values.
 *
 * `registryEntryRow` throws on anything the registry would refuse, so a test can
 * only build a row the registry could have stored. `malformedRow` skips the oauth
 * block validation on purpose; it exists for the negative cases that exercise
 * control-api's own defense against a block the registry would have rejected.
 */
import { randomUUID } from 'node:crypto'

/** `validationService.ts` name regexes. */
const UNSCOPED_NAME_REGEX = /^[a-z0-9][a-z0-9-]{2,62}$/
const SCOPED_NAME_REGEX = /^@[a-z0-9][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9-]{2,62}$/

/** Stand-in for `registry_orgs`: name → reserved. */
const KNOWN_ORGS = new Map<string, boolean>([
  ['clerum', true],
  ['evenfire', true],
  ['evenfire-dev', false],
  ['evenfire-prod', false],
  ['acme', false],
])

const ORG_IDS = new Map<string, string>()
function orgId(name: string): string {
  let id = ORG_IDS.get(name)
  if (!id) {
    id = randomUUID()
    ORG_IDS.set(name, id)
  }
  return id
}

/** Who published, as the registry authenticates the caller. */
export type RegistryPublisher =
  /** A curator-class machine client (today `evenfire-curator`), not bound to an org. */
  | { kind: 'curator-machine' }
  /** A machine client bound to one org (e.g. a control-api demoted to `@evenfire-dev`). */
  | { kind: 'org-machine'; org: string }
  /** A user token; `memberOf` are the orgs the user belongs to. */
  | { kind: 'user'; username: string; memberOf?: string[] }
  /** A row stored before ownership was stamped (registry migration 004). */
  | { kind: 'legacy-null-owner' }

export type PushRemoteOAuthMeta = Record<string, unknown>

export interface PushRemoteMcpEntryBody {
  name: string
  version?: string
  entryType?: 'mcp-server' | 'recipe' | 'llm-hook'
  mcpServer?: {
    serverMode?: 'remote' | 'local'
    transport?: string
    remoteEndpoints?: Array<{ url: string; region?: string; description?: string }>
    oauth?: PushRemoteOAuthMeta
    docsUrl?: string
    egressSummary?: unknown
    authHeaders?: unknown
  }
}

function fail(code: string): never {
  throw new Error(`registry would reject the publish: ${code}`)
}

/** createEntry's owner binding by name scope. */
function resolveOwner(
  name: string,
  publisher: RegistryPublisher
): { ownerType: 'org' | 'user' | null; ownerId: string | null } {
  const m = /^@([^/]+)\//.exec(name)
  const scope = m ? m[1] : null
  if (publisher.kind === 'legacy-null-owner') return { ownerType: null, ownerId: null }

  if (publisher.kind === 'curator-machine' || publisher.kind === 'org-machine') {
    const curator = publisher.kind === 'curator-machine'
    if (!scope) {
      // Unscoped curator publishes land in the reserved @clerum org (the bridge).
      if (curator) return { ownerType: 'org', ownerId: orgId('clerum') }
      fail('scope_required (400)')
    }
    const reserved = KNOWN_ORGS.get(scope)
    if (reserved === undefined) fail('scope_not_found (404)')
    if (reserved && !curator) fail('scope_reserved (403)')
    const boundOrg = curator ? null : publisher.org
    if (!reserved && scope !== boundOrg) fail('scope_not_bound (403)')
    return { ownerType: 'org', ownerId: orgId(scope) }
  }

  if (!scope) fail('scope_required (400)')
  const reserved = KNOWN_ORGS.get(scope)
  if (reserved) fail('scope_reserved (403)')
  if (reserved === false) {
    // An existing org wins over a personal scope with the same name.
    if (!publisher.memberOf?.includes(scope)) fail('not_an_org_member (403)')
    return { ownerType: 'org', ownerId: orgId(scope) }
  }
  if (scope === publisher.username) return { ownerType: 'user', ownerId: randomUUID() }
  fail('scope_not_owned (403)')
}

// ── validateRemoteOAuthMeta (validationService.ts, mcpServer.oauth section) ──
const OAUTH_KEYS = [
  'source',
  'allowedGrantScopes',
  'scopes',
  'authorizationServerHint',
  'expectedRegistration',
  'providerConsoleUrl',
  'setupGuide',
  'verification',
]
const VERIFICATION_KEYS = ['status', 'checkedAt', 'note']
const SCOPE_TOKEN_RE = /^[\x21\x23-\x5B\x5D-\x7E]+$/
const HINT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CONSOLE_ASCII_RE = /^[\x21-\x7E]+$/
const CONSOLE_PREFIX_RE = /^https:\/\/[^/\\]/

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max

function remoteOAuthMetaError(oauth: unknown): string | null {
  if (!isObj(oauth)) return 'oauth must be an object'
  const extra = Object.keys(oauth).find(k => !OAUTH_KEYS.includes(k))
  if (extra !== undefined) return `oauth.${extra}: Unsupported field`
  if (oauth.source !== 'remote') return 'oauth.source'
  const g = oauth.allowedGrantScopes
  if (
    !Array.isArray(g) ||
    g.length < 1 ||
    g.length > 2 ||
    g.some(x => x !== 'user' && x !== 'context') ||
    new Set(g).size !== g.length
  ) {
    return 'oauth.allowedGrantScopes'
  }
  if (oauth.scopes !== undefined) {
    const s = oauth.scopes
    if (!Array.isArray(s) || s.length > 50) return 'oauth.scopes'
    if (s.some(x => !bounded(x, 256) || !SCOPE_TOKEN_RE.test(x))) return 'oauth.scopes[i]'
    if (new Set(s).size !== s.length) return 'oauth.scopes duplicate'
  }
  if (
    oauth.authorizationServerHint !== undefined &&
    (typeof oauth.authorizationServerHint !== 'string' ||
      !HINT_RE.test(oauth.authorizationServerHint))
  ) {
    return 'oauth.authorizationServerHint'
  }
  if (!['cimd', 'dcr', 'pre-registered'].includes(oauth.expectedRegistration as string)) {
    return 'oauth.expectedRegistration'
  }
  if (oauth.providerConsoleUrl !== undefined) {
    const u = oauth.providerConsoleUrl
    if (!bounded(u, 512) || !CONSOLE_ASCII_RE.test(u) || !CONSOLE_PREFIX_RE.test(u)) {
      return 'oauth.providerConsoleUrl'
    }
    let parsed: URL
    try {
      parsed = new URL(u)
    } catch {
      return 'oauth.providerConsoleUrl'
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      return 'oauth.providerConsoleUrl'
    }
  }
  if (oauth.setupGuide !== undefined && !bounded(oauth.setupGuide, 4000)) return 'oauth.setupGuide'
  if (oauth.verification !== undefined) {
    const v = oauth.verification
    if (!isObj(v)) return 'oauth.verification'
    const vExtra = Object.keys(v).find(k => !VERIFICATION_KEYS.includes(k))
    if (vExtra !== undefined) return `oauth.verification.${vExtra}: Unsupported field`
    if (!['verified', 'untested', 'known-issue'].includes(v.status as string)) {
      return 'oauth.verification.status'
    }
    if (v.checkedAt !== undefined) {
      const d = v.checkedAt
      if (
        typeof d !== 'string' ||
        !DATE_RE.test(d) ||
        new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d
      ) {
        return 'oauth.verification.checkedAt'
      }
    }
    if (v.note !== undefined && !bounded(v.note, 500)) return 'oauth.verification.note'
  }
  return null
}

function buildRow(
  body: PushRemoteMcpEntryBody,
  publisher: RegistryPublisher,
  validateOAuth: boolean
): Record<string, unknown> & { name: string } {
  if (!UNSCOPED_NAME_REGEX.test(body.name) && !SCOPED_NAME_REGEX.test(body.name)) {
    fail(`invalid entry name ${JSON.stringify(body.name)}`)
  }
  const version = body.version ?? '1.0.0'
  const entryType = body.entryType ?? 'mcp-server'
  const mcp = body.mcpServer
  if (validateOAuth && entryType === 'mcp-server' && mcp?.oauth !== undefined) {
    if (mcp.serverMode !== 'remote') fail('mcpServer.oauth only valid for serverMode=remote')
    const err = remoteOAuthMetaError(mcp.oauth)
    if (err) fail(`mcpServer.${err}`)
  }
  const [major, minor, patch] = version.split('.').map(Number)
  const { ownerType, ownerId } = resolveOwner(body.name, publisher)

  // Same field list as createEntry's `mcpMeta` object.
  const mcpMeta =
    entryType === 'mcp-server' && mcp
      ? {
          imageRef: undefined,
          port: undefined,
          tools: undefined,
          docsUrl: mcp.docsUrl,
          command: undefined,
          credentialSchema: undefined,
          remoteEndpoints: mcp.remoteEndpoints,
          egressSummary: mcp.egressSummary,
          authHeaders: mcp.authHeaders,
          oauth: mcp.oauth,
        }
      : null

  const now = new Date().toISOString()
  const row = {
    id: randomUUID(),
    name: body.name,
    version,
    entry_type: entryType,
    description: 'Remote MCP connector',
    author: 'catalog',
    contact_email: null,
    origin: 'human-authored',
    category: 'productivity',
    tags: [],
    visibility: 'public',
    content_creator_tag: 'api-owner',
    config_creator_tag: 'api-owner',
    trust_level: 'mid',
    quality_tier: 'unverified',
    status: 'published',
    channel: 'stable',
    deprecated_at: null,
    version_major: major,
    version_minor: minor,
    version_patch: patch,
    version_prerelease: null,
    downloads: 0,
    installs: 0,
    created_at: now,
    updated_at: now,
    revision: 1,
    server_mode: mcp?.serverMode ?? null,
    transport: mcp?.transport ?? null,
    recipe_type: null,
    mcp_server_meta: mcpMeta,
    recipe_meta: null,
    hook_meta: null,
    artifact_refs: {},
    owner_type: ownerType,
    owner_id: ownerId,
  }
  return JSON.parse(JSON.stringify(row))
}

/** A row the registry could have stored; throws on anything it would reject. */
export function registryEntryRow(
  body: PushRemoteMcpEntryBody,
  publisher: RegistryPublisher
): Record<string, unknown> & { name: string } {
  return buildRow(body, publisher, true)
}

/**
 * A row whose oauth block (or `serverMode`) the registry would reject at
 * publish. Owner binding and the name grammar still apply. Use it only to prove
 * control-api's own validation holds when the registry's does not (an older or
 * misconfigured registry, or a direct database write).
 */
export function malformedRow(
  body: PushRemoteMcpEntryBody,
  publisher: RegistryPublisher
): Record<string, unknown> & { name: string } {
  return buildRow(body, publisher, false)
}
