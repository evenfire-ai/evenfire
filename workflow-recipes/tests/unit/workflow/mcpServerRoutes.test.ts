import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose'
import type { AddressInfo } from 'node:net'
import { ClerumMcpServer } from '../../../src/mcp/server'
import { JwtTokenFactory } from '../../../src/workflow/jwtTokenFactory'
import { initializePublicKey } from '../../../src/workflow/restEndpoints'

describe('ClerumMcpServer workflow routes', () => {
  let server: ClerumMcpServer | undefined
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
    consoleErrorSpy?.mockRestore()
    consoleErrorSpy = undefined
  })

  async function startTestServer(): Promise<{
    token: string
    port: number
    customApi: {
      getNamespacedCustomObject: ReturnType<typeof vi.fn>
      createNamespacedCustomObject: ReturnType<typeof vi.fn>
    }
  }> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    const privateKeyPem = await exportPKCS8(privateKey)
    const publicKeyPem = await exportSPKI(publicKey)
    const tokenFactory = new JwtTokenFactory(privateKeyPem)
    await tokenFactory.initialize()
    await initializePublicKey(publicKeyPem)
    const token = await tokenFactory.signCoordinatorToWrcToken('my-recipe', 'sandbox-recipes')

    const provider = {
      getAllRecipes: vi.fn(() => []),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getTokenFactory: vi.fn(() => tokenFactory),
      getTraceReporter: vi.fn(() => null),
      getDbRunProcessor: vi.fn(() => null),
    }
    const customApi = {
      getNamespacedCustomObject: vi.fn(),
      createNamespacedCustomObject: vi.fn(),
    }

    server = new ClerumMcpServer(
      provider as never,
      0,
      customApi as never,
      'control-plane',
      undefined,
      'sandbox-recipes',
      tokenFactory
    )
    await server.start()
    const address = (
      server as unknown as { httpServer: { address: () => AddressInfo | null } }
    ).httpServer.address()
    if (!address) throw new Error('test server did not bind')
    return { token, port: address.port, customApi }
  }

  it('does not register the removed singular direct-trigger endpoint', async () => {
    const { token, port, customApi } = await startTestServer()

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/workflow/my-recipe/trigger`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
    expect(customApi.getNamespacedCustomObject).not.toHaveBeenCalled()
    expect(customApi.createNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('does not reflect hostile auth input in the WRC auth log', async () => {
    const { port } = await startTestServer()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/workflow/my-recipe/status?marker=%25s%0D%0AFORGED`,
      {
        headers: { authorization: 'Bearer invalid-%s-FORGED' },
      }
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy).toHaveBeenCalledWith('[WRC-AUTH] Token verification failed')
    const calls = consoleErrorSpy.mock.calls.flat().join(' ')
    expect(calls).not.toContain('FORGED')
    expect(calls).not.toContain('%s')
    expect(calls).not.toContain('\r')
    expect(calls).not.toContain('\n')
  })
})
