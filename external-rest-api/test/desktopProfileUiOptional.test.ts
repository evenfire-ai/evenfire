import { afterEach, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const environmentNames = [
  'NODE_ENV',
  'CLERUM_DEV_MODE',
  'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL',
  'EXTERNAL_REST_API_CORS_ORIGIN',
  'EXTERNAL_REST_API_GOOGLE_CLIENT_ID',
  'EXTERNAL_REST_API_CONTROL_API_BASE_URL',
  'EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN',
  'EXTERNAL_REST_API_JWT_ISSUER',
  'EXTERNAL_REST_API_JWT_AUDIENCE',
  'EXTERNAL_REST_API_PUBLIC_BASE_URL',
  'EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL',
] as const
const savedEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]))

afterEach(() => {
  for (const name of environmentNames) {
    const value = savedEnvironment[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.resetModules()
})

function configureProduction(): void {
  process.env.NODE_ENV = 'production'
  delete process.env.CLERUM_DEV_MODE
  process.env.EXTERNAL_REST_API_CORS_ORIGIN = 'https://profile.example.test'
  process.env.EXTERNAL_REST_API_GOOGLE_CLIENT_ID = 'synthetic-client'
  process.env.EXTERNAL_REST_API_CONTROL_API_BASE_URL = 'https://control.example.test/api/v1'
  process.env.EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN = 'synthetic-test-service-token'
  process.env.EXTERNAL_REST_API_JWT_ISSUER = 'control-api'
  process.env.EXTERNAL_REST_API_JWT_AUDIENCE = 'profile-ui'
  process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL = 'https://api.example.test'
  process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL = 'https://rpc.example.test'
}

async function readDesktopEnvironment() {
  vi.resetModules()
  const { createDesktopRouter } = await import('../src/routes/desktop.js')
  const app = express()
  app.use('/api/v1', createDesktopRouter())
  return request(app).get('/api/v1/desktop/environment').expect(200)
}

it.each([undefined, 'javascript:alert(1)'])(
  'serves existing discovery fields when the optional origin is %s',
  async optionalOrigin => {
    configureProduction()
    if (optionalOrigin === undefined) delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
    else process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = optionalOrigin

    const responsePromise = readDesktopEnvironment()
    await expect(responsePromise).resolves.toMatchObject({ status: 200 })
    const response = await responsePromise
    expect(response.body).toMatchObject({
      externalRestApiBaseUrl: 'https://api.example.test',
      rpcProxyBaseUrl: 'https://rpc.example.test',
    })
    expect(typeof response.body.appName).toBe('string')
    expect(response.body).not.toHaveProperty('profileUiBaseUrl')
  }
)

it('serves a configured origin under the same production fixture', async () => {
  configureProduction()
  process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = 'https://profile.example.test'

  const response = await readDesktopEnvironment()
  expect(response.body).toMatchObject({
    externalRestApiBaseUrl: 'https://api.example.test',
    rpcProxyBaseUrl: 'https://rpc.example.test',
    profileUiBaseUrl: 'https://profile.example.test',
  })
})
