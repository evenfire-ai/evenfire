import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppServiceWatchHarness, meOf } from '../../testSupport/gfsWatch/appServiceHarness.js'
import {
  TEAM_1,
  TEAM_2,
  USER_A,
  USER_B,
  key,
  signV1SessionToken,
} from '../../testSupport/gfsWatch/sessionTokens.js'
import { config } from '../config.js'
import { ApiError } from '../httpClient.js'

vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => false),
    getPath: vi.fn(() => '/tmp/clerum-desktop-test'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

const tokenA = (teamId: string | null = TEAM_1) =>
  signV1SessionToken({ userId: USER_A, authGeneration: 1, teamId })
const tokenB = () => signV1SessionToken({ userId: USER_B, authGeneration: 1, teamId: TEAM_1 })
const keysA = [key('file', 1), key('dir', 2), key('file', 3)]

const meEnded = (status: number) =>
  new ApiError(`${status} session ended`, status, JSON.stringify({ error: 'invalid_session' }))

let h: AppServiceWatchHarness

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  h = await new AppServiceWatchHarness().start()
})

afterEach(async () => {
  await h.stop()
  vi.restoreAllMocks()
})

/** A logged-in user A whose window watches `keysA` on a ready stream. */
async function readyWithKeys(token = tokenA()) {
  const state = await h.login(token)
  const userId = state.me?.id ?? null
  await h.subscribe(keysA, userId)
  await vi.waitFor(
    () => {
      const link = h.client.inspect().link
      expect(link.kind === 'Ready' && link.accepted).toEqual(new Set(keysA))
      expect(h.server.current()?.keys).toEqual(new Set(keysA))
    },
    { timeout: 3_000 }
  )
  return { token, userId }
}

