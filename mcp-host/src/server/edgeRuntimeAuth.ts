import type { NextFunction, Request, Response } from 'express'
import { createHash } from 'node:crypto'
import {
  type ActionOperationId,
  type TrustedEdgeActionContextV2,
  canonicalActionTargetJson,
  hashActionTarget,
  validateActionOperationTarget,
  validateCanonicalResourceIdentity,
} from '@clerum/action-context-contracts'
import { config } from '../config'
import type { RuntimeCallerContext, RuntimeCallerKind } from './types'

const EDGE_CALLER_HEADER = 'x-clerum-edge-caller'
const EDGE_HOST_REF_HEADER = 'x-clerum-edge-host-ref'
const EDGE_USER_ID_HEADER = 'x-clerum-edge-user-id'
const EDGE_TEAM_ID_HEADER = 'x-clerum-edge-team-id'
const EDGE_REQUEST_ID_HEADER = 'x-clerum-edge-request-id'
const EDGE_CHANNEL_TYPE_HEADER = 'x-clerum-edge-channel-type'
const EDGE_CHANNEL_ID_HEADER = 'x-clerum-edge-channel-id'
const EDGE_SENDER_HEADER = 'x-clerum-edge-sender'
export const EDGE_ACTION_CONTEXT_HEADER = 'x-clerum-edge-action-context'
const MAX_ACTION_CONTEXT_HEADER_BYTES = 32 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TARGET_HASH_PATTERN = /^ath2_[A-Za-z0-9_-]{43}$/
const BEHAVIOR_HASH_PATTERN = /^bh2_[A-Za-z0-9_-]{43}$/
const ACCESS_PATH_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/
const AUTHORIZATION_REVISION_PATTERN = /^ar1_[A-Za-z0-9_-]{43}$/
const BEHAVIOR_KEYS = [
  'budget',
  'credentialPolicy',
  'approvalPolicy',
  'filesystemScope',
  'runtime',
  'providerModelPolicy',
  'audit',
] as const
const WORKFLOW_RUNTIME_ALIAS_REF_RE = /^([^/]+)\/~([0-9a-f]{16})$/

function firstHeaderValue(req: Request, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

function cleanHeader(req: Request, name: string): string | undefined {
  const value = firstHeaderValue(req, name)?.trim()
  return value ? value : undefined
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validBehavior(value: unknown): boolean {
  if (!hasExactKeys(value, BEHAVIOR_KEYS)) return false
  return BEHAVIOR_KEYS.every(key => {
    const dimension = value[key]
    if (hasExactKeys(dimension, ['state']) && dimension.state === 'unknown') return true
    return (
      hasExactKeys(dimension, ['state', 'value']) &&
      dimension.state === 'known' &&
      (dimension.value === null ||
        (typeof dimension.value === 'string' &&
          dimension.value.length <= 4096 &&
          !/[\u0000-\u001f\u007f]/.test(dimension.value)))
    )
  })
}

export function parseTrustedEdgeActionContext(value: string): TrustedEdgeActionContextV2 | null {
  if (
    Buffer.byteLength(value, 'utf8') > MAX_ACTION_CONTEXT_HEADER_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null
  }
  let decoded: unknown
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) return null
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (
    !hasExactKeys(decoded, [
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
      'behavior',
      'checkedAt',
      'expiresAt',
    ]) ||
    decoded.version !== 2 ||
    !UUID_PATTERN.test(String(decoded.userId)) ||
    !UUID_PATTERN.test(String(decoded.sid)) ||
    !Number.isSafeInteger(decoded.sessionVersion) ||
    Number(decoded.sessionVersion) < 1 ||
    !UUID_PATTERN.test(String(decoded.delegationJti)) ||
    typeof decoded.operationId !== 'string' ||
    !TARGET_HASH_PATTERN.test(String(decoded.targetHash)) ||
    !ACCESS_PATH_PATTERN.test(String(decoded.accessPathId)) ||
    !AUTHORIZATION_REVISION_PATTERN.test(String(decoded.authorizationRevision)) ||
    !BEHAVIOR_HASH_PATTERN.test(String(decoded.behaviorBindingHash)) ||
    (decoded.pathKind !== 'direct' && decoded.pathKind !== 'team') ||
    (decoded.effectiveTeamId !== null && !UUID_PATTERN.test(String(decoded.effectiveTeamId))) ||
    (decoded.pathKind === 'direct' && decoded.effectiveTeamId !== null) ||
    (decoded.pathKind === 'team' && decoded.effectiveTeamId === null) ||
    !validBehavior(decoded.behavior) ||
    typeof decoded.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(decoded.checkedAt)) ||
    typeof decoded.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(decoded.expiresAt)) ||
    Date.parse(decoded.expiresAt) < Date.parse(decoded.checkedAt) ||
    Date.parse(decoded.expiresAt) <= Date.now()
  ) {
    return null
  }
  try {
    const resource = validateCanonicalResourceIdentity(decoded.resource)
    const target = validateActionOperationTarget({
      operationId: decoded.operationId as ActionOperationId,
      resource,
      operationTarget: decoded.target,
    })
    if (
      canonicalActionTargetJson(target) !== canonicalActionTargetJson(decoded.target) ||
      hashActionTarget(target) !== decoded.targetHash
    ) {
      return null
    }
    return Object.freeze({ ...decoded, resource, target }) as TrustedEdgeActionContextV2
  } catch {
    return null
  }
}

