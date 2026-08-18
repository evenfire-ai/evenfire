import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  ACTION_OPERATION_IDS,
  ACTION_OPERATION_SCOPES,
  actionOperationScope,
  canonicalActionTargetJson,
  classifyMcpCallerOperation,
  parseActionOperationScope,
  parseActionOperationScopes,
} from '@clerum/action-context-contracts'
import {
  type AccessPathBehavior,
  buildAccessPath,
  knownBehavior,
} from '../src/services/access/accessPath.js'
import {
  ActionContextV2Error,
  buildValidatedActionContextV2,
  requestedActionContextV2,
} from '../src/services/access/actionContextV2.js'
import {
  delegationV2IssuanceResponse,
  prepareActionOperationTarget,
} from '../src/services/access/actionMessageId.js'
import {
  ACTION_OPERATION_REGISTRY,
  type ActionOperationDefinition,
  ActionOperationTargetError,
  getActionOperationDefinition,
  validateActionOperationTarget,
} from '../src/services/access/actionOperationRegistry.js'
import { normalizeAccessCapabilities } from '../src/services/access/capabilityRegistry.js'
import type { LiveAuthorizationResult } from '../src/services/access/liveAuthorizationResolver.js'
import { actionOperationTargetHash } from '../src/services/access/operationTarget.js'
import {
  type AccessResourceType,
  canonicalResourceIdentity,
} from '../src/services/access/resourceIdentity.js'

const environmentId = 'cluster.local/evenfire'
const userId = '10000000-0000-4000-8000-000000000001'
const teamId = '20000000-0000-4000-8000-000000000002'
const sid = '30000000-0000-4000-8000-000000000003'
const revision = `ar1_${'a'.repeat(43)}`
const generatedMessageId = '40000000-0000-4000-8000-000000000004'

function logicalId(type: AccessResourceType): string {
  if (
    ['user', 'team', 'workflow_run', 'workflow_approval', 'gfs_resource', 'notification'].includes(
      type
    )
  ) {
    return '50000000-0000-4000-8000-000000000005'
  }
  if (type === 'host') return 'mcp-host/host-a'
  if (type === 'context') return 'contexts/context-a'
  if (type === 'mcp_server') return 'mcp-system/server-a'
  if (type === 'workflow_recipe') return 'workflow-recipes/recipe-a'
  if (type === 'shared_filesystem') return 'shared-filesystems/files-a'
  if (type === 'sandbox_app') return 'sandbox-recipes/app-a'
  if (type === 'workflow_artifact') return 'artifact-a'
  if (type === 'chat') return 'chat-a'
  if (type === 'runtime_session') return 'session-a'
  throw new Error(`No test identity for ${type}`)
}

function resourceFor(definition: ActionOperationDefinition) {
  const type = definition.resourceTypes[0]!
  return canonicalResourceIdentity({ environmentId, type, logicalId: logicalId(type) })
}

function targetValue(
  field: string,
  definition: ActionOperationDefinition,
  resource: ReturnType<typeof resourceFor>
): string {
  const binding = definition.targetSchema.resourceBinding
  if (binding?.mode === 'field' && binding.field === field) return resource.logicalId
  if (binding?.mode === 'namespaced_fields') {
    const [namespace, name] = resource.logicalId.split('/')
    if (binding.namespaceField === field) return namespace!
    if (binding.nameField === field) return name!
  }
  const accepted = definition.targetSchema.enums[field]
  if (accepted) return accepted[0]!
  if (
    [
      'approvalId',
      'approvalRequestId',
      'grantId',
      'messageId',
      'notificationId',
      'parentResourceId',
      'resourceId',
      'runId',
      'shareId',
      'uploadId',
    ].includes(field)
  ) {
    return '60000000-0000-4000-8000-000000000006'
  }
  if (field === 'hostRef') return 'mcp-host/host-a'
  if (field === 'inherit' || field === 'includeDescendants') return 'false'
  if (field.endsWith('Namespace')) return 'namespace-a'
  if (field.endsWith('Name')) return 'name-a'
  if (field.includes('Path')) return '/bounded/path'
  return `${field}-value`
}

function targetFor(definition: ActionOperationDefinition) {
  if (definition.targetSchema.mode === 'none') return undefined
  const resource = resourceFor(definition)
  return Object.fromEntries(
    definition.targetSchema.required.map(field => [field, targetValue(field, definition, resource)])
  )
}

function behavior(capabilities: AccessPathBehavior['capabilities']): AccessPathBehavior {
  return Object.freeze({
    capabilities: Object.freeze([...capabilities]),
    budget: knownBehavior(null),
    credentialPolicy: knownBehavior(null),
    approvalPolicy: knownBehavior(null),
    filesystemScope: knownBehavior(null),
    runtime: knownBehavior(null),
    providerModelPolicy: knownBehavior(null),
    audit: knownBehavior(`user:${userId}`),
  })
}

