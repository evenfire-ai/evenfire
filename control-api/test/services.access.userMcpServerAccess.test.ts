import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { config } from '../src/config.js'
import {
  allowedMcpServerNamesForContexts,
  resolveConnectorsForAgents,
  resolveInvocableMcpServersForContexts,
  userHasContextEnablingMcpServer,
} from '../src/services/access/mcpInvocable.js'
import { membership, seedAgentHost, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import { MockGateway } from './mockGateway.js'

/**
 * The access rule shared by the per-user OAuth connect gate and its callback:
 * a user may connect a server iff some Context they reach allowlists it in
 * `spec.mcpServers` — directly (user_contexts) or through an assigned agent
 * (user_agents → a Host the agent directory shows → its contextRef). Those are
 * the sources of the flat `/mcp-servers` catalog and the connectors panel; team
 * membership does not count. Membership is answered at the pool (the real
 * readers' SQL runs through it); allowlists are written through the real
 * allowlist writer onto the gateway fake; Host CRs are hand-written (no
 * exported producer).
 */

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

const MCP_NS = config.mcpServersNamespace
const HOSTS_NS = config.hostsNamespace

function check(gateway: MockGateway, userId: string, mcpServerName: string): Promise<boolean> {
  return userHasContextEnablingMcpServer({
    gateway: gateway as never,
    contextsNamespace: MCP_NS,
    hostsNamespace: HOSTS_NS,
    userId,
    mcpServerName,
  })
}

describe('userHasContextEnablingMcpServer', () => {
  let gateway: MockGateway

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    mockPoolQuery.mockReset()
  })

  it('true when one of the user Contexts allowlists the server', async () => {
    await seedAllowlistedContext(gateway, 'ctx-owner', ['notion'])
    await seedAllowlistedContext(gateway, 'ctx-business', ['notion', 'gdrive'])
    membership(mockPoolQuery, { contexts: { 'user-1': ['ctx-business', 'ctx-unrelated'] } })
    expect(await check(gateway, 'user-1', 'notion')).toBe(true)
  })

  it('false when another user, not the asked one, belongs to the allowlisting Context', async () => {
    await seedAllowlistedContext(gateway, 'ctx-business', ['notion'])
    membership(mockPoolQuery, { contexts: { 'user-2': ['ctx-business'] } })
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
  })

  it('false when none of the user Contexts allowlists the server', async () => {
    await seedAllowlistedContext(gateway, 'ctx-a', ['gdrive'])
    await seedAllowlistedContext(gateway, 'ctx-b', [])
    membership(mockPoolQuery, { contexts: { 'user-1': ['ctx-a', 'ctx-b'] } })
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
  })

  it('false when the allowlisting Context is one the user is NOT a member of', async () => {
    await seedAllowlistedContext(gateway, 'ctx-owner', ['notion'])
    await seedAllowlistedContext(gateway, 'ctx-mine', [])
    membership(mockPoolQuery, { contexts: { 'user-1': ['ctx-mine'] } })
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
  })

  it('false without listing Contexts when the user belongs to none', async () => {
    await seedAllowlistedContext(gateway, 'ctx-owner', ['notion'])
    membership(mockPoolQuery, { contexts: { 'user-1': [] } })
    const listSpy = vi.spyOn(gateway, 'listResource')
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('team membership does not count: neither team_contexts nor team_agents is read', async () => {
    await seedAllowlistedContext(gateway, 'ctx-team', ['notion'])
    await seedAgentHost(gateway, 'host-team', 'ctx-team')
    membership(mockPoolQuery, { contexts: { 'user-1': [] }, agents: { 'user-1': [] } })
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
    const sqls = mockPoolQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some(sql => sql.includes('FROM user_contexts'))).toBe(true)
    expect(sqls.some(sql => sql.includes('FROM user_agents'))).toBe(true)
    expect(sqls.some(sql => /team_contexts|team_agents/.test(sql))).toBe(false)
  })

  it('propagates a Context list failure instead of answering false', async () => {
    membership(mockPoolQuery, { contexts: { 'user-1': ['ctx-a'] } })
    vi.spyOn(gateway, 'listResource').mockRejectedValueOnce(new Error('apiserver down'))
    await expect(check(gateway, 'user-1', 'notion')).rejects.toThrow('apiserver down')
  })
})

