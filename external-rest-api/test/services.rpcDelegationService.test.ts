import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const client = vi.hoisted(() => ({ controlApiRequest: vi.fn() }))
vi.mock('../src/controlApiClient.js', () => client)

const { issueRpcDelegationV2 } = await import('../src/services/rpcDelegationService.js')

const repositoryRoot = resolve(process.cwd(), '..')
const tsx = resolve(repositoryRoot, 'external-rest-api/node_modules/.bin/tsx')
const producer = resolve(
  repositoryRoot,
  'control-api/test/fixtures/emitBodyBoundRouteDelegationV2Fixture.ts'
)
let producedMessageResponse: { delegationToken: string; messageId: string }
let producedMcpResponse: { delegationToken: string }

beforeAll(() => {
  const emit = (operationId: string, resourceType: string, resourceId: string, target: unknown) =>
    JSON.parse(
      execFileSync(
        tsx,
        [producer, JSON.stringify({ operationId, resourceType, resourceId, target })],
        { cwd: repositoryRoot, encoding: 'utf8', env: process.env }
      )
    ) as { token: string; messageId: string | null }
  const message = emit('chat.message.invoke', 'host', 'mcp-host/chatllm', {
    hostRef: 'mcp-host/chatllm',
    channelType: 'rpc',
    channelId: 'chat-1',
  })
  const mcp = emit('mcp.invoke', 'mcp_server', 'mcp-server/weather', {
    serverNamespace: 'mcp-server',
    serverName: 'weather',
    toolName: 'forecast',
  })
  if (!message.messageId || !mcp.token) throw new Error('Control API producer fixture incomplete')
  producedMessageResponse = {
    delegationToken: message.token,
    messageId: message.messageId,
  }
  producedMcpResponse = { delegationToken: mcp.token }
})

describe('rpc delegation v2 forwarding', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards only the explicit bounded selector and trusted edge headers', async () => {
    client.controlApiRequest.mockResolvedValue(producedMcpResponse)
    const body = {
      version: 2,
      operationId: 'host.status.read',
      resource: { type: 'host', logicalId: 'default/chatllm' },
      target: { hostRef: 'default/chatllm' },
    }

    await issueRpcDelegationV2({
      sessionToken: 'session-v2',
      requestBody: body,
      clientIp: '192.0.2.1',
      clientVersion: '2.1.0',
      accessPathId: `ap1_${'a'.repeat(43)}`,
      authorizationRevision: `ar1_${'b'.repeat(43)}`,
    })

    expect(client.controlApiRequest).toHaveBeenCalledWith('POST', '/external/rpc/delegations', {
      userSessionToken: 'session-v2',
      body,
      extraHeaders: {
        'x-evenfire-client-ip': '192.0.2.1',
        'x-evenfire-client-version': '2.1.0',
        'x-evenfire-access-path-id': `ap1_${'a'.repeat(43)}`,
        'x-evenfire-authorization-revision': `ar1_${'b'.repeat(43)}`,
      },
    })
    const headers = client.controlApiRequest.mock.calls[0][2].extraHeaders
    expect(Object.keys(headers).some(name => name.startsWith('x-clerum-edge-'))).toBe(false)
  })

  it('accepts the real Control API message-issuance response shape', async () => {
    client.controlApiRequest.mockResolvedValue(producedMessageResponse)
    const body = {
      version: 2,
      operationId: 'chat.message.invoke',
      resource: { type: 'host', logicalId: 'mcp-host/chatllm' },
      target: { hostRef: 'mcp-host/chatllm', channelType: 'rpc', channelId: 'chat-1' },
    }

    await expect(
      issueRpcDelegationV2({ sessionToken: 'session-v2', requestBody: body })
    ).resolves.toEqual(producedMessageResponse)
  })

  it('rejects a malformed response derived from the real Control API producer', async () => {
    client.controlApiRequest.mockResolvedValue({
      ...producedMessageResponse,
      messageId: 'not-a-message-id',
    })
    const body = {
      version: 2,
      operationId: 'chat.message.invoke',
      resource: { type: 'host', logicalId: 'mcp-host/chatllm' },
      target: { hostRef: 'mcp-host/chatllm', channelType: 'rpc', channelId: 'chat-1' },
    }

    await expect(
      issueRpcDelegationV2({ sessionToken: 'session-v2', requestBody: body })
    ).rejects.toThrow('invalid_rpc_delegation_response')
  })

  it.each([
    ['missing token', response => ({ messageId: response.messageId })],
    ['non-compact token', response => ({ ...response, delegationToken: 'not-a-jwt' })],
    ['unexpected field', response => ({ ...response, internalMessage: 'private' })],
  ])('rejects a real producer response with %s', async (_name, corrupt) => {
    client.controlApiRequest.mockResolvedValue(corrupt(producedMcpResponse))

    await expect(
      issueRpcDelegationV2({
        sessionToken: 'session-v2',
        requestBody: {
          version: 2,
          operationId: 'mcp.invoke',
          resource: { type: 'mcp_server', logicalId: 'mcp-server/weather' },
        },
      })
    ).rejects.toThrow('invalid_rpc_delegation_response')
  })

  it('requires the Control API message identifier for message issuance', async () => {
    client.controlApiRequest.mockResolvedValue({
      delegationToken: producedMessageResponse.delegationToken,
    })

    await expect(
      issueRpcDelegationV2({
        sessionToken: 'session-v2',
        requestBody: {
          version: 2,
          operationId: 'chat.message.invoke',
          resource: { type: 'host', logicalId: 'mcp-host/chatllm' },
        },
      })
    ).rejects.toThrow('invalid_rpc_delegation_response')
  })

  it('rejects a message identifier on non-message issuance', async () => {
    client.controlApiRequest.mockResolvedValue({
      ...producedMcpResponse,
      messageId: producedMessageResponse.messageId,
    })

    await expect(
      issueRpcDelegationV2({
        sessionToken: 'session-v2',
        requestBody: {
          version: 2,
          operationId: 'mcp.invoke',
          resource: { type: 'mcp_server', logicalId: 'mcp-server/weather' },
        },
      })
    ).rejects.toThrow('invalid_rpc_delegation_response')
  })
})
