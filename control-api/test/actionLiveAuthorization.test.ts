import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { checkpointActionAuthority } from '../src/services/access/actionAuthorityCheckpoint.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import {
  type LiveActionAuthorizationInput,
  resolveLiveActionAuthorization,
} from '../src/services/access/liveAuthorizationResolver.js'
import {
  canonicalEnvironmentId,
  projectOperationalObject,
} from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

const environmentId = canonicalEnvironmentId()
const userId = '10000000-0000-4000-8000-000000000001'
const sid = '20000000-0000-4000-8000-000000000002'
const jti = '30000000-0000-4000-8000-000000000003'
const messageId = '40000000-0000-4000-8000-000000000004'
const session = Object.freeze({
  contract: 'v2' as const,
  userId,
  sid,
  jti,
  sessionVersion: 1,
})

const hostObject = Object.freeze({
  metadata: {
    name: 'host-a',
    namespace: config.hostsNamespace,
    uid: 'uid-host-a',
    resourceVersion: '91',
    generation: 1,
  },
  spec: { enabled: true },
})
const contextObject = Object.freeze({
  metadata: {
    name: 'ctx-a',
    namespace: config.contextsNamespace,
    uid: 'uid-context-a',
    resourceVersion: '17',
    generation: 1,
  },
  spec: { contextId: 'ctx-a', mcpServers: ['weather'], sharedFileSystems: [] },
})
const mcpObject = Object.freeze({
  metadata: {
    name: 'weather',
    namespace: config.mcpServersNamespace,
    uid: 'uid-mcp-weather',
    resourceVersion: '23',
    generation: 1,
  },
  spec: {
    enabled: true,
    auth: { type: 'none' },
    transport: { type: 'streamable-http', url: 'http://weather.mcp-server:3000/mcp' },
  },
})

const relationshipNamespaces = {
  context: config.contextsNamespace,
  mcpServer: config.mcpServersNamespace,
  sharedFilesystem: config.sharedFilesystemsNamespace,
}

function projection(plural: 'hosts' | 'contexts' | 'mcpservers', object: unknown) {
  return projectOperationalObject({
    environmentId,
    plural,
    namespace:
      plural === 'hosts'
        ? config.hostsNamespace
        : plural === 'contexts'
          ? config.contextsNamespace
          : config.mcpServersNamespace,
    object,
    behaviorFingerprintKey: config.sessionJwtPrivateKey,
    relationshipNamespaces,
  })
}

const hostProjection = projection('hosts', hostObject)
const contextProjection = projection('contexts', contextObject)
const mcpProjection = projection('mcpservers', mcpObject)

function resourceRow(resource: (typeof hostProjection.resources)[number]) {
  return {
    environment_id: resource.environmentId,
    resource_type: resource.resourceType,
    logical_id: resource.logicalId,
    source_family: resource.sourceFamily,
    provider_uid: resource.providerUid,
    provider_resource_version: resource.providerResourceVersion,
    display_name: resource.displayName,
    enabled: resource.enabled,
    deleted_at: resource.deletedAt,
    observed_generation: resource.observedGeneration,
    content_bytes: resource.contentBytes,
  }
}

function relationshipRow(relationship: (typeof contextProjection.relationships)[number]) {
  return {
    environment_id: relationship.environmentId,
    source_type: relationship.sourceType,
    source_id: relationship.sourceId,
    relationship_type: relationship.relationshipType,
    target_type: relationship.targetType,
    target_id: relationship.targetId,
    relationship_instance_id: relationship.relationshipInstanceId,
    behavior_attributes: relationship.behaviorAttributes,
    source_family: relationship.sourceFamily,
    source_provider_uid: relationship.sourceProviderUid,
    source_resource_version: relationship.sourceResourceVersion,
    observed_generation: relationship.observedGeneration,
    content_bytes: relationship.contentBytes,
  }
}

