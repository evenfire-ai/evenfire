import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { checkpointActionAuthority } from '../src/services/access/actionAuthorityCheckpoint.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import { resolveActionDestination } from '../src/services/access/actionDestination.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import {
  type LiveActionAuthorizationInput,
  resolveLiveActionAuthorization,
} from '../src/services/access/liveAuthorizationResolver.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  type AccessTransactionTripwire,
  type TripwireQueryResult,
  installAccessTransactionTripwire,
} from './helpers/accessTransactionTripwire.js'
import {
  contextObject,
  createFakeOperationalGateway,
  hostObject,
  mcpServerObject,
} from './helpers/fakeOperationalGateway.js'

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

const hostA = hostObject('host-a', {}, { uid: 'uid-host-a', resourceVersion: '91' })
const contextA = contextObject(
  'ctx-a',
  { contextId: 'ctx-a', mcpServers: ['weather'] },
  { uid: 'uid-context-a', resourceVersion: '17' }
)
const weather = mcpServerObject(
  'weather',
  { url: 'http://weather.mcp-server:3000/mcp' },
  { uid: 'uid-mcp-weather', resourceVersion: '23' }
)

function rows(values: Record<string, unknown>[]): TripwireQueryResult {
  return { rows: values, rowCount: values.length }
}

