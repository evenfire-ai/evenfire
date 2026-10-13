import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter, once } from 'node:events'
import { Worker } from 'node:worker_threads'
import type { DocumentJob, DocumentJobOutcome, XlsxOutcome } from '../types'
import { runDocumentJob } from '../workerRunner'
import {
  documentLimits,
  longRunningWorkbook,
  textPdf,
  valuesWorkbook,
  witnessCode,
} from './fixtures'

vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: vi.fn(function mockedWorker(...args: ConstructorParameters<typeof actual.Worker>) {
      return new actual.Worker(...args)
    }),
  }
})

const heavyWorkbook = longRunningWorkbook()

function job(bytes: Buffer, overrides: Partial<DocumentJob> = {}): DocumentJob {
  return {
    kind: 'xlsx',
    bytes: new Uint8Array(bytes),
    sheet: null,
    start: null,
    limits: documentLimits({ maxHeapMb: 256, timeoutMs: 10_000 }),
    ...overrides,
  } as DocumentJob
}

function lastWorker(): Worker {
  const result = vi.mocked(Worker).mock.results.at(-1)
  if (!result || result.type !== 'return') throw new Error('The runner did not create a worker')
  return result.value as Worker
}

function onlineOf(worker: Worker): Promise<void> {
  return new Promise(resolve => worker.once('online', () => resolve()))
}

function exitOf(worker: Worker): Promise<number> {
  return new Promise(resolve => worker.once('exit', code => resolve(code)))
}

async function observeLiveWorker(pending: Promise<unknown>, timeoutMs: number): Promise<Worker> {
  const worker = lastWorker()
  // Worker online is asynchronous, and this helper is called in the same tick
  // as runner dispatch, so this subscription cannot miss the first online event.
  const online = onlineOf(worker)
  await vi.waitFor(
    () => {
      expect(worker.threadId).toBeGreaterThan(0)
      return worker
    },
    { timeout: timeoutMs }
  )
  await Promise.race([online, new Promise(resolve => setTimeout(resolve, 100))])
  expect(pending).toBeInstanceOf(Promise)
  return worker
}

afterEach(async () => {
  const exits = vi
    .mocked(Worker)
    .mock.results.filter(result => result.type === 'return')
    .map(result => result.value as Worker)
    .filter(worker => typeof worker.threadId === 'number' && worker.threadId > 0)
    .map(worker => once(worker, 'exit'))
  await Promise.all(exits)
  vi.clearAllMocks()
})

