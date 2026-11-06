/**
 * Model test of the publish retry's ticket state machine (the real
 * AllowlistPublishRetry, real timers faked). The only stand-in is the
 * publisher, at the Kubernetes boundary: a publication reads the committed
 * version and, on success, the ConfigMap holds that version.
 *
 * The reference model is two counters: `committed` (the newest committed run)
 * and `published` (what the ConfigMap holds). A publication's read and write
 * are one step, as they are under the publish lock; its outcome reaches the
 * retry at any later point, interleaved with other runs. A sync numbers its
 * publication right after its commit, which is the contract the retry relies
 * on: any publication numbered later reads that commit.
 *
 * At rest (no publication in flight) the invariant is: either a publication is
 * owed, or the ConfigMap holds the newest commit. After draining the retry with
 * successful publications, the ConfigMap holds the newest commit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { AllowedModelsConfigMapPublisher } from '../src/services/llmAllowedModelsConfigMap.js'
import { AllowlistPublishRetry } from '../src/services/llmAllowlistPublishRetry.js'

const DELAY_MS = 1_000

type Outcome = 'ok' | 'fail'
type InFlight = { outcome: Outcome | null } & (
  | { kind: 'sync'; ticket: number }
  | { kind: 'retry'; resolve: () => void; reject: (err: Error) => void }
)

class World {
  committed = 0
  published = 0
  inFlight: InFlight[] = []
  readonly retry = new AllowlistPublishRetry({ baseDelayMs: DELAY_MS, maxDelayMs: DELAY_MS })
  readonly publisher: AllowedModelsConfigMapPublisher

  constructor() {
    const materializeIfChanged = () =>
      new Promise<'written'>((resolve, reject) => {
        this.inFlight.push({
          kind: 'retry',
          outcome: null,
          resolve: () => resolve('written'),
          reject,
        })
      })
    this.publisher = {
      materialize: async () => undefined,
      materializeIfChanged,
    } as unknown as AllowedModelsConfigMapPublisher
  }

  atRest(): boolean {
    return this.inFlight.length === 0
  }

  unwritten(): InFlight[] {
    return this.inFlight.filter(p => p.outcome === null)
  }

  written(): InFlight[] {
    return this.inFlight.filter(p => p.outcome !== null)
  }
}

type Model = { committed: number }
type Cmd = fc.AsyncCommand<Model, World>

/** A sync commits, then numbers its publication (the order the sync uses). */
class CommitSync implements Cmd {
  check = () => true
  async run(_m: Model, w: World) {
    w.committed += 1
    w.inFlight.push({ kind: 'sync', outcome: null, ticket: w.retry.begin() })
    expectAtRestInvariant(w)
  }
  toString = () => 'CommitSync'
}

/** A publication's step under the publish lock: it reads Postgres and writes. */
class Write implements Cmd {
  constructor(
    readonly pick: number,
    readonly outcome: Outcome
  ) {}
  check = () => true
  async run(_m: Model, w: World) {
    const pending = w.unwritten()
    if (pending.length === 0) return
    const pub = pending[this.pick % pending.length]
    pub.outcome = this.outcome
    if (this.outcome === 'ok') w.published = w.committed
  }
  toString = () => `Write(${this.pick}, ${this.outcome})`
}

/** The publication's outcome reaches the retry, at any later point. */
class Settle implements Cmd {
  constructor(readonly pick: number) {}
  check = () => true
  async run(_m: Model, w: World) {
    const done = w.written()
    if (done.length === 0) return
    const pub = done[this.pick % done.length]
    w.inFlight.splice(w.inFlight.indexOf(pub), 1)
    if (pub.kind === 'sync') {
      if (pub.outcome === 'ok') w.retry.succeeded(pub.ticket)
      else w.retry.failed(pub.ticket, w.publisher)
    } else {
      if (pub.outcome === 'ok') pub.resolve()
      else pub.reject(new Error('apiserver unavailable'))
      await vi.advanceTimersByTimeAsync(0)
    }
    expectAtRestInvariant(w)
  }
  toString = () => `Settle(${this.pick})`
}

class FireRetry implements Cmd {
  check = () => true
  async run(_m: Model, w: World) {
    await vi.advanceTimersByTimeAsync(DELAY_MS)
    expectAtRestInvariant(w)
  }
  toString = () => 'FireRetry'
}

function expectAtRestInvariant(w: World): void {
  if (!w.atRest()) return
  expect(w.retry.isPending() || w.published === w.committed).toBe(true)
}

async function settleAll(w: World, outcome: Outcome): Promise<void> {
  for (let i = 0; i < 100 && !w.atRest(); i++) {
    await new Write(0, outcome).run({ committed: 0 }, w)
    await new Settle(0).run({ committed: 0 }, w)
  }
}

async function drain(w: World): Promise<void> {
  await settleAll(w, 'fail')
  for (let i = 0; i < 50 && w.retry.isPending(); i++) {
    await vi.advanceTimersByTimeAsync(DELAY_MS)
    await settleAll(w, 'ok')
  }
}

describe('publish retry ticket state machine (model)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // A sequence the random search rarely reaches: a failure numbered below an
  // already-owed one settles late, then a success numbered between them, which
  // read before the newest commit, settles last.
  it('a late low-numbered failure does not lower what is owed', async () => {
    const world = new World()
    try {
      await fc.asyncModelRun(
        () => ({ model: { committed: 0 }, real: world }),
        [
          new CommitSync(), // t1
          new CommitSync(), // t2
          new Write(1, 'ok'), // t2 publishes commit 2
          new CommitSync(), // t3
          new Write(1, 'fail'), // t3
          new Settle(1), // t3 owed
          new Write(0, 'fail'), // t1
          new Settle(0), // t1 failed, after t3
          new Settle(0), // t2 succeeded: it never read commit 3
        ]
      )
      await drain(world)
      expect(world.published).toBe(world.committed)
    } finally {
      world.retry.stop()
    }
  })

  it('never loses an owed commit: at rest it is owed or published, and draining publishes it', async () => {
    const commands = [
      fc.constant(new CommitSync()),
      fc
        .tuple(fc.nat(3), fc.constantFrom<Outcome>('ok', 'fail'))
        .map(([pick, outcome]) => new Write(pick, outcome)),
      fc.nat(3).map(pick => new Settle(pick)),
      fc.constant(new FireRetry()),
    ]
    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { size: '+1' }), async cmds => {
        vi.clearAllTimers()
        const world = new World()
        try {
          await fc.asyncModelRun(() => ({ model: { committed: 0 }, real: world }), cmds)
          expectAtRestInvariant(world)
          await drain(world)
          expect(world.atRest()).toBe(true)
          expect(world.retry.isPending()).toBe(false)
          expect(world.published).toBe(world.committed)
        } finally {
          world.retry.stop()
        }
      }),
      { numRuns: 5_000 }
    )
  })
})
