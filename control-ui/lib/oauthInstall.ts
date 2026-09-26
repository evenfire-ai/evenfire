import type { RegistryEntry } from './api'
import { readGenericImmutables } from './oauthGeneric'
import type { GenericConfigSuggestion, GenericImmutableView } from './oauthGeneric.types'
import type {
  CatalogOAuthBlock,
  McpSecretSummary,
  OAuthGrantScope,
  OAuthInstallSubmit,
  OAuthReferenceSecretInput,
} from './oauthInstall.types'

// Public callback base URL for the exact redirect URI (D-B4). It is a control-api
// server env (CONTROL_API_OAUTH_CALLBACK_BASE_URL) and is NOT reachable from the
// browser, so control-ui reads a mirror. When it is unset the wizard refuses to
// invent a URI from window.location (a control-ui origin behind the funnel would
// guide the operator to register a broken redirect at the provider); it shows a
// "not configured" state instead, and control-api independently rejects the
// install with the same reason. Read lazily (not a module-load const) so the
// value reflects the deployment env at call time — Next still inlines the
// NEXT_PUBLIC_* reference at build for the browser bundle.
export function oauthCallbackBaseUrl(): string {
  return process.env.NEXT_PUBLIC_CONTROL_API_OAUTH_CALLBACK_BASE_URL?.trim() ?? ''
}

const GRANT_SCOPES: ReadonlySet<string> = new Set<OAuthGrantScope>(['user', 'context'])

const GENERIC_STRING_KNOBS = [
  'authorizationEndpoint',
  'tokenEndpoint',
  'refreshEndpoint',
  'resource',
] as const
const GENERIC_ENUM_KNOBS: Record<string, readonly string[]> = {
  tokenRequestFormat: ['form', 'json'],
  tokenAuthMethod: ['body', 'basic'],
  scopeSeparator: ['space', 'comma'],
}
const GENERIC_BOOL_KNOBS = [
  'sendScope',
  'usePkce',
  'includeResponseType',
  'supportsRefresh',
] as const

/**
 * Defensively parse the catalog's `genericConfig` suggestion (E-19.6): keep only known
 * knob keys with the right primitive type; drop anything unexpected. Returns undefined
 * when nothing usable survives, so a malformed suggestion never reaches the wizard or
 * crashes the render (§9 risk 7). The catalog only SUGGESTS — control-api arbitrates.
 */
function parseGenericConfig(raw: unknown): GenericConfigSuggestion | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const src = raw as Record<string, unknown>
  const out: GenericConfigSuggestion = {}

  for (const key of GENERIC_STRING_KNOBS) {
    const v = src[key]
    if (typeof v === 'string' && v.length > 0) out[key] = v
  }
  for (const [key, allowed] of Object.entries(GENERIC_ENUM_KNOBS)) {
    const v = src[key]
    if (typeof v === 'string' && allowed.includes(v)) {
      ;(out as Record<string, unknown>)[key] = v
    }
  }
  for (const key of GENERIC_BOOL_KNOBS) {
    const v = src[key]
    if (typeof v === 'boolean') out[key] = v
  }
  const extra = src.extraAuthorizeParams
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    const record: Record<string, string> = {}
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      if (typeof v === 'string') record[k] = v
    }
    if (Object.keys(record).length > 0) out.extraAuthorizeParams = record
  }

  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Preview mirror of control-api's `deriveOAuthClientId` (routes/admin/registry.ts).
 * The operator NEVER types `oauth.id`; control-api derives and validates it at
 * install (D-B5). This mirror only renders the read-only preview so the operator
 * can see the callback coordinate before submitting — control-api stays the
 * single authority, so a drift here is a cosmetic preview bug, not a wrong write.
 */
export function deriveOAuthClientIdPreview(serverName: string): string {
  return serverName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}

/**
 * The exact redirect URI the operator registers at the provider (D-B4):
 * `{base}/api/v1/oauth-callback/{oauth.id}`. Returns null when the base URL is
 * not configured or the id is empty — the caller shows a "not configured" notice
 * rather than a broken URI.
 */
export function buildOAuthRedirectUri(base: string | undefined, oauthId: string): string | null {
  const trimmedBase = (base ?? '').trim().replace(/\/+$/, '')
  if (!trimmedBase || !oauthId) return null
  return `${trimmedBase}/api/v1/oauth-callback/${encodeURIComponent(oauthId)}`
}

/**
 * Extracts and shallow-validates the frozen `mcp_server_meta.oauth` block. Returns
 * null when the entry declares no OAuth (the caller then uses the ordinary
 * connector install). Only fields the wizard understands survive. For a
 * `provider:'generic'` entry the catalog's `genericConfig` suggestion is parsed
 * defensively and kept (E-19.6); the wizard seeds from it, the admin confirms, and
 * control-api arbitrates (S-4).
 */
