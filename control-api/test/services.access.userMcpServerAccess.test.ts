import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { config } from '../src/config.js'
import {
  allowedMcpServerNamesForContexts,
  userHasContextEnablingMcpServer,
} from '../src/services/access/mcpInvocable.js'
import { membership, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
import { MockGateway } from './mockGateway.js'

/**
 * The access rule shared by the per-user OAuth connect gate and its callback:
 * a user may connect a server iff they belong (user_contexts) to at least one
 * Context whose `spec.mcpServers` allowlist names it — the same rule invoke and
 * the catalog apply. Membership comes from `getUserContexts` (mocked at the
 * pool, so the real SQL runs through it); allowlists are written through the
 * real allowlist writer onto the gateway fake.
 */

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

const MCP_NS = config.mcpServersNamespace

function check(gateway: MockGateway, userId: string, mcpServerName: string): Promise<boolean> {
  return userHasContextEnablingMcpServer({
    gateway: gateway as never,
    mcpServersNamespace: MCP_NS,
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

  it('membership is read from user_contexts only (team membership does not count)', async () => {
    await seedAllowlistedContext(gateway, 'ctx-team', ['notion'])
    membership(mockPoolQuery, { contexts: { 'user-1': [] } })
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
    const sqls = mockPoolQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some(sql => sql.includes('FROM user_contexts'))).toBe(true)
    expect(sqls.some(sql => sql.includes('team_contexts'))).toBe(false)
  })

  it('propagates a Context list failure instead of answering false', async () => {
    membership(mockPoolQuery, { contexts: { 'user-1': ['ctx-a'] } })
    vi.spyOn(gateway, 'listResource').mockRejectedValueOnce(new Error('apiserver down'))
    await expect(check(gateway, 'user-1', 'notion')).rejects.toThrow('apiserver down')
  })
})

describe('allowedMcpServerNamesForContexts', () => {
  const contextNames = ['ctx-a', 'ctx-b', 'ctx-c', 'ctx-d']
  // Padded variants are reachable: the allowlist writer stores the name as given.
  const serverName = fc.constantFrom('notion', 'gdrive', 'slack', ' notion', 'gdrive ', '')

  it('is exactly the trimmed union of the asked Contexts allowlists (oracle)', async () => {
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
            for (const n of allowlists[id] ?? []) if (n.trim()) expected.add(n.trim())
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
