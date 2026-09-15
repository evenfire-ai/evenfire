import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter, once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { boundedJson, validateBoundedSchema } from '../boundedSchemaValidation'

vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: vi.fn(function (...args: ConstructorParameters<typeof actual.Worker>) {
      return new actual.Worker(...args)
    }),
  }
})

afterEach(async () => {
  vi.useRealTimers()
  // Validation resolves promptly; worker capacity is released asynchronously on exit.
  const exits = vi.mocked(Worker).mock.results.flatMap(result => {
    const worker = result.value as Worker | undefined
    return worker && typeof worker.threadId === 'number' && worker.threadId !== -1
      ? [once(worker, 'exit')]
      : []
  })
  await Promise.all(exits)
  vi.clearAllMocks()
})

describe('bounded MCP schema validation', () => {
  it.each([
    undefined,
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft-07/schema',
    'http://json-schema.org/draft/2020-12/schema#',
    'http://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2020-12/schema',
  ])('validates without coercion for %s', async dialect => {
    const schema = boundedJson({
      ...(dialect ? { $schema: dialect } : {}),
      type: 'object',
      properties: { count: { type: 'integer', default: 1 } },
      required: ['count'],
      additionalProperties: false,
    })
    expect(await validateBoundedSchema(schema, boundedJson({ count: 1 }))).toBe(true)
    expect(await validateBoundedSchema(schema, boundedJson({ count: '1' }))).toBe(false)
    expect(await validateBoundedSchema(schema, boundedJson({}))).toBe(false)
    expect(await validateBoundedSchema(schema, boundedJson({ count: 1, extra: true }))).toBe(false)
  })

  it('fails closed for unsupported schemas and external references', async () => {
    for (const schema of [
      { $schema: 'https://example.invalid/schema' },
      { $ref: 'https://example.invalid/schema' },
      { $async: true, type: 'object' },
    ])
      expect(await validateBoundedSchema(boundedJson(schema), '{}')).toBe(false)
  })

  it('bounds input and does not call accessors or serialization hooks', () => {
    const getter = vi.fn(() => 'value')
    expect(() =>
      boundedJson({
        get value() {
          return getter()
        },
      })
    ).toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(() => boundedJson('x'.repeat(256 * 1024 + 1))).toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => boundedJson(cyclic)).toThrow()
    expect(() => boundedJson({ toJSON: () => ({}) })).toThrow()
  })

  it('queues a fifth validation until a worker exits', async () => {
    const workers = Array.from({ length: 5 }, () => {
      const worker = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> }
      worker.terminate = vi.fn(async () => {
        worker.emit('exit', 0)
        return 0
      })
      vi.mocked(Worker).mockImplementationOnce(function () {
        return worker as unknown as Worker
      })
      return worker
    })
    const pending = workers.map(() => validateBoundedSchema('{}', '{}'))
    await Promise.resolve()
    expect(Worker).toHaveBeenCalledTimes(4)
    workers[0].emit('message', true)
    await Promise.resolve()
    expect(Worker).toHaveBeenCalledTimes(5)
    workers.slice(1).forEach(worker => worker.emit('message', true))
    expect(await Promise.all(pending)).toEqual([true, true, true, true, true])
  })

  it('bounds queued requests and retains slots until stalled workers exit', async () => {
    vi.useFakeTimers()
    const workers = Array.from({ length: 4 }, () => {
      const worker = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> }
      worker.terminate = vi.fn(async () => 1)
      vi.mocked(Worker).mockImplementationOnce(function () {
        return worker as unknown as Worker
      })
      return worker
    })
    const pending = Array.from({ length: 36 }, () => validateBoundedSchema('{}', '{}'))
    const failure = vi.fn()
    expect(await validateBoundedSchema('{}', '{}', failure)).toBe(false)
    expect(failure).toHaveBeenCalledWith('queue_full')
    expect(Worker).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await Promise.all(pending)).toEqual(Array(36).fill(false))
    expect(Worker).toHaveBeenCalledTimes(4)
    for (const worker of workers) worker.emit('exit', 1)
  })

  it('terminates a benign stalled worker on deadline while the Host timer runs', async () => {
    vi.useFakeTimers()
    const stalled = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> }
    stalled.terminate = vi.fn(async () => {
      stalled.emit('exit', 1)
      return 1
    })
    vi.mocked(Worker).mockImplementationOnce(function () {
      return stalled as unknown as Worker
    })
    const hostTick = vi.fn()
    setTimeout(hostTick, 10)
    const failure = vi.fn()
    const result = validateBoundedSchema('{}', '{}', failure)
    await vi.advanceTimersByTimeAsync(10)
    expect(hostTick).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await result).toBe(false)
    expect(failure).toHaveBeenCalledWith('timeout')
    expect(stalled.terminate).toHaveBeenCalledOnce()
  })
})

it.each([
  [{ $schema: 'https://example.invalid/schema' }, {}, 'unsupported_schema'],
  [{ type: 'unknown-type' }, {}, 'invalid_schema'],
  [{ type: 'object', required: ['count'] }, {}, 'invalid_arguments'],
] as const)(
  'classifies validation failures without raw diagnostics: %s',
  async (schema, params, code) => {
    const failure = vi.fn()
    expect(await validateBoundedSchema(boundedJson(schema), boundedJson(params), failure)).toBe(
      false
    )
    expect(failure).toHaveBeenCalledExactlyOnceWith(code)
  }
)

it('classifies oversized worker input before starting a worker', async () => {
  const failure = vi.fn()
  expect(await validateBoundedSchema('{}', 'x'.repeat(256 * 1024 + 1), failure)).toBe(false)
  expect(failure).toHaveBeenCalledExactlyOnceWith('input_limit')
  expect(Worker).not.toHaveBeenCalled()
})