/** The Postgres side of one resolution: phase P's statements, nothing else. */
function statements(kind: 'host' | 'mcp_server') {
  return (text: string): TripwireQueryResult => {
    if (text.startsWith('SET TRANSACTION') || text.includes("set_config('statement_timeout'")) {
      return rows([])
    }
    if (text.includes('AS session_live')) {
      return rows([
        {
          user_id: userId,
          session_live: true,
          session_revision: '1:current',
          memberships: [],
        },
      ])
    }
    if (text.includes('FROM token_budgets')) return rows([])
    if (text.includes('FROM llm_allowed_models')) return rows([])
    if (text.includes('SELECT DISTINCT ON (context_id)')) return rows([])
    if (kind === 'mcp_server' && text.includes('WITH context_references AS')) {
      return rows([
        {
          kind: 'direct',
          grant_id: `user_contexts:${userId}:ctx-a`,
          team_id: null,
          current_role: null,
          source_type: 'context',
          source_name: `${config.contextsNamespace}/ctx-a`,
        },
      ])
    }
    if (kind === 'host' && text.includes('WITH candidates AS')) {
      return rows([
        {
          kind: 'direct',
          grant_id: `user_agents:${userId}:host-a`,
          team_id: null,
          current_role: null,
        },
      ])
    }
    throw new Error(`Unexpected query: ${text.slice(0, 100)}`)
  }
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

let tripwire: AccessTransactionTripwire
let fake: ReturnType<typeof createFakeOperationalGateway>

function install(kind: 'host' | 'mcp_server', objects: { hosts?: unknown[] } = {}) {
  tripwire = installAccessTransactionTripwire(statements(kind))
  fake = createFakeOperationalGateway({
    objects: {
      hosts: objects.hosts ?? [hostA],
      contexts: [contextA],
      mcpservers: [weather],
    },
    tripwire,
  })
}

beforeEach(() => install('host'))
afterEach(() => {
  vi.restoreAllMocks()
})

async function resolve(input: Omit<LiveActionAuthorizationInput, 'session'>) {
  return resolveLiveActionAuthorization({ session, ...input }, { gateway: fake.gateway })
}

function expectTransactionsClosed(): void {
  // T-L8 witness: the fakes were called, and every transaction ended.
  expect(tripwire.externalCalls.length).toBeGreaterThan(0)
  expect(tripwire.events).toContain('BEGIN')
  expect(tripwire.openTransactions()).toBe(0)
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
    expect(result.status, JSON.stringify(result)).toBe('allowed')
    // Liveness witness: the Host graph was read live from Kubernetes.
    expect(fake.calls.map(call => `${call.method}:${call.plural}`)).toContain(
      'listResourcePage:contexts'
    )
    expectTransactionsClosed()
    if (result.status !== 'allowed') return
    expect(result.selectedPath.behavior.capabilities).toContain(input.capability)
  })

  it('fails a Host closed when its configured Context does not resolve', async () => {
    vi.restoreAllMocks()
    install('host', { hosts: [hostObject('host-a', { contextRef: 'missing' })] })
    const result = await resolve({
      operationId: 'host.status.read',
      resource: hostResource,
      operationTarget: { hostRef: `${config.hostsNamespace}/host-a` },
    })
    expect(fake.calls.map(call => `${call.method}:${call.plural}`)).toContain(
      'listResourcePage:contexts'
    )
    expect(result).toEqual({
      status: 'unavailable',
      dependencyClass: 'operational_resource_store',
      retryable: true,
    })
  })

  it('resolves an exact MCP tool target through a current context grant', async () => {
    vi.restoreAllMocks()
    install('mcp_server')
    const target = {
      serverNamespace: config.mcpServersNamespace,
      serverName: 'weather',
      toolName: 'forecast',
    }
    const authorized = await authorizeActionV2({
      session,
      requested: { version: 2 },
      operationId: 'mcp.invoke',
      resource: mcpResource,
      operationTarget: target,
      allocateChatMessageId: false,
      gateway: fake.gateway,
    })
    expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
    expectTransactionsClosed()
    if (authorized.status !== 'allowed') return
    expect(authorized.context.selectedPathCapabilities).toContain('mcp_server.use')
    expect(authorized.mcpServerBinding).toEqual({
      providerUid: 'uid-mcp-weather',
      providerResourceVersion: '23',
    })

    const budget = AccessExecutionBudget.create('action')
    try {
      const destination = await resolveActionDestination({
        resource: authorized.context.resource,
        target: authorized.context.target,
        mcpServerBinding: authorized.mcpServerBinding,
        gateway: fake.gateway,
        budget,
      })
      expect(destination).toEqual({
        status: 'resolved',
        destination: {
          kind: 'mcp_server',
          ref: mcpResource.logicalId,
          url: 'http://weather.mcp-server:3000/mcp',
        },
      })
    } finally {
      budget.close()
    }
  })

  it.each([
    {
      description: 'same name with a different UID',
      uid: 'uid-mcp-weather-replacement',
      resourceVersion: '24',
    },
    {
      description: 'same UID with a changed resourceVersion',
      uid: 'uid-mcp-weather',
      resourceVersion: '24',
    },
  ])('rejects an MCP destination replaced after authorization: $description', async replacement => {
    vi.restoreAllMocks()
    install('mcp_server')
    const budget = AccessExecutionBudget.create('action')
    try {
      const authorized = await authorizeActionV2({
        session,
        requested: { version: 2 },
        operationId: 'mcp.invoke',
        resource: mcpResource,
        operationTarget: {
          serverNamespace: config.mcpServersNamespace,
          serverName: 'weather',
          toolName: 'forecast',
        },
        allocateChatMessageId: false,
        gateway: fake.gateway,
        budget,
      })
      expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
      if (authorized.status !== 'allowed') return
      expect(authorized.mcpServerBinding).toEqual({
        providerUid: 'uid-mcp-weather',
        providerResourceVersion: '23',
      })

      fake.objects.mcpservers[0] = mcpServerObject(
        'weather',
        { url: 'http://replacement.mcp-server:3000/mcp' },
        { uid: replacement.uid, resourceVersion: replacement.resourceVersion }
      )

      const destination = await resolveActionDestination({
        resource: authorized.context.resource,
        target: authorized.context.target,
        mcpServerBinding: authorized.mcpServerBinding,
        gateway: fake.gateway,
        budget,
      })
      expect(destination).toEqual({ status: 'stale' })
    } finally {
      budget.close()
    }
  })

  it('issues and checkpoints a read action using the real resolver path', async () => {
    const issued = await authorizeActionV2({
      session,
      requested: { version: 2 },
      operationId: 'host.status.read',
      resource: hostResource,
      operationTarget: { hostRef: `${config.hostsNamespace}/host-a` },
      allocateChatMessageId: false,
      gateway: fake.gateway,
    })
    expect(issued.status, JSON.stringify(issued)).toBe('allowed')
    if (issued.status !== 'allowed') return

    const budget = AccessExecutionBudget.create('action')
    try {
      const checked = await checkpointActionAuthority({
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
        gateway: fake.gateway,
        budget,
      })
      expect(checked).toMatchObject({
        version: 2,
        status: 'allowed',
        authorizationRevision: issued.context.authorizationRevision,
        behaviorBindingHash: issued.context.behaviorBindingHash,
      })
      expectTransactionsClosed()
    } finally {
      budget.close()
    }
  })

  it('rejects a replaced MCP destination in the action checkpoint consumer', async () => {
    vi.restoreAllMocks()
    install('mcp_server')
    const mcpTarget = {
      serverNamespace: config.mcpServersNamespace,
      serverName: 'weather',
      toolName: 'forecast',
    }
    const preparedMcpTarget = prepareActionOperationTarget({
      operationId: 'mcp.invoke',
      resource: mcpResource,
      operationTarget: mcpTarget,
      allocateMessageId: () => {
        throw new Error('MCP invocation must not allocate a chat message ID')
      },
    })
    const authorized = await authorizeActionV2({
      session,
      requested: { version: 2 },
      operationId: 'mcp.invoke',
      resource: mcpResource,
      operationTarget: mcpTarget,
      allocateChatMessageId: false,
      gateway: fake.gateway,
    })
    expect(authorized.status, JSON.stringify(authorized)).toBe('allowed')
    if (authorized.status !== 'allowed') return

    const replacement = mcpServerObject(
      'weather',
      { url: 'http://replacement.mcp-server:3000/mcp' },
      { uid: 'uid-mcp-weather-replacement', resourceVersion: '24' }
    )
    const budget = AccessExecutionBudget.create('action')
    try {
      const checked = await checkpointActionAuthority(
        {
          request: {
            version: 2,
            principal: { sub: userId, sid, sessionVersion: 1 },
            delegationJti: jti,
            resource: mcpResource,
            operationId: 'mcp.invoke',
            target: preparedMcpTarget.target,
            targetHash: preparedMcpTarget.targetHash,
            accessPathId: authorized.context.accessPathId,
            authorizationRevision: authorized.context.authorizationRevision,
            behaviorBindingHash: authorized.context.behaviorBindingHash,
            domain: {
              service: 'rpc-proxy',
              resource: mcpResource,
              targetHash: preparedMcpTarget.targetHash,
            },
          },
          gateway: fake.gateway,
          budget,
        },
        {
          authorize: async input => {
            const current = await authorizeActionV2(input)
            fake.objects.mcpservers[0] = replacement
            return current
          },
        }
      )

      expect(checked).toMatchObject({
        version: 2,
        status: 'access_path_stale',
        code: 'access_path_stale',
      })
      const lastGet = fake.calls.filter(call => call.method === 'getResourceExact').at(-1)
      expect(lastGet).toMatchObject({
        plural: 'mcpservers',
        name: 'weather',
        namespace: config.mcpServersNamespace,
      })
    } finally {
      budget.close()
    }
  })

  it('fails closed when the selected chat path lacks required behavior facts', async () => {
    vi.restoreAllMocks()
    // A non-string model connection reference leaves the Host credential
    // policy unknown in its projection.
    const unknownCredentialHost = {
      ...hostA,
      spec: {
        enabled: true,
        model: { provider: 'codex-subscription', name: 'gpt-5', connectionRef: 7 },
      },
    }
    install('host', { hosts: [unknownCredentialHost] })
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
          gateway: fake.gateway,
        },
        { messageId: () => messageId }
      )
    ).resolves.toEqual({
      status: 'authority_unavailable',
      code: 'authority_unavailable',
      retryable: true,
    })
    // Witness: the resolver reached its selected path: the root GET of phase K1
    // and the exact Host GET of phase K2 both ran.
    expect(
      fake.calls.filter(call => call.method === 'getResourceExact' && call.name === 'host-a')
    ).toHaveLength(2)
    expectTransactionsClosed()
  })
})
