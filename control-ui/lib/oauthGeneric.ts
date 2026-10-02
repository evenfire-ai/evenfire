// Pure, testable state machine for the `source:'generic'` install wizard (S3-B4).
// The form state is the single source of truth; each event transforms it with a pure
// function. Nothing auto-applies: discovery/catalog SUGGEST, the operator confirms, and
// control-api arbitrates (S-4). This module owns no network and no React.
import type {
  GenericClientMode,
  GenericConfigSuggestion,
  GenericDiscoveryPrefill,
  GenericExtraParam,
  GenericFieldOrigin,
  GenericFormState,
  GenericImmutableView,
  GenericOAuthInstallSubmit,
  GenericOAuthKnobs,
  GenericTouchKey,
  GenericWizardDefaults,
} from './oauthGeneric.types'
import type { OAuthGrantScope, OAuthSecretInput } from './oauthInstall.types'

// The wizard defaults (§5.1 "Default wizard" column = D-A1 defaults). The server writes
// no defaults (fidelity to a CRD with none); the wizard is the sole default provider.
export const GENERIC_WIZARD_DEFAULTS: GenericWizardDefaults = {
  tokenRequestFormat: 'form',
  tokenAuthMethod: 'body',
  scopeSeparator: 'space',
  sendScope: true,
  usePkce: true,
  includeResponseType: true,
  supportsRefresh: true,
}

// The touch/origin keys, in a fixed order, so origin maps are always fully populated.
const TOUCH_KEYS: readonly GenericTouchKey[] = [
  'authorizationEndpoint',
  'tokenEndpoint',
  'refreshEndpoint',
  'resource',
  'tokenRequestFormat',
  'tokenAuthMethod',
  'scopeSeparator',
  'sendScope',
  'usePkce',
  'includeResponseType',
  'supportsRefresh',
  'scopes',
]

// The subset of fields that generic discovery can inform (§5.1, "fuentes ∋ discovery").
// Apply only ever touches these; every other field is catalog/manual only.
const DISCOVERY_FIELDS: readonly GenericTouchKey[] = [
  'authorizationEndpoint',
  'tokenEndpoint',
  'resource',
  'tokenAuthMethod',
  'usePkce',
  'supportsRefresh',
  'scopes',
]

let paramCounter = 0

/** Stable, unique id for an extra-param row (non-index React key). */
function newParamId(): string {
  paramCounter += 1
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `gxp-${paramCounter}-${rand}`
}

/** A fresh, empty extra-param row for the editor. */
export function newExtraParamRow(): GenericExtraParam {
  return { id: newParamId(), key: '', value: '' }
}

function extraParamsFromRecord(record: Record<string, string> | undefined): GenericExtraParam[] {
  if (!record) return []
  return Object.entries(record).map(([key, value]) => ({ id: newParamId(), key, value }))
}

/**
 * Fold the extra-param editor rows into the wire record. Rows with a blank key are
 * dropped (a half-typed row is not a param); a later duplicate key wins (last write).
 */
export function extraParamsToRecord(rows: readonly GenericExtraParam[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) out[key] = row.value
  }
  return out
}

function fullOrigin(value: GenericFieldOrigin): Record<GenericTouchKey, GenericFieldOrigin> {
  const origin = {} as Record<GenericTouchKey, GenericFieldOrigin>
  for (const key of TOUCH_KEYS) origin[key] = value
  return origin
}

/**
 * Mount-time seed (§5.3, "Montaje del wizard"). Each knob ← the catalog suggestion when
 * present and of the right shape, else the wizard default; `origin` records which. The
 * catalog SUGGESTS: an operator can still change anything afterwards. `clientMode` is
 * confidential when the catalog pins `tokenAuthMethod:'basic'` (a Basic client needs a
 * secret), else public (D-A5). `scopes` seed from the catalog's top-level scope list.
 */
