import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { generateKeyPairSync } from 'node:crypto'
import type { Server } from 'node:http'
import { config as externalConfig } from '../src/config.js'
import {
  createDesktopAuthorization,
  setupInvitationPassword,
  setupInvitationPasswordWithToken,
} from '../src/services/invitationsService.js'

describe('reset consumer handling of unexpected Control API 4xx responses', () => {
  const controlServiceToken = `synthetic-control-service-${'x'.repeat(24)}`
  let server: Server
  let previousBaseUrl: string
  let previousServiceToken: string
  let controlConfig: (typeof import('../../control-api/src/config.js'))['config']
  let previousInternalServiceTokens: Record<string, string>

  beforeAll(async () => {
    previousBaseUrl = externalConfig.controlApiBaseUrl
    previousServiceToken = externalConfig.controlApiServiceToken
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    vi.stubEnv('CONTROL_API_RPC_JWT_PRIVATE_KEY', privateKeyPem)
    vi.stubEnv('CONTROL_API_SESSION_JWT_PRIVATE_KEY', privateKeyPem)
    vi.stubEnv('CONTROL_API_ADMIN_JWT_PRIVATE_KEY', privateKeyPem)
    vi.resetModules()
    controlConfig = (await import('../../control-api/src/config.js')).config
    const { requireInternalToken } =
      await import('../../control-api/src/middleware/internalServiceAuth.js')
    previousInternalServiceTokens = controlConfig.internalServiceTokens
    controlConfig.internalServiceTokens = {}

    const controlApp = express()
    controlApp.use(express.json())
    controlApp.use(requireInternalToken)
    controlApp.post('/api/v1/external/invitations/password-token', (_req, res) => {
      res.status(200).json({ passwordUpdated: true })
    })
    server = controlApp.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))

    externalConfig.controlApiBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`
    externalConfig.controlApiServiceToken = controlServiceToken
  })

  afterAll(async () => {
    externalConfig.controlApiBaseUrl = previousBaseUrl
    externalConfig.controlApiServiceToken = previousServiceToken
    controlConfig.internalServiceTokens = previousInternalServiceTokens
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
    vi.unstubAllEnvs()
  })

  it('treats a real internal-service 401 as a sanitized authority outage', async () => {
    const outcome = await setupInvitationPasswordWithToken(
      'Synthetic-Recovery-Proof',
      'member@example.invalid',
      'synthetic-reset-row',
      'Synthetic-New-Password-123'
    ).then(
      value => ({ value }),
      error => ({ error })
    )

    expect(outcome).toMatchObject({
      error: {
        status: 503,
        body: { error: 'authority_unavailable' },
        headers: { 'retry-after': '2' },
      },
    })
    if ('error' in outcome) {
      expect(outcome.error.message).not.toMatch(/Unauthorized|api\/v1|Synthetic-Recovery-Proof/)
      expect(JSON.stringify(outcome.error.body)).not.toMatch(
        /Unauthorized|member@example|synthetic/
      )
    }
  })

  it('applies the same operational fallback to the other password consumers', async () => {
    const auth = {
      userId: 'synthetic-user-id',
      email: 'member@example.invalid',
      sessionToken: 'synthetic-session-token',
    }
    const acceptedInvitation = await setupInvitationPassword(
      auth,
      'synthetic-invitation-row',
      'Synthetic-New-Password-123'
    ).then(
      value => ({ value }),
      error => ({ error })
    )
    const desktopAuthorization = await createDesktopAuthorization(
      auth,
      'Synthetic-Current-Password-123'
    ).then(
      value => ({ value }),
      error => ({ error })
    )

    for (const outcome of [acceptedInvitation, desktopAuthorization]) {
      expect(outcome).toMatchObject({
        error: {
          status: 503,
          body: { error: 'authority_unavailable' },
          headers: { 'retry-after': '2' },
        },
      })
      if ('error' in outcome) {
        expect(outcome.error.message).not.toMatch(/Unauthorized|api\/v1|synthetic/i)
      }
    }
  })
})
