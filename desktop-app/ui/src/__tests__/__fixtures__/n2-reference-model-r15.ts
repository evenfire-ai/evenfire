/**
 * Spec 110 r15 independent product oracle. PLANNING ARTIFACT, not production code.
 * The real driver must mount actual App/controllers and call actual main/queue
 * producers. An adapter returning this model's output is forbidden.
 * fc.commands/fc.scheduler execution has NOT been performed in ChatGPT.
 */
import fc from 'fast-check'
import assert from 'node:assert/strict'

export type Result = 'file' | 'folder' | 'denied' | 'transient'
export type Event =
  | { kind: 'receive'; id: number; uri: string }
  | { kind: 'ready'; principal: string }
  | { kind: 'confirm'; id: number }
  | { kind: 'dismiss'; id: number }
  | { kind: 'navigate'; destination: string }
  | { kind: 'invalidate'; floor: number }
  | { kind: 'releaseBarrier'; principal: string | null }
  | { kind: 'resolve'; id: number; result: Result }
  | { kind: 'ack'; id: number; applied: boolean }
  | { kind: 'retry'; id: number }

type Receipt = {
  uri: string
  receivedPrincipal: string | null
  phase: 'waiting' | 'resolving' | 'retryable' | 'local-terminal'
  confirmedPrincipal?: string
  confirmAction?: number
}
export type Model = {
  principal: string | null
  ready: boolean
  barrier: boolean
  floor: number
  action: number
  receipts: Map<number, Receipt>
  visible: string | null
  reads: Map<number, number>
  ack: Map<number, 'confirmed' | 'unconfirmed'>
}
export function initialModel(): Model {
  return {
    principal: null,
    ready: false,
    barrier: false,
    floor: 1,
    action: 0,
    receipts: new Map(),
    visible: null,
    reads: new Map(),
    ack: new Map(),
  }
}
function invalidate(m: Model, floor: number): void {
  m.action++
  m.floor = Math.max(m.floor, floor)
  m.barrier = true
  m.ready = false
  m.visible = null
  for (const [id] of m.receipts) if (id < m.floor) m.receipts.delete(id)
  // Invalidation also cancels eligibility of any local prior-lifetime work.
  for (const receipt of m.receipts.values()) receipt.phase = 'local-terminal'
}
export function transition(m: Model, event: Event): void {
  switch (event.kind) {
    case 'receive':
      if (!m.barrier && event.id >= m.floor && !m.receipts.has(event.id)) {
        m.receipts.set(event.id, {
          uri: event.uri,
          receivedPrincipal: m.principal,
          phase: 'waiting',
        })
      }
      return
    case 'ready':
      if (m.principal !== null && m.principal !== event.principal) {
        throw new Error(
          'Driver must expose actual principal invalidation before replacement readiness'
        )
      }
      m.principal = event.principal
      m.ready = true
      return
    case 'releaseBarrier':
      m.principal = event.principal
      m.ready = event.principal !== null
      m.barrier = false
      return
    case 'invalidate':
      invalidate(m, event.floor)
      return
    case 'navigate':
      m.action++
      m.visible = event.destination
      return
    case 'dismiss': {
      const r = m.receipts.get(event.id)
      if (r?.phase === 'waiting') r.phase = 'local-terminal'
      return
    }
    case 'confirm': {
      const r = m.receipts.get(event.id)
      if (!r || r.phase !== 'waiting' || !m.ready || !m.principal || m.barrier) return
      if (r.receivedPrincipal !== null && r.receivedPrincipal !== m.principal) return
      // Serial admission: an already admitted actual operation keeps its owner.
      if ([...m.receipts.values()].some(x => x.phase === 'resolving' || x.phase === 'retryable'))
        return
      r.phase = 'resolving'
      r.confirmedPrincipal = m.principal
      r.confirmAction = ++m.action
      m.reads.set(event.id, (m.reads.get(event.id) ?? 0) + 1)
      return
    }
    case 'resolve': {
      const r = m.receipts.get(event.id)
      if (!r || r.phase !== 'resolving') return
      if (m.barrier || r.confirmedPrincipal !== m.principal || r.confirmAction !== m.action) {
        r.phase = 'local-terminal'
        return
      }
      if (event.result === 'transient') {
        r.phase = 'retryable'
        return
      }
      if (event.result === 'file' || event.result === 'folder') m.visible = r.uri
      r.phase = 'local-terminal'
      return
    }
    case 'retry': {
      const r = m.receipts.get(event.id)
      if (
        !r ||
        r.phase !== 'retryable' ||
        r.confirmAction !== m.action ||
        r.confirmedPrincipal !== m.principal ||
        m.barrier
      )
        return
      r.phase = 'resolving'
      m.reads.set(event.id, (m.reads.get(event.id) ?? 0) + 1)
      return
    }
    case 'ack':
      // Destination and queue effect are intentionally independent (F1).
      m.ack.set(event.id, event.applied ? 'confirmed' : 'unconfirmed')
      return
  }
}
export interface Observation {
  visibleDestination: string | null
  visiblePromptIds: number[]
  resourceReadCountById: Map<number, number>
  wrongPrincipalContentObserved: boolean
  mainAckOutcomeById: Map<number, 'confirmed' | 'unconfirmed'>
  pendingOwnedWork: string[]
}
export function assertObservation(m: Model, o: Observation, final = false): void {
  assert.equal(o.wrongPrincipalContentObserved, false)
  assert.equal(o.visibleDestination, m.visible)
  // The driver counts actual resolver-entry/transport calls, not fabricated model calls.
  for (const [id, actual] of o.resourceReadCountById) assert.equal(actual, m.reads.get(id) ?? 0)
  for (const [id, expected] of m.reads) assert.equal(o.resourceReadCountById.get(id) ?? 0, expected)
  for (const id of o.visiblePromptIds) {
    const r = m.receipts.get(id)
    assert.ok(m.ready && !m.barrier && r?.phase === 'waiting')
    assert.ok(r.receivedPrincipal === null || r.receivedPrincipal === m.principal)
  }
  assert.ok(o.visiblePromptIds.length <= 1)
  const admitted = [...m.receipts.values()].some(
    r => r.phase === 'resolving' || r.phase === 'retryable'
  )
  const eligible =
    m.ready && !m.barrier && !admitted
      ? [...m.receipts]
          .filter(
            ([, r]) =>
              r.phase === 'waiting' &&
              (r.receivedPrincipal === null || r.receivedPrincipal === m.principal)
          )
          .map(([id]) => id)
          .sort((a, b) => a - b)
      : []
  // This driver has no competing App modal; scenario N11 tests modal priority separately.
  assert.deepEqual(
    o.visiblePromptIds,
    eligible.slice(0, 1),
    'an eligible request needs a visible prompt'
  )
  for (const [id, result] of m.ack) assert.equal(o.mainAckOutcomeById.get(id), result)
  if (final) assert.deepEqual(o.pendingOwnedWork, [], 'unresolved owned tasks are not quiescence')
}