describe('userHasContextEnablingMcpServer — Contexts reached through assigned agents', () => {
  let gateway: MockGateway

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    mockPoolQuery.mockReset()
  })

  it('S1: no direct Contexts, an assigned agent whose Context allowlists the server → true', async () => {
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    membership(mockPoolQuery, { agents: { 'user-1': ['host-c'] } })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(true)
  })

  it('S2: the direct Context dropped the server, an assigned agent Context still allowlists it → true', async () => {
    await seedAllowlistedContext(gateway, 'ctx-owner', [])
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    membership(mockPoolQuery, {
      contexts: { 'user-1': ['ctx-owner'] },
      agents: { 'user-1': ['host-c'] },
    })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(true)
  })

  it('an agent assigned to another user does not count', async () => {
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    membership(mockPoolQuery, { agents: { 'user-2': ['host-c'] } })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(false)
  })

  it('a disabled Host does not count', async () => {
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c', { enabled: false })
    membership(mockPoolQuery, { agents: { 'user-1': ['host-c'] } })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(false)
  })

  it('the legacy fleet-wide sentinel Host does not count', async () => {
    expect(HOSTS_NS).toBe('mcp-host')
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'standalone', 'ctx-c')
    membership(mockPoolQuery, { agents: { 'user-1': ['standalone'] } })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(false)
  })

  it('a deleting Host does not count', async () => {
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    const real = gateway.getResource.bind(gateway)
    vi.spyOn(gateway, 'getResource').mockImplementation(async (plural, name, ns) => {
      const row = (await real(plural, name, ns)) as { metadata: Record<string, unknown> }
      return plural === 'hosts'
        ? { ...row, metadata: { ...row.metadata, deletionTimestamp: '2026-10-12T00:00:00Z' } }
        : row
    })
    membership(mockPoolQuery, { agents: { 'user-1': ['host-c'] } })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(false)
  })

  it('a Host whose directory name differs from the assigned agent name does not count', async () => {
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-other', 'ctx-c')
    const real = gateway.getResource.bind(gateway)
    vi.spyOn(gateway, 'getResource').mockImplementation(async (plural, name, ns) =>
      plural === 'hosts' ? real(plural, 'host-other', ns) : real(plural, name, ns)
    )
    membership(mockPoolQuery, { agents: { 'user-1': ['host-c'] } })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(false)
  })

  it('a Host that reports another namespace does not count', async () => {
    // The read in the hosts namespace succeeds and the Host is enabled, so only
    // the directory's reported-namespace check can turn this into false; a Host
    // merely stored elsewhere would 404 and prove nothing about that check.
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c', { enabled: true })
    const real = gateway.getResource.bind(gateway)
    vi.spyOn(gateway, 'getResource').mockImplementation(async (plural, name, ns) => {
      const row = (await real(plural, name, ns)) as { metadata: Record<string, unknown> }
      return plural === 'hosts'
        ? { ...row, metadata: { ...row.metadata, namespace: 'some-other-namespace' } }
        : row
    })
    membership(mockPoolQuery, { agents: { 'user-1': ['host-c'] } })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(false)
  })

  it('a missing (404) Host is ignored, the other agents still count', async () => {
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    membership(mockPoolQuery, { agents: { 'user-1': ['host-gone', 'host-c'] } })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(true)
  })

  it('a non-404 Host read failure propagates when the direct Contexts do not enable the server', async () => {
    await seedAllowlistedContext(gateway, 'ctx-c', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    vi.spyOn(gateway, 'getResource').mockRejectedValue(
      Object.assign(new Error('apiserver unavailable'), { statusCode: 503 })
    )
    membership(mockPoolQuery, { agents: { 'user-1': ['host-c'] } })
    await expect(check(gateway, 'user-1', 'gdrive')).rejects.toThrow('apiserver unavailable')
  })

  it('a Host read failure does not matter when a direct Context already enables the server', async () => {
    await seedAllowlistedContext(gateway, 'ctx-business', ['gdrive'])
    await seedAgentHost(gateway, 'host-c', 'ctx-c')
    const hostRead = vi
      .spyOn(gateway, 'getResource')
      .mockRejectedValue(Object.assign(new Error('apiserver unavailable'), { statusCode: 503 }))
    membership(mockPoolQuery, {
      contexts: { 'user-1': ['ctx-business'] },
      agents: { 'user-1': ['host-c'] },
    })
    expect(await check(gateway, 'user-1', 'gdrive')).toBe(true)
    expect(hostRead).not.toHaveBeenCalled()
  })
})

/**
 * What the user is offered must be connectable: every server the connectors
 * panel classifies as `oauth-user` for the user's agents, or the flat
 * `/mcp-servers` rail returns for their Contexts (all grants present), passes
 * the consent gate. The converse — the gate admits nothing neither catalog
 * offers — holds only inside this generator, where every server is an enabled
 * user-scope OAuth server with a URL: the gate reads allowlists alone and
 * ignores `enabled`, transport and auth type, so outside it the gate is wider.
 */
