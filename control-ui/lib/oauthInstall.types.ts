// Wire + form types for the OAuth install-from-UI wizard (Slice 1, S1-U4).
// The submit shape mirrors the frozen control-api contract
// (routes/admin/registry.ts InstallOAuthInputSchema): `oauth.id` is NEVER sent —
// control-api derives and validates it (D-B5).

export type OAuthGrantScope = 'user' | 'context'

// The frozen catalog block carried under `mcp_server_meta.oauth` (S1-U1 contract).
// `genericConfig` is Slice-3-only and deliberately not modelled here: Slice 1
// serves only the 8 baked providers and never reads generic config (S-4).
export type CatalogOAuthBlock = {
  provider: string
  grantScope?: OAuthGrantScope
  scopes?: string[]
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

// The `oauth` sub-object attached to POST /admin/registry/install.
export type OAuthInstallSubmit = {
  scopes?: string[]
  grantScope?: OAuthGrantScope
  secret: OAuthSecretInput
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
