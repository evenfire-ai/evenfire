import { GfsError } from '../api/errors'

export type CanonicalTarget = Readonly<Record<string, string>>

export interface FilesystemAuthorityBindingV2 {
  version: 2
  userId: string
  sid: string
  sessionVersion: number
  delegationJti: string
  operationId: 'gfs.read' | 'gfs.write' | 'gfs.delete' | 'gfs.manage_acl' | 'gfs.share'
  resource: Readonly<Record<string, unknown>>
  target: CanonicalTarget
  targetHash: string
  accessPathId: string
  authorizationRevision: string
  pathKind: 'direct' | 'team'
  effectiveTeamId: string | null
  behaviorBindingHash: string
}

export interface FilesystemActionAuthorityV2 {
  binding: FilesystemAuthorityBindingV2
  sourceIssuedAt: number
  sourceExpiresAt: number
}

export interface GfsCheckpointConfig {
  baseUrl: string
  serviceToken: string
  timeoutMs: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_RE = /^[A-Za-z][A-Za-z0-9_-]{2,127}$/
const ACCESS_PATH_RE = /^ap1_[A-Za-z0-9_-]{43}$/
const REVISION_RE = /^ar1_[A-Za-z0-9_-]{43}$/
const OPERATIONS = new Set(['gfs.read', 'gfs.write', 'gfs.delete', 'gfs.manage_acl', 'gfs.share'])

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} contains unsupported fields`)
  }
}

function target(value: unknown): CanonicalTarget {
  const raw = record(value, 'actionAuthority.binding.target')
  if (Object.keys(raw).length === 0 || Object.keys(raw).length > 8) {
    throw new Error('actionAuthority.binding.target is invalid')
  }
  const parsed: Record<string, string> = {}
  for (const [key, item] of Object.entries(raw)) {
    if (
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) ||
      typeof item !== 'string' ||
      !item ||
      item.length > 1024
    ) {
      throw new Error('actionAuthority.binding.target is invalid')
    }
    parsed[key] = item
  }
  return Object.freeze(parsed)
}

export function parseGfsActionAuthority(
  value: unknown,
  outer: Readonly<{ sub: string; drive: string; iat: number; exp: number }>
): FilesystemActionAuthorityV2 | undefined {
  if (value === undefined) return undefined
  const authority = record(value, 'actionAuthority')
  exactKeys(authority, ['binding', 'sourceIssuedAt', 'sourceExpiresAt'], 'actionAuthority')
  const binding = record(authority.binding, 'actionAuthority.binding')
  exactKeys(
    binding,
    [
      'version',
      'userId',
      'sid',
      'sessionVersion',
      'delegationJti',
      'operationId',
      'resource',
      'target',
      'targetHash',
      'accessPathId',
      'authorizationRevision',
      'pathKind',
      'effectiveTeamId',
      'behaviorBindingHash',
    ],
    'actionAuthority.binding'
  )
  const resource = record(binding.resource, 'actionAuthority.binding.resource')
  const parsedTarget = target(binding.target)
  const issuedAt = Number(authority.sourceIssuedAt)
  const expiresAt = Number(authority.sourceExpiresAt)
  if (
    binding.version !== 2 ||
    binding.userId !== outer.sub ||
    !UUID_RE.test(String(binding.userId)) ||
    !UUID_RE.test(String(binding.sid)) ||
    !UUID_RE.test(String(binding.delegationJti)) ||
    !Number.isSafeInteger(binding.sessionVersion) ||
    Number(binding.sessionVersion) < 1 ||
    !OPERATIONS.has(String(binding.operationId)) ||
    resource.type !== 'gfs_resource' ||
    typeof resource.logicalId !== 'string' ||
    resource.logicalId !== parsedTarget.resourceId ||
    parsedTarget.drive !== outer.drive ||
    !HASH_RE.test(String(binding.targetHash)) ||
    !ACCESS_PATH_RE.test(String(binding.accessPathId)) ||
    !REVISION_RE.test(String(binding.authorizationRevision)) ||
    !HASH_RE.test(String(binding.behaviorBindingHash)) ||
    (binding.pathKind !== 'direct' && binding.pathKind !== 'team') ||
    (binding.pathKind === 'direct'
      ? binding.effectiveTeamId !== null
      : !UUID_RE.test(String(binding.effectiveTeamId))) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > outer.iat ||
    expiresAt > outer.exp ||
    expiresAt <= issuedAt
  ) {
    throw new Error('actionAuthority is invalid')
  }
  return Object.freeze({
    binding: Object.freeze({
      ...(binding as unknown as FilesystemAuthorityBindingV2),
      resource: Object.freeze({ ...resource }),
      target: parsedTarget,
    }),
    sourceIssuedAt: issuedAt,
    sourceExpiresAt: expiresAt,
  })
}

export function parseStoredGfsActionAuthority(value: unknown): FilesystemActionAuthorityV2 {
  const authority = record(value, 'stored actionAuthority')
  const binding = record(authority.binding, 'stored actionAuthority.binding')
  const storedTarget = record(binding.target, 'stored actionAuthority.binding.target')
  if (
    typeof binding.userId !== 'string' ||
    typeof storedTarget.drive !== 'string' ||
    !Number.isSafeInteger(authority.sourceIssuedAt) ||
    !Number.isSafeInteger(authority.sourceExpiresAt)
  ) {
    throw new Error('stored actionAuthority is invalid')
  }
  const parsed = parseGfsActionAuthority(value, {
    sub: binding.userId,
    drive: storedTarget.drive,
    iat: Number(authority.sourceIssuedAt),
    exp: Number(authority.sourceExpiresAt),
  })
  if (!parsed) throw new Error('stored actionAuthority is invalid')
  return parsed
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * A continuation carries a fresh exact delegation, so its JTI/operation/target
 * may differ. The durable ceiling is the originating user/session/resource and
 * selected access-path revision; crossing any of those boundaries is denied.
 */
export function sameGfsAuthorityOrigin(
  stored: FilesystemActionAuthorityV2,
  current: FilesystemActionAuthorityV2
): boolean {
  const left = stored.binding
  const right = current.binding
  return (
    left.userId === right.userId &&
    left.sid === right.sid &&
    left.sessionVersion === right.sessionVersion &&
    stableValue(left.resource) === stableValue(right.resource) &&
    left.accessPathId === right.accessPathId &&
    left.authorizationRevision === right.authorizationRevision &&
    left.pathKind === right.pathKind &&
    left.effectiveTeamId === right.effectiveTeamId &&
    left.behaviorBindingHash === right.behaviorBindingHash
  )
}

function canonicalRid(value: string): string {
  return value.replace(/-/g, '').toLowerCase()
}

function validUntilIsCurrent(value: unknown): boolean {
  if (value === null) return true
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > Date.now()
}

export function requireExactGfsAuthority(
  authority: FilesystemActionAuthorityV2 | undefined,
  expected: Readonly<{
    operationId: FilesystemAuthorityBindingV2['operationId']
    target: CanonicalTarget
  }>
): FilesystemActionAuthorityV2 | undefined {
  if (!authority) return undefined
  const actual = authority.binding
  const sameTarget =
    Object.keys(expected.target).length === Object.keys(actual.target).length &&
    Object.entries(expected.target).every(([key, value]) => {
      const observed = actual.target[key]
      return key === 'resourceId'
        ? canonicalRid(observed ?? '') === canonicalRid(value)
        : observed === value
    })
  if (actual.operationId !== expected.operationId || !sameTarget) {
    throw new GfsError('forbidden', 'v2 filesystem authority does not match this operation')
  }
  if (authority.sourceExpiresAt <= Math.floor(Date.now() / 1000)) {
    throw new GfsError('forbidden', 'v2 filesystem authority has expired')
  }
  return authority
}

export function createGfsAuthorityCheckpointer(config: GfsCheckpointConfig) {
  return async (authority: FilesystemActionAuthorityV2): Promise<void> => {
    const binding = authority.binding
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    timer.unref()
    let response: Response
    try {
      response = await fetch(
        `${config.baseUrl.replace(/\/+$/, '')}/api/v1/internal/action-authority/checkpoint`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.serviceToken}`,
            'x-service-token': 'gfs-controller',
          },
          body: JSON.stringify({
            version: 2,
            principal: {
              sub: binding.userId,
              sid: binding.sid,
              sessionVersion: binding.sessionVersion,
            },
            delegationJti: binding.delegationJti,
            resource: binding.resource,
            operationId: binding.operationId,
            target: binding.target,
            targetHash: binding.targetHash,
            accessPathId: binding.accessPathId,
            authorizationRevision: binding.authorizationRevision,
            behaviorBindingHash: binding.behaviorBindingHash,
            domain: {
              service: 'gfs-controller',
              resource: binding.resource,
              targetHash: binding.targetHash,
            },
          }),
          signal: controller.signal,
        }
      )
    } catch {
      throw new GfsError('not_mounted', 'live filesystem authority is unavailable')
    } finally {
      clearTimeout(timer)
    }
    let result: Record<string, unknown>
    try {
      result = record(await response.json(), 'checkpoint response')
    } catch {
      throw new GfsError('not_mounted', 'live filesystem authority returned an invalid response')
    }
    const attribution =
      result.attribution && typeof result.attribution === 'object'
        ? (result.attribution as Record<string, unknown>)
        : {}
    if (
      !response.ok ||
      result.status !== 'allowed' ||
      result.authorizationRevision !== binding.authorizationRevision ||
      result.behaviorBindingHash !== binding.behaviorBindingHash ||
      attribution.userId !== binding.userId ||
      attribution.sid !== binding.sid ||
      attribution.sessionVersion !== binding.sessionVersion ||
      attribution.accessPathId !== binding.accessPathId ||
      attribution.pathKind !== binding.pathKind ||
      attribution.effectiveTeamId !== binding.effectiveTeamId ||
      !validUntilIsCurrent(result.validUntil)
    ) {
      throw new GfsError(
        !response.ok && response.status >= 500 ? 'not_mounted' : 'forbidden',
        !response.ok && response.status >= 500
          ? 'live filesystem authority is unavailable'
          : 'live filesystem authority denied'
      )
    }
  }
}
