// Read the immutable fields of a `source:'remote'` connector for the read-only edit
// view (D-B7). The producer is control-api's `buildRemoteOAuthSpec`
// (src/routes/admin/remoteMcp.ts); this module mirrors the generic carril's
// `readGenericImmutables`. It owns no network and no React — each field is a direct,
// tolerant read off `spec.oauth`, never a decision.
import type {
  RemoteClientMode,
  RemoteImmutableView,
  RemoteSecretPosture,
} from './oauthRemote.types'

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function asBool(value: unknown): boolean {
  return value === true
}
function hasRef(value: unknown): boolean {
  return value !== undefined && value !== null
}

/**
 * Read the immutable remote knobs off an installed connector's `spec.oauth`. `clientMode`
 * comes straight from the CR (the remote flow writes it explicitly, unlike generic which
 * infers it). `secretPosture` is derived directly from the CR: paired client refs ⇒
 * pre-registered `'referenced'`; confidential with no refs ⇒ `'dynamic'` (DCR); otherwise
 * `'public'`. Tolerant of a malformed CR (missing/extra fields) — the edit view must never
 * crash on unexpected data.
 */
export function readRemoteImmutables(oauth: Record<string, unknown>): RemoteImmutableView {
  const clientMode: RemoteClientMode =
    oauth.clientMode === 'confidential' ? 'confidential' : 'public'
  const referenced = hasRef(oauth.clientSecretRef) || hasRef(oauth.clientIdRef)
  const secretPosture: RemoteSecretPosture = referenced
    ? 'referenced'
    : clientMode === 'confidential'
      ? 'dynamic'
      : 'public'
  return {
    clientMode,
    authorizationEndpoint: asString(oauth.authorizationEndpoint),
    tokenEndpoint: asString(oauth.tokenEndpoint),
    registrationEndpoint: asString(oauth.registrationEndpoint),
    issuer: asString(oauth.issuer),
    resource: asString(oauth.resource),
    issForCallback: asString(oauth.issForCallback),
    bearerInBody: asBool(oauth.bearerInBody),
    supportsRefresh: asBool(oauth.supportsRefresh),
    secretPosture,
  }
}
