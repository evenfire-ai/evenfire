import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { userHasContextEnablingMcpServer } from '../src/services/access/mcpInvocable.js'
import { memberOf, seedAllowlistedContext } from './fixtures/contextAllowlist.js'
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
    memberOf(mockPoolQuery, ['ctx-business', 'ctx-unrelated'])
    expect(await check(gateway, 'user-1', 'notion')).toBe(true)
    const [, params] = mockPoolQuery.mock.calls[0]
    expect(params).toEqual(['user-1'])
  })

  it('false when none of the user Contexts allowlists the server', async () => {
    await seedAllowlistedContext(gateway, 'ctx-a', ['gdrive'])
    await seedAllowlistedContext(gateway, 'ctx-b', [])
    memberOf(mockPoolQuery, ['ctx-a', 'ctx-b'])
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
  })

  it('false when the allowlisting Context is one the user is NOT a member of', async () => {
    await seedAllowlistedContext(gateway, 'ctx-owner', ['notion'])
    await seedAllowlistedContext(gateway, 'ctx-mine', [])
    memberOf(mockPoolQuery, ['ctx-mine'])
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
  })

  it('false without listing Contexts when the user belongs to none', async () => {
    await seedAllowlistedContext(gateway, 'ctx-owner', ['notion'])
    memberOf(mockPoolQuery, [])
    const listSpy = vi.spyOn(gateway, 'listResource')
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('membership is read from user_contexts only (team membership does not count)', async () => {
    await seedAllowlistedContext(gateway, 'ctx-team', ['notion'])
    memberOf(mockPoolQuery, [])
    expect(await check(gateway, 'user-1', 'notion')).toBe(false)
    const sqls = mockPoolQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some(sql => sql.includes('FROM user_contexts'))).toBe(true)
    expect(sqls.some(sql => sql.includes('team_contexts'))).toBe(false)
  })

  it('propagates a Context list failure instead of answering false', async () => {
    memberOf(mockPoolQuery, ['ctx-a'])
    vi.spyOn(gateway, 'listResource').mockRejectedValueOnce(new Error('apiserver down'))
    await expect(check(gateway, 'user-1', 'notion')).rejects.toThrow('apiserver down')
  })
})
