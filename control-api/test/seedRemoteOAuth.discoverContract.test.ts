import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
// @ts-expect-error -- plain ESM script without type declarations
import { evaluateDiscover } from '../../scripts/registry/seed-remote-oauth.mjs'
// @ts-expect-error -- plain ESM script without type declarations
import { discoverResponse } from '../../scripts/registry/test-support/fake-servers.mjs'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import type { K8sGateway } from '../src/k8s.js'
import { discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import * as catalogRules from '../src/routes/admin/catalogRemoteOAuth.js'
import { createAdminRemoteMcpRouter } from '../src/routes/admin/remoteMcp.js'
import {
  PILOTS,
  type PilotFixture,
  VERCEL_PILOT,
  makeDiscoveryTransport,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * The catalog seed script judges the answer of the real `/discover` dry-run. This
 * suite drives the real route (real discovery client and real transport probe over
 * recorded provider fixtures) and checks two things: the seed's verdict on the real
 * answer, and that the fake `/discover` answer the script tests use is a subset of
 * the real one for the same scenario.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

const DNS = async () => ['93.184.216.34']
const ALIVE: PinnedTransport = async ({ method }) =>
  method === 'POST'
    ? { status: 401, headers: { 'www-authenticate': 'Bearer realm="OAuth"' }, bodyText: '' }
    : { status: 404, headers: {}, bodyText: '' }

/** Documented subtraction: the pilot's AS without a registration endpoint. */
function withoutRegistrationEndpoint(pilot: PilotFixture): PilotFixture {
  const as = JSON.parse(pilot.as.json)
  delete as.registration_endpoint
  return { ...pilot, as: { ...pilot.as, json: JSON.stringify(as) } }
}

function appFor(pilot: PilotFixture, probeTransport: PinnedTransport) {
  const app = express()
  app.use(express.json())
  app.use(
    createAdminRemoteMcpRouter(new MockGateway('mcp-server') as unknown as K8sGateway, {
      discover: (url, deps, opts) =>
        discoverRemoteOAuth(
          url,
          { ...deps, transport: makeDiscoveryTransport(pilot), resolveDns: DNS },
          opts
        ),
      probe: (url, deps, opts) =>
        probeMcpTransport(url, { ...deps, transport: probeTransport, resolveDns: DNS }, opts),
    })
  )
  return app
}

async function realDiscover(pilot: PilotFixture, probeTransport: PinnedTransport = ALIVE) {
  const res = await request(appFor(pilot, probeTransport))
    .post('/admin/mcp-servers/remote/discover')
    .send({ baseUrl: pilot.mcpUrl })
  return { status: res.status, body: res.body }
}

const rules = {
  parseRemoteOAuthCatalogBlock: catalogRules.parseRemoteOAuthCatalogBlock,
  catalogRegistrationDrifts: catalogRules.catalogRegistrationDrifts,
}

describe('seed-remote-oauth against the real /discover answer', () => {
  it('alive + matching mode passes; the fake answer is a subset of the real one', async () => {
    const real = await realDiscover(PILOTS.linear)
    expect(real.status).toBe(200)
    expect(real.body).toMatchObject(discoverResponse({ registrationMode: 'cimd' }))
    expect(evaluateDiscover({ expectedRegistration: 'cimd' }, real, {}, rules)).toEqual({
      ok: true,
    })
  })

  it('a dead transport fails the item', async () => {
    const real = await realDiscover(VERCEL_PILOT, makeDiscoveryTransport(VERCEL_PILOT))
    expect(real.status).toBe(200)
    expect(real.body).toMatchObject(
      discoverResponse({ transport: 'dead', registrationMode: 'dcr' })
    )
    const verdict = evaluateDiscover({ expectedRegistration: 'dcr' }, real, {}, rules)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/MCP transport is dead/)
  })

  it('drift fails unless allowed', async () => {
    const real = await realDiscover(PILOTS.linear)
    expect(evaluateDiscover({ expectedRegistration: 'dcr' }, real, {}, rules).ok).toBe(false)
    expect(
      evaluateDiscover({ expectedRegistration: 'dcr' }, real, { allowDrift: true }, rules)
    ).toMatchObject({
      ok: true,
      warning: expect.stringMatching(/expected dcr, detected cimd/),
    })
  })

  it('a server without self-registration reports manual, which matches pre-registered', async () => {
    const real = await realDiscover(withoutRegistrationEndpoint(PILOTS.notion))
    expect(real.status).toBe(200)
    expect(real.body).toMatchObject(discoverResponse({ registrationMode: 'manual' }))
    expect(evaluateDiscover({ expectedRegistration: 'pre-registered' }, real, {}, rules)).toEqual({
      ok: true,
    })
    expect(evaluateDiscover({ expectedRegistration: 'dcr' }, real, {}, rules).ok).toBe(false)
  })
})
