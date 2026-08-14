import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const authTokenMock = vi.hoisted(() => ({ verifyToken: vi.fn() }))
vi.mock('../src/authToken.js', () => authTokenMock)

const originalEnv = {
  publicBaseUrl: process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL,
  rpcProxyBaseUrl: process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL,
  desktopAppName: process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME,
  desktopReleaseBaseUrl: process.env.EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL,
  buildRevision: process.env.BUILD_REVISION,
}

async function buildApp() {
  const { createDesktopRouter } = await import('../src/routes/desktop.js')
  const app = express()
  app.use('/api/v1', createDesktopRouter())
  return app
}

describe('routes/desktop', () => {
  beforeEach(() => {
    vi.resetModules()
    authTokenMock.verifyToken.mockReset()
    process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL = 'https://api.example.com/'
    process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL = 'https://rpc.example.com/'
    process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME = 'Example Tenant'
    process.env.EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL =
      'https://github.com/example/evenfire/releases/'
    process.env.BUILD_REVISION = '4be949df1c2b3a4d5e6f708192a3b4c5d6e7f809'
  })

  afterEach(() => {
    if (originalEnv.publicBaseUrl === undefined)
      delete process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL
    else process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL = originalEnv.publicBaseUrl
    if (originalEnv.rpcProxyBaseUrl === undefined) {
      delete process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL
    } else {
      process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL = originalEnv.rpcProxyBaseUrl
    }
    if (originalEnv.desktopAppName === undefined)
      delete process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME
    else process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME = originalEnv.desktopAppName
    if (originalEnv.desktopReleaseBaseUrl === undefined) {
      delete process.env.EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL
    } else {
      process.env.EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL = originalEnv.desktopReleaseBaseUrl
    }
    if (originalEnv.buildRevision === undefined) delete process.env.BUILD_REVISION
    else process.env.BUILD_REVISION = originalEnv.buildRevision
  })

  it('returns public desktop environment discovery data', async () => {
    const res = await request(await buildApp())
      .get('/api/v1/desktop/environment')
      .expect(200)

    expect(res.body).toEqual({
      appName: 'Example Tenant',
      externalRestApiBaseUrl: 'https://api.example.com',
      rpcProxyBaseUrl: 'https://rpc.example.com',
    })
  })

  it('requires auth before returning desktop release policy', async () => {
    await request(await buildApp())
      .get('/api/v1/desktop/release')
      .expect(401)
  })

  it('returns the active desktop release policy for authenticated sessions', async () => {
    const { releaseManifest } = await import('../src/releaseManifest.js')
    authTokenMock.verifyToken.mockReturnValue({
      userId: 'u1',
      email: 'u@example.com',
      teamId: 'team-1',
      role: 'member',
      exp: 9_999_999_999,
    })

    const res = await request(await buildApp())
      .get('/api/v1/desktop/release')
      .set('authorization', 'Bearer session-xyz')
      .expect(200)

    expect(res.body).toEqual({
      releaseId: releaseManifest.releaseId,
      externalRestApiVersion: releaseManifest.externalRestApiVersion,
      rpcProxyVersion: releaseManifest.rpcProxyVersion,
      desktopVersion: releaseManifest.desktopVersion,
      minimumDesktopVersion: releaseManifest.minimumDesktopVersion,
      buildRevision: '4be949d',
      releaseTag: `v${releaseManifest.desktopVersion}`,
      releaseUrl: `https://github.com/example/evenfire/releases/tag/v${releaseManifest.desktopVersion}`,
    })
  })

  // Between releases, releaseId and desktopVersion are frozen at the last cut,
  // so this is the only field that moves when a component is rebuilt.
  it('reports the image build revision alongside the frozen release fields', async () => {
    process.env.BUILD_REVISION = 'aaaaaaabbbbbbbcccccccdddddddeeeeeeefffff'
    authTokenMock.verifyToken.mockReturnValue({
      userId: 'u1',
      email: 'u@example.com',
      teamId: 'team-1',
      role: 'member',
      exp: 9_999_999_999,
    })

    const res = await request(await buildApp())
      .get('/api/v1/desktop/release')
      .set('authorization', 'Bearer session-xyz')
      .expect(200)

    expect(res.body.buildRevision).toBe('aaaaaaa')
  })

  it('reports an empty build revision when nothing stamped the image', async () => {
    delete process.env.BUILD_REVISION
    authTokenMock.verifyToken.mockReturnValue({
      userId: 'u1',
      email: 'u@example.com',
      teamId: 'team-1',
      role: 'member',
      exp: 9_999_999_999,
    })

    const res = await request(await buildApp())
      .get('/api/v1/desktop/release')
      .set('authorization', 'Bearer session-xyz')
      .expect(200)

    expect(res.body.buildRevision).toBe('')
  })

  it('defaults the release base URL to the real repository', async () => {
    delete process.env.EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL
    const { config } = await import('../src/config.js')
    expect(config.desktopReleaseBaseUrl).toBe('https://github.com/evenfire-ai/evenfire/releases')
  })
})
