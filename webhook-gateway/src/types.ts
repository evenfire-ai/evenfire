/**
 * Per-webhook config materialized by WRC into
 * /etc/webhook-gateway/config.json. The shape is a strict subset of
 * the CRD-level WebhookDef — the gateway only sees policy fields, not
 * raw secret material (secrets are mounted under /run/secrets and
 * referenced by file path).
 */
export interface WebhookConfigEntry {
  /** Stable id; matches the route segment `/:webhookId`. */
  id: string
  /** Subset of {POST, GET}; defaults to ['POST'] if omitted. */
  methods: ReadonlyArray<'POST' | 'GET'>
  /** Maximum inbound body size in bytes. */
  maxBodyBytes: number
  /** Verification scheme + scheme-specific knobs. */
  verification: VerificationConfig
  /**
   * Optional setup-handshake handler. When set, the strategy's exact request
   * shape is answered inline by the gateway and bypasses the body-signature
   * verifier (`meta-hub-challenge`) or short-circuits the forwarder after
   * verification (`slack-url-verification`). See spec §7.5.
   */
  setupHandshake?: SetupHandshakeConfig
  /** Replay window — present iff scheme is hmac-sha256-timestamp-body. */
  replay?: ReplayConfig
  /** Where to forward verified traffic. */
  upstream: UpstreamConfig
  /**
   * When true, the webhook is deferred-credential dormant — its referenced
   * Secret was missing at reconcile time and the spec marked it
   * `optional: true`. The gateway short-circuits every inbound request
   * with `410 Gone` + `X-Clerum-Webhook-State: dormant` and never reaches
   * the verifier, forwarder, or any /run/secrets file (the volume
   * projection is marked optional so missing files don't crash the pod).
   */
  dormant?: boolean
  /** Secret name the operator must create to activate a dormant entry. */
  dormantSecretName?: string
}

export interface SetupHandshakeConfig {
  strategy: 'meta-hub-challenge' | 'slack-url-verification' | 'stripe-verify'
  /** Filesystem path to the verify-token value (meta-hub-challenge only). */
  secretPath?: string
}

/**
 * V1.1 only ships `hmac-sha256-body`. The full union mirrors the CRD
 * so future verifier slices (W1.2+) just add another branch and a
 * verifier function — the dispatch site is the discriminant.
 */
export type VerificationConfig =
  | HmacSha256BodyVerification
  | HmacSha256TimestampBodyVerification
  | JwtBearerJwksVerification
  | StaticBearerVerification

export interface HmacSha256BodyVerification {
  scheme: 'hmac-sha256-body'
  /** Header name carrying the signature (lowercase). */
  signatureHeader: string
  /** Optional prefix stripped before decoding (e.g. "sha256="). */
  signaturePrefix?: string
  /** "hex" or "base64". */
  signatureEncoding: 'hex' | 'base64'
  /** Filesystem path to the signing-secret value. */
  secretPath: string
}

export interface HmacSha256TimestampBodyVerification {
  scheme: 'hmac-sha256-timestamp-body'
  signatureHeader: string
  signaturePrefix?: string
  signatureEncoding: 'hex' | 'base64'
  secretPath: string
}

export interface JwtBearerJwksVerification {
  scheme: 'jwt-bearer-jwks'
  jwksUrl: string
  issuer: string
  audience: string
  /** Filesystem path to the baked JWKS document (one per webhookId). */
  jwksPath: string
}

export interface StaticBearerVerification {
  scheme: 'static-bearer'
  /** Filesystem path to the bearer-token value. */
  secretPath: string
  /**
   * Lowercase HTTP header name to read the token from. Defaults to
   * `authorization` when omitted. Custom headers (e.g.
   * `x-telegram-bot-api-secret-token`) let providers that authenticate
   * webhooks via a non-Authorization header fit the same scheme.
   *
   * Always stored lowercase so it can be looked up directly in
   * IncomingHttpHeaders without an extra normalization step.
   */
  tokenHeader?: string
  /**
   * String to strip from the front of the header value before
   * constant-time comparison with the secret. Defaults to `Bearer `
   * (with trailing space) when omitted — matches the standard
   * `Authorization: Bearer <token>` shape. Author-supplied empty
   * string is honored as "no prefix" (the entire header value IS the
   * token, e.g. Telegram).
   */
  tokenPrefix?: string
}

export interface ReplayConfig {
  timestampHeader: string
  toleranceSec: number
}

export interface UpstreamConfig {
  /** Service hostname inside the cluster, e.g. wf-foo-handler.sandbox-recipes.svc.cluster.local. */
  host: string
  /** Service port (8080, 3000, etc.). */
  port: number
  /** Path the handler workload sees on the forwarded request. */
  path: string
}

/**
 * Top-level gateway config. WRC writes this file; gateway reads it on
 * startup. ConfigMap-hash annotation triggers a rolling restart when
 * any value changes (§11.4).
 */
export interface GatewayConfig {
  /** Map keyed on webhookId for O(1) lookup on each request. */
  webhooks: Record<string, WebhookConfigEntry>
}

// ─── Failure modes ─────────────────────────────────────────────────

/**
 * Discriminant for verifier outcomes. Mapped to HTTP status by the
 * caller; verifiers never write the response themselves so they
 * remain easy to unit-test.
 */
export type VerifyOutcome =
  | { kind: 'ok' }
  | { kind: 'invalid_signature' }
  | { kind: 'timestamp_skew' }
  | { kind: 'body_too_large' }
  | { kind: 'method_not_allowed' }
  | { kind: 'invalid_webhook_id' }
  | { kind: 'webhook_not_found' }
  | { kind: 'verifier_misconfigured'; detail: string }
