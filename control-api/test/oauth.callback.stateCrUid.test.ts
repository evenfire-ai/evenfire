import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { signOAuthState } from '../src/oauth/state.js'
import {
  buildOAuthCallbackDeps,
  createOAuthCallbackRouter,
} from '../src/routes/external/oauthCallback.js'
import { membership, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import { mintMcpState } from './fixtures/mcpOAuthState.js'
import { MockGateway } from './mockGateway.js'

/**
 * A consent belongs to the McpServer installation it was started on, not to its
 * name. Between the authorize-URL mint and the callback the server can be
 * uninstalled and installed again under the same name; with CIMD (one platform
 * client id) or a shared pre-registered app the provider accepts the code for
 * either installation, so only the CR uid signed into the state tells them apart.
 *
 * States come from the real authorize-URL mint (no mock of `buildAuthorizeUrl`),
 * except the pre-deploy state, which is the real signer called without the uid,
 * exactly what the previous minter emitted. Production callback wiring over a
 * `MockGateway` (which assigns each installation a new uid, as the apiserver
 * does); the pool is mocked and the provider token endpoint is the only network
 * edge.
 */

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

const MCP_NS = config.mcpServersNamespace
const SERVER = 'gdrive'
const CLIENT = 'google-drive'
const CONTEXT = 'ctx-1'
const MEMBER = '22222222-2222-4222-8222-222222222222'

async function installServer(gateway: MockGateway, grantScope: 'user' | 'context') {
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name: SERVER },
      spec: {
        transport: { type: 'streamableHttp', url: 'https://gdrive.example.com/mcp' },
        auth: { type: 'oauth' },
        oauth: {
          id: CLIENT,
          provider: 'google',
          clientIdRef: { name: 'google-creds', key: 'client-id' },
          clientSecretRef: { name: 'google-creds', key: 'client-secret' },
          grantScope,
        },
      },
    },
    MCP_NS
  )
  return (await gateway.getResource('mcpservers', SERVER, MCP_NS)) as {
    metadata: { uid?: string }
  }
}

function grantWrites(): unknown[][] {
  return mockPoolQuery.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('oauth_grants')
  )
}

describe('mcp OAuth state bound to the McpServer installation (crUid)', () => {
  let gateway: MockGateway
  let app: express.Express
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    gateway = new MockGateway(MCP_NS)
    app = express()
    app.use('/api/v1', createOAuthCallbackRouter(gateway as never))
    app.use(clerumErrorHandler)
    mockPoolQuery.mockReset()
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
      )
    gateway.seedSecret('google-creds', MCP_NS, {
      data: {
        'client-id': Buffer.from('GOOGLE_CLIENT_ID').toString('base64'),
        'client-secret': Buffer.from('GOOGLE_CLIENT_SECRET').toString('base64'),
      },
    })
    await seedAllowlistedContext(gateway, CONTEXT, [SERVER], config.contextsNamespace)
    membership(mockPoolQuery, { contexts: { [MEMBER]: [CONTEXT] } }, () =>
      Promise.resolve({ rows: [{ id: 'grant-1' }], rowCount: 1 })
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  function mint(contextId?: string) {
    return mintMcpState(buildOAuthCallbackDeps(gateway as never), config.oauthStateHmacSecret, {
      mcpServerName: SERVER,
      userId: MEMBER,
      oauthClientId: CLIENT,
      ...(contextId !== undefined ? { contextId } : {}),
    })
  }

  function callback(state: string) {
    return request(app).get(`/api/v1/oauth-callback/${CLIENT}`).query({ code: 'CODE', state })
  }

  async function reinstall(grantScope: 'user' | 'context') {
    await gateway.deleteResource('mcpservers', SERVER, MCP_NS)
    return installServer(gateway, grantScope)
  }

  function expectRefusedUntouched(res: request.Response) {
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'oauth_state_outdated' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(grantWrites()).toHaveLength(0)
  }

  it('the installation the consent started on: exchanges and seals the grant with its uid', async () => {
    const cr = await installServer(gateway, 'user')
    const state = await mint()

    const res = await callback(state)

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const writes = grantWrites()
    expect(writes).toHaveLength(1)
    expect((writes[0][1] as unknown[]).at(-1)).toBe(cr.metadata.uid)
  })

  it.each(['user', 'context'] as const)(
    '%s flavor: a same-name reinstall between mint and callback → oauth_state_outdated, no exchange, no grant',
    async grantScope => {
      const before = await installServer(gateway, grantScope)
      const state = await mint(grantScope === 'context' ? CONTEXT : undefined)
      const after = await reinstall(grantScope)
      expect(after.metadata.uid).not.toBe(before.metadata.uid)

      expectRefusedUntouched(await callback(state))
    }
  )

  // The reinstall lands right after the mint read the CR. The authorize URL then
  // carries the old installation's declaration, so the state must carry the old
  // uid too, and the consent is refused against the new installation.
  it('a reinstall racing the mint: the state names the CR its declaration came from', async () => {
    await installServer(gateway, 'user')
    const production = buildOAuthCallbackDeps(gateway as never)
    let reinstalled = false
    const racingReader = {
      async read(name: string) {
        const subject = await production.mcpServerReader!.read(name)
        if (!reinstalled) {
          reinstalled = true
          await reinstall('user')
        }
        return subject
      },
    }
    const state = await mintMcpState(
      { mcpServerReader: racingReader, secretReader: production.secretReader },
      config.oauthStateHmacSecret,
      { mcpServerName: SERVER, userId: MEMBER, oauthClientId: CLIENT }
    )

    expectRefusedUntouched(await callback(state))
  })

  it('a state signed before states carried the uid → oauth_state_outdated, no exchange, no grant', async () => {
    await installServer(gateway, 'user')
    const preDeployState = signOAuthState(config.oauthStateHmacSecret, {
      subjectKind: 'mcp',
      mcpServerName: SERVER,
      userId: MEMBER,
      oauthClientId: CLIENT,
      grantKind: 'user',
      background: false,
    } as Parameters<typeof signOAuthState>[1])

    expectRefusedUntouched(await callback(preDeployState))
  })

  it('a live CR without a uid → oauth_state_outdated, no exchange, no grant', async () => {
    const cr = await installServer(gateway, 'user')
    const state = await mint()
    delete cr.metadata.uid

    expectRefusedUntouched(await callback(state))
  })

  // Neither side identifies an installation: two absent uids must not pass as equal.
  it('a pre-deploy state against a live CR without a uid → oauth_state_outdated', async () => {
    const cr = await installServer(gateway, 'user')
    delete cr.metadata.uid
    const preDeployState = signOAuthState(config.oauthStateHmacSecret, {
      subjectKind: 'mcp',
      mcpServerName: SERVER,
      userId: MEMBER,
      oauthClientId: CLIENT,
      grantKind: 'user',
      background: false,
    } as Parameters<typeof signOAuthState>[1])

    expectRefusedUntouched(await callback(preDeployState))
  })

  it('the mint refuses to sign a state for a CR without a uid', async () => {
    const cr = await installServer(gateway, 'user')
    delete cr.metadata.uid

    await expect(mint()).rejects.toThrow(/has no metadata\.uid/)
  })
})
