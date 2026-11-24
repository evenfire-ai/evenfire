import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import type { OidcProviderConfiguration } from '../src/oidc/configuration.js'
import { createExternalAuthMethodsRouter } from '../src/routes/external/authMethods.js'
import { createExternalRouter } from '../src/routes/external/index.js'
import { createOidcMemberSignInFakeProvider } from './helpers/oidcMemberSignInFakeProvider.js'

/**
 * `GET /external/auth/methods` answers which sign-in methods Desktop offers.
 * The bodies below are the route's own answers; nothing here stands for them.
 */
const flowLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../src/observability/logger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/observability/logger.js')>()
  const rootLogger = new Proxy(actual.rootLogger, {
    get(target, prop, receiver) {
      if (prop !== 'child') return Reflect.get(target, prop, receiver)
      return (bindings: Record<string, unknown>, options?: object) =>
        bindings?.component === 'oidc_profile_flow' ? flowLog : target.child(bindings, options)
    },
  })
  return { ...actual, rootLogger }
})

const METHODS_PATH = '/external/auth/methods'
const baseProvider = createOidcMemberSignInFakeProvider().provider
const memberSignInOn: OidcProviderConfiguration = {
  ...baseProvider,
  displayLabel: 'Fixture Sign-In',
  issuer: 'https://login.fixture-issuer.example.com/fixture-tenant-id/v2.0',
  clientId: 'fixture-client-id-0001',
  redirectUri: 'https://profile.example.com/api/oidc/callback',
  memberSignIn: baseProvider.memberSignIn ?? baseProvider.memberEligibility,
}
const memberSignInOff: OidcProviderConfiguration = { ...memberSignInOn, memberSignIn: null }

function appWith(getProvider: () => OidcProviderConfiguration | undefined) {
  const app = express()
  app.use(createExternalAuthMethodsRouter({ getProvider }))
  return app
}

describe('GET /external/auth/methods', () => {
  beforeEach(() => {
    flowLog.error.mockReset()
  })

  it.each([
    ['password only when no provider is configured', () => undefined],
    ['password only when member sign-in is off', () => memberSignInOff],
  ])('answers %s', async (_name, getProvider) => {
    const response = await request(appWith(getProvider)).get(METHODS_PATH)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ methods: ['password'] })
  })

  it('answers password and oidc with the label and the Profile UI sign-in page when member sign-in is on', async () => {
    const response = await request(appWith(() => memberSignInOn)).get(METHODS_PATH)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      methods: ['password', 'oidc'],
      oidc: { label: 'Fixture Sign-In', signInUrl: 'https://profile.example.com/desktop-login' },
    })
  })

  it('answers password only, and logs the failure, when the loader throws', async () => {
    const response = await request(
      appWith(() => {
        throw new Error('CONTROL_API_OIDC_MEMBER_SIGN_IN requires CONTROL_API_OIDC_UNRELEASED')
      })
    ).get(METHODS_PATH)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ methods: ['password'] })
    expect(flowLog.error).toHaveBeenCalledTimes(1)
    expect(flowLog.error.mock.calls[0]?.[0]).toMatchObject({
      event: 'oidc_configuration_unavailable',
      errorClass: 'Error',
    })
  })

  it('never includes the issuer, tenant or client id', async () => {
    const response = await request(appWith(() => memberSignInOn)).get(METHODS_PATH)

    // The block is there, so the absence below is about what it leaves out.
    expect(response.body.oidc).toEqual({
      label: 'Fixture Sign-In',
      signInUrl: 'https://profile.example.com/desktop-login',
    })
    for (const secret of ['fixture-issuer', 'fixture-tenant-id', memberSignInOn.clientId]) {
      expect(JSON.stringify(response.body)).not.toContain(secret)
    }
  })

  it('is mounted on the external router and answers without a session token', async () => {
    const app = express()
    app.use(createExternalRouter({} as K8sGateway))

    const response = await request(app).get(METHODS_PATH)

    expect(response.status).toBe(200)
    expect(response.body.methods).toContain('password')
  })
})
