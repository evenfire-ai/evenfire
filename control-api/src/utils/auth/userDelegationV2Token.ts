import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import {
  ACTION_CONTEXT_VERSION,
  type ActionOperationId,
  type ActionOperationScope,
  type CanonicalActionTarget,
  type CanonicalResourceIdentityWire,
  actionOperationScope,
  canonicalActionTarget,
  hashActionTarget,
  parseActionOperationScopes,
  requireActionOperationId,
} from '@clerum/action-context-contracts'
import { config } from '../../config.js'
import type { PreparedActionOperationTarget } from '../../services/access/actionMessageId.js'
import { validateActionOperationTarget } from '../../services/access/actionOperationRegistry.js'
import {
  type CanonicalResourceIdentity,
  canonicalResourceIdentity,
} from '../../services/access/resourceIdentity.js'

export const USER_DELEGATION_V2_TYPE = 'user_delegation' as const
export const USER_DELEGATION_V2_MAX_TTL_SECONDS = 300

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACCESS_PATH_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/
const AUTHORIZATION_REVISION_PATTERN = /^ar1_[A-Za-z0-9_-]{43}$/
const HASH_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,127}$/
const ALLOWED_CLAIMS = new Set([
  'typ',
  'ver',
  'sub',
  'sid',
  'sv',
  'jti',
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
  'iat',
  'exp',
  'iss',
  'aud',
])

export type UserDelegationV2Claims = Readonly<{
  typ: typeof USER_DELEGATION_V2_TYPE
  ver: typeof ACTION_CONTEXT_VERSION
  sub: string
  sid: string
  sv: number
  jti: string
  iat: number
  exp: number
  operationIds: readonly ActionOperationId[]
  scopes: readonly ActionOperationScope[]
  resource: CanonicalResourceIdentityWire
  targets: Readonly<Record<ActionOperationId, CanonicalActionTarget>>
  targetHashes: Readonly<Record<ActionOperationId, string>>
  accessPathId: string
  authorizationRevision: string
  behaviorBindingHash: string
  pathKind: 'direct' | 'team'
  effectiveTeamId: string | null
}>

export type IssueUserDelegationV2Input = Readonly<{
  principal: Readonly<{ userId: string; sid: string; sessionVersion: number }>
  operationIds: readonly ActionOperationId[]
  resource: CanonicalResourceIdentity
  preparedTargets: Readonly<Partial<Record<ActionOperationId, PreparedActionOperationTarget>>>
  accessPathId: string
  authorizationRevision: string
  behaviorBindingHash: string
  pathKind: 'direct' | 'team'
  effectiveTeamId: string | null
  ttlSeconds?: number
  issuedAtSeconds?: number
  delegationJti?: string
}>

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function canonicalOperationIds(value: unknown): readonly ActionOperationId[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null
  try {
    const ids = value.map(requireActionOperationId)
    if (new Set(ids).size !== ids.length) return null
    return Object.freeze(ids)
  } catch {
    return null
  }
}

function canonicalTargets(
  operationIds: readonly ActionOperationId[],
  rawTargets: unknown,
  rawHashes?: unknown
): {
  targets: Readonly<Record<ActionOperationId, CanonicalActionTarget>>
  targetHashes: Readonly<Record<ActionOperationId, string>>
} | null {
  if (!isPlainObject(rawTargets) || !hasExactKeys(rawTargets, operationIds)) return null
  if (
    rawHashes !== undefined &&
    (!isPlainObject(rawHashes) || !hasExactKeys(rawHashes, operationIds))
  ) {
    return null
  }
  const targets: Partial<Record<ActionOperationId, CanonicalActionTarget>> = {}
  const targetHashes: Partial<Record<ActionOperationId, string>> = {}
  try {
    for (const operationId of operationIds) {
      const rawTarget = rawTargets[operationId]
      const target = canonicalActionTarget(rawTarget)
      if (JSON.stringify(rawTarget) !== JSON.stringify(target)) return null
      const targetHash = hashActionTarget(target)
      if (rawHashes !== undefined && rawHashes[operationId] !== targetHash) return null
      targets[operationId] = target
      targetHashes[operationId] = targetHash
    }
  } catch {
    return null
  }
  return {
    targets: Object.freeze(targets) as Readonly<Record<ActionOperationId, CanonicalActionTarget>>,
    targetHashes: Object.freeze(targetHashes) as Readonly<Record<ActionOperationId, string>>,
  }
}

