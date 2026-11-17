import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type ListenerClient,
  type ListenerConn,
  createGfsWatchListener,
} from '../src/services/gfsWatch/listener.js'
import { createRecentDirty } from '../src/services/gfsWatch/recentDirty.js'
import { createWatchRuntime } from '../src/services/gfsWatch/runtime.js'
import {
  type VirtualWatchClock,
  createVirtualWatchClock,
  flushMicrotasks,
} from './helpers/gfsWatchClock.js'

// Model of the LISTEN client's lifecycle: the real listener over a stubbed pg
// client and a virtual clock, driven by every event that can reach it (build
// failures, connect outcomes, client events of any client ever built, echo
// loss, time, stop) while fc.scheduler orders when each connect and LISTEN
// resolves against those events. After each command, at rest, the listener
// must always have a way back unless it was stopped (I-V1), never run two
// attempts at once (I-S1), hold nothing after a stop (I-S2), and only ever
// treat a client with its three handlers as current (I-S3).

type Handler = (...args: unknown[]) => void
type Fault = 'create' | 'on' | null
type Conn = ListenerConn & { op: { dirtyOverflow: boolean } | null }

const HANDLERS = ['error', 'end', 'notification'] as const

class StubClient implements ListenerClient {
  handlers = new Map<string, Handler[]>()
  /** Every handler ever registered, so a command can fire an event of a disposed client. */
  everRegistered = new Map<string, Handler[]>()
  throwOn: string | null = null
  echo = true
  connectSettle: { resolve: () => void; reject: (e: Error) => void } | null = null

  constructor(private readonly s: fc.Scheduler) {}

  on(event: string, listener: Handler) {
    if (event === this.throwOn) {
      this.throwOn = null
      throw new Error(`on('${event}') failed`)
    }
    for (const map of [this.handlers, this.everRegistered]) {
      map.set(event, [...(map.get(event) ?? []), listener])
    }
    return this
  }
  removeAllListeners() {
    this.handlers.clear()
    return this
  }
  emitEver(event: string, ...args: unknown[]) {
    for (const h of this.everRegistered.get(event) ?? []) h(...args)
  }
  connect() {
    return new Promise<void>((resolve, reject) => (this.connectSettle = { resolve, reject }))
  }
  query(text: string, values?: unknown[]) {
    if (text.startsWith('LISTEN')) return this.s.schedule(Promise.resolve({}), 'listen')
    if (text.includes('pg_notify') && this.echo) {
      const payload = String(values?.[0])
      queueMicrotask(() => {
        for (const h of this.handlers.get('notification') ?? []) {
          h({ channel: 'gfs_watch_ping', payload, processId: 1 })
        }
      })
    }
    return Promise.resolve({})
  }
  end() {
    return Promise.resolve()
  }
}

type Real = {
  s: fc.Scheduler
  clock: VirtualWatchClock
  clients: StubClient[]
  nextFault: Fault
  listener: ReturnType<typeof createGfsWatchListener<Conn>>
}

/** The reference model: only whether the listener was stopped. */
type Model = { stopped: boolean }

function build(s: fc.Scheduler, initialFault: Fault): Real {
  const clock = createVirtualWatchClock({ random: () => 0.5 })
  const rt = createWatchRuntime<Conn>({ clock, closeConnInternal: () => undefined })
  const real = { s, clock, clients: [], nextFault: initialFault } as unknown as Real
  real.listener = createGfsWatchListener<Conn>({
    connectionString: 'postgres://unused',
    runtime: rt,
    recentDirty: createRecentDirty(clock.now),
    connections: () => [],
    opsInFlight: () => [],
    closeConn: () => undefined,
    onCmd: () => undefined,
    onResourceChanged: () => undefined,
    resetWindows: () => undefined,
    onExpansionFailed: () => undefined,
    createClient: () => {
      const fault = real.nextFault
      real.nextFault = null
      if (fault === 'create') throw new Error('invalid connection string')
      const c = new StubClient(s)
      if (fault === 'on') c.throwOn = 'notification'
      real.clients.push(c)
      return c
    },
  })
  return real
}

type Phase = 'stopped' | 'ready' | 'connecting' | 'backoff' | 'dead'

function phaseOf(real: Real): Phase {
  const st = real.listener.state
  if (st.shuttingDown) return 'stopped'
  if (st.listenerReady) return 'ready'
  if (st.listenerClient !== null && st.tConnect !== null) return 'connecting'
  if (st.reconnectTimer !== null) return 'backoff'
  return 'dead'
}

function violations(m: Model, real: Real): string[] {
  const st = real.listener.state
  const v: string[] = []
  const phase = phaseOf(real)
  if (phase === 'dead') v.push('I-V1: not ready, not connecting and no reconnection scheduled')
  if (st.tConnect !== null && st.reconnectTimer !== null) {
    v.push('I-S1: an attempt in flight and another one scheduled')
  }
  if (st.shuttingDown && (st.tConnect || st.reconnectTimer || st.listenerClient)) {
    v.push('I-S2: something left armed or current after stop')
  }
  if (st.listenerClient !== null) {
    const c = st.listenerClient as StubClient
    for (const e of HANDLERS) {
      if (!c.handlers.get(e)?.length) v.push(`I-S3: current client without its ${e} handler`)
    }
  }
  if (m.stopped !== (phase === 'stopped')) v.push(`model: stopped=${m.stopped}, phase ${phase}`)
  if (phase === 'ready' && (st.listenerClient === null || st.tConnect || st.reconnectTimer)) {
    v.push('model: ready without a current client or with an attempt armed')
  }
  return v
}

