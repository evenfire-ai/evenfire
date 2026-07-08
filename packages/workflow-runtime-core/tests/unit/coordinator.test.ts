import { describe, expect, it } from 'vitest'
import type { StepSpec } from '../../src/config-loader/types'
import { StepCoordinator, type StepExecutor } from '../../src/coordinator/step-coordinator'
import { CycleDetectedError } from '../../src/errors'

const makeStep = (id: string, dependsOn: string[] = []): StepSpec =>
  ({
    id,
    instruction: `Do ${id}`,
    dependsOn,
    timeoutSeconds: 30,
    retries: 0,
    backoffSeconds: 5,
  }) as StepSpec

describe('StepCoordinator.resolveOrder()', () => {
  it('returns single step unchanged', () => {
    const c = new StepCoordinator()
    const steps = [makeStep('a')]
    expect(c.resolveOrder(steps).map(s => s.id)).toEqual(['a'])
  })

  it('resolves linear dependency a -> b -> c', () => {
    const c = new StepCoordinator()
    const steps = [makeStep('c', ['b']), makeStep('a'), makeStep('b', ['a'])]
    const order = c.resolveOrder(steps).map(s => s.id)
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
  })

  it('resolves custom id-only steps', () => {
    const c = new StepCoordinator()
    const steps: StepSpec[] = [
      { id: 'emit', dependsOn: ['transform'] },
      { id: 'prepare' },
      { id: 'transform', dependsOn: ['prepare'] },
    ]
    const order = c.resolveOrder(steps).map(s => s.id)
    expect(order).toEqual(['prepare', 'transform', 'emit'])
  })

  it('throws CycleDetectedError for direct cycle a -> b -> a', () => {
    const c = new StepCoordinator()
    const steps = [makeStep('a', ['b']), makeStep('b', ['a'])]
    expect(() => c.resolveOrder(steps)).toThrow(CycleDetectedError)
  })

  it('CycleDetectedError message contains cycle nodes', () => {
    const c = new StepCoordinator()
    const steps = [makeStep('a', ['b']), makeStep('b', ['a'])]
    try {
      c.resolveOrder(steps)
    } catch (e) {
      expect((e as CycleDetectedError).message).toContain('a')
      expect((e as CycleDetectedError).message).toContain('b')
    }
  })

  it('resolves diamond dependency (a -> b, a -> c, b -> d, c -> d)', () => {
    const c = new StepCoordinator()
    const steps = [
      makeStep('a'),
      makeStep('b', ['a']),
      makeStep('c', ['a']),
      makeStep('d', ['b', 'c']),
    ]
    const order = c.resolveOrder(steps).map(s => s.id)
    expect(order[0]).toBe('a')
    expect(order[order.length - 1]).toBe('d')
  })

  it('throws for self-referencing step', () => {
    const c = new StepCoordinator()
    expect(() => c.resolveOrder([makeStep('a', ['a'])])).toThrow(CycleDetectedError)
  })

  it('throws for unknown dependency reference', () => {
    const c = new StepCoordinator()
    expect(() => c.resolveOrder([makeStep('a', ['nonexistent'])])).toThrow()
  })

  it('handles multiple independent steps (no dependencies)', () => {
    const c = new StepCoordinator()
    const steps = [makeStep('a'), makeStep('b'), makeStep('c')]
    const order = c.resolveOrder(steps)
    expect(order).toHaveLength(3)
  })

  it('handles 3-node cycle (a -> b -> c -> a)', () => {
    const c = new StepCoordinator()
    const steps = [makeStep('a', ['c']), makeStep('b', ['a']), makeStep('c', ['b'])]
    expect(() => c.resolveOrder(steps)).toThrow(CycleDetectedError)
  })

  it('preserves stable order for independent steps', () => {
    const c = new StepCoordinator()
    const steps = [makeStep('z'), makeStep('a'), makeStep('m')]
    const order1 = c.resolveOrder(steps).map(s => s.id)
    const order2 = c.resolveOrder(steps).map(s => s.id)
    expect(order1).toEqual(order2)
  })

  it('handles complex 5-step DAG', () => {
    const c = new StepCoordinator()
    const steps = [
      makeStep('fetch'),
      makeStep('parse', ['fetch']),
      makeStep('validate', ['parse']),
      makeStep('enrich', ['parse']),
      makeStep('publish', ['validate', 'enrich']),
    ]
    const order = c.resolveOrder(steps).map(s => s.id)
    expect(order[0]).toBe('fetch')
    expect(order[order.length - 1]).toBe('publish')
    expect(order.indexOf('parse')).toBeLessThan(order.indexOf('validate'))
    expect(order.indexOf('parse')).toBeLessThan(order.indexOf('enrich'))
  })
})