describe('document reader worker runner', () => {
  it('rejects invalid runner limits without starting a worker and accepts valid limits', async () => {
    const invalid = job(await valuesWorkbook(witnessCode()))
    invalid.limits = documentLimits({ timeoutMs: 0, maxHeapMb: 1.5, maxOutputBytes: 0 })
    await expect(runDocumentJob(invalid)).rejects.toThrow('Invalid document reader limits')
    expect(Worker).not.toHaveBeenCalled()

    const valid = (await runDocumentJob(job(await valuesWorkbook(witnessCode())))) as Extract<
      XlsxOutcome,
      { ok: true }
    >
    expect(valid.ok).toBe(true)
    expect(Worker).toHaveBeenCalledTimes(1)
  })

  it('resolves source_bytes before worker creation and admits the same bytes below the cap', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    const oversized = job(bytes, { limits: documentLimits({ maxSourceBytes: bytes.length - 1 }) })
    expect(await runDocumentJob(oversized)).toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'source_bytes',
    })
    expect(Worker).not.toHaveBeenCalled()
    expect(await runDocumentJob(job(bytes))).toMatchObject({ ok: true })
  })

  it('terminates a live worker on timeout and resolves limit time', async () => {
    const pending = runDocumentJob(
      job(await heavyWorkbook, { limits: documentLimits({ timeoutMs: 600, maxHeapMb: 256 }) })
    )
    const worker = await observeLiveWorker(pending, 550)
    const exited = exitOf(worker)
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'time',
    })
    await exited
    // Node resets the id when the thread is gone: the post-call witness is
    // the opposite of the pre-cancellation online/threadId witness.
    expect(worker.threadId).toBe(-1)
  })

  it('settles as a defect when terminate() rejects without an exit event', async () => {
    const pending = runDocumentJob(
      job(await heavyWorkbook, { limits: documentLimits({ timeoutMs: 600, maxHeapMb: 256 }) })
    )
    const worker = await observeLiveWorker(pending, 550)
    const realTerminate = worker.terminate.bind(worker)
    const terminate = vi
      .spyOn(worker, 'terminate')
      .mockRejectedValueOnce(new Error('terminate failed'))
    try {
      await expect(pending).rejects.toThrow('Document reader worker failed')
      // Witness: the timeout path ran and asked the worker to stop.
      expect(terminate).toHaveBeenCalledTimes(1)
    } finally {
      const exited = exitOf(worker)
      await realTerminate()
      await exited
    }
  })

  it('terminates a live worker on abort and rejects with the signal reason', async () => {
    const controller = new AbortController()
    const reason = new Error('document read cancelled')
    const pending = runDocumentJob(
      job(await heavyWorkbook, {
        limits: documentLimits({ timeoutMs: 10_000, maxHeapMb: 256 }),
      }),
      controller.signal
    )
    const worker = await observeLiveWorker(pending, 1_000)
    const exited = exitOf(worker)
    expect(controller.signal.aborted).toBe(false)
    controller.abort(reason)
    await expect(pending).rejects.toThrow('document read cancelled')
    await exited
  })

  it('resolves a heap overrun as a typed document limit', async () => {
    const pending = runDocumentJob(
      job(await heavyWorkbook, { limits: documentLimits({ timeoutMs: 15_000, maxHeapMb: 24 }) })
    )
    const worker = await observeLiveWorker(pending, 10_000)
    const exited = exitOf(worker)
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'heap',
    })
    await exited
  }, 20_000)

  it('resolves an oversized posted outcome as output_bytes with a normal-size control', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    const oversized = job(bytes, {
      limits: documentLimits({ maxOutputBytes: 1, timeoutMs: 5_000 }),
    })
    const pending = runDocumentJob(oversized)
    const worker = await observeLiveWorker(pending, 1_000)
    const exited = exitOf(worker)
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'output_bytes',
    })
    await exited
    expect(await runDocumentJob(job(bytes))).toMatchObject({ ok: true })
  })

  it('reports a crashing worker as a defect and never as document_parse_failed', async () => {
    const pending = runDocumentJob(
      job(Buffer.alloc(0), { kind: 'unknown' } as unknown as Partial<DocumentJob>)
    )
    const worker = await observeLiveWorker(pending, 1_000)
    const exited = exitOf(worker)
    await expect(pending).rejects.toThrow('Document reader worker failed')
    await exited
  })

  it('rejects a malformed posted message as a defect while a real message succeeds', async () => {
    const malformed = new EventEmitter() as EventEmitter &
      Partial<Worker> & { terminate: () => Promise<number> }
    malformed.terminate = vi.fn(async () => {
      process.nextTick(() => malformed.emit('exit', 1))
      return 1
    })
    vi.mocked(Worker).mockImplementationOnce(function fakeWorker() {
      return malformed as Worker
    })
    const pending = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    await vi.waitFor(() => {
      expect(Worker).toHaveBeenCalledTimes(1)
      expect(malformed.emit).toBeTypeOf('function')
    })
    malformed.emit('message', { unexpected: true })
    await expect(pending).rejects.toThrow('Document reader worker failed')
    expect(malformed.terminate).toHaveBeenCalledTimes(1)

    const valid = (await runDocumentJob(job(await valuesWorkbook(witnessCode())))) as Extract<
      XlsxOutcome,
      { ok: true }
    >
    expect(valid.ok).toBe(true)
  })

  it.each([
    ['an unknown failure reason', { ok: false, reason: 'disk_full' }],
    ['an unknown limit name', { ok: false, reason: 'document_limits_exceeded', limit: 'rows' }],
    ['a limits failure without its limit', { ok: false, reason: 'document_limits_exceeded' }],
    ['a limit on a non-limit failure', { ok: false, reason: 'invalid_range', limit: 'time' }],
    ['a success without sheets', { ok: true, sheetNames: ['Sheet1'] }],
    [
      'a success with an object cell',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [{ name: 'Sheet1', startRow: 1, truncated: false, rows: [[{ formula: 'A1' }]] }],
      },
    ],
    [
      'a continuation without its stop reason',
      { ok: true, sheetNames: ['Sheet1'], sheets: [], next: { sheetIndex: 0, row: 8 } },
    ],
    [
      'a stop reason without a continuation',
      { ok: true, sheetNames: ['Sheet1'], sheets: [], stoppedBy: 'max_rows' },
    ],
    [
      'a PDF text success for an XLSX job',
      { ok: true, pageCount: 1, pages: [{ page: 1, text: 'x', from: 0, to: 1, lowText: false }] },
    ],
  ])('rejects a posted outcome with %s as a defect', async (_name, message) => {
    const fake = new EventEmitter() as EventEmitter &
      Partial<Worker> & { terminate: () => Promise<number> }
    fake.terminate = vi.fn(async () => {
      process.nextTick(() => fake.emit('exit', 1))
      return 1
    })
    vi.mocked(Worker).mockImplementationOnce(function fakeWorker() {
      return fake as Worker
    })
    const pending = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    await vi.waitFor(() => expect(Worker).toHaveBeenCalledTimes(1))
    // Witness: the runner subscribed to the worker's message before it posted.
    expect(fake.listenerCount('message')).toBe(1)
    fake.emit('message', message)
    await expect(pending).rejects.toThrow('Document reader worker failed')
    expect(fake.terminate).toHaveBeenCalledTimes(1)
  })

  it('propagates a typed success from a real PDF job', async () => {
    const outcome = (await runDocumentJob(
      job(await textPdf([witnessCode()]), {
        kind: 'pdf_text',
        pages: null,
        start: { page: 1, charOffset: 0 },
      })
    )) as DocumentJobOutcome<DocumentJob>
    expect(outcome).toMatchObject({ ok: true, pageCount: 1 })
  })
})
