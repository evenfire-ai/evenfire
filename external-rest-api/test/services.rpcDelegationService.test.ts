import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({ controlApiRequest: vi.fn() }))
vi.mock('../src/controlApiClient.js', () => client)

const { issueRpcDelegationV2 } = await import('../src/services/rpcDelegationService.js')

describe('rpc delegation v2 forwarding', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards only the explicit bounded selector and trusted edge headers', async () => {
    client.controlApiRequest.mockResolvedValue({ delegationToken: 'delegation-v2' })
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
})
