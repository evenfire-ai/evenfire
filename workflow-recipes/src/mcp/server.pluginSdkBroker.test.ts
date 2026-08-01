import { describe, expect, it, vi } from 'vitest'
import { ClerumMcpServer, revalidatePluginSdkCredentialTicket } from './server'

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('WRC Plugin SDK credential ticket TOCTOU revalidation', () => {
  it('consumes each verified ticket jti only once within its TTL', () => {
    const server = new ClerumMcpServer({} as never, 8082, {} as never, 'sandbox-recipes')
    const consume = (
      server as unknown as { consumePluginSdkTicket: (jti: string) => boolean }
    ).consumePluginSdkTicket.bind(server)
    expect(consume('ticket-jti')).toBe(true)
    expect(consume('ticket-jti')).toBe(false)
    expect(consume('another-ticket-jti')).toBe(true)
  })

  it('calls control-api immediately with runtime auth and accepts only active=true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { active: true }))
    await expect(
      revalidatePluginSdkCredentialTicket({
        runtimeToken: 'runtime-jwt',
        credentialTicket: 'signed-ticket',
        invocationId: 'inv-1',
        targetRef: 'primary-zai',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        controlApiBaseUrl: 'http://control-api:8090/',
      })
    ).resolves.toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://control-api:8090/api/v1/mcp-host/plugin-workload-sdk/credential-ticket/introspect'
    )
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer runtime-jwt')
    expect(JSON.parse(String(init.body))).toEqual({
      credentialTicket: 'signed-ticket',
      invocationId: 'inv-1',
      targetRef: 'primary-zai',
    })
  })

  it.each([
    [200, { active: false }],
    [403, { error: 'provider_policy_denied' }],
    [503, { error: 'unavailable' }],
  ])('fails closed for status/body %#', async (status, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(status as number, body))
    await expect(
      revalidatePluginSdkCredentialTicket({
        runtimeToken: 'runtime-jwt',
        credentialTicket: 'signed-ticket',
        invocationId: 'inv-1',
        targetRef: 'primary-zai',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        controlApiBaseUrl: 'http://control-api:8090',
      })
    ).resolves.toBe(false)
  })

  it('fails closed on network failure without exposing the ticket', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network detail'))
    await expect(
      revalidatePluginSdkCredentialTicket({
        runtimeToken: 'runtime-jwt',
        credentialTicket: 'signed-ticket',
        invocationId: 'inv-1',
        targetRef: 'primary-zai',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toBe(false)
  })
})
