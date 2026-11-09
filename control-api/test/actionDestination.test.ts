import { describe, expect, it, vi } from 'vitest'
import {
  type ActionOperationId,
  canonicalResourceIdentity,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { config } from '../src/config.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { resolveActionDestination } from '../src/services/access/actionDestination.js'

const runtimeOperations: ReadonlyArray<
  readonly [ActionOperationId, Readonly<Record<string, string>>]
> = [
  ['task.read', { hostRef: `${config.hostsNamespace}/chatllm`, taskId: 'task-a' }],
  [
    'task.manage',
    { hostRef: `${config.hostsNamespace}/chatllm`, taskId: 'task-a', action: 'cancel' },
  ],
  ['model.read', { hostRef: `${config.hostsNamespace}/chatllm`, agent: 'a', chatId: 'c' }],
  [
    'model.select',
    {
      hostRef: `${config.hostsNamespace}/chatllm`,
      agent: 'a',
      chatId: 'c',
      provider: 'openai',
      model: 'model-a',
    },
  ],
  ['session.read', { hostRef: `${config.hostsNamespace}/chatllm` }],
  [
    'session.manage',
    {
      hostRef: `${config.hostsNamespace}/chatllm`,
      agent: 'a',
      chatId: 'c',
      action: 'delete',
    },
  ],
]

describe('runtime-session action destinations', () => {
  it.each(runtimeOperations)(
    'resolves the validated target host for %s',
    async (operationId, raw) => {
      const resource = canonicalResourceIdentity({
        environmentId: 'test',
        type: 'runtime_session',
        logicalId: 'session-a',
      })
      const target = validateActionOperationTarget({
        operationId,
        resource,
        operationTarget: raw,
      })
      const gateway = { getResourceExact: vi.fn() }

      await expect(
        resolveActionDestination({
          resource,
          target,
          gateway,
          budget: {} as never,
        })
      ).resolves.toEqual({
        status: 'resolved',
        destination: {
          kind: 'host',
          ref: `${config.hostsNamespace}/chatllm`,
          url: `http://chatllm.${config.hostsNamespace}.svc.cluster.local:8080`,
        },
      })
      expect(gateway.getResourceExact).not.toHaveBeenCalled()
    }
  )

  it('rejects a substituted host namespace without Kubernetes discovery', async () => {
    const resource = canonicalResourceIdentity({
      environmentId: 'test',
      type: 'runtime_session',
      logicalId: 'session-a',
    })
    const target = validateActionOperationTarget({
      operationId: 'session.read',
      resource,
      operationTarget: { hostRef: 'other-namespace/chatllm' },
    })
    const gateway = { getResourceExact: vi.fn() }

    await expect(
      resolveActionDestination({ resource, target, gateway, budget: {} as never })
    ).resolves.toEqual({ status: 'not_found' })
    expect(gateway.getResourceExact).not.toHaveBeenCalled()
  })
})

describe('MCP server action destinations', () => {
  const mcpResource = canonicalResourceIdentity({
    environmentId: 'test',
    type: 'mcp_server',
    logicalId: `${config.mcpServersNamespace}/weather`,
  })
  const mcpTarget = validateActionOperationTarget({
    operationId: 'mcp.invoke',
    resource: mcpResource,
    operationTarget: {
      serverNamespace: config.mcpServersNamespace,
      serverName: 'weather',
      toolName: 'forecast',
    },
  })

  function mcpServer(authType: string) {
    return Object.freeze({
      metadata: {
        name: 'weather',
        namespace: config.mcpServersNamespace,
        uid: 'uid-mcp-weather',
        resourceVersion: '23',
      },
      spec: {
        enabled: true,
        auth: { type: authType },
        transport: { type: 'streamable-http', url: 'http://weather.mcp-server:3000/mcp' },
      },
    })
  }

  async function resolveFor(authType: string) {
    const gateway = { getResourceExact: vi.fn(async () => mcpServer(authType)) }
    const budget = AccessExecutionBudget.create('action')
    try {
      const result = await resolveActionDestination({
        resource: mcpResource,
        target: mcpTarget,
        mcpServerBinding: { providerUid: 'uid-mcp-weather', providerResourceVersion: '23' },
        gateway,
        budget,
      })
      return { result, gateway }
    } finally {
      budget.close()
    }
  }

  it('gives an OAuth MCP server no action destination while the same server with auth type none resolves', async () => {
    const none = await resolveFor('none')
    const oauth = await resolveFor('oauth')

    // Liveness witness: the same live object with `auth.type: 'none'` resolves
    // to its URL, so the null destination below comes from the auth-type branch.
    expect(none.result).toEqual({
      status: 'resolved',
      destination: {
        kind: 'mcp_server',
        ref: `${config.mcpServersNamespace}/weather`,
        url: 'http://weather.mcp-server:3000/mcp',
      },
    })
    for (const { gateway } of [none, oauth]) {
      expect(gateway.getResourceExact).toHaveBeenCalledTimes(1)
      expect(gateway.getResourceExact).toHaveBeenCalledWith(
        'mcpservers',
        'weather',
        config.mcpServersNamespace,
        expect.objectContaining({ timeoutSeconds: expect.any(Number) })
      )
    }
    expect(oauth.result).toEqual({ status: 'resolved', destination: null })
  })
})