describe('consent gate vs. what the catalogs offer (property)', () => {
  const contextNames = ['ctx-a', 'ctx-b', 'ctx-c']
  const hostNames = ['host-1', 'host-2', 'host-3']
  const servers = ['s1', 's2', 's3']
  /**
   * Unit stand-in for the grants table, hand-written because the real writer
   * (`upsertOAuthGrant`) needs a Postgres and this property must run in the
   * default suite. Contract assumed: `oauthGrantExists` reports a grant iff
   * its `SELECT 1 FROM oauth_grants … LIMIT 1` returns a row, so answering
   * every query with one row means "every server has a grant". The property
   * asserts that meaning on each run (the flat rail returns exactly the
   * allowlisted servers) so a stub that drifts fails here instead of
   * silently shrinking what the flat rail offers.
   */
  const allGrantsPresent = { query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }) }

  async function seedUserOauthServer(gateway: MockGateway, name: string): Promise<void> {
    await gateway.createResource(
      'mcpservers',
      {
        metadata: { name },
        spec: {
          contextRef: 'ctx-a',
          image: 'example/mcp:1',
          transport: { type: 'streamableHttp', url: `https://${name}.example.com/mcp` },
          auth: { type: 'oauth' },
          oauth: { id: `${name}-client`, grantScope: 'user' },
        },
      },
      MCP_NS
    )
  }

  it('panel ∪ flat rail ⇔ gate', async () => {
    let runsWithFlatOffer = 0
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          allowlists: fc.dictionary(
            fc.constantFrom(...contextNames),
            fc.uniqueArray(fc.constantFrom(...servers), { maxLength: 3 })
          ),
          hosts: fc.dictionary(
            fc.constantFrom(...hostNames),
            fc.record({ contextRef: fc.constantFrom(...contextNames), enabled: fc.boolean() })
          ),
          userContexts: fc.uniqueArray(fc.constantFrom(...contextNames), { maxLength: 3 }),
          userAgents: fc.uniqueArray(fc.constantFrom(...hostNames, 'host-gone'), { maxLength: 4 }),
        }),
        async ({ allowlists, hosts, userContexts, userAgents }) => {
          const gateway = new MockGateway(MCP_NS)
          for (const name of servers) await seedUserOauthServer(gateway, name)
          for (const name of contextNames) {
            await seedAllowlistedContext(gateway, name, allowlists[name] ?? [])
          }
          for (const [name, h] of Object.entries(hosts)) {
            await seedAgentHost(gateway, name, h.contextRef, { enabled: h.enabled })
          }
          membership(mockPoolQuery, {
            contexts: { 'user-1': userContexts },
            agents: { 'user-1': userAgents },
          })

          const panel = await resolveConnectorsForAgents(
            gateway as never,
            {
              mcpServersNamespace: MCP_NS,
              contextsNamespace: MCP_NS,
              hostsNamespace: HOSTS_NS,
              agentNames: userAgents,
              userId: 'user-1',
            },
            allGrantsPresent as never
          )
          const flat = await resolveInvocableMcpServersForContexts(
            gateway as never,
            MCP_NS,
            userContexts,
            'user-1',
            allGrantsPresent as never,
            MCP_NS
          )
          const allowlistedForUser = new Set(userContexts.flatMap(id => allowlists[id] ?? []))
          expect(flat.map(s => s.name).sort()).toEqual([...allowlistedForUser].sort())
          if (flat.length > 0) runsWithFlatOffer++

          const offered = new Set<string>(flat.map(s => s.name))
          for (const agent of panel) {
            for (const c of agent.connectors) if (c.authKind === 'oauth-user') offered.add(c.name)
          }

          for (const name of servers) {
            expect({ name, gate: await check(gateway, 'user-1', name) }).toEqual({
              name,
              gate: offered.has(name),
            })
          }
        }
      ),
      { numRuns: 200 }
    )
    expect(runsWithFlatOffer).toBeGreaterThan(0)
  })
})

describe('allowedMcpServerNamesForContexts', () => {
  const contextNames = ['ctx-a', 'ctx-b', 'ctx-c', 'ctx-d']
  // Padded variants are reachable: the allowlist writer stores the name as given.
  const serverName = fc.constantFrom('notion', 'gdrive', 'slack', ' notion', 'gdrive ', '')

  it('is exactly the union of the asked Contexts allowlists, compared without trimming (oracle)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.constantFrom(...contextNames),
          fc.uniqueArray(serverName, { maxLength: 4 })
        ),
        fc.uniqueArray(fc.constantFrom(...contextNames, 'ctx-unseeded'), { maxLength: 5 }),
        async (allowlists, asked) => {
          const gateway = new MockGateway(MCP_NS)
          for (const [name, servers] of Object.entries(allowlists)) {
            await seedAllowlistedContext(gateway, name, servers)
          }

          const out = await allowedMcpServerNamesForContexts(gateway as never, MCP_NS, asked)

          const expected = new Set<string>()
          for (const id of asked) {
            for (const n of allowlists[id] ?? []) if (n.length > 0) expected.add(n)
          }
          expect([...out].sort()).toEqual([...expected].sort())
        }
      ),
      { numRuns: 300 }
    )
  })

  it('resolves empty without listing Contexts when asked for none', async () => {
    const gateway = new MockGateway(MCP_NS)
    await seedAllowlistedContext(gateway, 'ctx-a', ['notion'])
    const listSpy = vi.spyOn(gateway, 'listResource')
    expect(await allowedMcpServerNamesForContexts(gateway as never, MCP_NS, [])).toEqual(new Set())
    expect(listSpy).not.toHaveBeenCalled()
  })
})
