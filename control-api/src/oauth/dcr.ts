import { type PinnedFetchError, type PinnedTransport, pinnedFetch } from '../http/pinnedFetch.js'
import type { DnsResolver, ValidationError } from '../http/validateMcpServerSpec.js'
import { type Logger, rootLogger } from '../observability/logger.js'
import type { DiscoveryResult } from './discovery.js'

/**
 * Dynamic Client Registration client (RFC 7591), spec 02 C2 / D-5 / DEC-18.
 *
 * When discovery (`discovery.ts`) resolves the registration mode to `dcr` — the
 * AS offers neither a pre-registered client nor CIMD — control-api registers a
 * client dynamically against the AS's registration endpoint and the caller
 * persists the returned credentials in the encrypted `dynamic_clients` store.
 *
 * Mirrors `discovery.ts`: pure request builder, effectful register with a typed
 * outcome and injectable deps. The registration endpoint was already kernel-
 * validated during discovery; the POST here re-pins it through `pinnedFetch`
 * (single hop, no redirect following) so it is re-validated at connect time too
 * (S-1 structural). This module NEVER follows a 3xx to a `Location` (a redirect
 * is fail-closed `redirect_blocked`) — an AS re-pointing the registration POST to
 * an internal host is a classic SSRF, not a legitimate flow.
 */

const DCR_TIMEOUT_MS = 15_000

/** Field name used when reporting a kernel rejection of the registration endpoint. */
const REGISTRATION_ENDPOINT_FIELD = 'spec.oauth.registrationEndpoint'

/**
 * The auth methods control-api can actually present at the token endpoint. The
 * generic remote token builders (`providers.ts`) emit `client_secret_post` only
 * (never HTTP Basic), and a public client uses `none`. Any other assignment by
 * the AS — notably `client_secret_basic` — is one we cannot honor, so we refuse
 * to store a client we could never authenticate (fail-closed).
 */
const PRESENTABLE_AUTH_METHODS = new Set(['none', 'client_secret_post'])

// ─── RFC 7591 shapes (request we send; response is third-party data) ────────

export interface DcrRegistrationRequest {
  redirect_uris: string[]
  token_endpoint_auth_method: 'none' | 'client_secret_post'
  grant_types: string[]
  response_types: ['code']
  client_name: 'Evenfire'
  application_type: 'web'
  scope?: string
}

/** RFC 7591 §3.2.1 registration response — every field is untrusted AS data. */
export interface DcrRegistrationResponse {
  client_id: string
  client_secret?: string
  /** NumericDate (epoch seconds). */
  client_id_issued_at?: number
  /** NumericDate (epoch seconds); 0 ⇒ non-expiring. */
  client_secret_expires_at?: number
  /** RFC 7592 management bearer — as sensitive as the secret. */
  registration_access_token?: string
  /** RFC 7592 management endpoint. */
  registration_client_uri?: string
  token_endpoint_auth_method?: string
  [k: string]: unknown
}

/**
 * RFC 7592 mint handle carried on the *minted-but-rejected* error variants: a 2xx
 * response that DID assign a `client_id` (a real client exists at the AS) but is
 * unusable to us. It lets the caller run the best-effort RFC 7592 cleanup DELETE so
 * the orphaned client does not linger (DEC-18). Present ONLY on those variants and
 * ONLY when the AS returned a management endpoint + token; never on non-2xx errors
 * (`fetch_failed`/`redirect_blocked`/`kernel_rejected`) where nothing was minted.
 * In-memory only — used solely for the cleanup DELETE, never persisted or logged.
 */
export interface DcrMintHandle {
  registrationClientUri?: string
  registrationAccessToken?: string
}

export type DcrError =
  | { kind: 'kernel_rejected'; field: string; errors: ValidationError[] }
  | { kind: 'fetch_failed'; url: string; status?: number; detail: string }
  /** A 3xx from the registration POST — never re-POSTed to `Location` (SSRF fail-closed). */
  | { kind: 'redirect_blocked'; url: string; detail: string }
  /**
   * 2xx but the body is not a usable RFC 7591 registration (missing client_id, etc.).
   * Carries a mint handle ONLY for the confidential-without-`client_secret` case,
   * where a real `client_id` was assigned; the parse/no-client_id cases mint nothing.
   */
  | ({ kind: 'invalid_response'; url: string; detail: string } & DcrMintHandle)
  /** The AS assigned a token_endpoint_auth_method we cannot present (e.g. client_secret_basic). */
  | ({ kind: 'auth_method_unsupported'; detail: string } & DcrMintHandle)
  /** Response arrived with a non-identity content-encoding (fail-closed, never mis-parse). */
  | { kind: 'content_encoding_rejected'; url: string; encoding: string }

export type DcrOutcome =
  | { ok: true; response: DcrRegistrationResponse }
  | { ok: false; error: DcrError }

export interface DcrDeps {
  transport?: PinnedTransport
  resolveDns?: DnsResolver
  logger?: Logger
}

/**
 * Build the RFC 7591 registration request (pure). `token_endpoint_auth_method` is
 * `none` for a public client (AS lists `none`) or `client_secret_post` for a
 * confidential one. `refresh_token` is added to `grant_types` ONLY when the AS
 * advertised it (invariant §6 #8, fail-closed) — never register a refresh grant
 * against an AS that did not advertise it. `redirect_uris` is the single source of
 * truth passed in by the caller (the CIMD remote callback), never re-hardcoded.
 */
