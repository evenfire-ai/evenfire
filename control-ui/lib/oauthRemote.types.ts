// Read-only projection types for the `source:'remote'` OAuth carril (DEC-28 / REMOTE-*).
// A remote connector is discovered against a live MCP server; control-api's
// `buildRemoteOAuthSpec` (src/routes/admin/remoteMcp.ts) writes `spec.oauth.source:'remote'`
// with NO `provider` (REMOTE-FORBID-PROVIDER) — the carril is discriminated by `source`.
// Nothing here is a decision module: each field is a direct read off the CR, mirroring
// how the generic carril projects its immutables.

// The confidential/public client selector, as written by the remote install flow.
export type RemoteClientMode = 'public' | 'confidential'

// The secret posture of a remote connector, read directly off the CR:
// - 'referenced': paired client refs present ⇒ pre-registered confidential; the client
//   secret lives in the named K8s Secret.
// - 'dynamic':    confidential with no refs ⇒ DCR; the secret lives in the encrypted
//   `dynamic_clients` store, keyed by `oauth.id`.
// - 'public':     a public client ⇒ no client secret at all (CIMD-public or DCR-public).
export type RemoteSecretPosture = 'referenced' | 'dynamic' | 'public'

// Read-only projection of an installed remote connector's `spec.oauth` for the edit view
// (D-B7). These are the fields IMM-6 marks create-only: a change means delete + recreate.
// `scopes` is deliberately absent — it is editable (D-B6). `id` (the client_id / callback
// coordinate) is surfaced by the shared base fields, not repeated here.
export type RemoteImmutableView = {
  clientMode: RemoteClientMode
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
  issuer: string
  resource: string
  issForCallback: string
  bearerInBody: boolean
  supportsRefresh: boolean
  secretPosture: RemoteSecretPosture
}
