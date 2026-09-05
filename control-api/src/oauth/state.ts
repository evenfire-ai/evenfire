import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * State binding for an OAuth callback. The state value carried in the
 * provider redirect chain is HMAC-signed by control-api at authorize-URL
 * issuance, then re-verified on the callback. The signed binding glues the
 * callback to a specific subject + (user, oauthClientId) — a malicious caller
 * cannot replay another subject's state and claim the resulting tokens.
 *
 * The subject is one of two kinds:
 *   - a WorkflowRecipe (the historical embed/admin Connect flow), OR
 *   - an OAuth McpServer (U5, reactive consent for mcp-servers).
 *
 * The recipe subject wire format is FROZEN: a recipe state carries NO
 * `subjectKind` discriminator and NO mcp fields, so an existing recipe state
 * serializes / signs byte-for-byte identically to before U5. The mcp subject is
 * strictly additive — it carries `subjectKind:'mcp'` + `mcpServerName`. Anything
 * that is neither an unmarked recipe nor a well-formed mcp subject fails closed
 * (see {@link decodePayload}): a state marked `mcp` with a missing
 * `mcpServerName`, or an unrecognized `subjectKind`, is rejected rather than
 * silently reinterpreted as a recipe.
 *
 * Spec §9.9 / Decision 20 (recipe) · §U5 (mcp).
 */

/** Fields common to every subject. */
interface OAuthStateCommonClaims {
  userId: string
  oauthClientId: string
  /**
   * `user` — embed/mcp Connect flow, grant owned by `userId` (or, for a
   * context-identity mcp-server, bootstrapped by `userId` — resolved on the
   * callback from the server's authoritative `spec.contextRef`).
   * `service` — admin "connect for the recipe" flow (Path B). `userId` is the
   * initiating admin, recorded for audit only and NOT written to the grant.
   */
  grantKind: 'user' | 'service'
  /** True when the user opted into background (offline) use of this grant. */
  background: boolean
  /** Unix seconds when the state value becomes invalid. */
  expiresAt: number
  /** Random nonce so identical bindings produce distinct state strings. */
  nonce: string
}

/**
 * Recipe subject — the FROZEN legacy shape. No `subjectKind` field is present on
 * the wire; its absence IS the discriminator.
 */
export interface OAuthRecipeStateClaims extends OAuthStateCommonClaims {
  subjectKind?: undefined
  recipeNamespace: string
  recipeName: string
}

/** OAuth McpServer subject (U5) — additive, `subjectKind:'mcp'`. */
export interface OAuthMcpStateClaims extends OAuthStateCommonClaims {
  subjectKind: 'mcp'
  mcpServerName: string
}

export type OAuthStateClaims = OAuthRecipeStateClaims | OAuthMcpStateClaims

const STATE_VERSION = 'v1'
const STATE_TTL_SECONDS = 600 // 10 min — covers slow user OAuth flow but no longer
const NONCE_BYTES = 16

/**
 * The (recipe, user, client) tuple the callback re-asserts against the
 * URL-path-derived and cookie/peek-derived values. `grantKind` is deliberately
 * NOT part of the binding — it is a property of the signed state itself, with
 * no independent source to check it against.
 *
 * Only the recipe subject carries an external binding to re-check; the mcp
 * subject's identity is recovered from the unforgeable signed claims (there is
 * no recipe (ns, name) in the mcp callback path).
 */
export interface OAuthStateBinding {
  recipeNamespace: string
  recipeName: string
  userId: string
  oauthClientId: string
}

export type SignStateInput =
  | {
      /** Recipe subject (default). Omit `subjectKind` or pass `'recipe'`. */
      subjectKind?: 'recipe'
      recipeNamespace: string
      recipeName: string
      userId: string
      oauthClientId: string
      grantKind: 'user' | 'service'
      background: boolean
    }
  | {
      /** OAuth McpServer subject (U5). */
      subjectKind: 'mcp'
      mcpServerName: string
      userId: string
      oauthClientId: string
      grantKind: 'user' | 'service'
      background: boolean
    }

/**
 * Sign a fresh state value. Caller embeds the returned string in the
 * provider authorize URL's `state` parameter.
 */
export function signOAuthState(secret: string, input: SignStateInput): string {
  if (secret.length < 32) {
    throw new Error('signOAuthState: secret must be at least 32 characters')
  }
  const nonce = randomBytes(NONCE_BYTES).toString('base64url')
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS

  let claims: OAuthStateClaims
  if (input.subjectKind === 'mcp') {
    // Additive mcp subject — carries the discriminator + mcpServerName.
    claims = {
      subjectKind: 'mcp',
      mcpServerName: input.mcpServerName,
      userId: input.userId,
      oauthClientId: input.oauthClientId,
      grantKind: input.grantKind,
      background: input.background,
      expiresAt,
      nonce,
    }
  } else {
    // FROZEN recipe subject — this object literal (field set + order) MUST stay
    // byte-for-byte identical to the pre-U5 shape. No `subjectKind`, no mcp
    // fields. The golden test in oauth.state.test.ts pins this.
    claims = {
      recipeNamespace: input.recipeNamespace,
      recipeName: input.recipeName,
      userId: input.userId,
      oauthClientId: input.oauthClientId,
      grantKind: input.grantKind,
      background: input.background,
      expiresAt,
      nonce,
    }
  }
  const payload = encodePayload(claims)
  const signature = computeSignature(secret, payload)
  return `${STATE_VERSION}.${payload}.${signature}`
}

