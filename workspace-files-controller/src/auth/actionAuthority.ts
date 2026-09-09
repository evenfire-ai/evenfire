import { err } from '../errors'

export type WfcOperation = 'shared_filesystem.read' | 'shared_filesystem.write'
export type WfcTarget = Readonly<Record<string, string>>

export interface WfcAuthorityBindingV2 {
  version: 2
  userId: string
  sid: string
  sessionVersion: number
  delegationJti: string
  operationId: WfcOperation
  resource: Readonly<Record<string, unknown>>
  target: WfcTarget
  targetHash: string
  accessPathId: string
  authorizationRevision: string
  pathKind: 'direct' | 'team'
  effectiveTeamId: string | null
  behaviorBindingHash: string
}

export interface WfcActionAuthorityV2 {
  binding: WfcAuthorityBindingV2
  sourceIssuedAt: number
  sourceExpiresAt: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_RE = /^[A-Za-z][A-Za-z0-9_-]{2,127}$/
const ACCESS_PATH_RE = /^ap1_[A-Za-z0-9_-]{43}$/
const REVISION_RE = /^ar1_[A-Za-z0-9_-]{43}$/

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw err('forbidden', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw err('forbidden', `${field} contains unsupported fields`)
  }
}

function parseTarget(value: unknown): WfcTarget {
  const raw = object(value, 'actionAuthority.binding.target')
  const result: Record<string, string> = {}
  if (Object.keys(raw).length < 4 || Object.keys(raw).length > 6) {
    throw err('forbidden', 'actionAuthority.binding.target is invalid')
  }
  for (const [key, item] of Object.entries(raw)) {
    if (
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) ||
      typeof item !== 'string' ||
      !item ||
      item.length > 1024
    ) {
      throw err('forbidden', 'actionAuthority.binding.target is invalid')
    }
    result[key] = item
  }
  return Object.freeze(result)
}

export function parseWfcActionAuthority(
  value: unknown,
  outer: Readonly<{ sub: string; iat?: number; exp?: number; name: string; namespace: string }>
): WfcActionAuthorityV2 | undefined {
  if (value === undefined) return undefined
  const authority = object(value, 'actionAuthority')
  exactKeys(authority, ['binding', 'sourceIssuedAt', 'sourceExpiresAt'], 'actionAuthority')
  const binding = object(authority.binding, 'actionAuthority.binding')
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
  const resource = object(binding.resource, 'actionAuthority.binding.resource')
  const target = parseTarget(binding.target)
  const sourceIssuedAt = Number(authority.sourceIssuedAt)
  const sourceExpiresAt = Number(authority.sourceExpiresAt)
  const expectedResource = `${outer.namespace}/${outer.name}`
  if (
    binding.version !== 2 ||
    binding.userId !== outer.sub ||
    !UUID_RE.test(String(binding.userId)) ||
    !UUID_RE.test(String(binding.sid)) ||
    !UUID_RE.test(String(binding.delegationJti)) ||
    !Number.isSafeInteger(binding.sessionVersion) ||
    Number(binding.sessionVersion) < 1 ||
    (binding.operationId !== 'shared_filesystem.read' &&
      binding.operationId !== 'shared_filesystem.write') ||
    resource.type !== 'shared_filesystem' ||
    resource.logicalId !== expectedResource ||
    target.sharedFileSystemNamespace !== outer.namespace ||
    target.sharedFileSystemName !== outer.name ||
    !target.relationshipInstanceId ||
    !target.canonicalRelativePath ||
    !HASH_RE.test(String(binding.targetHash)) ||
    !ACCESS_PATH_RE.test(String(binding.accessPathId)) ||
    !REVISION_RE.test(String(binding.authorizationRevision)) ||
    !HASH_RE.test(String(binding.behaviorBindingHash)) ||
    (binding.pathKind !== 'direct' && binding.pathKind !== 'team') ||
    (binding.pathKind === 'direct'
      ? binding.effectiveTeamId !== null
      : !UUID_RE.test(String(binding.effectiveTeamId))) ||
    !Number.isSafeInteger(sourceIssuedAt) ||
    !Number.isSafeInteger(sourceExpiresAt) ||
    sourceExpiresAt <= sourceIssuedAt ||
    (outer.iat !== undefined && sourceIssuedAt > outer.iat) ||
    (outer.exp !== undefined && sourceExpiresAt > outer.exp)
  ) {
    throw err('forbidden', 'actionAuthority is invalid')
  }
  return Object.freeze({
    binding: Object.freeze({
      ...(binding as unknown as WfcAuthorityBindingV2),
      resource: Object.freeze({ ...resource }),
      target,
    }),
    sourceIssuedAt,
    sourceExpiresAt,
  })
}

export function createWfcAuthorityCheckpointer(config: {
  baseUrl: string
  serviceToken: string
  timeoutMs: number
}) {
  return async (
    authority: WfcActionAuthorityV2,
    expected: { operationId: WfcOperation; target: WfcTarget }
  ): Promise<void> => {
    const binding = authority.binding
    const sameTarget =
      Object.keys(binding.target).length === Object.keys(expected.target).length &&
      Object.entries(expected.target).every(([key, value]) => binding.target[key] === value)
    if (
      binding.operationId !== expected.operationId ||
      !sameTarget ||
      authority.sourceExpiresAt <= Math.floor(Date.now() / 1000)
    ) {
      throw err('forbidden', 'v2 filesystem authority does not match this operation')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    timer.unref()
    try {
      const response = await fetch(
        `${config.baseUrl.replace(/\/+$/, '')}/api/v1/internal/action-authority/checkpoint`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.serviceToken}`,
            'x-service-token': 'workspace-files-controller',
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
              service: 'workspace-files-controller',
              resource: binding.resource,
              targetHash: binding.targetHash,
            },
          }),
          signal: controller.signal,
        }
      )
      const payload = object(await response.json(), 'checkpoint response')
      if (!response.ok) {
        throw err(
          response.status >= 500 ? 'not_mounted' : 'forbidden',
          response.status >= 500
            ? 'live filesystem authority is unavailable'
            : 'live filesystem authority denied'
        )
      }
      const attribution = object(payload.attribution, 'checkpoint response attribution')
      if (
        payload.status !== 'allowed' ||
        payload.authorizationRevision !== binding.authorizationRevision ||
        payload.behaviorBindingHash !== binding.behaviorBindingHash ||
        attribution.userId !== binding.userId ||
        attribution.sid !== binding.sid ||
        attribution.sessionVersion !== binding.sessionVersion ||
        attribution.accessPathId !== binding.accessPathId ||
        attribution.pathKind !== binding.pathKind ||
        attribution.effectiveTeamId !== binding.effectiveTeamId ||
        (payload.validUntil !== null &&
          (typeof payload.validUntil !== 'string' ||
            !Number.isFinite(Date.parse(payload.validUntil)) ||
            Date.parse(payload.validUntil) <= Date.now()))
      ) {
        throw err('forbidden', 'live filesystem authority denied')
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error) throw error
      throw err('not_mounted', 'live filesystem authority is unavailable')
    } finally {
      clearTimeout(timer)
    }
  }
}