function fakeTransaction(kind: 'host' | 'mcp_server') {
  const query = vi.fn(async (text: string) => {
    if (text.startsWith('SET TRANSACTION') || text.includes("set_config('statement_timeout'")) {
      return { rows: [], rowCount: 0 }
    }
    if (text.includes('AS session_live')) {
      return {
        rows: [
          {
            user_id: userId,
            user_revision: '1',
            resource_revision: '1',
            session_live: true,
            session_revision: '1:current',
            memberships: [],
          },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('FROM operational_catalog_source_state')) {
      const families = kind === 'host' ? ['host'] : ['mcp_server', 'context', 'host']
      return {
        rows: families.map(source_family => ({
          source_family,
          generation: '7',
          resource_version: '91',
          status: 'current',
          safe_error_code: null,
        })),
        rowCount: families.length,
      }
    }
    if (text.includes('FROM operational_resource_index')) {
      const row =
        kind === 'host'
          ? resourceRow(hostProjection.resources[0]!)
          : resourceRow(mcpProjection.resources[0]!)
      return { rows: [row], rowCount: 1 }
    }
    if (text.includes('FROM operational_resource_relationships')) {
      const rows =
        kind === 'mcp_server'
          ? contextProjection.relationships
              .filter(value => value.targetId === `${config.mcpServersNamespace}/weather`)
              .map(relationshipRow)
          : []
      return { rows, rowCount: rows.length }
    }
    if (text.includes('WITH context_names AS')) {
      return {
        rows: [
          {
            kind: 'direct',
            grant_id: `user_contexts:${userId}:ctx-a`,
            team_id: null,
            current_role: null,
            source_type: 'context',
            source_name: 'ctx-a',
          },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('WITH candidates AS')) {
      return {
        rows: [
          {
            kind: 'direct',
            grant_id: `user_agents:${userId}:host-a`,
            team_id: null,
            current_role: null,
          },
        ],
        rowCount: 1,
      }
    }
    throw new Error(`Unexpected query: ${text.slice(0, 100)}`)
  })
  return {
    query,
    transaction: async <T>(work: (db: DbClient) => Promise<T>) =>
      work({ query } as unknown as DbClient),
  }
}

const gateway = {
  getResourceExact: vi.fn(async (plural: string, name: string) => {
    if (plural === 'hosts' && name === 'host-a') return hostObject
    if (plural === 'contexts' && name === 'ctx-a') return contextObject
    if (plural === 'mcpservers' && name === 'weather') return mcpObject
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }),
}

const hostResource = canonicalResourceIdentity({
  environmentId,
  type: 'host',
  logicalId: `${config.hostsNamespace}/host-a`,
})
const mcpResource = canonicalResourceIdentity({
  environmentId,
  type: 'mcp_server',
  logicalId: `${config.mcpServersNamespace}/weather`,
})

async function resolve(input: Omit<LiveActionAuthorizationInput, 'session'>) {
  const db = fakeTransaction(input.resource.type === 'mcp_server' ? 'mcp_server' : 'host')
  return resolveLiveActionAuthorization(
    { session, ...input },
    { transaction: db.transaction, gateway }
  )
}

describe('canonical action live authorization', () => {
  it.each([
    {
      operationId: 'host.status.read' as const,
      resource: hostResource,
      operationTarget: { hostRef: `${config.hostsNamespace}/host-a` },
      capability: 'host.read',
    },
    {
      operationId: 'chat.message.invoke' as const,
      resource: hostResource,
      operationTarget: {
        hostRef: `${config.hostsNamespace}/host-a`,
        channelType: 'rpc',
        channelId: 'host-a',
        messageId,
      },
      capability: 'chat.message.invoke',
    },
  ])('resolves $operationId through the real selected-path resolver', async input => {
    const result = await resolve(input)
    expect(result.status).toBe('allowed')
    if (result.status !== 'allowed') return
    expect(result.selectedPath.behavior.capabilities).toContain(input.capability)
  })

  it('resolves an exact MCP tool target through a current context grant', async () => {
    const result = await resolve({
      operationId: 'mcp.invoke',
      resource: mcpResource,
      operationTarget: {
        serverNamespace: config.mcpServersNamespace,
        serverName: 'weather',
        toolName: 'forecast',
      },
    })
    expect(result.status).toBe('allowed')
    if (result.status !== 'allowed') return
    expect(result.selectedPath.behavior.capabilities).toContain('mcp_server.use')
  })

  it('issues and checkpoints a read action using the real resolver path', async () => {
    const firstDb = fakeTransaction('host')
    const issued = await authorizeActionV2(
      {
        session,
        requested: { version: 2 },
        operationId: 'host.status.read',
        resource: hostResource,
        operationTarget: { hostRef: `${config.hostsNamespace}/host-a` },
        allocateChatMessageId: false,
        gateway,
      },
      { authorizationOptions: { transaction: firstDb.transaction } }
    )
    expect(issued.status).toBe('allowed')
    if (issued.status !== 'allowed') return

    const budget = AccessExecutionBudget.create('action')
    try {
      const checkpointDb = fakeTransaction('host')
      const checked = await checkpointActionAuthority(
        {
          request: {
            version: 2,
            principal: {
              sub: userId,
              sid,
              sessionVersion: 1,
            },
            delegationJti: jti,
            resource: hostResource,
            operationId: 'host.status.read',
            target: issued.context.target,
            targetHash: issued.context.targetHash,
            accessPathId: issued.context.accessPathId,
            authorizationRevision: issued.context.authorizationRevision,
            behaviorBindingHash: issued.context.behaviorBindingHash,
            domain: {
              service: 'rpc-proxy',
              resource: hostResource,
              targetHash: issued.context.targetHash,
            },
          },
          gateway,
          budget,
        },
        {
          authorize: input =>
            authorizeActionV2(input, {
              authorizationOptions: { transaction: checkpointDb.transaction },
            }),
        }
      )
      expect(checked).toMatchObject({
        version: 2,
        status: 'allowed',
        authorizationRevision: issued.context.authorizationRevision,
        behaviorBindingHash: issued.context.behaviorBindingHash,
      })
    } finally {
      budget.close()
    }
  })

  it('fails closed when the selected chat path lacks required behavior facts', async () => {
    const db = fakeTransaction('host')
    await expect(
      authorizeActionV2(
        {
          session,
          requested: { version: 2 },
          operationId: 'chat.message.invoke',
          resource: hostResource,
          operationTarget: {
            hostRef: `${config.hostsNamespace}/host-a`,
            channelType: 'rpc',
            channelId: 'host-a',
          },
          allocateChatMessageId: true,
          gateway,
        },
        {
          messageId: () => messageId,
          authorizationOptions: { transaction: db.transaction },
        }
      )
    ).resolves.toEqual({
      status: 'authority_unavailable',
      code: 'authority_unavailable',
      retryable: true,
    })
  })
})
