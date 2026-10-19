import { type PinnedFetchError, type PinnedTransport, pinnedFetch } from '../http/pinnedFetch.js'
import type { DnsResolver, ValidationError } from '../http/validateMcpServerSpec.js'
import { type Logger, rootLogger } from '../observability/logger.js'
import { MAX_CLIENT_ID_LENGTH } from './cimdIdentity.js'
import type { DiscoveryResult } from './discovery.js'
import type { RemoteCallbackVariant } from './remoteCallback.js'

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
  /**
   * RFC 7591 §3.2.1: the AS echoes the registered metadata, including the redirect
   * URIs it actually accepted. Untrusted — check it with {@link verifyDcrRedirectUris}.
   */
  redirect_uris?: unknown
  [k: string]: unknown
}

/**
 * RFC 7592 mint handle carried on the *minted-but-rejected* error variants: a 2xx
 * response that DID assign a `client_id` (a real client exists at the AS) but is
 * unusable to us. It lets the caller run the best-effort RFC 7592 cleanup DELETE so
 * the orphaned client does not linger (DEC-18). Present ONLY on those variants and
 * ONLY when the AS returned a management endpoint + token; never on non-2xx errors
 * (`fetch_failed`/`registration_rejected`/`redirect_blocked`/`kernel_rejected`) where
 * nothing was minted.
 * In-memory only — used solely for the cleanup DELETE, never persisted or logged.
 */
export interface DcrMintHandle {
  /**
   * Set when a client WAS minted at the AS, with or without a management handle, so
   * the caller can tell "cleaned up" from "left behind" when the handle is missing.
   */
  minted?: true
  registrationClientUri?: string
  registrationAccessToken?: string
}

export type DcrError =
  | { kind: 'kernel_rejected'; field: string; errors: ValidationError[] }
  /** Transport failure: the registration POST got no HTTP response we could read. */
  | { kind: 'fetch_failed'; url: string; detail: string }
  /**
   * The AS answered the registration POST with a non-2xx status other than a followed
   * redirect (301/302/303/307/308 are `redirect_blocked`). `error` and
   * `errorDescription` are the RFC 7591 §3.2.2 fields from its body, when present and
   * well-formed; both are third-party text, bounded by {@link boundedRegistrationError}.
   */
  | {
      kind: 'registration_rejected'
      url: string
      status: number
      error?: string
      errorDescription?: string
    }
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
  | {
      ok: true
      response: DcrRegistrationResponse
      /**
       * The auth method that actually governs the minted client — the AS's
       * assignment when it overrode our request, else what we asked for. The AS is
       * the final authority (RFC 7591), so a confidential request the AS downgrades
       * to `none` yields `effectiveAuthMethod: 'none'` here, NOT what we requested.
       */
      effectiveAuthMethod: 'none' | 'client_secret_post'
      /** `public` iff `effectiveAuthMethod` is `none`; the caller persists THIS mode. */
      effectiveClientMode: 'public' | 'confidential'
    }
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

/**
 * Upper bound (in UTF-16 code units, ellipsis included) on a relayed
 * `error_description`. control-ui re-applies the same bound (`lib/remoteMcp.ts`).
 */
export const DCR_ERROR_DESCRIPTION_MAX = 300

// RFC 7591 §3.2.2 error codes are snake_case tokens (`invalid_redirect_uri`, …). The
// RFC 6749 charset would also admit spaces, URLs and parentheses, which can read as
// platform copy once rendered, so only a plain token is kept as a code.
const PROVIDER_ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/