function canonicalResource(value: unknown): CanonicalResourceIdentity | null {
  if (!isPlainObject(value)) return null
  const expected = ['environmentId', 'type', 'canonicalId', 'logicalId', 'displayName']
  if ('providerUid' in value) expected.push('providerUid')
  if (!hasExactKeys(value, expected)) return null
  try {
    const resource = canonicalResourceIdentity({
      environmentId: value.environmentId,
      type: value.type,
      logicalId: value.logicalId,
      displayName: value.displayName,
      ...(value.providerUid !== undefined ? { providerUid: value.providerUid } : {}),
    })
    return resource.canonicalId === value.canonicalId ? resource : null
  } catch {
    return null
  }
}

function ttlSeconds(value: number | undefined): number {
  const configured = value ?? config.rpcTokenTtlSeconds
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new Error('user_delegation_ttl_invalid')
  }
  return Math.min(Math.floor(configured), USER_DELEGATION_V2_MAX_TTL_SECONDS)
}

function validateBinding(input: {
  sub: unknown
  sid: unknown
  sv: unknown
  jti: unknown
  accessPathId: unknown
  authorizationRevision: unknown
  behaviorBindingHash: unknown
  pathKind: unknown
  effectiveTeamId: unknown
}): boolean {
  if (
    !isUuid(input.sub) ||
    !isUuid(input.sid) ||
    !isUuid(input.jti) ||
    !Number.isInteger(input.sv) ||
    Number(input.sv) < 1 ||
    typeof input.accessPathId !== 'string' ||
    !ACCESS_PATH_PATTERN.test(input.accessPathId) ||
    typeof input.authorizationRevision !== 'string' ||
    !AUTHORIZATION_REVISION_PATTERN.test(input.authorizationRevision) ||
    typeof input.behaviorBindingHash !== 'string' ||
    !HASH_PATTERN.test(input.behaviorBindingHash) ||
    (input.pathKind !== 'direct' && input.pathKind !== 'team')
  ) {
    return false
  }
  return input.pathKind === 'direct'
    ? input.effectiveTeamId === null
    : isUuid(input.effectiveTeamId)
}

export function issueUserDelegationV2(input: IssueUserDelegationV2Input): string {
  const delegationJti = input.delegationJti ?? randomUUID()
  if (
    !validateBinding({
      sub: input.principal.userId,
      sid: input.principal.sid,
      sv: input.principal.sessionVersion,
      jti: delegationJti,
      accessPathId: input.accessPathId,
      authorizationRevision: input.authorizationRevision,
      behaviorBindingHash: input.behaviorBindingHash,
      pathKind: input.pathKind,
      effectiveTeamId: input.effectiveTeamId,
    })
  ) {
    throw new Error('user_delegation_binding_invalid')
  }
  const operationIds = canonicalOperationIds(input.operationIds)
  const resource = canonicalResource(input.resource)
  if (!resource) throw new Error('user_delegation_resource_invalid')
  if (!operationIds || !hasExactKeys(input.preparedTargets, operationIds)) {
    throw new Error('user_delegation_operations_invalid')
  }
  const preparedTargets: Partial<Record<ActionOperationId, CanonicalActionTarget>> = {}
  for (const operationId of operationIds) {
    const prepared = input.preparedTargets[operationId]
    if (!prepared) throw new Error('user_delegation_operations_invalid')
    const validated = validateActionOperationTarget({
      operationId,
      resource,
      operationTarget: prepared.target,
    })
    const canonical = canonicalActionTarget(validated)
    if (
      JSON.stringify(prepared.target) !== JSON.stringify(canonical) ||
      prepared.targetHash !== hashActionTarget(canonical)
    ) {
      throw new Error('user_delegation_operations_invalid')
    }
    preparedTargets[operationId] = canonical
  }
  const targetValues = canonicalTargets(operationIds, preparedTargets)
  if (!targetValues) throw new Error('user_delegation_operations_invalid')
  const scopes = operationIds.map(actionOperationScope)
  const issuedAt = input.issuedAtSeconds ?? Math.floor(Date.now() / 1000)
  return jwt.sign(
    {
      typ: USER_DELEGATION_V2_TYPE,
      ver: ACTION_CONTEXT_VERSION,
      sub: input.principal.userId,
      sid: input.principal.sid,
      sv: input.principal.sessionVersion,
      jti: delegationJti,
      operationIds,
      scopes,
      resource,
      targets: targetValues.targets,
      targetHashes: targetValues.targetHashes,
      accessPathId: input.accessPathId,
      authorizationRevision: input.authorizationRevision,
      behaviorBindingHash: input.behaviorBindingHash,
      pathKind: input.pathKind,
      effectiveTeamId: input.effectiveTeamId,
      iat: issuedAt,
    },
    config.rpcJwtPrivateKey,
    {
      algorithm: 'RS256',
      expiresIn: ttlSeconds(input.ttlSeconds),
      issuer: config.rpcJwtIssuer,
      audience: config.rpcJwtAudience,
    }
  )
}

