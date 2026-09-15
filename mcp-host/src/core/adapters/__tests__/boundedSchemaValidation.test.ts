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

  it('fails closed at capacity until cancelled workers actually exit', async () => {
    vi.useFakeTimers()
    const workers = Array.from({ length: 4 }, () => {
      const worker = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> }
      worker.terminate = vi.fn(async () => 1)
      vi.mocked(Worker).mockImplementationOnce(function () {
        return worker as unknown as Worker
      })
      return worker
    })
    const pending = workers.map(() => validateBoundedSchema('{}', '{}'))
    expect(await validateBoundedSchema('{}', '{}')).toBe(false)
    expect(Worker).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await Promise.all(pending)).toEqual([false, false, false, false])
    expect(await validateBoundedSchema('{}', '{}')).toBe(false)
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
    const result = validateBoundedSchema('{}', '{}')
    await vi.advanceTimersByTimeAsync(10)
    expect(hostTick).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await result).toBe(false)
    expect(stalled.terminate).toHaveBeenCalledOnce()
  })
})