export type VerifyOAuthStateResult =
  | { kind: 'ok'; claims: OAuthStateClaims }
  | { kind: 'invalid_format' }
  | { kind: 'invalid_version' }
  | { kind: 'invalid_signature' }
  | { kind: 'expired' }
  | { kind: 'binding_mismatch'; reason: string }

/**
 * Verify a state value's version, signature, and expiry, returning the parsed
 * claims on success. Unlike {@link verifyOAuthState}, this asserts NO external
 * binding — use it when the callback URL no longer carries the
 * (recipeNamespace, recipeName) in its path and the subject identity is
 * recovered from the signed claims instead. That is safe because the HMAC
 * signature makes the payload unforgeable. Callers that still hold an
 * out-of-band value (e.g. the oauthClientId in the callback path) SHOULD
 * cross-check it against the returned claims for defence in depth.
 */
export function verifyOAuthStateSignature(secret: string, state: string): VerifyOAuthStateResult {
  const parts = state.split('.')
  if (parts.length !== 3) return { kind: 'invalid_format' }
  const [version, payload, providedSignature] = parts
  if (version !== STATE_VERSION) return { kind: 'invalid_version' }

  const expectedSignature = computeSignature(secret, payload)
  if (!constantTimeEqualString(expectedSignature, providedSignature)) {
    return { kind: 'invalid_signature' }
  }

  let claims: OAuthStateClaims
  try {
    claims = decodePayload(payload)
  } catch {
    return { kind: 'invalid_format' }
  }

  if (claims.expiresAt <= Math.floor(Date.now() / 1000)) {
    return { kind: 'expired' }
  }

  return { kind: 'ok', claims }
}

/**
 * Verify a state value supplied by the provider redirect. On success returns
 * the parsed claims; on failure returns a discriminated error variant.
 *
 * The caller MUST also assert binding to the URL-path-derived
 * (recipeNamespace, recipeName, oauthClientId) and to the cookie-derived
 * userId — pass them via `expected` for an inline binding check.
 *
 * This binding check is RECIPE-ONLY: an mcp-subject state carries no recipe
 * (ns, name) to bind against, so it fails closed here (`binding_mismatch`).
 * The mcp callback path uses {@link verifyOAuthStateSignature} + a claims-side
 * cross-check instead.
 */
export function verifyOAuthState(
  secret: string,
  state: string,
  expected: OAuthStateBinding
): VerifyOAuthStateResult {
  const verified = verifyOAuthStateSignature(secret, state)
  if (verified.kind !== 'ok') return verified
  const { claims } = verified

  // Fail closed: this external-binding verifier only understands recipe
  // subjects. An mcp subject has no recipe coordinates to re-assert.
  if (claims.subjectKind === 'mcp') {
    return { kind: 'binding_mismatch', reason: 'subjectKind' }
  }

  if (claims.recipeNamespace !== expected.recipeNamespace) {
    return { kind: 'binding_mismatch', reason: 'recipeNamespace' }
  }
  if (claims.recipeName !== expected.recipeName) {
    return { kind: 'binding_mismatch', reason: 'recipeName' }
  }
  if (claims.userId !== expected.userId) {
    return { kind: 'binding_mismatch', reason: 'userId' }
  }
  if (claims.oauthClientId !== expected.oauthClientId) {
    return { kind: 'binding_mismatch', reason: 'oauthClientId' }
  }

  return { kind: 'ok', claims }
}

function encodePayload(claims: OAuthStateClaims): string {
  return Buffer.from(JSON.stringify(claims)).toString('base64url')
}

function decodePayload(payload: string): OAuthStateClaims {
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof obj.userId !== 'string' ||
    typeof obj.oauthClientId !== 'string' ||
    (obj.grantKind !== 'user' && obj.grantKind !== 'service') ||
    typeof obj.expiresAt !== 'number' ||
    typeof obj.nonce !== 'string'
  ) {
    throw new Error('decodePayload: malformed claims')
  }
  const common: OAuthStateCommonClaims = {
    userId: obj.userId,
    oauthClientId: obj.oauthClientId,
    grantKind: obj.grantKind,
    background: obj.background === true,
    expiresAt: obj.expiresAt,
    nonce: obj.nonce,
  }

  // mcp subject — requires a well-formed mcpServerName. Fail closed otherwise.
  if (obj.subjectKind === 'mcp') {
    if (typeof obj.mcpServerName !== 'string' || obj.mcpServerName.length === 0) {
      throw new Error('decodePayload: malformed mcp claims')
    }
    return { subjectKind: 'mcp', mcpServerName: obj.mcpServerName, ...common }
  }

  // Recipe subject — the ONLY shape allowed to omit `subjectKind`. Requires the
  // recipe coordinates.
  if (obj.subjectKind === undefined) {
    if (typeof obj.recipeNamespace !== 'string' || typeof obj.recipeName !== 'string') {
      throw new Error('decodePayload: malformed recipe claims')
    }
    return { recipeNamespace: obj.recipeNamespace, recipeName: obj.recipeName, ...common }
  }

  // Any other `subjectKind` value is an unknown subject — fail closed rather
  // than defaulting to recipe.
  throw new Error('decodePayload: unknown subjectKind')
}

function computeSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`${STATE_VERSION}.${payload}`).digest('base64url')
}

function constantTimeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
