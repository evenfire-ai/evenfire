import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReporterTerminalError } from './boundedOffPathReporter'
import { HostContextLogger } from './logger'
import { throwForFailedSubmit } from './reporterHttpFailure'

function response(status: number, readBody: () => Promise<unknown>) {
  const json = vi.fn(readBody)
  return { response: { ok: status < 300, status, json } as unknown as Response, json }
}

function named(name: string): Error {
  const error = new Error(`${name} while reading the body`)
  error.name = name
  return error
}

async function failure(status: number, readBody: () => Promise<unknown>) {
  const { response: res } = response(status, readBody)
  return throwForFailedSubmit(res, 'test event').then(
    () => undefined,
    (error: unknown) => error
  )
}

afterEach(() => vi.restoreAllMocks())

describe('throwForFailedSubmit', () => {
  it('returns for a 2xx without reading the body', async () => {
    const { response: res, json } = response(202, async () => ({}))

    await expect(throwForFailedSubmit(res, 'test event')).resolves.toBeUndefined()
    expect(json).not.toHaveBeenCalled()
  })

  it.each([
    [409, 'tracing_idempotency_conflict', 'conflict'],
    [409, 'administrative_intent_generation_drift', 'rejected'],
    [400, 'unsafe_tracing_input', 'rejected'],
    [400, 'invalid_tracing_input', 'rejected'],
  ] as const)('treats %i %s as terminal %s', async (status, code, result) => {
    const error = await failure(status, async () => ({ code, error: 'ignored' }))

    expect(error).toBeInstanceOf(ReporterTerminalError)
    expect(error).toMatchObject({ result })
  })

  /**
   * Two codes now share status 409 (#329), so the `find` on `code` decides
   * which terminal result applies rather than merely confirming the only
   * candidate. A resolver that returned the first 409 entry would answer
   * `conflict` for a drift refusal, and HCC would record a routine operator
   * outcome as an idempotency collision.
   */
  it('picks the terminal result by code when two entries share status 409', async () => {
    const conflict = await failure(409, async () => ({ code: 'tracing_idempotency_conflict' }))
    const drift = await failure(409, async () => ({
      code: 'administrative_intent_generation_drift',
    }))

    expect(conflict).toMatchObject({ result: 'conflict' })
    expect(drift).toMatchObject({ result: 'rejected' })
  })

  it.each([
    [400, 'tracing_idempotency_conflict'],
    [409, 'unsafe_tracing_input'],
    [409, 'invalid_tracing_input'],
    [403, 'tracing_idempotency_conflict'],
    // The drift code carried on a 403 is NOT terminal. The 403 next door is
    // `tracing_binding_unavailable`, which also covers a binding that is
    // merely not visible yet; keeping the whole status retryable is what lets
    // a control-api/HCC deploy overlap heal itself (#329).
    [403, 'administrative_intent_generation_drift'],
  ] as const)(
    'keeps %i with %s retryable: the status is part of the pair',
    async (status, code) => {
      const error = await failure(status, async () => ({ code }))

      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(ReporterTerminalError)
      expect((error as Error).message).toBe(`test event submit failed with ${status}`)
    }
  )

  it.each([
    ['an array', [{ code: 'tracing_idempotency_conflict' }]],
    ['null', null],
    ['a numeric code', { code: 409 }],
    ['a string', 'tracing_idempotency_conflict'],
  ])('keeps a 409 whose body is %s retryable', async (_label, body) => {
    const error = await failure(409, async () => body)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ReporterTerminalError)
  })

  it('does not read the body of a status that has no terminal pair', async () => {
    const { response: res, json } = response(500, async () => ({ code: 'unsafe_tracing_input' }))

    await expect(throwForFailedSubmit(res, 'test event')).rejects.toThrow(
      'test event submit failed with 500'
    )
    expect(json).not.toHaveBeenCalled()
  })

  it('keeps the body out of the error message', async () => {
    const error = await failure(409, async () => ({
      code: 'tracing_idempotency_conflict',
      error: 'body-marker',
    }))

    // Liveness: the body was read, since the code made it terminal.
    expect(error).toBeInstanceOf(ReporterTerminalError)
    expect((error as Error).message).not.toContain('body-marker')
  })

  it.each([
    ['SyntaxError', 'not_json'],
    ['AbortError', 'aborted'],
    ['TypeError', 'read_failed'],
  ])('logs a %s during the body read as %s and stays retryable', async (name, reason) => {
    const warn = vi.spyOn(HostContextLogger.prototype, 'warn').mockImplementation(() => {})

    const error = await failure(409, async () => {
      throw named(name)
    })

    expect(error).not.toBeInstanceOf(ReporterTerminalError)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('reporter could not read the response code', {
      label: 'test event',
      status: 409,
      reason,
    })
  })
})
