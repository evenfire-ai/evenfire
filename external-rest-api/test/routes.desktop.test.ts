import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import desktopEnvironmentFixture from '../../profile-ui/test/fixtures/desktop-environment-response.json'

const originalEnv = {
  publicBaseUrl: process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL,
  rpcProxyBaseUrl: process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL,
  desktopAppName: process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME,
  desktopReleaseBaseUrl: process.env.EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL,
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
    process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL = 'https://api.example.com/'
    process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL = 'https://rpc.example.com/'
    process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME = 'Example Tenant'
    process.env.EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL =
      'https://github.com/example/evenfire/releases/'
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
  })

  it('returns public desktop environment discovery data', async () => {
    const res = await request(await buildApp())
      .get('/api/v1/desktop/environment')
      .expect(200)

    expect(res.body).toEqual(desktopEnvironmentFixture)
  })

  it('defaults the desktop discovery app name when it is not configured', async () => {
    delete process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME

    const res = await request(await buildApp())
      .get('/api/v1/desktop/environment')
      .expect(200)

    expect(res.body).toEqual({ ...desktopEnvironmentFixture, appName: 'Evenfire' })
  })

  it('returns the non-secret desktop compatibility policy without authentication', async () => {
    const { releaseManifest } = await import('../src/releaseManifest.js')
    const res = await request(await buildApp())
      .get('/api/v1/desktop/release')
      .expect(200)

    expect(res.body).toEqual({
      releaseId: releaseManifest.releaseId,
      externalRestApiVersion: releaseManifest.externalRestApiVersion,
      rpcProxyVersion: releaseManifest.rpcProxyVersion,
      desktopVersion: releaseManifest.desktopVersion,
      compatibleDesktopVersions: releaseManifest.compatibleDesktopVersions,
      minimumDesktopVersion: releaseManifest.minimumDesktopVersion,
      releaseTag: `v${releaseManifest.desktopVersion}`,
      releaseUrl: `https://github.com/example/evenfire/releases/tag/v${releaseManifest.desktopVersion}`,
    })
  })

  it('defaults the release base URL to the real repository', async () => {
    delete process.env.EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL
    const { config } = await import('../src/config.js')
    expect(config.desktopReleaseBaseUrl).toBe('https://github.com/evenfire-ai/evenfire/releases')
  })
})
