import jwt from 'jsonwebtoken'
import {
  type ActionOperationId,
  type ActionOperationScope,
  type CanonicalActionTarget,
  type CanonicalResourceIdentityWire,
  actionOperationScope,
  canonicalActionTarget,
  canonicalActionTargetJson,
  hashActionTarget,
  isActionOperationId,
  validateActionOperationTarget,
  validateCanonicalResourceIdentity,
} from '@clerum/action-context-contracts'
import { config } from './config.js'

const MAX_DELEGATION_TTL_SECONDS = 300
const MAX_DELEGATED_OPERATIONS = 16
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACCESS_PATH_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/
const AUTHORIZATION_REVISION_PATTERN = /^ar1_[A-Za-z0-9_-]{43}$/
const HASH_PATTERN = /^bh2_[A-Za-z0-9_-]{43}$/
const JWT_CLAIMS = new Set([
  'iss',
  'aud',
  'typ',
  'ver',
  'sub',
  'sid',
  'sv',
  'jti',
  'iat',
  'exp',
  'operationIds',
  'scopes',
  'resource',
  'targets',
  'targetHashes',
  'accessPathId',
  'authorizationRevision',
  'behaviorBindingHash',
  'pathKind',
  'effectiveTeamId',
])

export type UserDelegationV2Claims = Readonly<{
  typ: 'user_delegation'
  ver: 2
  sub: string
  sid: string
  sv: number
  jti: string
  iat: number
  exp: number
  operationIds: readonly ActionOperationId[]
  scopes: readonly ActionOperationScope[]
  resource: CanonicalResourceIdentityWire
  targets: Readonly<Partial<Record<ActionOperationId, CanonicalActionTarget>>>
  targetHashes: Readonly<Partial<Record<ActionOperationId, string>>>
  accessPathId: string
  authorizationRevision: string
  behaviorBindingHash: string
  pathKind: 'direct' | 'team'
  effectiveTeamId: string | null
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, max = 1024): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return null
  }
  return normalized
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function parseResource(value: unknown): CanonicalResourceIdentityWire | null {
  try {
    return validateCanonicalResourceIdentity(value)
  } catch {
    return null
  }
}

function parseOperations(value: unknown): readonly ActionOperationId[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DELEGATED_OPERATIONS) {
    return null
  }
  const operations: ActionOperationId[] = []
  const seen = new Set<ActionOperationId>()
  for (const entry of value) {
    if (!isActionOperationId(entry) || seen.has(entry)) return null
    seen.add(entry)
    operations.push(entry)
  }
  return Object.freeze(operations)
}

function parseScopes(
  value: unknown,
  operationIds: readonly ActionOperationId[]
): readonly ActionOperationScope[] | null {
  if (!Array.isArray(value) || value.length !== operationIds.length) return null
  const expected = operationIds.map(actionOperationScope)
  const scopes: ActionOperationScope[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry !== expected[index]) {
      return null
    }
    scopes.push(entry as ActionOperationScope)
  }
  return Object.freeze(scopes)
}

function parseTargets(
  targetsValue: unknown,
  hashesValue: unknown,
  operationIds: readonly ActionOperationId[],
  resource: CanonicalResourceIdentityWire
): {
  targets: Readonly<Partial<Record<ActionOperationId, CanonicalActionTarget>>>
  targetHashes: Readonly<Partial<Record<ActionOperationId, string>>>
} | null {
  if (!isRecord(targetsValue) || !isRecord(hashesValue)) return null
  const operations = new Set(operationIds)
  if (
    Object.keys(targetsValue).length !== operations.size ||
    Object.keys(hashesValue).length !== operations.size ||
    Object.keys(targetsValue).some(key => !isActionOperationId(key) || !operations.has(key)) ||
    Object.keys(hashesValue).some(key => !isActionOperationId(key) || !operations.has(key))
  ) {
    return null
  }
  const targets: Partial<Record<ActionOperationId, CanonicalActionTarget>> = {}
  const targetHashes: Partial<Record<ActionOperationId, string>> = {}
  for (const operationId of operationIds) {
    let target: CanonicalActionTarget
    try {
      target = canonicalActionTarget(targetsValue[operationId])
    } catch {
      return null
    }
    try {
      target = validateActionOperationTarget({
        operationId,
        resource,
        operationTarget: target,
      })
    } catch {
      return null
    }
    const hash = boundedString(hashesValue[operationId], 128)
    if (!hash || hash !== hashActionTarget(target)) return null
    // Require the producer to have emitted the canonical wire representation,
    // not merely something that canonicalizes to the same target.
    if (JSON.stringify(targetsValue[operationId]) !== canonicalActionTargetJson(target)) return null
    targets[operationId] = target
    targetHashes[operationId] = hash
  }
  return { targets: Object.freeze(targets), targetHashes: Object.freeze(targetHashes) }
}

