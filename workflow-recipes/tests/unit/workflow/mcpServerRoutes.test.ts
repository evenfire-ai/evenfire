import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, exportPKCS8, exportSPKI, generateKeyPair } from 'jose'
import type { AddressInfo } from 'node:net'
import { ClerumMcpServer, MAX_BODY_BYTES } from '../../../src/mcp/server'
import { JwtTokenFactory } from '../../../src/workflow/jwtTokenFactory'
import {
  initializeControlApiPublicKey,
  initializePublicKey,
} from '../../../src/workflow/restEndpoints'

const logSpy = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withStep: vi.fn(),
  }
  logger.withStep.mockReturnValue(logger)
  return logger
})

vi.mock('../../../src/observability/logger', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/observability/logger')>()),
  createLogger: () => logSpy,
}))

describe('ClerumMcpServer workflow routes', () => {
  let server: ClerumMcpServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
    vi.clearAllMocks()
    logSpy.withStep.mockReturnValue(logSpy)
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

    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/workflow/my-recipe/status?marker=%25s%0D%0AFORGED`,
      {
        headers: { authorization: 'Bearer invalid-%s-FORGED' },
      }
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(logSpy.error).toHaveBeenCalledTimes(1)
    expect(logSpy.error).toHaveBeenCalledWith('WRC auth token verification failed')
    const calls = JSON.stringify(logSpy.error.mock.calls)
    expect(calls).not.toContain('FORGED')
    expect(calls).not.toContain('%s')
    expect(calls).not.toContain('\r')
    expect(calls).not.toContain('\n')
  })

  it('answers an oversized status report with a readable 413 and logs it without the body', async () => {
    const { token, port, customApi } = await startTestServer()
    const body = JSON.stringify({
      stepId: 'review',
      phase: 'completed',
      output: `BODY-MARKER-${'x'.repeat(MAX_BODY_BYTES)}`,
    })

    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/workflow/my-recipe/status?marker=QUERY-MARKER`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      }
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: 'Request body too large' })
    expect(customApi.getNamespacedCustomObject).not.toHaveBeenCalled()
    expect(logSpy.warn).toHaveBeenCalledWith('Rejected oversized request body', {
      method: 'POST',
      route: 'workflow',
      recipeName: 'my-recipe',
      bytesRead: Buffer.byteLength(body),
      contentLength: Buffer.byteLength(body),
      limitBytes: MAX_BODY_BYTES,
    })
    const logged = JSON.stringify(logSpy.warn.mock.calls)
    expect(logged).not.toContain('BODY-MARKER')
    expect(logged).not.toContain('QUERY-MARKER')
    expect(logged).not.toContain(token)

    // The drained connection keeps serving the next request.
    const next = await fetch(`http://127.0.0.1:${port}/api/v1/workflow/my-recipe/trigger`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(next.status).toBe(404)
  })

  it('answers an oversized credential broker request with a readable 413', async () => {
    const { port } = await startTestServer()
    const controlApiKeys = await generateKeyPair('RS256', { extractable: true })
    await initializeControlApiPublicKey(await exportSPKI(controlApiKeys.publicKey))
    const brokerToken = await new SignJWT({
      scope: 'workflow:approval:request',
      recipeName: 'my-recipe',
      recipeNamespace: 'sandbox-recipes',
      workflowControlScopes: ['plugin-workload-sdk'],
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('sandbox-recipes/my-recipe')
      .setIssuer('control-api')
      .setAudience('workflow-approvals')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(controlApiKeys.privateKey)
    const body = JSON.stringify({ target: `BODY-MARKER-${'x'.repeat(MAX_BODY_BYTES)}` })

    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/workflow/my-recipe/plugin-workload-sdk/credentials`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${brokerToken}`, 'content-type': 'application/json' },
        body,
      }
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid credential broker request' })
    expect(logSpy.warn).toHaveBeenCalledWith('Rejected oversized request body', {
      method: 'POST',
      route: 'plugin-workload-sdk-credentials',
      recipeName: 'my-recipe',
      bytesRead: Buffer.byteLength(body),
      contentLength: Buffer.byteLength(body),
      limitBytes: MAX_BODY_BYTES,
    })
    expect(JSON.stringify(logSpy.warn.mock.calls)).not.toContain('BODY-MARKER')
  })

  it('passes an unhandled handler error to the logger as the Error object it redacts', async () => {
    const { token, port, customApi } = await startTestServer()
    const failure = new Error('HTTP-Code: 403\nBody: {"url":"https://10.0.0.1/apis/x"}')
    customApi.getNamespacedCustomObject.mockRejectedValue(failure)

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/workflow/my-recipe/status`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.status).toBe(500)
    expect(logSpy.error).toHaveBeenCalledWith('Unhandled error in request handler', {
      error: failure,
    })
  })
})