export function buildDcrRequest(
  discovery: DiscoveryResult,
  opts: { clientMode: 'public' | 'confidential'; redirectUris: string[]; scopes?: string[] }
): DcrRegistrationRequest {
  const grantTypes = ['authorization_code']
  if (discovery.quirks.supportsRefresh) grantTypes.push('refresh_token')

  const request: DcrRegistrationRequest = {
    redirect_uris: opts.redirectUris,
    token_endpoint_auth_method: opts.clientMode === 'public' ? 'none' : 'client_secret_post',
    grant_types: grantTypes,
    response_types: ['code'],
    client_name: 'Evenfire',
    application_type: 'web',
  }
  if (opts.scopes && opts.scopes.length > 0) request.scope = opts.scopes.join(' ')
  return request
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Map a pinned-fetch error onto DCR's typed error union. */
function mapPinnedError(error: PinnedFetchError, url: string): DcrError {
  switch (error.kind) {
    case 'kernel_rejected':
      return { kind: 'kernel_rejected', field: error.field, errors: error.errors }
    case 'transport_failed':
      return { kind: 'fetch_failed', url, detail: error.detail }
    case 'content_encoding_rejected':
      return { kind: 'content_encoding_rejected', url, encoding: error.encoding }
  }
}

/** Compose a human-readable detail from an RFC 6749-style error body, if present. */
function errorBodyDetail(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText)
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      const description =
        typeof parsed.error_description === 'string' ? `: ${parsed.error_description}` : ''
      return `${parsed.error}${description}`
    }
  } catch {
    // Non-JSON error body — fall through to the bare status.
  }
  return `HTTP ${status}`
}

/**
 * Register a dynamic client (RFC 7591) at `endpoint`. Single-hop POST through
 * `pinnedFetch` (re-validates + pins the endpoint); a 3xx is `redirect_blocked`
 * and never followed. The AS response is untrusted: a missing `client_id` or an
 * un-presentable `token_endpoint_auth_method` is a typed, fail-closed error, so we
 * never persist a client we cannot use.
 */
export async function registerDynamicClient(
  deps: DcrDeps,
  endpoint: string,
  request: DcrRegistrationRequest
): Promise<DcrOutcome> {
  const log = (deps.logger ?? rootLogger).child({ module: 'oauth-dcr' })
  const body = JSON.stringify(request)

  const fetched = await pinnedFetch(endpoint, REGISTRATION_ENDPOINT_FIELD, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
    resolveDns: deps.resolveDns,
    transport: deps.transport,
    timeoutMs: DCR_TIMEOUT_MS,
  })
  if (!fetched.ok) {
    const error = mapPinnedError(fetched.error, endpoint)
    log.warn({ dcr: error.kind }, 'dynamic client registration transport failed')
    return { ok: false, error }
  }

  const response = fetched.response
  if (isRedirectStatus(response.status)) {
    // Never re-POST to a Location: an AS redirecting the registration is a
    // fail-closed SSRF vector (H2), not a flow to follow.
    log.warn({ dcr: 'redirect_blocked', status: response.status }, 'dcr registration redirected')
    return {
      ok: false,
      error: {
        kind: 'redirect_blocked',
        url: endpoint,
        detail: `HTTP ${response.status} redirect on the registration POST`,
      },
    }
  }

  const isSuccess = response.status >= 200 && response.status < 300
  if (!isSuccess) {
    const detail = errorBodyDetail(response.status, response.bodyText)
    log.warn({ dcr: 'fetch_failed', status: response.status }, 'dcr registration rejected')
    return {
      ok: false,
      error: { kind: 'fetch_failed', url: endpoint, status: response.status, detail },
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.bodyText)
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: 'invalid_response',
        url: endpoint,
        detail: e instanceof Error ? e.message : String(e),
      },
    }
  }
  if (!isRecord(parsed) || typeof parsed.client_id !== 'string' || parsed.client_id.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'invalid_response',
        url: endpoint,
        detail: 'registration response has no client_id',
      },
    }
  }

  const assigned = parsed as DcrRegistrationResponse

  // Fail-closed on an auth method we cannot present. The AS's assignment wins over
  // what we requested; a bare absence means it honored our request.
  const effectiveAuthMethod =
    assigned.token_endpoint_auth_method ?? request.token_endpoint_auth_method
  if (
    typeof effectiveAuthMethod === 'string' &&
    !PRESENTABLE_AUTH_METHODS.has(effectiveAuthMethod)
  ) {
    log.warn(
      { dcr: 'auth_method_unsupported', assigned: effectiveAuthMethod },
      'dcr registration assigned an un-presentable token_endpoint_auth_method'
    )
    return {
      ok: false,
      error: {
        kind: 'auth_method_unsupported',
        detail: `authorization server assigned token_endpoint_auth_method "${effectiveAuthMethod}", which control-api cannot present`,
        // A client WAS minted (2xx + client_id) but is unusable — expose the RFC 7592
        // handle so the caller can clean it up.
        registrationClientUri: assigned.registration_client_uri,
        registrationAccessToken: assigned.registration_access_token,
      },
    }
  }

  // A confidential registration MUST hand us a secret; otherwise we would persist
  // a client_secret_post client we can never authenticate.
  if (
    request.token_endpoint_auth_method === 'client_secret_post' &&
    typeof assigned.client_secret !== 'string'
  ) {
    return {
      ok: false,
      error: {
        kind: 'invalid_response',
        url: endpoint,
        detail: 'confidential registration returned no client_secret',
        // A client WAS minted (2xx + client_id) but is unusable — expose the RFC 7592
        // handle so the caller can clean it up.
        registrationClientUri: assigned.registration_client_uri,
        registrationAccessToken: assigned.registration_access_token,
      },
    }
  }

  return { ok: true, response: assigned }
}
