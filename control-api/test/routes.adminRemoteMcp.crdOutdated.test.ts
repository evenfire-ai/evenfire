import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { remoteWireForProfile } from '../src/oauth/asProfiles.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import {
  WORKIQ_GUID_SCOPE,
  discoverPilot,
  installRemoteServer,
  seedContext,
  withRfc9207,
} from './fixtures/perServerInstall.js'
import {
  ENTRA_TENANT_AUTHORITY,
  ENTRA_UNKNOWN_GUID_PILOT,
  ENTRA_WORKIQ_PILOT,
  PILOTS,
  type PilotFixture,
  makeInMemoryDynamicClientsDb,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * A remote install against an apiserver whose McpServer CRD predates `spec.oauth.asProfile`.
 * Such an apiserver prunes the unknown field and still answers 201, so the gateway below
 * stores and returns exactly what the route sent minus that one field (T1: the object is
 * derived from the route's own write, never hand-authored). Discovery runs the real client
 * over the recorded Entra probe fixtures.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

const NS = config.mcpServersNamespace
const CONTEXT = 'ctx-a'
const UNKNOWN_GUID_SCOPE = '11111111-2222-3333-4444-555555555555/Tools.Read'

/** The apiserver of an outdated CRD: `spec.oauth.asProfile` does not survive a create. */
type CreateArgs = Parameters<MockGateway['createResource']>

class PruningGateway extends MockGateway {
  override async createResource(
    plural: CreateArgs[0],
    body: CreateArgs[1],
    namespace?: CreateArgs[2]
  ): Promise<unknown> {
    if (plural !== 'mcpservers') return super.createResource(plural, body, namespace)
    const pruned = structuredClone(body) as CreateArgs[1] & {
      spec?: { oauth?: Record<string, unknown> }
    }
    delete pruned.spec?.oauth?.asProfile
    return super.createResource(plural, pruned, namespace)
  }
}

let savedCallbackBaseUrl: string
beforeEach(() => {
  savedCallbackBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = 'https://control.example.com'
})
afterEach(() => {
  config.oauthCallbackBaseUrl = savedCallbackBaseUrl
})

async function pruningGateway(): Promise<PruningGateway> {
  const gw = new PruningGateway(NS)
  await seedContext(gw, config.contextsNamespace, CONTEXT)
  return gw
}

function entraDiscovery(pilot: PilotFixture = ENTRA_WORKIQ_PILOT): Promise<DiscoveryResult> {
  return discoverPilot(pilot, {
    hasPreRegisteredClient: true,
    authorizationServer: ENTRA_TENANT_AUTHORITY,
  })
}

function preRegisteredBody(
  pilot: PilotFixture,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    serverName: 'workiq',
    baseUrl: pilot.mcpUrl,
    mode: 'pre-registered',
    clientId: '11111111-2222-3333-4444-555555555555',
    clientSecret: 'entra-client-secret',
    authorizationServer: ENTRA_TENANT_AUTHORITY,
    scopes: [WORKIQ_GUID_SCOPE],
    ...extra,
  }
}

const CRD_OUTDATED = {
  error: 'mcpserver_crd_outdated',
  code: 'mcpserver_crd_outdated',
}

describe('remote install on an apiserver that prunes spec.oauth.asProfile', () => {
  it('the profile is what makes the wire Entra-specific (why losing it matters)', async () => {
    const discovery = await entraDiscovery()
    expect(discovery.asProfile).toBe('entra-v2')
    expect(remoteWireForProfile(discovery.asProfile)).not.toEqual(remoteWireForProfile(undefined))
  })

  it('pre-registered Entra → 409 mcpserver_crd_outdated; the fenced CR and Secret are removed', async () => {
    const gw = await pruningGateway()
    const created: Array<{ uid?: string; resourceVersion?: string }> = []
    const createResource = gw.createResource.bind(gw)
    vi.spyOn(gw, 'createResource').mockImplementation(async (plural, body, ns) => {
      const out = (await createResource(plural, body, ns)) as {
        metadata: { uid?: string; resourceVersion?: string }
      }
      if (plural === 'mcpservers') created.push({ ...out.metadata })
      return out
    })
    const createSecret = gw.createSecret.bind(gw)
    const secrets: Array<{ uid: string; resourceVersion: string }> = []
    vi.spyOn(gw, 'createSecret').mockImplementation(async (req, opts) => {
      const snap = await createSecret(req, opts)
      secrets.push({ uid: snap.uid, resourceVersion: snap.resourceVersion })
      return snap
    })
    const deleteResource = vi.spyOn(gw, 'deleteResource')
    const deleteSecret = vi.spyOn(gw, 'deleteSecret')

    const res = await installRemoteServer({
      gateway: gw,
      db: makeInMemoryDynamicClientsDb().db,
      discovery: await entraDiscovery(),
      body: preRegisteredBody(ENTRA_WORKIQ_PILOT),
    })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject(CRD_OUTDATED)
    expect(created).toHaveLength(1)
    expect(deleteResource).toHaveBeenCalledWith('mcpservers', 'workiq', NS, {
      uid: created[0].uid,
      resourceVersion: created[0].resourceVersion,
    })
    expect(secrets).toHaveLength(1)
    expect(deleteSecret).toHaveBeenCalledWith('workiq-oauth-client', NS, secrets[0])
    await expect(gw.getResource('mcpservers', 'workiq', NS)).rejects.toThrow()
    await expect(gw.getSecret('workiq-oauth-client', NS)).rejects.toThrow()
    // An install never writes a Context allowlist.
    const ctx = (await gw.getResource('contexts', CONTEXT, config.contextsNamespace)) as {
      spec: { mcpServers?: unknown[] }
    }
    expect(ctx.spec.mcpServers ?? []).toEqual([])
  })

  it('a failed rollback still answers 409 and names what was left behind', async () => {
    const gw = await pruningGateway()
    vi.spyOn(gw, 'deleteResource').mockRejectedValue(new Error('apiserver unavailable'))
    const reqLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const res = await installRemoteServer({
      gateway: gw,
      db: makeInMemoryDynamicClientsDb().db,
      discovery: await entraDiscovery(),
      body: preRegisteredBody(ENTRA_WORKIQ_PILOT),
      reqLog,
    })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject(CRD_OUTDATED)
    expect(reqLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'remote_install_crd_outdated_rollback_failed',
        serverName: 'workiq',
        serverRemoved: false,
        secretRemoved: true,
      }),
      expect.any(String)
    )
  })

  it('the confirmed-unverified-scopes audit record is kept even when the install is refused', async () => {
    // The CR existed, however briefly, and a rollback can fail: the record of who vouched
    // for the audience must not depend on the install completing.
    const gw = await pruningGateway()
    const reqLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const res = await installRemoteServer({
      gateway: gw,
      db: makeInMemoryDynamicClientsDb().db,
      discovery: await entraDiscovery(ENTRA_UNKNOWN_GUID_PILOT),
      body: preRegisteredBody(ENTRA_UNKNOWN_GUID_PILOT, {
        scopes: [UNKNOWN_GUID_SCOPE],
        confirmedUnverifiedScopes: [UNKNOWN_GUID_SCOPE],
      }),
      reqLog,
    })
    expect(res.status).toBe(409)
    expect(reqLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'remote_install_unverified_scopes_confirmed',
        scopes: [UNKNOWN_GUID_SCOPE],
      }),
      expect.any(String)
    )
  })

  it('an install without a profile is unaffected by the outdated CRD → 201', async () => {
    const gw = await pruningGateway()
    const discovery = await discoverPilot(withRfc9207(PILOTS.sentry), {
      hasPreRegisteredClient: true,
    })
    expect(discovery.asProfile).toBeUndefined()
    const res = await installRemoteServer({
      gateway: gw,
      db: makeInMemoryDynamicClientsDb().db,
      discovery,
      body: {
        serverName: 'sentry',
        baseUrl: PILOTS.sentry.mcpUrl,
        mode: 'pre-registered',
        clientId: 'client-abc',
        clientSecret: 'client-secret',
      },
    })
    expect(res.status).toBe(201)
    await expect(gw.getResource('mcpservers', 'sentry', NS)).resolves.toBeTruthy()
  })
})