describe('AppService GFS watch — session token producers', () => {
  it('a saved session restored at startup opens the watch with its token', async () => {
    const saved = tokenA()
    h.service.tokenStore.getSessionToken!.mockResolvedValue(saved)
    const state = await h.service.getSessionState()
    await vi.waitFor(() => expect(h.linkKind()).toBe('Ready'), { timeout: 3_000 })
    expect(state.authenticated).toBe(true)
    expect(h.client.inspect().session?.token).toBe(saved)
    expect(h.server.gets.map(g => g.token)).toEqual([saved])
    expect(h.linkKind()).toBe('Ready')
  })

  it('T-CB5: a team hop with restore keeps the stream; an expiry of the opening token reopens without purge', async () => {
    const { token } = await readyWithKeys()
    const getsBefore = h.server.gets.length

    const seen: string[] = []
    await h.service.runWithTeamContext(TEAM_2, async hopToken => {
      seen.push(hopToken)
      await h.settle()
      return null
    })
    await h.settle()

    // The restored token is new (same user, team and auth generation): the
    // generation rises, the binding does not change, so nothing reopens.
    expect(seen[0]).not.toBe(token)
    expect(h.service.sessionToken).not.toBe(token)
    expect(h.client.inspect().session?.token).toBe(h.service.sessionToken)
    expect(h.client.inspect().session?.generation).toBeGreaterThan(1)
    expect(h.server.gets.length).toBe(getsBefore)

    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    await h.advance(1_000)

    expect(h.owner().ofType('sessionExpired')).toHaveLength(0)
    expect(h.client.inspect().latch).toBeNull()
    expect(h.service.authClient.getMe).toHaveBeenCalledTimes(2) // only the two switches' /me
    expect(h.server.gets.length).toBe(getsBefore + 1)
    expect(h.server.gets.at(-1)?.token).toBe(h.service.sessionToken)
    expect(h.server.gets.at(-1)?.keys).toEqual(keysA)
  })

  it('T-CB5: a failed restore publishes the hop token as the session', async () => {
    await readyWithKeys()
    const getsBefore = h.server.gets.length
    h.service.authClient.switchTeam!.mockImplementationOnce(async (_t: string, teamId: string) => ({
      token: signV1SessionToken({ userId: USER_A, authGeneration: 1, teamId }),
      team: { id: teamId, name: teamId, role: 'member' },
    }))
    h.service.authClient.switchTeam!.mockRejectedValueOnce(new Error('restore failed'))

    await expect(h.service.runWithTeamContext(TEAM_2, async () => 'ok')).rejects.toThrow(
      'restore failed'
    )
    await h.settle()

    expect(h.service.me?.teamId).toBe(TEAM_2)
    expect(h.client.inspect().session?.token).toBe(h.service.sessionToken)
    expect(h.client.inspect().session?.binding).toEqual({ userId: USER_A, authGeneration: 1 })
    expect(h.server.gets.length).toBe(getsBefore)
  })

  it('T-CB5: after a failed restore the hop token is already the session while the hop is still held', async () => {
    await readyWithKeys()
    const getsBefore = h.server.gets.length
    let restoreFailed = false
    h.service.authClient.switchTeam!.mockImplementationOnce(async (_t: string, teamId: string) => ({
      token: signV1SessionToken({ userId: USER_A, authGeneration: 1, teamId }),
      team: { id: teamId, name: teamId, role: 'member' },
    }))
    h.service.authClient.switchTeam!.mockImplementationOnce(async () => {
      restoreFailed = true
      throw new Error('restore failed')
    })
    // The chat store rebind after a failed restore runs before the hop is
    // released: an expiry of the opening token lands in that gap.
    const inGap: Array<{ gets: number; hopDepth: number; latch: unknown; expired: number }> = []
    h.service.bindCurrentChatStore.mockImplementation(async () => {
      if (!restoreFailed || inGap.length > 0) return
      h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
      await h.settle()
      inGap.push({
        gets: h.server.gets.length,
        hopDepth: h.service.gfsTransientTeamHopDepth,
        latch: h.client.inspect().latch,
        expired: h.owner().ofType('sessionExpired').length,
      })
    })

    await expect(h.service.runWithTeamContext(TEAM_2, async () => 'ok')).rejects.toThrow(
      'restore failed'
    )
    await h.settle()

    expect(inGap).toEqual([{ gets: getsBefore + 1, hopDepth: 1, latch: null, expired: 0 }])
    expect(h.server.gets.at(-1)?.token).toBe(h.service.sessionToken)
    expect(h.owner().ofType('sessionExpired')).toHaveLength(0)
  })

  it('T-CB6/T-CB62: switchTeam publishes the token and stops streams in one tick: 0 GET, 0 accessChanged, next PUT with the new token', async () => {
    const { userId } = await readyWithKeys()
    const getsBefore = h.server.gets.length
    const accessBefore = h.owner().ofType('accessChanged').length

    const state = await h.service.switchTeam(TEAM_2)
    await h.settle()

    expect(state.me?.teamId).toBe(TEAM_2)
    expect(h.server.gets.length).toBe(getsBefore)
    expect(h.server.openStreams()).toHaveLength(1)
    expect(h.owner().ofType('accessChanged')).toHaveLength(accessBefore)
    expect(h.client.inspect().sent).toEqual(keysA)

    await h.subscribe([key('file', 9)], userId)
    expect(h.server.puts.at(-1)?.token).toBe(h.service.sessionToken)
    expect(h.server.puts.at(-1)?.keys).toEqual([key('file', 9)])
    expect(h.server.current()?.keys).toEqual(new Set([key('file', 9)]))
  })

  it('T-CB6: the inverse order (stop, then token) also keeps one stream with the same keys', async () => {
    await readyWithKeys()
    const getsBefore = h.server.gets.length
    h.client.onStopAllStreams()
    h.client.onSessionToken(tokenA(TEAM_2))
    await h.settle()
    expect(h.server.gets.length).toBe(getsBefore)
    expect(h.server.openStreams()).toHaveLength(1)
    expect(h.client.inspect().sent).toEqual(keysA)
  })

  it('T-CB10: a max_lifetime close inside a team hop reopens: 1 stream when the hop ends', async () => {
    await readyWithKeys()
    const getsBefore = h.server.gets.length
    await h.service.runWithTeamContext(TEAM_2, async () => {
      h.server.frame({ type: 'stream.closing', reason: 'max_lifetime', retryAfterMs: 1_000 })
      await h.settle()
      await h.advance(10_000)
      return null
    })
    await h.settle()
    await h.advance(10_000)
    expect(h.server.openStreams()).toHaveLength(1)
    expect(h.server.gets.length).toBe(getsBefore + 1)
    expect(h.server.current()?.keys).toEqual(new Set(keysA))
  })

  it('T-CB45: a hop without restore publishes its token on release; the original token expiring reopens without purge', async () => {
    const original = tokenA(null)
    await readyWithKeys(original)
    expect(h.service.me?.teamId).toBeNull()
    const getsBefore = h.server.gets.length
    const generationBefore = h.client.inspect().session?.generation ?? 0

    await h.service.runWithTeamContext(TEAM_2, async () => null)
    await h.settle()

    const hopToken = h.service.sessionToken
    expect(hopToken).not.toBe(original)
    expect(h.client.inspect().session?.token).toBe(hopToken)
    expect(h.client.inspect().session?.generation).toBeGreaterThan(generationBefore)
    expect(h.server.gets.length).toBe(getsBefore)

    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    await h.advance(1_000)

    expect(h.owner().ofType('sessionExpired')).toHaveLength(0)
    expect(h.client.inspect().latch).toBeNull()
    expect(h.server.gets.at(-1)?.token).toBe(hopToken)
    expect(h.server.gets.at(-1)?.keys).toEqual(keysA)
  })

  it('T-CB50: an opaque session token never breaks the login; every list counts as empty', async () => {
    const opaque = 'synthetic-opaque-session-token'
    const state = await h.login(opaque, meOf(opaque, USER_A))
    expect(state.authenticated).toBe(true)
    expect(h.service.sessionToken).toBe(opaque)
    expect(h.client.inspect().session?.binding).toBeNull()

    await h.subscribe(keysA, state.me?.id ?? null)
    expect(h.client.inspect().sent).toEqual([])
    expect(h.server.gets.every(g => g.keys.length === 0)).toBe(true)
  })

  it('T-CB37/T-CB48: a list of A in flight over the login of B is dropped; the list of B (me.id) enters', async () => {
    await readyWithKeys()
    const stateB = await h.login(tokenB())
    // The renderer's userId is auth.me.id from the session state the login returned.
    const userIdB = stateB.me?.id ?? null
    expect(userIdB).toBe(USER_B)

    await h.subscribe(keysA, USER_A)
    expect(h.client.inspect().sent).toEqual([])
    expect(h.client.hasOwner(1)).toBe(true)
    const ofB = h.server.gets.filter(g => g.token === h.service.sessionToken)
    expect(ofB.length).toBeGreaterThan(0)
    expect(ofB.every(g => g.keys.length === 0)).toBe(true)
    expect(h.server.puts.filter(p => p.token === h.service.sessionToken)).toHaveLength(0)

    const keysB = [key('file', 20)]
    await h.subscribe(keysB, userIdB)
    expect(h.server.current()?.keys).toEqual(new Set(keysB))

    // Control: the principal identity (`${me.id}:${email}`) never equals the claim.
    await h.subscribe(keysB, `${stateB.me?.id}:${stateB.me?.email}`)
    expect(h.client.inspect().sent).toEqual([])
  })

  it('T-CB22: two windows, one with an empty list, both receive sessionExpired after the login of another user', async () => {
    await readyWithKeys()
    await h.subscribe([], USER_A, 2)
    const stateB = await h.login(tokenB())
    await h.subscribe([key('file', 30)], stateB.me?.id ?? null)

    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()

    expect(h.owner(1).ofType('sessionExpired')).toHaveLength(1)
    expect(h.owner(2).ofType('sessionExpired')).toHaveLength(1)

    // A late IPC of the document that was replaced is dropped.
    const oldToken = h.owner(2).frameToken
    h.client.ownerNavigated(2, h.owner(2).navigate())
    const late = h.client.setSubscriptions(
      h.owner(2),
      { keys: [key('file', 31)], userId: USER_B },
      oldToken
    )
    expect(late.sessionExpired).toBe(false)
    expect(h.client.inspect().owners.get(2)?.keys).toEqual([])
  })
})