// A surrogate half without its partner (possible through JSON `\u` escapes).
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
// Double quotation marks, ASCII and typographic: provider text must not be able to
// close the quotation the operator sees it in.
const DOUBLE_QUOTES_RE = /["“”„‟«»]/g
// A combining mark run beyond the third, which only stacks glyphs on one character.
const STACKED_MARKS_RE = /(\p{M}{3})\p{M}+/gu

/**
 * Third-party text bounded for display: lone surrogates and default-ignorable
 * characters (bidi overrides, zero-width, fillers, variation selectors) are dropped,
 * control characters become spaces so line breaks still separate words, double
 * quotes become single quotes, combining mark runs are capped, whitespace collapses,
 * and the result is cut to `max` code units without splitting a surrogate pair.
 */
function boundedProviderText(value: string, max: number): string {
  const text = value
    .replace(LONE_SURROGATE_RE, '')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(DOUBLE_QUOTES_RE, "'")
    .replace(STACKED_MARKS_RE, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  let cut = text.slice(0, max - 1)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

/**
 * The RFC 7591 §3.2.2 `error` / `error_description` of a rejected registration,
 * bounded for relay to the operator: the body is third-party content, so the code
 * must be a plain token and the description goes through
 * {@link boundedProviderText}. Missing, malformed or blank fields are omitted.
 */
function boundedRegistrationError(bodyText: string): {
  error?: string
  errorDescription?: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const result: { error?: string; errorDescription?: string } = {}
  if (typeof parsed.error === 'string' && PROVIDER_ERROR_CODE_RE.test(parsed.error)) {
    result.error = parsed.error
  }
  if (typeof parsed.error_description === 'string') {
    const description = boundedProviderText(parsed.error_description, DCR_ERROR_DESCRIPTION_MAX)
    if (description.length > 0) result.errorDescription = description
  }
  return result
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
    const providerError = boundedRegistrationError(response.bodyText)
    // The code only: the description is free third-party text and stays out of logs.
    log.warn(
      { dcr: 'registration_rejected', status: response.status, error: providerError.error },
      'dcr registration rejected'
    )
    return {
      ok: false,
      error: {
        kind: 'registration_rejected',
        url: endpoint,
        status: response.status,
        ...providerError,
      },
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

  // An oversized client_id is refused before anything compares, stores or logs it. A
  // client WAS minted, so the RFC 7592 handle goes back for cleanup.
  if (Buffer.byteLength(assigned.client_id, 'utf8') > MAX_CLIENT_ID_LENGTH) {
    return {
      ok: false,
      error: {
        kind: 'invalid_response',
        url: endpoint,
        detail: `registration response client_id exceeds ${MAX_CLIENT_ID_LENGTH} bytes`,
        minted: true,
        registrationClientUri: stringOrUndefined(assigned.registration_client_uri),
        registrationAccessToken: stringOrUndefined(assigned.registration_access_token),
      },
    }
  }

  // Fail-closed on an auth method we cannot present. The AS's assignment wins over
  // what we requested; a bare absence (undefined/null) means it honored our request.
  // The AS response is untrusted, so we reject anything that is NOT a presentable
  // string here — an un-presentable method (e.g. client_secret_basic) OR a non-string
  // the AS injected (e.g. a number/object). Both fail closed to `auth_method_unsupported`
  // so a garbage value never reaches the effective-mode cast/derivation below.
  const effectiveAuthMethod =
    assigned.token_endpoint_auth_method ?? request.token_endpoint_auth_method
  if (
    typeof effectiveAuthMethod !== 'string' ||
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
        minted: true,
        registrationClientUri: assigned.registration_client_uri,
        registrationAccessToken: assigned.registration_access_token,
      },
    }
  }

  // Past the PRESENTABLE guard the effective method is one of the two we can present.
  // It — not what we requested — is the final authority on public vs confidential.
  const presentedAuthMethod = effectiveAuthMethod as 'none' | 'client_secret_post'
  const effectiveClientMode: 'public' | 'confidential' =
    presentedAuthMethod === 'none' ? 'public' : 'confidential'

  // A confidential-EFFECTIVE registration MUST hand us a secret; otherwise we would
  // persist a client_secret_post client we can never authenticate. Anchoring this on
  // the EFFECTIVE method (not what we requested) is deliberate: when the AS downgrades
  // a confidential request to public (`none`, no secret), that is a valid public
  // client per RFC 7591 — the AS owns the auth method — not an error (Vercel does this).
  if (effectiveClientMode === 'confidential' && typeof assigned.client_secret !== 'string') {
    return {
      ok: false,
      error: {
        kind: 'invalid_response',
        url: endpoint,
        detail: 'confidential registration returned no client_secret',
        // A client WAS minted (2xx + client_id) but is unusable — expose the RFC 7592
        // handle so the caller can clean it up.
        minted: true,
        registrationClientUri: assigned.registration_client_uri,
        registrationAccessToken: assigned.registration_access_token,
      },
    }
  }

  return {
    ok: true,
    response: assigned,
    effectiveAuthMethod: presentedAuthMethod,
    effectiveClientMode,
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export type DcrRedirectUrisCheck =
  | { ok: true }
  | { ok: false; reason: 'redirect_uris_missing' | 'redirect_uris_mismatch' }

/**
 * Check the `redirect_uris` a registration response reports against the ones we sent.
 *
 *   per-server: REQUIRED and exactly equal (same strings, no normalization). The
 *               per-server redirect URI is the only mix-up defence there, so a client
 *               the AS registered with a different or unreported URI cannot be trusted
 *               to redirect only to this installation.
 *   shared:     the response `iss` is the defence, so an ABSENT (or `null`) field is
 *               tolerated (ASes that omit the echo keep working); a PRESENT one that
 *               differs still fails.
 *
 * Comparison is set equality over exact strings (RFC 7591 gives the array no order).
 * Pure; the caller turns a failure into an install failure with RFC 7592 cleanup.
 */
export function verifyDcrRedirectUris(input: {
  variant: RemoteCallbackVariant
  requested: readonly string[]
  response: Pick<DcrRegistrationResponse, 'redirect_uris'>
}): DcrRedirectUrisCheck {
  const reported = input.response.redirect_uris
  // JSON `null` is how some serializers spell an omitted field, so it counts as absent.
  if (reported === undefined || reported === null) {
    return input.variant === 'shared'
      ? { ok: true }
      : { ok: false, reason: 'redirect_uris_missing' }
  }
  if (
    !Array.isArray(reported) ||
    reported.length !== input.requested.length ||
    !reported.every(uri => typeof uri === 'string' && input.requested.includes(uri)) ||
    !input.requested.every(uri => reported.includes(uri))
  ) {
    return { ok: false, reason: 'redirect_uris_mismatch' }
  }
  return { ok: true }
}
