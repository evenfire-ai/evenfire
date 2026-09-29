// Wire + form types for the `source:'generic'` install carril (S3-B4 / DEC-28).
// The generic carril is discriminated by `mcp_server_meta.oauth.provider === 'generic'`
// (a string sentinel, never a baked provider) and writes `spec.oauth.source:'generic'`
// with an explicit set of 11 wire knobs — a 1:1 mirror of the control-api install-side
// schema (`GenericOAuthKnobsSchema`) and the CRD generic block. Nothing here is a
// decision module: each knob independently selects one fixed wire behaviour.
import type { OAuthGrantScope, OAuthSecretInput } from './oauthInstall.types'

// The 11 wire knobs sent under `body.oauth.generic`. Mirror of control-api's
// `GenericOAuthKnobs` (src/oauth/genericKnobs.ts). `extraAuthorizeParams` is a plain
// map on the wire; the form models it as an ordered list (see GenericExtraParam).
export type GenericOAuthKnobs = {
  authorizationEndpoint: string
  tokenEndpoint: string
  refreshEndpoint?: string
  resource?: string
  tokenRequestFormat: 'form' | 'json'
  tokenAuthMethod: 'body' | 'basic'
  scopeSeparator: 'space' | 'comma'
  sendScope: boolean
  usePkce: boolean
  includeResponseType: boolean
  supportsRefresh: boolean
  extraAuthorizeParams?: Record<string, string>
}

// A catalog-supplied suggestion (E-19.6): every knob optional — the catalog SUGGESTS,
// the admin confirms, control-api arbitrates (S-4). Mirror of `GenericConfigSuggestion`.
export type GenericConfigSuggestion = Partial<GenericOAuthKnobs>

// Wire returned by POST /admin/oauth/discover (E-19.5, §5.2). Mirror of control-api's
// `GenericDiscoveryPrefill`. `resource` is present only when discovery reached the AS
// through a protected-resource-metadata document. `capabilities` are the raw AS
// advertisements (shown in the "Detected" panel); `suggested` are the deterministic,
// documented derivations the wizard offers on Apply.
export type GenericDiscoveryPrefill = {
  issuer: string
  endpoints: { authorization: string; token: string }
  resource?: string
  scopesSupported: string[]
  capabilities: {
    codeChallengeMethods: string[]
    tokenEndpointAuthMethods: string[]
    grantTypes: string[]
  }
  suggested: {
    usePkce: boolean
    tokenAuthMethod: 'body' | 'basic'
    supportsRefresh: boolean
  }
}

// The confidential/public client selector. `basic` token auth forces `confidential`
// (a Basic auth header needs a client secret).
export type GenericClientMode = 'public' | 'confidential'

// The provenance of each field's current value, surfaced as a badge so the operator
// can audit where every value came from (S-4: catalog suggests, discovery suggests,
// the admin confirms — the origin stays visible).
export type GenericFieldOrigin = 'default' | 'catalog' | 'detected' | 'edited'

// Fields that participate in touched-tracking + origin badges. `extraAuthorizeParams`
// is excluded: it has no standard discovery metadata and is catalog/manual only.
export type GenericTouchKey =
  | 'authorizationEndpoint'
  | 'tokenEndpoint'
  | 'refreshEndpoint'
  | 'resource'
  | 'tokenRequestFormat'
  | 'tokenAuthMethod'
  | 'scopeSeparator'
  | 'sendScope'
  | 'usePkce'
  | 'includeResponseType'
  | 'supportsRefresh'
  | 'scopes'

// One extra authorize-param row. `id` is a stable key assigned at row creation so the
// list renders with a non-index React key even as rows reorder/remove.
export type GenericExtraParam = {
  id: string
  key: string
  value: string
}

// The full generic wizard state. It is the SINGLE source of truth: every event
// (mount, edit, Apply) transforms it with a pure function; nothing auto-applies (S-4).
export type GenericFormState = {
  authorizationEndpoint: string
  tokenEndpoint: string
  refreshEndpoint: string
  resource: string
  tokenRequestFormat: 'form' | 'json'
  tokenAuthMethod: 'body' | 'basic'
  scopeSeparator: 'space' | 'comma'
  sendScope: boolean
  usePkce: boolean
  includeResponseType: boolean
  supportsRefresh: boolean
  extraAuthorizeParams: GenericExtraParam[]
  scopes: string[]
  clientMode: GenericClientMode
  // Last successful discovery result. Held until the operator clicks Apply; Detect
  // alone never mutates the form (invariant 8).
  detected: GenericDiscoveryPrefill | null
  // Fields the operator has edited — an edited field is never overwritten by Apply.
  touched: ReadonlySet<GenericTouchKey>
  // Where each field's current value came from (badge source).
  origin: Record<GenericTouchKey, GenericFieldOrigin>
}

// The knob defaults the wizard seeds a fresh generic form with (§5.1, "Default wizard"
// column). Endpoints/resource default empty; the booleans/enums carry the D-A1 defaults.
export type GenericWizardDefaults = {
  tokenRequestFormat: 'form' | 'json'
  tokenAuthMethod: 'body' | 'basic'
  scopeSeparator: 'space' | 'comma'
  sendScope: boolean
  usePkce: boolean
  includeResponseType: boolean
  supportsRefresh: boolean
}

// Read-only projection of an installed generic connector's `spec.oauth` for the edit
// view (D-B7). Everything is create-only (GENERIC-IMM / GENERIC-SECRET-IMM): a change
// means delete + recreate.
export type GenericImmutableView = {
  authorizationEndpoint: string
  tokenEndpoint: string
  refreshEndpoint: string
  resource: string
  tokenRequestFormat: string
  tokenAuthMethod: string
  scopeSeparator: string
  sendScope: boolean
  usePkce: boolean
  includeResponseType: boolean
  supportsRefresh: boolean
  clientMode: GenericClientMode
  extraAuthorizeParams: GenericExtraParam[]
}

// The `oauth` sub-object the generic branch attaches to POST /admin/registry/install.
// `secret` is absent for a public client (DA-1); `generic` carries the wire knobs.
export type GenericOAuthInstallSubmit = {
  scopes: string[]
  grantScope: OAuthGrantScope
  secret?: OAuthSecretInput
  generic: GenericOAuthKnobs
}
