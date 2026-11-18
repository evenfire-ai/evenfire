import {
  type GfsWatchClient,
  type GfsWatchLogger,
  createGfsWatchClient,
} from '../../src/gfs/watchClient.js'
import { requestJson } from '../../src/httpClient.js'
import { FakeOwner } from './fakeOwner.js'
import { FakeWatchServer } from './fakeWatchServer.js'
import { USER_A, signV1SessionToken } from './sessionTokens.js'
import { VirtualClock, type VirtualTimer, seededRandom } from './virtualClock.js'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * The real watch client with the real `fetch` and `requestJson` against a
 * fake watch over HTTP, and every client timer on a virtual clock. Real I/O
 * is awaited with `settle()`, which waits until nothing observable moves.
 */
export class WatchHarness {
  clock = new VirtualClock()
  server = new FakeWatchServer()
  client!: GfsWatchClient
  owners = new Map<number, FakeOwner>()
  hopDepth = 0
  verdicts = 0
  logs: Array<{ level: 'warn' | 'error'; message: string; meta?: Record<string, unknown> }> = []
  unhandled: unknown[] = []
  private onUnhandled = (reason: unknown) => this.unhandled.push(reason)
  appToken: string | null = null
  /** Runs between a GET's response arriving and the client's handler seeing it. */
  beforeGetResponse: (() => void) | null = null
  /** PUT requests started and neither settled nor aborted; and its maximum. */
  putsInFlight = 0
  maxPutsInFlight = 0

  constructor(private seed = 1) {}

  async start(opts: { random?: () => number } = {}): Promise<this> {
    process.on('unhandledRejection', this.onUnhandled)
    await this.server.start()
    const log: GfsWatchLogger = {
      warn: (message, meta) => this.logs.push({ level: 'warn', message, meta }),
      error: (message, meta) => this.logs.push({ level: 'error', message, meta }),
    }
    this.client = createGfsWatchClient({
      baseUrl: () => this.server.baseUrl,
      fetch: (input, init) =>
        fetch(input, init).then(res => {
          const hook = this.beforeGetResponse
          this.beforeGetResponse = null
          hook?.()
          return res
        }),
      requestJson: (method, url, options) => {
        let open = true
        const done = () => {
          if (!open) return
          open = false
          this.putsInFlight -= 1
        }
        this.putsInFlight += 1
        this.maxPutsInFlight = Math.max(this.maxPutsInFlight, this.putsInFlight)
        options.signal.addEventListener('abort', done)
        const p = requestJson(method, url, options)
        p.then(done, done)
        return p
      },
      clock: this.clock,
      random: opts.random ?? seededRandom(this.seed),
      log,
      readHopDepth: () => this.hopDepth,
      onSessionExpiredVerdict: () => {
        this.verdicts += 1
      },
    })
    return this
  }

  async stop(): Promise<void> {
    this.client.dispose()
    await this.settle()
    await this.server.stop()
    await sleep(5)
    process.off('unhandledRejection', this.onUnhandled)
  }

  /** A V1 token for `userId` at `authGeneration`; every call is a distinct token. */
  token(userId = USER_A, authGeneration = 1, teamId: string | null = null): string {
    return signV1SessionToken({ userId, authGeneration, teamId })
  }

  /** E15 with a fresh token, as the app service publishes it. */
  async login(userId = USER_A, authGeneration = 1, teamId: string | null = null): Promise<string> {
    const token = this.token(userId, authGeneration, teamId)
    this.appToken = token
    this.client.onSessionToken(token)
    await this.settle()
    return token
  }

  async publish(token: string | null): Promise<void> {
    this.appToken = token
    this.client.onSessionToken(token)
    await this.settle()
  }

  owner(id = 1): FakeOwner {
    let o = this.owners.get(id)
    if (!o) {
      o = new FakeOwner(id)
      this.owners.set(id, o)
    }
    return o
  }

  /** The renderer's `setSubscriptions` with the `userId` of the current session. */
  async subscribe(keys: string[], id = 1, userId?: string): Promise<{ sessionExpired: boolean }> {
    const o = this.owner(id)
    const uid = userId ?? this.client.inspect().session?.binding?.userId ?? null
    const r = this.client.setSubscriptions(o, { keys, userId: uid }, o.frameToken)
    await this.settle()
    return r
  }

  isPending(handle: unknown): boolean {
    return this.clock.isPending(handle)
  }

  /** Waits until neither the client, the server nor the owners change for a few rounds of real I/O. */
  async settle(maxMs = 3_000): Promise<void> {
    const started = Date.now()
    let last = ''
    let stable = 0
    while (Date.now() - started < maxMs) {
      await new Promise<void>(resolve => setImmediate(resolve))
      await sleep(2)
      const s = this.signature()
      if (s === last) {
        stable += 1
        if (stable >= 3) return
      } else {
        stable = 0
        last = s
      }
    }
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
    ])
  }

  /** Fires the earliest pending timer (optionally only those matching) and settles. */
  async fireNext(filter?: (t: VirtualTimer) => boolean): Promise<VirtualTimer | undefined> {
    const t = this.clock.pending().find(x => (filter ? filter(x) : true))
    if (!t) return undefined
    this.clock.fire(t)
    await this.settle()
    return t
  }

  /**
   * Advances virtual time by `ms`, firing every timer due on the way. With
   * `heartbeats`, the server writes a heartbeat on every live stream each
   * `heartbeatMs`, as the registry does.
   */
  async advance(ms: number, opts: { heartbeats?: boolean } = {}): Promise<void> {
    const end = this.clock.elapsed + ms
    let nextBeat = new Map<string, number>()
    for (;;) {
      if (opts.heartbeats) {
        for (const c of this.server.openStreams()) {
          if (!nextBeat.has(c.connId)) nextBeat.set(c.connId, this.clock.elapsed + c.heartbeatMs)
        }
      }
      const t = this.clock.next()
      const beat = opts.heartbeats
        ? [...nextBeat.entries()]
            .sort((a, b) => a[1] - b[1])
            .find(([id]) => this.server.openStreams().some(c => c.connId === id))
        : undefined
      const tAt = t ? t.at : Infinity
      const bAt = beat ? beat[1] : Infinity
      const at = Math.min(tAt, bAt)
      if (at > end) break
      if (bAt <= tAt && beat) {
        this.clock.elapsed = Math.max(this.clock.elapsed, bAt)
        const conn = this.server.openStreams().find(c => c.connId === beat[0])
        nextBeat.set(beat[0], bAt + (conn?.heartbeatMs ?? 20_000))
        if (conn) this.server.frame({ type: 'heartbeat' }, conn)
      } else if (t) {
        this.clock.fire(t)
      }
      await this.settle()
      nextBeat = new Map(
        [...nextBeat].filter(([id]) => this.server.openStreams().some(c => c.connId === id))
      )
    }
    this.clock.elapsed = Math.max(this.clock.elapsed, end)
  }

  /** Polls real I/O until `pred` holds. */
  async until(pred: () => boolean, maxMs = 3_000): Promise<void> {
    const started = Date.now()
    while (!pred()) {
      if (Date.now() - started > maxMs) throw new Error('until: condition not reached')
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  linkKind(): string {
    return this.client.inspect().link.kind
  }
}