function readLegacyRuntimeCaller(req: Request): RuntimeCallerContext | null {
  const caller = cleanHeader(req, EDGE_CALLER_HEADER)
  if (
    caller !== 'rpc-proxy' &&
    caller !== 'channel-reader' &&
    caller !== 'workflow-approval-request-reader'
  ) {
    return null
  }

  const context: RuntimeCallerContext = {
    caller,
    hostRef: cleanHeader(req, EDGE_HOST_REF_HEADER),
    requestId: cleanHeader(req, EDGE_REQUEST_ID_HEADER),
  }

  if (caller === 'rpc-proxy') {
    context.userId = cleanHeader(req, EDGE_USER_ID_HEADER)
    context.teamId = cleanHeader(req, EDGE_TEAM_ID_HEADER)
  } else {
    context.channelType = cleanHeader(req, EDGE_CHANNEL_TYPE_HEADER)
    context.channelId = cleanHeader(req, EDGE_CHANNEL_ID_HEADER)
    context.sender = cleanHeader(req, EDGE_SENDER_HEADER)
  }

  return context
}

function readRuntimeCaller(req: Request): RuntimeCallerContext | null {
  const legacy = readLegacyRuntimeCaller(req)
  if (!legacy) return null
  const encoded = cleanHeader(req, EDGE_ACTION_CONTEXT_HEADER)
  if (!encoded) return legacy
  if (legacy.caller !== 'rpc-proxy') return null
  if (
    cleanHeader(req, EDGE_USER_ID_HEADER) ||
    cleanHeader(req, EDGE_TEAM_ID_HEADER) ||
    cleanHeader(req, 'x-clerum-edge-access-scope')
  ) {
    return null
  }
  const actionContextV2 = parseTrustedEdgeActionContext(encoded)
  if (!actionContextV2) return null
  return {
    caller: legacy.caller,
    hostRef: legacy.hostRef,
    requestId: legacy.requestId,
    userId: actionContextV2.userId,
    actionContextV2,
  }
}

function routeAliasForHostRef(hostRef: string): string | null {
  const [namespace, name, ...rest] = hostRef.split('/')
  if (!namespace || !name || rest.length > 0) return null
  const hash = createHash('sha256').update(hostRef).digest('hex').slice(0, 16)
  return `${namespace}/~${hash}`
}

function hostRefMatchesRuntimeHost(hostRef: string, runtimeHost: string): boolean {
  if (hostRef === runtimeHost) return true
  const alias = hostRef.match(WORKFLOW_RUNTIME_ALIAS_REF_RE)
  if (!alias) return false
  const runtimeAlias = routeAliasForHostRef(runtimeHost)
  return runtimeAlias === hostRef
}

export function getRuntimeCallerContext(req: Request): RuntimeCallerContext | undefined {
  return (req as Request & { runtimeCaller?: RuntimeCallerContext }).runtimeCaller
}

export function runtimeActionTargetMatches(
  req: Request,
  expected: Readonly<Record<string, string | undefined>>
): boolean {
  const target = getRuntimeCallerContext(req)?.actionContextV2?.target
  if (target === undefined) return true
  if (target === null) return false
  const expectedEntries = Object.entries(expected).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
  const expectedKeys = expectedEntries.map(([key]) => key).sort()
  const targetKeys = Object.keys(target).sort()
  return (
    expectedKeys.length === targetKeys.length &&
    expectedKeys.every((key, index) => targetKeys[index] === key && target[key] === expected[key])
  )
}

export function runtimeEdgeGuard(
  allowedCallers: RuntimeCallerKind[],
  allowedV2Operations?: readonly ActionOperationId[]
) {
  const allowed = new Set<RuntimeCallerKind>(allowedCallers)
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.headers.authorization) {
      res
        .status(401)
        .json({ error: 'Authorization is not accepted on this direct mcp-host runtime route' })
      return
    }

    const context = readRuntimeCaller(req)
    if (!context || !allowed.has(context.caller)) {
      res.status(401).json({ error: 'Missing runtime edge caller context' })
      return
    }

    if (!context.hostRef) {
      res.status(401).json({ error: 'Missing runtime edge host context' })
      return
    }
    if (context.caller === 'rpc-proxy' && !context.userId) {
      res.status(401).json({ error: 'Missing rpc edge caller context' })
      return
    }
    if (
      context.actionContextV2 &&
      (!allowedV2Operations || !allowedV2Operations.includes(context.actionContextV2.operationId))
    ) {
      res.status(403).json({ error: 'Runtime edge operation mismatch' })
      return
    }
    if (context.actionContextV2) {
      const targetHostRef = context.actionContextV2.target?.hostRef
      const expectedHostRef = `${config.namespace}/${config.hostName}`
      if (typeof targetHostRef === 'string' && targetHostRef !== expectedHostRef) {
        res.status(403).json({ error: 'Runtime edge action host mismatch' })
        return
      }
    }
    if (context.hostRef && !hostRefMatchesRuntimeHost(context.hostRef, config.hostName)) {
      res.status(403).json({ error: 'Runtime edge host mismatch' })
      return
    }

    ;(req as Request & { runtimeCaller?: RuntimeCallerContext }).runtimeCaller = context
    next()
  }
}
