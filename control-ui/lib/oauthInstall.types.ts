// Wire + form types for the OAuth install-from-UI wizard (Slice 1, S1-U4).
// The submit shape mirrors the frozen control-api contract
// (routes/admin/registry.ts InstallOAuthInputSchema): `oauth.id` is NEVER sent —
// control-api derives and validates it (D-B5).
import type { GenericConfigSuggestion, GenericOAuthKnobs } from './oauthGeneric.types'

export type OAuthGrantScope = 'user' | 'context'

// The frozen catalog block carried under `mcp_server_meta.oauth` (S1-U1 contract).
// `genericConfig` is the Slice-3 generic-carril suggestion (E-19.6): a partial set of
// wire knobs the catalog SUGGESTS for a `provider:'generic'` entry. It is parsed
// defensively and never auto-applied — the wizard seeds from it, the admin confirms,
// and control-api arbitrates (S-4). A baked (non-generic) entry carries none.
export type CatalogOAuthBlock = {
  provider: string
  grantScope?: OAuthGrantScope
  scopes?: string[]
  genericConfig?: GenericConfigSuggestion
}

export type OAuthSecretMode = 'managed' | 'reference'

// Managed mode: the operator types client_id/client_secret and control-api
// creates the Secret with canonical keys.
export type OAuthManagedSecretInput = {
  mode: 'managed'
  clientId: string
  clientSecret: string
}

// Reference mode: the operator points at an existing Secret and names the keys
// that hold the id and the secret.
export type OAuthReferenceSecretInput = {
  mode: 'reference'
  secretName: string
  clientIdKey: string
  clientSecretKey: string
}

export type OAuthSecretInput = OAuthManagedSecretInput | OAuthReferenceSecretInput

// The `oauth` sub-object attached to POST /admin/registry/install. `secret` is optional
// because a public generic client (DA-1) carries none; a baked install always sends it.
// `generic` is present only for the `provider:'generic'` carril (S3-B4).
export type OAuthInstallSubmit = {
  scopes?: string[]
  grantScope?: OAuthGrantScope
  secret?: OAuthSecretInput
  generic?: GenericOAuthKnobs
}

// GET /admin/oauth/providers/:id/credential-manifest response.
export type OAuthCredentialField = {
  name: string
  label: string
  secret: boolean
  required: boolean
  help?: string
}

export type OAuthCredentialManifest = {
  provider: string
  fields: OAuthCredentialField[]
}

// GET /admin/mcp-secrets item — names + keys only, never values (E-16.1).
export type McpSecretSummary = {
  name: string
  keys: string[]
}