/** Actual fixture contract; no dummy implementation or model-as-system fallback. */
export interface ProductionDriver {
  /** Produce raw input via real URL builder -> router/queue; return actual ID/URI. */
  produce(target: 'file' | 'folder'): Promise<{ id: number; uri: string }>
  /** Calls real user/IPC/network boundaries. Held work starts but is not awaited here. */
  perform(event: Event, schedule: fc.Scheduler): Promise<void>
  observe(): Promise<Observation>
  /** Resolve/reject explicitly selected boundaries, observe rejections, then flush React. */
  finish(schedule: fc.Scheduler): Promise<void>
  dispose(): Promise<void>
}

export async function runReadySourceControls(
  createActualDriver: (scheduler: fc.Scheduler) => Promise<ProductionDriver>
): Promise<void> {
  // A6 event/state commands run against the real App adapter supplied by the implementation tests.
  // Keep receipt IDs as actual producer outputs; do not generate imaginary IPC records.
  const choices = ['duplicate', 'ready', 'confirm', 'dismiss', 'navigate', 'resolve'] as const
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.commands(
        [
          fc.constantFrom(...choices).map(choice => ({
            check: (_m: Model) => true,
            async run(
              m: Model,
              r: {
                driver: ProductionDriver
                scheduler: fc.Scheduler
                target: { id: number; uri: string }
              }
            ) {
              const event: Event =
                choice === 'duplicate'
                  ? { kind: 'receive', ...r.target }
                  : choice === 'ready'
                    ? { kind: 'ready', principal: 'fixture-principal' }
                    : choice === 'confirm'
                      ? { kind: 'confirm', id: r.target.id }
                      : choice === 'dismiss'
                        ? { kind: 'dismiss', id: r.target.id }
                        : choice === 'navigate'
                          ? { kind: 'navigate', destination: 'fixture-user-navigation' }
                          : { kind: 'resolve', id: r.target.id, result: 'file' }
              const applying = r.driver.perform(event, r.scheduler)
              await r.scheduler.waitAll()
              await applying
              transition(m, event)
              assertObservation(m, await r.driver.observe())
            },
            toString: () => choice,
          })),
        ],
        { maxCommands: 20 }
      ),
      async (scheduler, commands) => {
        const driver = await createActualDriver(scheduler)
        try {
          const target = await driver.produce('file')
          const model = initialModel()
          transition(model, { kind: 'receive', ...target })
          await fc.asyncModelRun(() => ({ model, real: { driver, scheduler, target } }), commands)
          await driver.finish(scheduler)
          // finish may only settle selected boundaries with their matching model events;
          // it must not silently manufacture a destination. Assert final parity in scenario drivers.
        } finally {
          await driver.dispose()
        }
      }
    ),
    { seed: 1101501, numRuns: 100 }
  )
}