describe('canonical action-operation registry', () => {
  it('is exhaustive, unique, capability-backed, and never uses explicit-team runtime authority', () => {
    expect(ACTION_OPERATION_REGISTRY.map(entry => entry.operationId)).toEqual(ACTION_OPERATION_IDS)
    expect(new Set(ACTION_OPERATION_REGISTRY.map(entry => entry.operationId)).size).toBe(
      ACTION_OPERATION_IDS.length
    )
    for (const definition of ACTION_OPERATION_REGISTRY) {
      expect(definition.requiredCapabilities.length).toBeGreaterThan(0)
      expect(definition.pathMode).not.toBe('explicit_team')
      expect(getActionOperationDefinition(definition.operationId)).toBe(definition)
    }
  })

  it('freezes required behavior dimensions by operation semantics', () => {
    for (const definition of ACTION_OPERATION_REGISTRY) {
      if (definition.pathMode === 'resource_only') {
        expect(definition.requiredBehaviorDimensions).toEqual([])
      } else {
        expect(definition.requiredBehaviorDimensions).toContain('audit')
      }
    }
    expect(getActionOperationDefinition('chat.message.invoke').requiredBehaviorDimensions).toEqual([
      'budget',
      'credentialPolicy',
      'approvalPolicy',
      'filesystemScope',
      'runtime',
      'providerModelPolicy',
      'audit',
    ])
    expect(getActionOperationDefinition('mcp.invoke').requiredBehaviorDimensions).toEqual([
      'credentialPolicy',
      'approvalPolicy',
      'filesystemScope',
      'runtime',
      'audit',
    ])
    expect(getActionOperationDefinition('mcp.tools.read').requiredBehaviorDimensions).toEqual([
      'credentialPolicy',
      'runtime',
      'audit',
    ])
    expect(getActionOperationDefinition('model.select').requiredBehaviorDimensions).toEqual([
      'runtime',
      'providerModelPolicy',
      'audit',
    ])
  })

  it('accepts each exact registered target and rejects missing or additional authority fields', () => {
    for (const definition of ACTION_OPERATION_REGISTRY) {
      const resource = resourceFor(definition)
      const raw = targetFor(definition)
      expect(
        validateActionOperationTarget({
          operationId: definition.operationId,
          resource,
          operationTarget: raw,
        })
      ).toEqual(raw ?? null)

      if (definition.targetSchema.mode === 'none') {
        expect(() =>
          validateActionOperationTarget({
            operationId: definition.operationId,
            resource,
            operationTarget: { unexpected: 'value' },
          })
        ).toThrow(ActionOperationTargetError)
        continue
      }

      expect(() =>
        validateActionOperationTarget({
          operationId: definition.operationId,
          resource,
          operationTarget: { ...(raw ?? {}), unexpected: 'value' },
        })
      ).toThrow(ActionOperationTargetError)

      const required = definition.targetSchema.required[0]
      if (required) {
        const missing = { ...(raw ?? {}) }
        delete missing[required]
        expect(() =>
          validateActionOperationTarget({
            operationId: definition.operationId,
            resource,
            operationTarget: missing,
          })
        ).toThrow(ActionOperationTargetError)
      }
    }
  })

  it('rejects resource substitution for every operation with an immutable target binding', () => {
    for (const definition of ACTION_OPERATION_REGISTRY) {
      const binding = definition.targetSchema.resourceBinding
      if (!binding) continue
      const resource = resourceFor(definition)
      const raw = { ...(targetFor(definition) ?? {}) }
      if (binding.mode === 'field') {
        raw[binding.field] =
          binding.field === 'hostRef'
            ? 'mcp-host/substituted'
            : '70000000-0000-4000-8000-000000000007'
      } else raw[binding.nameField] = 'substituted'
      expect(() =>
        validateActionOperationTarget({
          operationId: definition.operationId,
          resource,
          operationTarget: raw,
        })
      ).toThrowError(expect.objectContaining({ code: 'resource_mismatch' }))
    }
  })

  it('hashes equivalent target maps identically under arbitrary insertion order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,12}$/),
          fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,24}$/),
          { maxKeys: 10 }
        ),
        target => {
          const entries = Object.entries(target)
          const reversed = Object.fromEntries([...entries].reverse())
          expect(canonicalActionTargetJson(target)).toBe(canonicalActionTargetJson(reversed))
          expect(actionOperationTargetHash(target)).toBe(actionOperationTargetHash(reversed))
        }
      ),
      { numRuns: 2_000 }
    )
  })
})

