import { describe, expect, it } from 'vitest'
import { createKeyedSingleFlight } from '../keyedSingleFlight'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('createKeyedSingleFlight', () => {
  it('runs one pass per key at a time and collapses a burst into one trailing pass', async () => {
    const flight = createKeyedSingleFlight()
    const gates: Array<ReturnType<typeof deferred>> = []
    const runs: string[] = []
    const task = (label: string) => () => {
      runs.push(label)
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    }
    flight.run('k', task('first'))
    flight.run('k', task('second'))
    flight.run('k', task('third'))
    await tick()
    expect(runs).toEqual(['first'])

    gates[0]!.resolve()
    await tick()
    expect(runs).toEqual(['first', 'third'])

    gates[1]!.resolve()
    await tick()
    expect(runs).toEqual(['first', 'third'])

    flight.run('k', task('later'))
    await tick()
    expect(runs).toEqual(['first', 'third', 'later'])
  })

  it('keeps keys independent', async () => {
    const flight = createKeyedSingleFlight()
    const started: string[] = []
    const gate = deferred()
    flight.run('a', () => {
      started.push('a')
      return gate.promise
    })
    flight.run('b', async () => {
      started.push('b')
    })
    await tick()
    expect(started).toEqual(['a', 'b'])
    gate.resolve()
  })

  it('runs the trailing pass after a failed one', async () => {
    const flight = createKeyedSingleFlight()
    const gate = deferred()
    const runs: string[] = []
    flight.run('k', () => {
      runs.push('fails')
      return gate.promise
    })
    flight.run('k', async () => {
      runs.push('next')
    })
    gate.reject(new Error('boom'))
    await tick()
    await tick()
    expect(runs).toEqual(['fails', 'next'])
  })

  it('runs nothing after dispose', async () => {
    const flight = createKeyedSingleFlight()
    const gate = deferred()
    const runs: string[] = []
    flight.run('k', () => {
      runs.push('in-flight')
      return gate.promise
    })
    flight.run('k', async () => {
      runs.push('kept')
    })
    flight.dispose()
    gate.resolve()
    flight.run('k', async () => {
      runs.push('after')
    })
    await tick()
    expect(runs).toEqual(['in-flight'])
  })
})
