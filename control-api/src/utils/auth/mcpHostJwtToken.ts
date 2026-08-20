import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { mcpHostJwtIssueTotal } from '../../observability/metrics.js'

// ─── DB-backed refresh token revocation ────────────────────────────────
// JTIs of rotated refresh tokens are persisted to workflow_revoked_refresh_jtis.
// This survives process restarts — a rotated token cannot be replayed even
// after control-api restarts. Expired entries are cleaned by the expiry cron.
// An in-memory cache avoids a DB round-trip on every refresh verification.

const revokedRefreshJtis = new Set<string>()
const MAX_CACHED_JTIS = 10_000
const EXPIRED_REFRESH_REISSUE_GRACE_SECONDS = 5 * 60

/**
 * jsonwebtoken normalizes a single `aud` to a string and multiple to an array.
 * Our claims model carries a single audience string, so unwrap consistently.
 */
function firstAudience(aud: jwt.JwtPayload['aud']): string {
  return Array.isArray(aud) ? aud[0] : (aud as string)
}

// Eviction is FIFO (Set iterator is insertion-ordered), not LRU. At
// replicas: 1 and current throughput this is fine — every cache miss falls
// back to the DB query, so an evicted-but-still-valid revocation is still
// enforced. If control-api ever scales horizontally or ingestion rate spikes
// past MAX_CACHED_JTIS/TTL, revisit: either raise MAX, switch to LRU, or
// back the cache with Redis.
function cacheRevokedRefreshJti(jti: string): void {
  revokedRefreshJtis.add(jti)
  if (revokedRefreshJtis.size > MAX_CACHED_JTIS) {
    const iter = revokedRefreshJtis.values()
    const toRemove = revokedRefreshJtis.size - MAX_CACHED_JTIS
    for (let i = 0; i < toRemove; i++) {
      const entry = iter.next()
      if (entry.done) break
      revokedRefreshJtis.delete(entry.value)
    }
  }
}