export function verifyUserDelegationV2(token: string): UserDelegationV2Claims | null {
  try {
    const payload = jwt.verify(token, config.rpcJwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.rpcJwtIssuer,
      audience: config.rpcJwtAudience,
    }) as jwt.JwtPayload
    if (Object.keys(payload).some(claim => !ALLOWED_CLAIMS.has(claim))) return null
    if (
      payload.typ !== USER_DELEGATION_V2_TYPE ||
      payload.ver !== ACTION_CONTEXT_VERSION ||
      payload.iss !== config.rpcJwtIssuer ||
      payload.aud !== config.rpcJwtAudience ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > USER_DELEGATION_V2_MAX_TTL_SECONDS ||
      !validateBinding({
        sub: payload.sub,
        sid: payload.sid,
        sv: payload.sv,
        jti: payload.jti,
        accessPathId: payload.accessPathId,
        authorizationRevision: payload.authorizationRevision,
        behaviorBindingHash: payload.behaviorBindingHash,
        pathKind: payload.pathKind,
        effectiveTeamId: payload.effectiveTeamId,
      })
    ) {
      return null
    }
    const operationIds = canonicalOperationIds(payload.operationIds)
    if (!operationIds) return null
    const parsedScopes = parseActionOperationScopes(payload.scopes)
    if (JSON.stringify(parsedScopes.operationIds) !== JSON.stringify(operationIds)) return null
    const resource = canonicalResource(payload.resource)
    const targetValues = canonicalTargets(operationIds, payload.targets, payload.targetHashes)
    if (!resource || !targetValues) return null
    for (const operationId of operationIds) {
      const target = validateActionOperationTarget({
        operationId,
        resource,
        operationTarget: targetValues.targets[operationId],
      })
      if (JSON.stringify(target) !== JSON.stringify(targetValues.targets[operationId])) return null
    }
    return Object.freeze({
      typ: USER_DELEGATION_V2_TYPE,
      ver: ACTION_CONTEXT_VERSION,
      sub: payload.sub as string,
      sid: payload.sid as string,
      sv: Number(payload.sv),
      jti: payload.jti as string,
      iat: payload.iat,
      exp: payload.exp,
      operationIds,
      scopes: parsedScopes.scopes,
      resource,
      targets: targetValues.targets,
      targetHashes: targetValues.targetHashes,
      accessPathId: payload.accessPathId as string,
      authorizationRevision: payload.authorizationRevision as string,
      behaviorBindingHash: payload.behaviorBindingHash as string,
      pathKind: payload.pathKind as 'direct' | 'team',
      effectiveTeamId: payload.effectiveTeamId as string | null,
    })
  } catch {
    return null
  }
}