describe('AppService GFS watch — team hop release', () => {
  it('T-CB32: a double release of the real hop yields one exit and one sessionExpired', async () => {
    await readyWithKeys()
    const release = h.service.enterGfsTransientTeamHop()
    const exits = vi.spyOn(h.client, 'onHopRelease')

    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(h.client.inspect().latch).toEqual({ generation: 1, deferred: true })
    expect(h.owner().ofType('sessionExpired')).toHaveLength(0)

    release()
    release()
    await h.settle()

    expect(h.service.gfsTransientTeamHopDepth).toBe(0)
    expect(exits).toHaveBeenCalledTimes(1)
    expect(h.owner().ofType('sessionExpired')).toHaveLength(1)
    expect(h.service.authClient.getMe).toHaveBeenCalledTimes(1)
  })

  it('T-CB14: an expiry inside a team switch opens nothing until the hop ends, then one sessionExpired; a window mounted later learns it from the answer', async () => {
    await readyWithKeys()
    const getsBefore = h.server.gets.length
    let failSwitch!: (e: Error) => void
    h.service.authClient.switchTeam!.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failSwitch = reject))
    )
    const switching = h.service.switchTeam(TEAM_2)
    await h.settle()

    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    await h.advance(60_000)
    expect(h.server.gets.length).toBe(getsBefore)
    expect(h.owner().ofType('sessionExpired')).toHaveLength(0)

    failSwitch(new Error('switch unavailable'))
    await expect(switching).rejects.toThrow('switch unavailable')
    await h.settle()

    expect(h.owner().ofType('sessionExpired')).toHaveLength(1)
    expect(h.server.gets.length).toBe(getsBefore)

    // The window closes and a new one mounts: the answer carries the expiry.
    h.client.ownerDestroyed(1)
    const answer = await h.subscribe(keysA, USER_A, 3)
    expect(answer.sessionExpired).toBe(true)
    expect(h.server.gets.length).toBe(getsBefore)
  })
})