type Cmd = fc.AsyncCommand<Model, Real>

const pick = <T>(xs: T[], i: number): T | undefined => (xs.length ? xs[i % xs.length] : undefined)

class FaultCmd implements Cmd {
  constructor(readonly fault: 'create' | 'on') {}
  check = () => true
  async run(_m: Model, real: Real) {
    real.nextFault = this.fault
  }
  toString = () => (this.fault === 'create' ? 'CreateThrows' : 'OnThrows')
}

class ConnectCmd implements Cmd {
  constructor(
    readonly i: number,
    readonly ok: boolean
  ) {}
  check = () => true
  async run(_m: Model, real: Real) {
    const c = pick(
      real.clients.filter(x => x.connectSettle !== null),
      this.i
    )
    if (!c) return
    const settle = c.connectSettle!
    c.connectSettle = null
    void real.s.schedule(Promise.resolve(), 'connect').then(() => {
      if (this.ok) settle.resolve()
      else settle.reject(new Error('ECONNREFUSED'))
    })
  }
  toString = () => `${this.ok ? 'ConnectOk' : 'ConnectFail'}(${this.i})`
}

class ClientEventCmd implements Cmd {
  constructor(
    readonly i: number,
    readonly event: 'error' | 'end'
  ) {}
  check = () => true
  async run(_m: Model, real: Real) {
    pick(real.clients, this.i)?.emitEver(this.event, new Error('connection reset'))
  }
  toString = () => `ClientEvent(${this.i}, ${this.event})`
}

class EchoLostCmd implements Cmd {
  check = () => true
  async run(_m: Model, real: Real) {
    const c = real.listener.state.listenerClient as StubClient | null
    if (c) c.echo = false
  }
  toString = () => 'EchoLost'
}

class AdvanceCmd implements Cmd {
  constructor(readonly ms: number) {}
  check = () => true
  async run(_m: Model, real: Real) {
    await real.clock.advanceAsync(this.ms)
  }
  toString = () => `Advance(${this.ms})`
}

class ReleaseCmd implements Cmd {
  check = () => true
  async run(_m: Model, real: Real) {
    if (real.s.count() > 0) await real.s.waitOne()
    await flushMicrotasks()
  }
  toString = () => 'Release'
}

class StopCmd implements Cmd {
  check = (m: Readonly<Model>) => !m.stopped
  async run(m: Model, real: Real) {
    real.listener.stopGfsWatchRegistry()
    m.stopped = true
  }
  toString = () => 'Stop'
}

const connect = fc.tuple(fc.nat(3), fc.boolean()).map(([i, ok]) => new ConnectCmd(i, ok))
const release = fc.constant(new ReleaseCmd())
// Weighted so that runs reach `ready` and spend most commands before the stop:
// a connect needs its own release and the LISTEN's before it confirms.
const commands = [
  fc.constantFrom<'create' | 'on'>('create', 'on').map(f => new FaultCmd(f)),
  connect,
  connect,
  fc
    .tuple(fc.nat(5), fc.constantFrom<'error' | 'end'>('error', 'end'))
    .map(([i, e]) => new ClientEventCmd(i, e)),
  fc.constant(new EchoLostCmd()),
  fc.constantFrom(100, 1_000, 2_500, 10_000, 25_000).map(ms => new AdvanceCmd(ms)),
  release,
  release,
  release,
  fc.nat(11).map(n => (n === 0 ? new StopCmd() : new ReleaseCmd())),
]

/** Wraps each command so the invariants are checked at rest after every one. */
function checked(cmd: Cmd, failures: string[]): Cmd {
  return {
    check: m => cmd.check(m),
    async run(m, real) {
      await cmd.run(m, real)
      await flushMicrotasks()
      for (const x of violations(m, real)) failures.push(`after ${cmd.toString()}: ${x}`)
    },
    toString: () => cmd.toString(),
  }
}

describe('GFS watch listener lifecycle model', () => {
  it('keeps I-V1, I-S1, I-S2 and I-S3 under any build failure, client event and interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.constantFrom<Fault>(null, 'create', 'on'),
        fc.commands(commands, { maxCommands: 40, size: 'large' }),
        async (s, initialFault, cmds) => {
          const unhandled: unknown[] = []
          const onUnhandled = (reason: unknown) => unhandled.push(reason)
          process.on('unhandledRejection', onUnhandled)
          try {
            const real = build(s, initialFault)
            const model: Model = { stopped: false }
            const failures: string[] = []
            real.listener.startGfsWatchRegistry()
            await flushMicrotasks()
            failures.push(...violations(model, real).map(x => `after Start: ${x}`))
            const wrapped = [...cmds].map(c => checked(c, failures))
            await fc.asyncModelRun(() => ({ model, real }), wrapped)
            while (s.count() > 0) await s.waitAll()
            await flushMicrotasks()
            failures.push(...violations(model, real).map(x => `at rest: ${x}`))
            await new Promise(resolve => setImmediate(resolve))
            expect([...failures, ...unhandled.map(e => `unhandled: ${String(e)}`)]).toEqual([])
          } finally {
            process.off('unhandledRejection', onUnhandled)
          }
        }
      ),
      { numRuns: Number(process.env.GFS_WATCH_LISTENER_MODEL_RUNS ?? 300) }
    )
  })
})