/**
 * Strict v2 verifier. The legacy RPC token verifier never calls this function,
 * and this function accepts no legacy scope/team/role claims.
 */
export function verifyUserDelegationV2(
  token: string,
  options: {
    publicKey?: string
    issuer?: string
    audience?: string
    nowSeconds?: number
  } = {}
): UserDelegationV2Claims | null {
  try {
    const payload = jwt.verify(token, options.publicKey ?? config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: options.issuer ?? config.jwtIssuer,
      audience: options.audience ?? config.jwtAudience,
      clockTimestamp: options.nowSeconds,
    }) as jwt.JwtPayload
    if (!isRecord(payload) || !hasOnlyKeys(payload, JWT_CLAIMS)) return null
    if (payload.typ !== 'user_delegation' || payload.ver !== 2) return null
    const sub = boundedString(payload.sub)
    const sid = boundedString(payload.sid)
    const jti = boundedString(payload.jti)
    const accessPathId = boundedString(payload.accessPathId)
    const authorizationRevision = boundedString(payload.authorizationRevision)
    const behaviorBindingHash = boundedString(payload.behaviorBindingHash, 128)
    if (
      !sub ||
      !UUID_PATTERN.test(sub) ||
      !sid ||
      !UUID_PATTERN.test(sid) ||
      !jti ||
      !UUID_PATTERN.test(jti) ||
      !accessPathId ||
      !ACCESS_PATH_PATTERN.test(accessPathId) ||
      !authorizationRevision ||
      !AUTHORIZATION_REVISION_PATTERN.test(authorizationRevision) ||
      !behaviorBindingHash ||
      !HASH_PATTERN.test(behaviorBindingHash)
    ) {
      return null
    }
    if (!Number.isSafeInteger(payload.sv) || Number(payload.sv) < 1) return null
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return null
    const iat = Number(payload.iat)
    const exp = Number(payload.exp)
    if (exp <= iat || exp - iat > MAX_DELEGATION_TTL_SECONDS) return null
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (iat > now + 30 || exp <= now) return null

    const operationIds = parseOperations(payload.operationIds)
    if (!operationIds) return null
    const scopes = parseScopes(payload.scopes, operationIds)
    if (!scopes) return null
    const resource = parseResource(payload.resource)
    if (!resource) return null
    const targetRecords = parseTargets(
      payload.targets,
      payload.targetHashes,
      operationIds,
      resource
    )
    if (!targetRecords) return null

    const pathKind = payload.pathKind
    if (pathKind !== 'direct' && pathKind !== 'team') return null
    const effectiveTeamId =
      payload.effectiveTeamId === null ? null : boundedString(payload.effectiveTeamId)
    if (pathKind === 'direct' && payload.effectiveTeamId !== null) return null
    if (pathKind === 'team' && (!effectiveTeamId || !UUID_PATTERN.test(effectiveTeamId)))
      return null

    return Object.freeze({
      typ: 'user_delegation',
      ver: 2,
      sub,
      sid,
      sv: Number(payload.sv),
      jti,
      iat,
      exp,
      operationIds,
      scopes,
      resource,
      targets: targetRecords.targets,
      targetHashes: targetRecords.targetHashes,
      accessPathId,
      authorizationRevision,
      behaviorBindingHash,
      pathKind,
      effectiveTeamId,
    })
  } catch {
    return null
  }
}

/** Anything that looks like v2 is never allowed to fall back into v1 parsing. */
export function tokenDeclaresV2(token: string): boolean {
  const decoded = jwt.decode(token)
  return isRecord(decoded) && (decoded.typ === 'user_delegation' || decoded.ver === 2)
}
