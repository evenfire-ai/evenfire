import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose'
import type { AddressInfo } from 'node:net'
import { ClerumMcpServer } from '../../../src/mcp/server'
import { JwtTokenFactory } from '../../../src/workflow/jwtTokenFactory'
import { initializePublicKey } from '../../../src/workflow/restEndpoints'

describe('ClerumMcpServer workflow routes', () => {
  let server: ClerumMcpServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  it('does not register the removed singular direct-trigger endpoint', async () => {
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
    expect(address).not.toBeNull()

    const response = await fetch(
      `http://127.0.0.1:${address!.port}/api/v1/workflow/my-recipe/trigger`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
    expect(customApi.getNamespacedCustomObject).not.toHaveBeenCalled()
    expect(customApi.createNamespacedCustomObject).not.toHaveBeenCalled()
  })
})