describe('AppService GFS watch — session verdict from /me', () => {
  it.each([
    [
      'a session_expired frame',
      () => h.server.frame({ type: 'stream.closing', reason: 'session_expired' }),
    ],
  ])('T-CB64: %s asks /me once; a 2xx keeps the session and the latch', async (_label, expire) => {
    await readyWithKeys()
    expire()
    await h.settle()
    expect(h.service.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(h.service.sessionToken).not.toBeNull()
    expect(h.client.inspect().latch).not.toBeNull()
    expect(h.onSessionCleared).not.toHaveBeenCalled()
  })

  it('T-CB64: a 401 of the reopening GET asks /me once', async () => {
    await readyWithKeys()
    h.server.getPolicy = () => ({ kind: 'error', status: 401, code: 'unauthorized' })
    h.server.frame({ type: 'stream.closing', reason: 'listener_lost' })
    await h.settle()
    await h.advance(30_000)
    expect(h.client.inspect().latch).not.toBeNull()
    expect(h.service.authClient.getMe).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 410])('T-CB64: /me %i ends the session', async status => {
    await readyWithKeys()
    h.meAnswer = async () => {
      throw meEnded(status)
    }
    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(h.service.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(h.service.sessionToken).toBeNull()
    expect(h.onSessionCleared).toHaveBeenCalledTimes(1)
    expect(h.client.inspect().session?.token ?? null).toBeNull()
  })

  it('T-CB64: an expiry with a newer committed session asks /me nothing', async () => {
    await readyWithKeys()
    await h.service.runWithTeamContext(TEAM_2, async () => null)
    await h.settle()
    const meCalls = h.service.authClient.getMe!.mock.calls.length
    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(h.service.authClient.getMe).toHaveBeenCalledTimes(meCalls)
  })

  it('T-CB64: releasing a hop with a deferred expiry asks /me once', async () => {
    await readyWithKeys()
    const release = h.service.enterGfsTransientTeamHop()
    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(h.service.authClient.getMe).not.toHaveBeenCalled()
    release()
    await h.settle()
    expect(h.service.authClient.getMe).toHaveBeenCalledTimes(1)
  })

  it('T-CB63: /me 401 after a rejected workflow listing closes the stream before the window is told', async () => {
    await readyWithKeys()
    const getsBefore = h.server.gets.length
    h.meAnswer = async () => {
      throw meEnded(401)
    }
    h.service.authClient.listWorkflows!.mockRejectedValue(
      new ApiError('401 Unauthorized', 401, '{"error":"Unauthorized"}')
    )
    const atClear: Array<{ link: string; sent: readonly string[]; ownerKeys: unknown }> = []
    h.onSessionCleared.mockImplementation(() => {
      const st = h.client.inspect()
      atClear.push({ link: st.link.kind, sent: st.sent, ownerKeys: st.owners.get(1)?.keys })
    })

    await expect(h.service.listWorkflows()).rejects.toThrow()
    await h.settle()

    expect(h.service.sessionToken).toBeNull()
    expect(atClear).toEqual([{ link: 'Idle', sent: [], ownerKeys: [] }])
    expect(h.server.openStreams()).toHaveLength(0)
    expect(h.server.gets.length).toBe(getsBefore)
    expect(h.client.hasOwner(1)).toBe(true)
  })
})

describe('AppService GFS watch — environment switch', () => {
  it('T-CB21: E17 → logout and stop → E17′(true): no stream on the new environment with the old token or keys', async () => {
    await readyWithKeys()
    const serverB = (await import('../../testSupport/gfsWatch/fakeWatchServer.js')).FakeWatchServer
    const envB = new serverB()
    await envB.start()
    try {
      const order: string[] = []
      const client = h.client
      for (const m of [
        'onEnvSwitchStart',
        'onSessionToken',
        'onStopAllStreams',
        'onEnvSwitchEnd',
      ] as const) {
        const original = client[m].bind(client) as (...a: unknown[]) => void
        vi.spyOn(client, m).mockImplementation(((...args: unknown[]) => {
          order.push(
            `${m}(${args.map(a => (a === null ? 'null' : typeof a === 'string' ? 'token' : String(a))).join(',')})`
          )
          original(...args)
        }) as never)
      }

      await h.service.applyRuntimeEnvironmentChange(async () => {
        config.externalRestApiBaseUrl = envB.baseUrl
      })
      await h.settle()

      expect(order).toEqual([
        'onEnvSwitchStart()',
        'onSessionToken(null)',
        'onStopAllStreams()',
        'onEnvSwitchEnd(true)',
      ])
      expect(h.server.openStreams()).toHaveLength(0)
      expect(envB.gets).toHaveLength(0)
      expect(h.client.inspect().owners.get(1)?.keys).toEqual([])

      // The next login on the new environment opens there without the old keys.
      await h.login(tokenB())
      expect(envB.gets).toHaveLength(1)
      expect(envB.gets[0]?.keys).toEqual([])
      expect(h.server.gets.filter(g => g.token === h.service.sessionToken)).toHaveLength(0)
    } finally {
      await envB.stop()
    }
  })

  it('an error after the environment switch never leaves the watch switching', async () => {
    const { token } = await readyWithKeys()
    const getsBefore = h.server.gets.length
    const internals = h.service as unknown as { beginPrewarmAuthTransition: () => () => void }
    internals.beginPrewarmAuthTransition = () => () => {
      throw new Error('prewarm release failed')
    }
    await expect(h.service.applyRuntimeEnvironmentChange(async () => undefined)).rejects.toThrow(
      'prewarm release failed'
    )
    await h.settle()
    expect(h.client.inspect().envSwitching).toBe(false)
    expect(h.client.inspect().session?.token).toBe(token)
    expect(h.server.gets.length).toBe(getsBefore + 1)
    expect(h.linkKind()).toBe('Ready')
  })

  it('T-CB21: a switch that keeps the environment keeps the session and reopens with the same keys', async () => {
    const { token } = await readyWithKeys()
    const getsBefore = h.server.gets.length
    await h.service.applyRuntimeEnvironmentChange(async () => undefined)
    await h.settle()
    expect(h.service.sessionToken).toBe(token)
    expect(h.client.inspect().session?.token).toBe(token)
    expect(h.server.gets.length).toBe(getsBefore + 1)
    expect(h.server.current()?.keys).toEqual(new Set(keysA))
  })
})