export function seedFromCatalog(
  defaults: GenericWizardDefaults,
  suggestion?: GenericConfigSuggestion,
  catalogScopes?: readonly string[]
): GenericFormState {
  const s = suggestion ?? {}
  const origin = fullOrigin('default')

  function str(key: 'authorizationEndpoint' | 'tokenEndpoint' | 'refreshEndpoint' | 'resource') {
    const v = s[key]
    if (typeof v === 'string' && v.length > 0) {
      origin[key] = 'catalog'
      return v
    }
    return ''
  }
  function enumField<T extends string>(
    key: 'tokenRequestFormat' | 'tokenAuthMethod' | 'scopeSeparator',
    allowed: readonly T[],
    fallback: T
  ): T {
    const v = s[key]
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) {
      origin[key] = 'catalog'
      return v as T
    }
    return fallback
  }
  function bool(key: 'sendScope' | 'usePkce' | 'includeResponseType' | 'supportsRefresh'): boolean {
    const v = s[key]
    if (typeof v === 'boolean') {
      origin[key] = 'catalog'
      return v
    }
    return defaults[key]
  }

  const tokenAuthMethod = enumField(
    'tokenAuthMethod',
    ['body', 'basic'] as const,
    defaults.tokenAuthMethod
  )
  const scopes = (catalogScopes ?? []).filter(x => typeof x === 'string')
  if (scopes.length > 0) origin.scopes = 'catalog'

  return {
    authorizationEndpoint: str('authorizationEndpoint'),
    tokenEndpoint: str('tokenEndpoint'),
    refreshEndpoint: str('refreshEndpoint'),
    resource: str('resource'),
    tokenRequestFormat: enumField(
      'tokenRequestFormat',
      ['form', 'json'] as const,
      defaults.tokenRequestFormat
    ),
    tokenAuthMethod,
    scopeSeparator: enumField(
      'scopeSeparator',
      ['space', 'comma'] as const,
      defaults.scopeSeparator
    ),
    sendScope: bool('sendScope'),
    usePkce: bool('usePkce'),
    includeResponseType: bool('includeResponseType'),
    supportsRefresh: bool('supportsRefresh'),
    extraAuthorizeParams: extraParamsFromRecord(s.extraAuthorizeParams),
    scopes,
    // A Basic client needs a secret, so a catalog that pins basic implies confidential.
    clientMode: tokenAuthMethod === 'basic' ? 'confidential' : 'public',
    detected: null,
    touched: new Set<GenericTouchKey>(),
    origin,
  }
}

/** Record the operator's edit of a field: mark touched, flip origin to 'edited'. */
export function markEdited(state: GenericFormState, field: GenericTouchKey): GenericFormState {
  const touched = new Set(state.touched)
  touched.add(field)
  return { ...state, touched, origin: { ...state.origin, [field]: 'edited' } }
}

/**
 * Edit an enum knob, upholding the basic⇒confidential invariant that `seedFromCatalog`
 * and `applyDiscoveryPrefill` also maintain: selecting HTTP Basic client authentication
 * forces a confidential client (a Basic header needs a client secret). Without this, the
 * client-type toggle renders disabled (forced confidential via `effectiveClientMode`)
 * while `clientMode` stays `'public'`, so the form could never validate and the one
 * control that could fix it is disabled. Marks the edited field touched.
 */
export function editEnumKnob(
  state: GenericFormState,
  field: 'tokenRequestFormat' | 'tokenAuthMethod' | 'scopeSeparator',
  value: string
): GenericFormState {
  const next = markEdited({ ...state, [field]: value } as GenericFormState, field)
  if (field === 'tokenAuthMethod' && value === 'basic') {
    return { ...next, clientMode: 'confidential' }
  }
  return next
}

/**
 * Apply a discovery result (§5.3, "Apply"). Only ever called on an explicit operator
 * click — Detect alone stores `detected` and leaves the form untouched (invariant 8).
 * For each field discovery can inform: value ← detected, UNLESS the operator has already
 * edited it (`touched`) or discovery carries no datum for it ("sin dato nunca
 * sobrescribe"). `scopes` fill only when currently empty. Idempotent by construction:
 * Apply never marks a field touched, and re-applying the same result yields the same
 * values, so `apply(apply(s,d),d) === apply(s,d)`.
 */