// Explicit revocation path for admin/manual invalidation flows. Refresh-token
// rotation uses consumeRefreshJti() instead so the one-time-use path stays
// atomic under race.
async function revokeRefreshJti(jti: string, exp: number): Promise<void> {
  const expiresAt = new Date(exp * 1000).toISOString()
  // Persist to DB first (authoritative), then update cache
  await pool.query(
    `INSERT INTO workflow_revoked_refresh_jtis (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [jti, expiresAt]
  )
  cacheRevokedRefreshJti(jti)
}

async function consumeRefreshJti(jti: string, exp: number): Promise<boolean> {
  if (revokedRefreshJtis.has(jti)) {
    return false
  }

  const expiresAt = new Date(exp * 1000).toISOString()
  const result = await pool.query(
    `INSERT INTO workflow_revoked_refresh_jtis (jti, expires_at)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING jti`,
    [jti, expiresAt]
  )

  if ((result.rowCount ?? 0) === 0) {
    cacheRevokedRefreshJti(jti)
    return false
  }

  cacheRevokedRefreshJti(jti)
  return true
}

async function isRefreshJtiRevoked(jti: string): Promise<boolean> {
  if (revokedRefreshJtis.has(jti)) return true
  // Cache miss — check DB
  const result = await pool.query(`SELECT 1 FROM workflow_revoked_refresh_jtis WHERE jti = $1`, [
    jti,
  ])
  if ((result.rowCount ?? 0) > 0) {
    revokedRefreshJtis.add(jti)
    return true
  }
  return false
}

export { revokeRefreshJti }

/**
 * For 1st-party HCC-issued tokens, `hostRefs[0]` is the actual Host CRD
 * name (e.g. "trader", "chatllm") and per-event identity binding (e.g.
 * usage ingest) verifies the bearer is acting on its own behalf.
 * For WRC-issued recipe tokens, `hostRefs[0]` is the recipe binding
 * `${recipeNamespace}/${recipeName}` — recipe pods don't run on a single
 * named host. Authorization for those tokens uses recipeName/recipeNamespace
 * (recipe binding) rather than hostRefs.
 */
export type McpHostAccessClaims = {
  sub: string
  recipeNamespace: string
  recipeName: string
  hostRefs: string[]
  scope: 'workflow:approval:request'
  workflowControlScopes: McpHostControlScope[]
  iss: string
  aud: string
  jti: string
  exp: number
}

export type McpHostRefreshClaims = {
  sub: string
  recipeNamespace: string
  recipeName: string
  hostRefs: string[]
  scope: 'workflow:approval:refresh'
  workflowControlScopes: McpHostControlScope[]
  iss: string
  aud: string
  jti: string
  exp: number
}

export type McpHostRefreshVerificationFailureReason =
  | 'invalid_sig'
  | 'invalid_claims'
  | 'expired_beyond_reissue_grace'
  | 'revoked'

export type McpHostRefreshVerificationResult =
  | { ok: true; claims: McpHostRefreshClaims }
  | { ok: false; reason: McpHostRefreshVerificationFailureReason }

export const ALL_MCP_HOST_CONTROL_SCOPES = [
  'workflow:list',
  'workflow:read',
  'workflow:trigger',
  'workflow:approval:resolve',
  'workflow:approval:decide',
  // Plugin Workload SDK (promptBridge + clientNotifications). Provisioners
  // request this scope only for recipes whose validated capability
  // (status.pluginWorkloadSdk) declares the SDK; SDK routes reject access
  // tokens without it via scope_denied.
  'plugin-workload-sdk',
  // Derive-only Codex execution. HCC/WRC may request this after projecting an
  // eligible broker target. Never add it to user-declarable Host/Recipe CRD fields.
  'llm:codex:execute',
] as const

export type McpHostControlScope = (typeof ALL_MCP_HOST_CONTROL_SCOPES)[number]

// Control JWTs are intentionally stateless short-lived bearer credentials.
// Runtime Secret rotation is the revocation boundary; refresh JWTs use the
// DB-backed JTI path because they are rotation credentials.
const MCP_HOST_CONTROL_SCOPE_SET = new Set<string>(ALL_MCP_HOST_CONTROL_SCOPES)

export type McpHostControlClaims = {
  sub: string
  recipeNamespace: string
  recipeName: string
  hostRefs: string[]
  typ: 'service'
  scopes: McpHostControlScope[]
  iss: string
  aud: string
  jti: string
  exp: number
}

// Lazy memoized public key — deferred until first verification call so that
// tests can mock config.adminJwtPrivateKey before the key is computed.
let _workflowJwtPublicKey: string | null = null
function getWorkflowJwtPublicKey(): string {
  if (!_workflowJwtPublicKey) {
    _workflowJwtPublicKey = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    }) as string
  }
  return _workflowJwtPublicKey
}

function issueToken(
  recipeNamespace: string,
  recipeName: string,
  scope: 'workflow:approval:request' | 'workflow:approval:refresh',
  ttlSec: number,
  hostRefs: string[],
  workflowControlScopes: McpHostControlScope[] = []
): { token: string; expiresInSeconds: number } {
  const token = jwt.sign(
    {
      sub: `${recipeNamespace}/${recipeName}`,
      recipeNamespace,
      recipeName,
      hostRefs,
      scope,
      workflowControlScopes,
    },
    config.adminJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.adminJwtIssuer,
      audience: 'workflow-approvals',
      jwtid: randomUUID(),
      expiresIn: ttlSec,
    }
  )
  return { token, expiresInSeconds: ttlSec }
}

export function issueMcpHostAccessJwt(
  recipeNamespace: string,
  recipeName: string,
  hostRefs?: string[],
  options: { workflowControlScopes?: McpHostControlScope[] } = {}
): { token: string; expiresInSeconds: number } {
  const refs = normalizeIssuedMcpHostHostRefs(recipeNamespace, recipeName, hostRefs)
  const workflowControlScopes = normalizeMcpHostControlScopes(options.workflowControlScopes ?? [])
  if (!workflowControlScopes) throw new Error('invalid mcp-host workflowControlScopes')
  const out = issueToken(
    recipeNamespace,
    recipeName,
    'workflow:approval:request',
    config.mcpHostJwtAccessTtlSec,
    refs,
    workflowControlScopes
  )
  mcpHostJwtIssueTotal.inc({ kind: 'access' }, 1)
  return out
}

export function issueMcpHostRefreshJwt(
  recipeNamespace: string,
  recipeName: string,
  hostRefs?: string[],
  options: { workflowControlScopes?: McpHostControlScope[] } = {}
): { token: string; expiresInSeconds: number } {
  const refs = normalizeIssuedMcpHostHostRefs(recipeNamespace, recipeName, hostRefs)
  const workflowControlScopes = normalizeMcpHostControlScopes(options.workflowControlScopes ?? [])
  if (!workflowControlScopes) throw new Error('invalid mcp-host workflowControlScopes')
  const out = issueToken(
    recipeNamespace,
    recipeName,
    'workflow:approval:refresh',
    config.mcpHostJwtRefreshTtlSec,
    refs,
    workflowControlScopes
  )
  mcpHostJwtIssueTotal.inc({ kind: 'refresh' }, 1)
  return out
}

export function issueMcpHostControlJwt(
  recipeNamespace: string,
  recipeName: string,
  hostRefs?: string[],
  options: { scopes?: McpHostControlScope[] } = {}
): { token: string; expiresInSeconds: number } {
  const refs = normalizeIssuedMcpHostHostRefs(recipeNamespace, recipeName, hostRefs)
  const scopes = normalizeMcpHostControlScopes(options.scopes ?? [])
  if (!scopes) throw new Error('invalid mcp-host control scopes')
  const token = jwt.sign(
    {
      sub: `${recipeNamespace}/${recipeName}`,
      recipeNamespace,
      recipeName,
      hostRefs: refs,
      typ: 'service',
      scopes,
    },
    config.adminJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.adminJwtIssuer,
      audience: 'mcp-host',
      jwtid: randomUUID(),
      expiresIn: config.mcpHostJwtControlTtlSec,
    }
  )
  mcpHostJwtIssueTotal.inc({ kind: 'control' }, 1)
  return { token, expiresInSeconds: config.mcpHostJwtControlTtlSec }
}

function normalizeMcpHostControlScopes(value: unknown): McpHostControlScope[] | null {
  if (!Array.isArray(value)) return null

  const scopes: McpHostControlScope[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !MCP_HOST_CONTROL_SCOPE_SET.has(entry) || seen.has(entry)) {
      return null
    }
    seen.add(entry)
    scopes.push(entry as McpHostControlScope)
  }
  return scopes
}

function normalizeMcpHostHostRefs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (value.length > config.mcpHostJwtMaxHostRefs) return null

  const hostRefs: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return null
    const hostRef = entry.trim()
    if (!hostRef) return null
    if (hostRef.length > config.mcpHostJwtMaxHostRefLength) return null
    hostRefs.push(hostRef)
  }
  return hostRefs
}

function normalizeIssuedMcpHostHostRefs(
  recipeNamespace: string,
  recipeName: string,
  hostRefs?: string[]
): string[] {
  const refs = normalizeMcpHostHostRefs(hostRefs ?? [`${recipeNamespace}/${recipeName}`])
  if (!refs) throw new Error('invalid mcp-host hostRefs')
  return refs
}

function validateClaims(
  payload: jwt.JwtPayload,
  expectedScope: string
): McpHostAccessClaims | McpHostRefreshClaims | null {
  const hostRefs = normalizeMcpHostHostRefs(payload?.hostRefs)
  const workflowControlScopes = normalizeMcpHostControlScopes(payload?.workflowControlScopes ?? [])
  if (
    typeof payload?.sub !== 'string' ||
    typeof payload?.recipeNamespace !== 'string' ||
    typeof payload?.recipeName !== 'string' ||
    !hostRefs ||
    !workflowControlScopes ||
    payload?.scope !== expectedScope ||
    typeof payload?.jti !== 'string' ||
    typeof payload?.exp !== 'number'
  ) {
    return null
  }
  return {
    sub: payload.sub,
    recipeNamespace: payload.recipeNamespace,
    recipeName: payload.recipeName,
    hostRefs,
    scope: expectedScope as 'workflow:approval:request' | 'workflow:approval:refresh',
    workflowControlScopes,
    iss: payload.iss as string,
    aud: firstAudience(payload.aud),
    jti: payload.jti,
    exp: payload.exp,
  }
}

export function verifyMcpHostAccessJwt(token: string): McpHostAccessClaims | null {
  try {
    const payload = jwt.verify(token, getWorkflowJwtPublicKey(), {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: 'workflow-approvals',
    }) as jwt.JwtPayload
    return validateClaims(payload, 'workflow:approval:request') as McpHostAccessClaims
  } catch {
    return null
  }
}

export function verifyMcpHostControlJwt(token: string): McpHostControlClaims | null {
  try {
    const payload = jwt.verify(token, getWorkflowJwtPublicKey(), {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: 'mcp-host',
    }) as jwt.JwtPayload

    const { sub, recipeNamespace, recipeName, jti, exp } = payload
    const hostRefs = normalizeMcpHostHostRefs(payload.hostRefs)
    if (
      typeof sub !== 'string' ||
      typeof recipeNamespace !== 'string' ||
      typeof recipeName !== 'string' ||
      !hostRefs ||
      typeof jti !== 'string' ||
      typeof exp !== 'number'
    ) {
      return null
    }

    if (payload.typ !== 'service') {
      return null
    }

    const scopes = normalizeMcpHostControlScopes(payload.scopes)
    if (!scopes) {
      return null
    }

    return {
      sub,
      recipeNamespace,
      recipeName,
      hostRefs,
      typ: 'service',
      scopes,
      iss: payload.iss as string,
      aud: firstAudience(payload.aud),
      jti,
      exp,
    }
  } catch {
    return null
  }
}

export function getMcpHostRefreshRateLimitKey(
  token: string,
  opts: { expiredGraceSeconds?: number } = {}
): string | null {
  try {
    const expiredGraceSeconds = opts.expiredGraceSeconds ?? 0
    const payload = jwt.verify(token, getWorkflowJwtPublicKey(), {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: 'workflow-approvals',
      ignoreExpiration: expiredGraceSeconds > 0,
    }) as jwt.JwtPayload

    if (expiredGraceSeconds > 0) {
      const exp = typeof payload.exp === 'number' ? payload.exp : 0
      if (exp < Math.floor(Date.now() / 1000) - expiredGraceSeconds) {
        return null
      }
    }

    const claims = validateClaims(
      payload,
      'workflow:approval:refresh'
    ) as McpHostRefreshClaims | null
    if (!claims) {
      return null
    }

    if (claims.recipeNamespace === config.hostsNamespace) {
      const primaryHostRef = claims.hostRefs[0]?.trim()
      if (!primaryHostRef) return null
      return `${claims.recipeNamespace}/host/${primaryHostRef}`
    }

    return `${claims.recipeNamespace}/${claims.recipeName}`
  } catch {
    return null
  }
}

export function getMcpHostExpiredRefreshRateLimitKey(token: string): string | null {
  return getMcpHostRefreshRateLimitKey(token, {
    expiredGraceSeconds: EXPIRED_REFRESH_REISSUE_GRACE_SECONDS,
  })
}

export async function verifyMcpHostRefreshJwt(token: string): Promise<McpHostRefreshClaims | null> {
  try {
    const payload = jwt.verify(token, getWorkflowJwtPublicKey(), {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: 'workflow-approvals',
    }) as jwt.JwtPayload

    const claims = validateClaims(
      payload,
      'workflow:approval:refresh'
    ) as McpHostRefreshClaims | null
    if (!claims) {
      return null
    }

    if (await isRefreshJtiRevoked(claims.jti)) {
      return null
    }

    return claims
  } catch {
    return null
  }
}

/**
 * Verify a refresh token for the recovery path.
 *
 * Unlike `verifyMcpHostRefreshJwt`, this accepts tokens whose `exp` has
 * already passed within a short grace window. The re-issue endpoint exists to
 * recover from the crash window where mcp-host persisted a refresh pair but
 * the corresponding rotation round-trip didn't complete, so by the time
 * mcp-host retries the token may be both expired AND revoked.
 *
 * Returns the claims if: signature valid, iss/aud match, scope is refresh,
 * and the jti is NOT in the revoked table. Returns null in ALL other cases
 * (the caller surfaces an opaque 401 to avoid leaking which check failed).
 *
 * Does NOT consume the jti — callers that want one-shot semantics must
 * invoke `consumeRevokedRefreshJti` separately (see route handler).
 */
export async function verifyExpiredMcpHostRefreshJwt(
  token: string
): Promise<McpHostRefreshClaims | null> {
  const result = await verifyExpiredMcpHostRefreshJwtDetailed(token)
  return result.ok ? result.claims : null
}

export async function verifyExpiredMcpHostRefreshJwtDetailed(
  token: string
): Promise<McpHostRefreshVerificationResult> {
  let payload: jwt.JwtPayload
  try {
    payload = jwt.verify(token, getWorkflowJwtPublicKey(), {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: 'workflow-approvals',
      // Critical: do NOT let jsonwebtoken reject expiration here. This route
      // applies its own bounded grace window after normal claim validation.
      ignoreExpiration: true,
    }) as jwt.JwtPayload
  } catch {
    return { ok: false, reason: 'invalid_sig' }
  }

  const claims = validateClaims(payload, 'workflow:approval:refresh') as McpHostRefreshClaims | null
  if (!claims) {
    return { ok: false, reason: 'invalid_claims' }
  }

  const now = Math.floor(Date.now() / 1000)
  if (claims.exp < now - EXPIRED_REFRESH_REISSUE_GRACE_SECONDS) {
    return { ok: false, reason: 'expired_beyond_reissue_grace' }
  }

  if (await isRefreshJtiRevoked(claims.jti)) {
    return { ok: false, reason: 'revoked' }
  }

  return { ok: true, claims }
}

/**
 * Atomic single-use consumption of an expired refresh jti on the recovery
 * path. Same contract as `consumeRefreshJti` but exported so the
 * reissue route can close the race between "verify" and "emit new pair":
 * if two mcp-host replicas both hold the same expired refresh and both
 * hit /reissue simultaneously, only one wins the INSERT and only one
 * receives fresh tokens.
 */
export async function consumeExpiredRefreshJti(jti: string, exp: number): Promise<boolean> {
  // The expiry cron removes rows where `expires_at < now()`. An expired
  // refresh jti (exp in the past) would be reclaimed almost immediately,
  // which defeats replay prevention during the short window after reissue.
  // Floor the stored expiry at the reissue grace window so the revocation record
  // survives long enough to block a replayed token issued in the same
  // minute.
  const minExp = Math.floor(Date.now() / 1000) + EXPIRED_REFRESH_REISSUE_GRACE_SECONDS
  const effectiveExp = Math.max(exp, minExp)
  return consumeRefreshJti(jti, effectiveExp)
}

export async function consumeMcpHostRefreshJwt(
  token: string
): Promise<McpHostRefreshClaims | null> {
  try {
    const payload = jwt.verify(token, getWorkflowJwtPublicKey(), {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: 'workflow-approvals',
    }) as jwt.JwtPayload

    const claims = validateClaims(
      payload,
      'workflow:approval:refresh'
    ) as McpHostRefreshClaims | null
    if (!claims) {
      return null
    }

    const consumed = await consumeRefreshJti(claims.jti, claims.exp)
    if (!consumed) {
      return null
    }

    return claims
  } catch {
    return null
  }
}

export function getMcpHostCallerKey(
  claims: Pick<
    McpHostAccessClaims | McpHostRefreshClaims | McpHostControlClaims,
    'hostRefs' | 'sub'
  >
): string {
  // hostRefs[0] is the protocol caller/usage binding. Do not scan later
  // entries: they authorize additional targets, but they do not redefine the
  // caller identity stamped into approvals, workflow runs, or usage records.
  const primaryHostRef = claims.hostRefs?.[0]?.trim()
  if (!primaryHostRef) {
    throw new Error('mcp-host JWT missing canonical hostRefs[0] caller binding')
  }
  return primaryHostRef
}

export function isHostRefAuthorized(
  claims: McpHostAccessClaims | McpHostRefreshClaims | McpHostControlClaims,
  targetNamespace: string,
  targetName: string
): boolean {
  const target = `${targetNamespace}/${targetName}`
  return claims.hostRefs.includes(target)
}
