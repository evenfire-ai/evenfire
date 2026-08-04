import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, importPKCS8 } from 'jose'
import crypto from 'node:crypto'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { config } from '../config'
import { PluginWorkloadSdkBootstrapServer } from './bootstrapServer'

const originalEnableAuth = config.enableAuth
const originalWrcPublicKey = config.wrcPublicKey
const originalRecipe = process.env.CLERUM_WORKFLOW_RECIPE
const originalNamespace = process.env.CLERUM_WORKFLOW_NAMESPACE
let publicKeyPem: string
let privateKeyPem: string

beforeAll(() => {
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  publicKeyPem = pair.publicKey
  privateKeyPem = pair.privateKey
})

async function signWorkflowToken(claims: Record<string, unknown>): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'RS256')
  return new SignJWT({
    sub: 'wrc',
    recipeName: 'sdk-recipe',
    recipeNamespace: 'sandbox-recipes',
    scopes: ['configure'],
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('clerum-wrc')
    .setAudience('mcp-host')
    .setExpirationTime('5m')
    .sign(key)
}

describe('PluginWorkloadSdkBootstrapServer', () => {
  let server: PluginWorkloadSdkBootstrapServer | null = null

  beforeEach(() => {
    config.enableAuth = false
  })

  afterEach(async () => {
    await server?.stop()
    server = null
    config.enableAuth = originalEnableAuth
    config.wrcPublicKey = originalWrcPublicKey
    if (originalRecipe === undefined) delete process.env.CLERUM_WORKFLOW_RECIPE
    else process.env.CLERUM_WORKFLOW_RECIPE = originalRecipe
    if (originalNamespace === undefined) delete process.env.CLERUM_WORKFLOW_NAMESPACE
    else process.env.CLERUM_WORKFLOW_NAMESPACE = originalNamespace
  })

  async function start(configure = vi.fn().mockResolvedValue({ configured: true, ready: true })) {
    server = new PluginWorkloadSdkBootstrapServer({ port: 0, configure })
    await server.start()
    const listener = (server as unknown as { server: http.Server }).server
    const address = listener.address() as AddressInfo
    return { baseUrl: `http://127.0.0.1:${address.port}`, configure }
  }

  it('exposes readiness and projects bootstrap input to public identity only', async () => {
    const { baseUrl, configure } = await start()
    const health = await fetch(`${baseUrl}/v1/runtime/health`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({ mode: 'sdk-only', ready: true })

    const response = await fetch(`${baseUrl}/api/v1/workflow/plugin-workload-sdk/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-5.4-mini',
        apiKey: 'must-not-cross-the-boundary',
      }),
    })
    expect(response.status).toBe(200)
    expect(configure).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.4-mini' })
  })

  it('requires a configure-scoped WRC token bound to the Pod recipe', async () => {
    config.enableAuth = true
    config.wrcPublicKey = publicKeyPem
    process.env.CLERUM_WORKFLOW_RECIPE = 'sdk-recipe'
    process.env.CLERUM_WORKFLOW_NAMESPACE = 'sandbox-recipes'
    const { baseUrl, configure } = await start()
    const endpoint = `${baseUrl}/api/v1/workflow/plugin-workload-sdk/bootstrap`
    const request = (token?: string) =>
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }),
      })

    expect((await request()).status).toBe(401)
    expect((await request(await signWorkflowToken({ scopes: ['execute'] }))).status).toBe(403)
    expect(
      (await request(await signWorkflowToken({ sub: 'coordinator', scopes: ['configure'] }))).status
    ).toBe(403)
    expect(
      (await request(await signWorkflowToken({ recipeName: 'different-recipe' }))).status
    ).toBe(403)
    expect((await request(await signWorkflowToken({}))).status).toBe(200)
    expect(configure).toHaveBeenCalledTimes(1)
  })

  it.each([
    '/api/v1/workflow/configure',
    '/api/v1/workflow/execute',
    '/api/v1/workflow/artifacts',
    '/v1/runtime/messages',
    '/v1/runtime/artifacts',
  ])('does not expose workflow or standalone route %s', async route => {
    const { baseUrl } = await start()
    const response = await fetch(`${baseUrl}${route}`, { method: 'POST' })
    expect(response.status).toBe(404)
  })
})