describe('v2 operation scopes and MCP classification', () => {
  it('generates one canonical v2 scope per registry operation and parses it bijectively', () => {
    expect(ACTION_OPERATION_SCOPES).toEqual(
      ACTION_OPERATION_REGISTRY.map(definition => `action:${definition.operationId}`)
    )
    for (const definition of ACTION_OPERATION_REGISTRY) {
      const scope = actionOperationScope(definition.operationId)
      expect(parseActionOperationScope(scope)).toBe(definition.operationId)
      expect(parseActionOperationScopes([scope])).toEqual({
        scopes: [scope],
        operationIds: [definition.operationId],
      })
    }
    expect(() => parseActionOperationScopes(['action:mcp.invoke', 'action:mcp.invoke'])).toThrow()
  })

  it('feeds classified caller MCP targets through the canonical registry validator', () => {
    const resource = canonicalResourceIdentity({
      environmentId,
      type: 'mcp_server',
      logicalId: 'mcp-system/server-a',
    })
    const call = classifyMcpCallerOperation({
      serverNamespace: 'mcp-system',
      serverName: 'server-a',
      method: 'tools/call',
      params: { name: 'lookup' },
    })
    const list = classifyMcpCallerOperation({
      serverNamespace: 'mcp-system',
      serverName: 'server-a',
      method: 'tools/list',
    })
    expect(call.status).toBe('classified')
    expect(list.status).toBe('classified')
    if (call.status === 'classified') {
      expect(
        validateActionOperationTarget({
          operationId: call.operationId,
          resource,
          operationTarget: call.target,
        })
      ).toEqual(call.target)
    }
    if (list.status === 'classified') {
      expect(
        validateActionOperationTarget({
          operationId: list.operationId,
          resource,
          operationTarget: list.target,
        })
      ).toEqual(list.target)
    }
    for (const method of ['initialize', 'notifications/initialized', 'ping', 'resources/list']) {
      expect(
        classifyMcpCallerOperation({
          serverNamespace: 'mcp-system',
          serverName: 'server-a',
          method,
        }).status
      ).toBe('denied')
    }
  })
})

describe('message target preparation and selected-path action context', () => {
  const host = canonicalResourceIdentity({
    environmentId,
    type: 'host',
    logicalId: 'mcp-host/host-a',
  })

  it('allocates the canonical chat message ID server-side and returns it with the token', () => {
    const prepared = prepareActionOperationTarget({
      operationId: 'chat.message.invoke',
      resource: host,
      operationTarget: {
        hostRef: host.logicalId,
        channelType: 'rpc',
        channelId: 'channel-a',
      },
      allocateMessageId: () => generatedMessageId.toUpperCase(),
    })
    expect(prepared.messageId).toBe(generatedMessageId)
    expect(prepared.target).toEqual({
      channelId: 'channel-a',
      channelType: 'rpc',
      hostRef: host.logicalId,
      messageId: generatedMessageId,
    })
    expect(
      delegationV2IssuanceResponse({
        operationId: 'chat.message.invoke',
        delegationToken: 'signed-token',
        prepared,
      })
    ).toEqual({ delegationToken: 'signed-token', messageId: generatedMessageId })

    expect(() =>
      prepareActionOperationTarget({
        operationId: 'chat.message.invoke',
        resource: host,
        operationTarget: {
          hostRef: host.logicalId,
          channelType: 'rpc',
          channelId: 'channel-a',
          messageId: generatedMessageId,
        },
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid' }))

    const first = prepareActionOperationTarget({
      operationId: 'chat.message.invoke',
      resource: host,
      operationTarget: { hostRef: host.logicalId, channelType: 'rpc', channelId: 'channel-a' },
    })
    const second = prepareActionOperationTarget({
      operationId: 'chat.message.invoke',
      resource: host,
      operationTarget: { hostRef: host.logicalId, channelType: 'rpc', channelId: 'channel-a' },
    })
    expect(first.messageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.messageId).not.toBe(first.messageId)
  })

  it('denies when only another path contributes the aggregate operation capability', () => {
    const pathA = buildAccessPath({
      principalUserId: userId,
      resource: host,
      seed: { kind: 'direct', grantId: 'direct-a', behavior: behavior(['host.read']) },
      authorizationRevision: revision,
    })
    const pathB = buildAccessPath({
      principalUserId: userId,
      resource: host,
      seed: {
        kind: 'team',
        grantId: 'team-b',
        teamId,
        currentRole: 'member',
        behavior: behavior(['host.read', 'remote_desktop.use']),
      },
      authorizationRevision: revision,
    })
    const authorization = {
      status: 'allowed',
      effectiveCapabilities: normalizeAccessCapabilities([
        ...pathA.behavior.capabilities,
        ...pathB.behavior.capabilities,
      ]),
      paths: [pathA, pathB],
      selectedPath: pathA,
      authorizationRevision: revision,
      validUntil: null,
    } satisfies LiveAuthorizationResult
    expect(authorization.effectiveCapabilities).toContain('remote_desktop.use')
    expect(pathA.behavior.capabilities).not.toContain('remote_desktop.use')

    expect(() =>
      buildValidatedActionContextV2({
        session: { contract: 'v2', userId, sid, jti: generatedMessageId, sessionVersion: 1 },
        requested: requestedActionContextV2({ accessPathId: pathA.id }),
        operation: getActionOperationDefinition('remote_desktop.open'),
        resource: host,
        preparedTarget: prepareActionOperationTarget({
          operationId: 'remote_desktop.open',
          resource: host,
          operationTarget: { hostRef: host.logicalId },
        }),
        authorization,
      })
    ).toThrowError(
      expect.objectContaining<ActionContextV2Error>({
        code: 'selected_path_capability_missing',
      })
    )
  })
})