export function getCatalogOAuthBlock(
  entry: RegistryEntry | null | undefined
): CatalogOAuthBlock | null {
  const raw = entry?.mcp_server_meta?.oauth
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const block = raw as Record<string, unknown>
  if (typeof block.provider !== 'string' || block.provider.trim().length === 0) return null

  const result: CatalogOAuthBlock = { provider: block.provider }
  if (typeof block.grantScope === 'string' && GRANT_SCOPES.has(block.grantScope)) {
    result.grantScope = block.grantScope as OAuthGrantScope
  }
  if (Array.isArray(block.scopes)) {
    result.scopes = block.scopes.filter((s): s is string => typeof s === 'string')
  }
  const genericConfig = parseGenericConfig(block.genericConfig)
  if (genericConfig) result.genericConfig = genericConfig
  return result
}

/**
 * Parses the free-text scopes field into a clean, de-duplicated list. Operators
 * paste scopes separated by whitespace, newlines, or commas; all are normalised.
 */
export function parseScopesInput(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of text.split(/[\s,]+/)) {
    const scope = token.trim()
    if (scope && !seen.has(scope)) {
      seen.add(scope)
      out.push(scope)
    }
  }
  return out
}

/** Renders a scope list back into the editable textarea (one per line). */
export function formatScopesForInput(scopes: readonly string[]): string {
  return scopes.join('\n')
}

/**
 * GAP-6 UI gate: a baked OAuth server must never be submitted with an empty scope
 * list. The wizard blocks submit until the operator has at least one scope,
 * mirroring the server's reject (control-api computes an effective scope list and
 * rejects `[]`).
 */
export function scopesAreSatisfied(scopes: readonly string[]): boolean {
  return scopes.length > 0
}

// The OAuth fields that are CEL-immutable on the mcpserver CRD (D-B7): a change
// means delete + recreate, so the edit form shows them read-only. `scopes` is
// deliberately absent — it is editable (D-B6). `generic` is present only for the
// `source:'generic'` carril: its endpoints and wire knobs are all create-only
// (GENERIC-IMM / GENERIC-SECRET-IMM) and shown read-only alongside the base fields.
export type OAuthImmutableFields = {
  id: string
  provider: string
  grantScope: OAuthGrantScope | ''
  generic?: GenericImmutableView
}

/**
 * Reads the immutable OAuth fields off an installed McpServer's `spec.oauth` for a
 * read-only display in the edit form (D-B7). Returns null when the server carries
 * no OAuth block. A generic connector has no `provider` (it is discriminated by
 * `source:'generic'`, DEC-28); it is surfaced with a synthetic `provider:'generic'`
 * label plus its read-only endpoints/knobs.
 */
export function extractOAuthImmutables(
  spec: Record<string, unknown> | null | undefined
): OAuthImmutableFields | null {
  const raw = spec?.oauth
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const oauth = raw as Record<string, unknown>
  const grantScope =
    oauth.grantScope === 'user' || oauth.grantScope === 'context' ? oauth.grantScope : ''
  const id = typeof oauth.id === 'string' ? oauth.id : ''

  if (oauth.source === 'generic') {
    return {
      id,
      provider: 'generic',
      grantScope,
      generic: readGenericImmutables(oauth),
    }
  }

  const provider = typeof oauth.provider === 'string' ? oauth.provider : ''
  if (!provider) return null
  return { id, provider, grantScope }
}

/**
 * The name of the Secret that holds this OAuth connector's client credential
 * (D-B7 edit view). It is `spec.oauth.clientSecretRef.name` (falling back to
 * `clientIdRef.name` when the pair shares one Secret) — for a managed install
 * this is `${serverName}-oauth-client`, for a referenced install it is whatever
 * the operator named. Returns null when no ref is present.
 */
export function oauthClientSecretRefName(
  spec: Record<string, unknown> | null | undefined
): string | null {
  const raw = spec?.oauth
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const oauth = raw as Record<string, unknown>
  for (const key of ['clientSecretRef', 'clientIdRef']) {
    const ref = oauth[key]
    if (
      ref &&
      typeof ref === 'object' &&
      typeof (ref as Record<string, unknown>).name === 'string'
    ) {
      return (ref as { name: string }).name
    }
  }
  return null
}

/**
 * Reference-mode pre-check (Fam. B(1)): the Secret must exist and carry both named
 * keys BEFORE submit, so the wizard never writes a CR whose refs dangle. Returns a
 * human message when something is missing, else null. `GET /admin/mcp-secrets`
 * returns names + keys only (never values), so this is safe to run client-side.
 */
export function referenceSecretIssue(
  ref: Pick<OAuthReferenceSecretInput, 'secretName' | 'clientIdKey' | 'clientSecretKey'>,
  secrets: readonly McpSecretSummary[]
): string | null {
  const secretName = ref.secretName.trim()
  const clientIdKey = ref.clientIdKey.trim()
  const clientSecretKey = ref.clientSecretKey.trim()
  if (!secretName) return 'Choose an existing Secret.'
  if (!clientIdKey || !clientSecretKey) return 'Name the Client ID key and the Client Secret key.'

  const match = secrets.find(secret => secret.name === secretName)
  if (!match) return `Secret "${secretName}" was not found in the MCP servers namespace.`

  const keySet = new Set(match.keys)
  const missing = [clientIdKey, clientSecretKey].filter(key => !keySet.has(key))
  if (missing.length > 0) {
    return `Secret "${secretName}" is missing key(s): ${missing.join(', ')}.`
  }
  return null
}