export function applyDiscoveryPrefill(
  state: GenericFormState,
  prefill: GenericDiscoveryPrefill
): GenericFormState {
  const next: GenericFormState = { ...state, origin: { ...state.origin } }

  const set = <K extends GenericTouchKey>(field: K, value: GenericFormState[K]) => {
    if (state.touched.has(field)) return // manual wins
    ;(next[field] as GenericFormState[K]) = value
    next.origin[field] = 'detected'
  }

  set('authorizationEndpoint', prefill.endpoints.authorization)
  set('tokenEndpoint', prefill.endpoints.token)

  // "Sin dato nunca sobrescribe": each suggestion is gated on the AS actually having
  // advertised the underlying metadata, read off `capabilities` (the raw arrays).
  if (prefill.resource) set('resource', prefill.resource)
  if (prefill.capabilities.tokenEndpointAuthMethods.length > 0) {
    set('tokenAuthMethod', prefill.suggested.tokenAuthMethod)
  }
  if (prefill.capabilities.codeChallengeMethods.length > 0) {
    set('usePkce', prefill.suggested.usePkce)
  }
  if (prefill.capabilities.grantTypes.length > 0) {
    set('supportsRefresh', prefill.suggested.supportsRefresh)
  }

  // Scopes fill only when empty AND not operator-edited: an operator-typed or
  // catalog-seeded list is kept, and an explicitly cleared list is respected (§5.3,
  // "nunca sobre edited").
  if (
    !state.touched.has('scopes') &&
    state.scopes.length === 0 &&
    prefill.scopesSupported.length > 0
  ) {
    next.scopes = [...prefill.scopesSupported]
    next.origin.scopes = 'detected'
  }

  // `tokenAuthMethod` may have moved to 'basic'; a Basic client must be confidential.
  if (next.tokenAuthMethod === 'basic') next.clientMode = 'confidential'

  return next
}

const HAS_SPACE = /\s/

function urlIssue(raw: string, label: string): string | undefined {
  const value = raw.trim()
  if (HAS_SPACE.test(value)) return `${label} must not contain spaces.`
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return `${label} must be an absolute https URL.`
  }
  if (parsed.protocol !== 'https:') return `${label} must use https.`
  if (!parsed.hostname.includes('.')) return `${label} must have a fully-qualified hostname.`
  return undefined
}

/**
 * Client-side FORM validation for the generic wizard (UX only — the 422 from control-api
 * is the authority). Returns a `field → message` map keyed by wizard field ids. Covers:
 * required/absolute-https endpoints, optional refresh/resource URLs, `basic ⇒
 * confidential`, `sendScope ⇒ ≥1 scope` (DA-4/GAP-6), and the extra-param bounds.
 */
export function genericFormIssues(state: GenericFormState): Record<string, string> {
  const issues: Record<string, string> = {}

  const authIssue = state.authorizationEndpoint.trim()
    ? urlIssue(state.authorizationEndpoint, 'Authorization endpoint')
    : 'Authorization endpoint is required.'
  if (authIssue) issues.authorizationEndpoint = authIssue

  const tokenIssue = state.tokenEndpoint.trim()
    ? urlIssue(state.tokenEndpoint, 'Token endpoint')
    : 'Token endpoint is required.'
  if (tokenIssue) issues.tokenEndpoint = tokenIssue

  if (state.refreshEndpoint.trim()) {
    const issue = urlIssue(state.refreshEndpoint, 'Refresh endpoint')
    if (issue) issues.refreshEndpoint = issue
  }
  if (state.resource.trim()) {
    const issue = urlIssue(state.resource, 'Resource')
    if (issue) issues.resource = issue
  }

  if (state.tokenAuthMethod === 'basic' && state.clientMode !== 'confidential') {
    issues.tokenAuthMethod =
      'Basic client authentication requires a confidential client with a client secret.'
  }

  if (state.sendScope && state.scopes.length === 0) {
    issues.scopes = 'Add at least one scope, or turn off “Send scope” to authorize without one.'
  }

  const rows = state.extraAuthorizeParams
  const nonEmpty = rows.filter(r => r.key.trim())
  if (nonEmpty.length > 16) {
    issues.extraAuthorizeParams = 'At most 16 extra authorize params are allowed.'
  } else if (nonEmpty.some(r => r.value.length > 1024)) {
    issues.extraAuthorizeParams = 'An extra authorize param value must be 1024 characters or fewer.'
  } else {
    const keys = nonEmpty.map(r => r.key.trim())
    if (new Set(keys).size !== keys.length) {
      issues.extraAuthorizeParams = 'Extra authorize param keys must be unique.'
    }
  }

  return issues
}