describe('StepCoordinator.runWorkflow()', () => {
  it('executes all steps in resolved order', async () => {
    const c = new StepCoordinator()
    const executed: string[] = []
    const executor: StepExecutor = async step => {
      executed.push(step.id)
      return `output-${step.id}`
    }
    const spec = {
      name: 'wf',
      namespace: 'default',
      steps: [makeStep('b', ['a']), makeStep('a')],
    }
    await c.runWorkflow(spec, executor)
    expect(executed).toEqual(['a', 'b'])
  })

  it('passes previousOutputs to each step context', async () => {
    const c = new StepCoordinator()
    const contexts: Record<string, unknown>[] = []
    const executor: StepExecutor = async (_step, ctx) => {
      contexts.push({ ...ctx.previousOutputs })
      return 'output'
    }
    const spec = {
      name: 'wf',
      namespace: 'default',
      steps: [makeStep('a'), makeStep('b', ['a'])],
    }
    await c.runWorkflow(spec, executor)
    expect(contexts[0]).toEqual({})
    expect(contexts[1]).toHaveProperty('a', 'output')
  })

  it('stops on cancel signal before next step', async () => {
    const c = new StepCoordinator()
    let executedCount = 0
    const executor: StepExecutor = async () => {
      executedCount++
      return 'out'
    }
    c.injectSignal({
      type: 'cancel',
      requestId: 'r1',
      receivedAt: new Date().toISOString(),
    })
    const spec = {
      name: 'wf',
      namespace: 'default',
      steps: [makeStep('a'), makeStep('b')],
    }
    await c.runWorkflow(spec, executor)
    expect(executedCount).toBe(0)
  })

  it('returns collected outputs as record', async () => {
    const c = new StepCoordinator()
    const executor: StepExecutor = async step => `result-${step.id}`
    const spec = {
      name: 'wf',
      namespace: 'default',
      steps: [makeStep('a'), makeStep('b')],
    }
    const outputs = await c.runWorkflow(spec, executor)
    expect(outputs).toEqual({ a: 'result-a', b: 'result-b' })
  })

  it('propagates executor error', async () => {
    const c = new StepCoordinator()
    const executor: StepExecutor = async () => {
      throw new Error('step failed')
    }
    const spec = {
      name: 'wf',
      namespace: 'default',
      steps: [makeStep('a')],
    }
    await expect(c.runWorkflow(spec, executor)).rejects.toThrow('step failed')
  })

  it('provides signals snapshot in step context', async () => {
    const c = new StepCoordinator()
    const receivedSignals: unknown[][] = []
    const executor: StepExecutor = async (_step, ctx) => {
      receivedSignals.push([...ctx.signals])
      return 'ok'
    }
    // Inject a non-cancel signal
    c.injectSignal({
      type: 'pause',
      requestId: 'r1',
      receivedAt: new Date().toISOString(),
    })
    const spec = {
      name: 'wf',
      namespace: 'default',
      steps: [makeStep('a')],
    }
    // pause signal doesn't stop execution in runWorkflow (only cancel does)
    await c.runWorkflow(spec, executor)
    expect(receivedSignals[0]).toHaveLength(1)
  })

  it('stops execution mid-workflow when cancel injected after first step', async () => {
    const c = new StepCoordinator()
    const executed: string[] = []
    const executor: StepExecutor = async step => {
      executed.push(step.id)
      if (step.id === 'a') {
        c.injectSignal({
          type: 'cancel',
          requestId: 'mid-cancel',
          receivedAt: new Date().toISOString(),
        })
      }
      return `out-${step.id}`
    }
    const spec = {
      name: 'wf',
      namespace: 'default',
      steps: [makeStep('a'), makeStep('b', ['a']), makeStep('c', ['b'])],
    }
    const outputs = await c.runWorkflow(spec, executor)
    expect(executed).toEqual(['a'])
    expect(outputs).toHaveProperty('a', 'out-a')
    expect(outputs).not.toHaveProperty('b')
  })

  it('handles empty steps array', async () => {
    const c = new StepCoordinator()
    const executor: StepExecutor = async () => 'never'
    const spec = { name: 'wf', namespace: 'default', steps: [] }
    const result = await c.runWorkflow(spec, executor)
    expect(result).toEqual({})
  })

  it('provides workflowName in step context', async () => {
    const c = new StepCoordinator()
    let receivedName = ''
    const executor: StepExecutor = async (_step, ctx) => {
      receivedName = ctx.workflowName
      return 'ok'
    }
    const spec = {
      name: 'my-wf',
      namespace: 'default',
      steps: [makeStep('a')],
    }
    await c.runWorkflow(spec, executor)
    expect(receivedName).toBe('my-wf')
  })

  it('passes snippet run specs through to the executor', async () => {
    const c = new StepCoordinator()
    const seenRunTypes: string[] = []
    const executor: StepExecutor = async step => {
      seenRunTypes.push(step.run?.type ?? 'missing')
      return { ok: true }
    }
    const spec = {
      name: 'my-wf',
      namespace: 'default',
      steps: [
        { id: 'first', run: { type: 'snippet', language: 'typescript', code: 'return {}' } },
        {
          id: 'second',
          dependsOn: ['first'],
          run: { type: 'snippet', language: 'typescript', code: 'return {}' },
        },
      ],
    }

    const outputs = await c.runWorkflow(spec, executor)

    expect(seenRunTypes).toEqual(['snippet', 'snippet'])
    expect(outputs).toEqual({ first: { ok: true }, second: { ok: true } })
  })

  it('skips completed steps and exposes their outputs during resume', async () => {
    const c = new StepCoordinator()
    const seen: string[] = []
    const executor: StepExecutor = async (step, ctx) => {
      seen.push(step.id)
      expect(ctx.previousOutputs.first).toBe('cached')
      return 'fresh'
    }
    const spec = {
      name: 'my-wf',
      namespace: 'default',
      steps: [makeStep('first'), makeStep('second', ['first'])],
    }

    const outputs = await c.runWorkflow(spec, executor, {
      completedStepIds: ['first'],
      initialOutputs: { first: 'cached' },
    })

    expect(seen).toEqual(['second'])
    expect(outputs).toEqual({ first: 'cached', second: 'fresh' })
  })
})
