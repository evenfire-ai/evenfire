import { vi } from 'vitest'
import { AppService } from '../../src/appService.js'
import { config } from '../../src/config.js'
import type { GfsWatchLogger } from '../../src/gfs/watchClient.js'
import { decodeJwtPayload } from '../../src/gfs/watchProtocol.js'
import { requestJson } from '../../src/httpClient.js'
import type { SessionMe } from '../../src/types.js'
import { currentTest } from './currentTest.js'
import { FakeOwner } from './fakeOwner.js'
import { FakeWatchServer } from './fakeWatchServer.js'
import { signV1SessionToken } from './sessionTokens.js'
import { VirtualClock, seededRandom } from './virtualClock.js'
import { settle, wireLedger } from './wireLedger.js'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Mock = ReturnType<typeof vi.fn>

/**
 * `/me` for a session token, as ERA resolves it: the user and team come from
 * the token's own claims (`me.id` is the `userId` claim). An undecodable token
 * belongs to the user the test names.
 */
export function meOf(token: string, fallbackUserId = 'opaque-user'): SessionMe {
  const claims = decodeJwtPayload(token)
  const id = typeof claims?.userId === 'string' ? claims.userId : fallbackUserId
  const teamId = typeof claims?.teamId === 'string' && claims.teamId ? claims.teamId : null
  return {
    id,
    email: typeof claims?.email === 'string' ? claims.email : `${id.slice(0, 8)}@example.test`,
    name: null,
    picture: null,
    teamId,
    teamName: teamId,
    role: 'member',
  }
}

/** The private surface of AppService that these tests drive or observe. */
export type ServiceInternals = AppService & {
  sessionToken: string | null
  me: SessionMe | null
  gfsTransientTeamHopDepth: number
  authClient: Record<string, Mock>
  tokenStore: Record<string, Mock>
  suspendDesktopGfsUploadsForAuthBoundary: Mock
  bindCurrentChatStore: Mock
  enterGfsTransientTeamHop(): () => void
  runWithTeamContext<T>(teamId: string | null, op: (token: string) => Promise<T>): Promise<T>
  applyRuntimeEnvironmentChange(op: () => Promise<void>): Promise<number>
}

/**
 * The real AppService, with its real watch client running the real `fetch`
 * and `requestJson` against a fake watch over HTTP. Mocks stop at the network
 * (the auth client's HTTP calls) and at disk (token store, chat store, upload
 * state). The watch client's timers run on a virtual clock. `settle()` waits
 * until no watch request is on the wire and nothing observable moves, and
 * throws when that does not happen in time.
 */
export class AppServiceWatchHarness {
  clock = new VirtualClock()
  server = new FakeWatchServer()
  service!: ServiceInternals
  onSessionCleared = vi.fn()
  logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = []
  owners = new Map<number, FakeOwner>()
  private originalBaseUrl = config.externalRestApiBaseUrl
  /** Answer of `/me` per token; defaults to the token's claims. */
  meAnswer: (token: string) => Promise<SessionMe> = async token => meOf(token)

  async start(): Promise<this> {
    await this.server.start()
    config.externalRestApiBaseUrl = this.server.baseUrl
    const log: GfsWatchLogger = {
      warn: (message, meta) => this.logs.push({ level: 'warn', message, meta }),
      error: (message, meta) => this.logs.push({ level: 'error', message, meta }),
    }
    const tokenStore = {
      setSessionToken: vi.fn().mockResolvedValue(undefined),
      clearSessionToken: vi.fn().mockResolvedValue(undefined),
      getSessionToken: vi.fn().mockResolvedValue(null),
    }
    this.service = new AppService({
      tokenStore: tokenStore as never,
      onSessionCleared: this.onSessionCleared,
      // The real fetch, explicitly: the suite-wide default is an inert one. Both
      // transports are tagged so `settle()` sees their requests on the wire.
      gfsWatch: {
        fetch: wireLedger.fetch(currentTest),
        requestJson: wireLedger.requestJson(currentTest, requestJson),
        clock: this.clock,
        random: seededRandom(7),
        log,
      },
    }) as unknown as ServiceInternals
    this.service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    this.service.bindCurrentChatStore = vi.fn().mockResolvedValue(undefined)
    this.service.authClient = {
      getDesktopEnvironment: vi.fn().mockRejectedValue(new Error('no discovery in tests')),
      googleLogin: vi.fn(),
      getMe: vi.fn((token: string) => this.meAnswer(token)),
      // The auth service mints a token of the same user and auth generation
      // for the target team, as the external team exchange does.
      switchTeam: vi.fn(async (token: string, teamId: string) => {
        const claims = decodeJwtPayload(token)
        return {
          token: signV1SessionToken({
            userId: String(claims?.userId),
            authGeneration: Number(claims?.authGeneration),
            teamId,
          }),
          team: { id: teamId, name: teamId, role: 'member' },
        }
      }),
      listWorkflows: vi.fn(),
    }
    return this
  }

  async stop(): Promise<void> {
    this.service.gfsWatch.dispose()
    try {
      await this.settle()
    } finally {
      await this.server.stop()
      config.externalRestApiBaseUrl = this.originalBaseUrl
      await sleep(5)
    }
  }

  get client() {
    return this.service.gfsWatch
  }

  /** The real interactive login: `installAuthenticatedLogin` publishes the token. */
  async login(token: string, me: SessionMe = meOf(token)) {
    this.service.authClient.googleLogin!.mockResolvedValueOnce({ token, me })
    const state = await this.service.googleLogin('synthetic-google-id-token')
    await this.settle()
    return state
  }

  owner(id = 1): FakeOwner {
    let o = this.owners.get(id)
    if (!o) {
      o = new FakeOwner(id)
      this.owners.set(id, o)
    }
    return o
  }

  async subscribe(keys: string[], userId: string | null, id = 1) {
    const o = this.owner(id)
    const result = this.client.setSubscriptions(o, { keys, userId }, o.frameToken)
    await this.settle()
    return result
  }

  linkKind(): string {
    return this.client.inspect().link.kind
  }

  /** Fires every due client timer (backoff, reopen) up to `ms` of virtual time. */
  async advance(ms: number): Promise<void> {
    const end = this.clock.elapsed + ms
    for (;;) {
      const t = this.clock.next()
      if (!t || t.at > end) break
      this.clock.fire(t)
      await this.settle()
    }
    this.clock.elapsed = end
  }

  /**
   * Waits until no watch request is on the wire and nothing observable moves
   * for a few rounds of real I/O; throws after `maxMs`.
   */
  async settle(maxMs = 3_000): Promise<void> {
    await settle({ signature: () => this.signature(), maxMs })
  }

  private signature(): string {
    const st = this.client.inspect()
    const link = st.link as { kind: string; g?: number }
    return JSON.stringify([
      link.kind,
      link.g,
      st.put?.phase,
      st.put?.seq,
      st.sent,
      this.server.gets.length,
      this.server.gets.filter(g => g.closed).length,
      this.server.puts.length,
      this.server.puts.filter(p => p.closed || p.answered).length,
      this.server.conns.map(c => [c.alive, c.lastSeq]),
      [...this.owners.values()].map(o => o.events.length),
      this.clock.pending().length,
      this.service.sessionToken,
      this.onSessionCleared.mock.calls.length,
      this.service.authClient.getMe?.mock.calls.length,
    ])
  }
}