/** True when the generic form has no client-side blocking issue. */
export function genericFormOk(state: GenericFormState): boolean {
  return Object.keys(genericFormIssues(state)).length === 0
}

/**
 * Build the `body.oauth` sub-object for a generic install (§5.1 knob→wire). Sends the 10
 * required knobs explicitly plus the optional ones only when present. `secret` is
 * attached only for a confidential client (the caller passes it, or nothing for public).
 */
export function buildGenericSubmit(
  state: GenericFormState,
  grantScope: OAuthGrantScope,
  secret?: OAuthSecretInput
): GenericOAuthInstallSubmit {
  const generic: GenericOAuthKnobs = {
    authorizationEndpoint: state.authorizationEndpoint.trim(),
    tokenEndpoint: state.tokenEndpoint.trim(),
    tokenRequestFormat: state.tokenRequestFormat,
    tokenAuthMethod: state.tokenAuthMethod,
    scopeSeparator: state.scopeSeparator,
    sendScope: state.sendScope,
    usePkce: state.usePkce,
    includeResponseType: state.includeResponseType,
    supportsRefresh: state.supportsRefresh,
  }
  const refresh = state.refreshEndpoint.trim()
  if (refresh) generic.refreshEndpoint = refresh
  const resource = state.resource.trim()
  if (resource) generic.resource = resource
  const extra = extraParamsToRecord(state.extraAuthorizeParams)
  if (Object.keys(extra).length > 0) generic.extraAuthorizeParams = extra

  const submit: GenericOAuthInstallSubmit = {
    scopes: state.scopes,
    grantScope,
    generic,
  }
  if (secret) submit.secret = secret
  return submit
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function asBool(value: unknown): boolean {
  return value === true
}

/**
 * Read the immutable generic knobs off an installed connector's `spec.oauth` for the
 * read-only edit view (D-B7). `clientMode` is inferred from the presence of the paired
 * client refs (confidential) vs their absence (public, DA-1). Tolerant of a malformed CR
 * (missing/extra fields) — the edit view must never crash on unexpected data (§9 risk 7).
 */
export function readGenericImmutables(oauth: Record<string, unknown>): GenericImmutableView {
  const extraRaw = oauth.extraAuthorizeParams
  const extraAuthorizeParams: GenericExtraParam[] =
    extraRaw && typeof extraRaw === 'object' && !Array.isArray(extraRaw)
      ? Object.entries(extraRaw as Record<string, unknown>).map(([key, value]) => ({
          id: newParamId(),
          key,
          value: asString(value),
        }))
      : []
  const hasSecret =
    (oauth.clientSecretRef !== undefined && oauth.clientSecretRef !== null) ||
    (oauth.clientIdRef !== undefined && oauth.clientIdRef !== null)
  return {
    authorizationEndpoint: asString(oauth.authorizationEndpoint),
    tokenEndpoint: asString(oauth.tokenEndpoint),
    refreshEndpoint: asString(oauth.refreshEndpoint),
    resource: asString(oauth.resource),
    tokenRequestFormat: asString(oauth.tokenRequestFormat),
    tokenAuthMethod: asString(oauth.tokenAuthMethod),
    scopeSeparator: asString(oauth.scopeSeparator),
    sendScope: asBool(oauth.sendScope),
    usePkce: asBool(oauth.usePkce),
    includeResponseType: asBool(oauth.includeResponseType),
    supportsRefresh: asBool(oauth.supportsRefresh),
    clientMode: hasSecret ? 'confidential' : 'public',
    extraAuthorizeParams,
  }
}

/** The effective client mode: `basic` token auth forces confidential regardless of toggle. */
export function effectiveClientMode(state: GenericFormState): GenericClientMode {
  return state.tokenAuthMethod === 'basic' ? 'confidential' : state.clientMode
}
