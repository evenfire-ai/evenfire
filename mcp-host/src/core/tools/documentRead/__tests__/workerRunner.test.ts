import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../../../../logger'
import { childVirtualReserveBytes } from '../documentMemory'
import * as oomScore from '../oomScore'
import { oomVictimMarker } from '../oomScore'
import * as residentMemory from '../residentMemory'
import { residentMemorySampler } from '../residentMemory'
import type { DocumentJob, DocumentJobOutcome, XlsxOutcome } from '../types'
import {
  dataLimitKiB,
  rlimitDataEnforced,
  runDocumentJob,
  workerSpawnCommand,
} from '../workerRunner'
import {
  documentLimits,
  emptyWorkbook,
  longRunningWorkbook,
  textPdf,
  valuesWorkbook,
  witnessCode,
} from './fixtures'
import { heapPressureWorkbook, inflatedWorkbook } from './memoryFixtures'

const MIB = 1_048_576
const temporaryRoots: string[] = []

// The RLIMIT_DATA premise reads a fixed absolute sysfs path. Delegate to the
// real filesystem unless a case overrides the next read.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const childObservation = vi.hoisted(() => ({
  observe: undefined as ((child: ChildProcess) => void) | undefined,
}))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args)
      childObservation.observe?.(child)
      childObservation.observe = undefined
      return child
    }),
  }
})

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

function lastChild(): ChildProcess {
  const result = vi.mocked(spawn).mock.results.at(-1)
  if (!result || result.type !== 'return') throw new Error('The runner did not create a child')
  return result.value as ChildProcess
}

async function liveChild(): Promise<ChildProcess> {
  const child = await new Promise<ChildProcess>(resolve => {
    if (vi.mocked(spawn).mock.results.length > 0) resolve(lastChild())
    else childObservation.observe = resolve
  })
  expect(child.pid).toBeGreaterThan(0)
  expect(child.exitCode).toBeNull()
  expect(child.signalCode).toBeNull()
  return child
}

// Valid content, so each malformed case below fails only on the property it names.
const VALID_SHEET = { name: 'Sheet1', startRow: 1, truncated: false, lastRow: 1, rows: [['value']] }
const PAGE = { page: 1, text: 'x', from: 0, to: 1, lowText: false }

async function control(): Promise<void> {
  expect((await runDocumentJob(job(await valuesWorkbook(witnessCode())))).ok).toBe(true)
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  )
  childObservation.observe = undefined
  vi.restoreAllMocks()
  const children = vi
    .mocked(spawn)
    .mock.results.filter(result => result.type === 'return')
    .map(result => result.value as ChildProcess)
    .filter(child => child.exitCode === null && child.signalCode === null)
  await Promise.all(
    children.map(async child => {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    })
  )
  vi.clearAllMocks()
})

describe('document reader child runner', () => {
  it.each([
    { timeoutMs: 0 },
    { maxHeapMb: 1.5 },
    { maxOutputBytes: 0 },
    { maxResidentMb: 0 },
    { maxUncompressedBytes: Number.NaN },
    { maxSourceBytes: -1 },
    { maxRenderPixelsPerCall: 0 },
    { maxEmbeddedImagePixels: 0 },
  ])('rejects invalid limits %j before spawning and accepts valid limits', async limits => {
    const invalid = job(await valuesWorkbook(witnessCode()), { limits: documentLimits(limits) })
    await expect(runDocumentJob(invalid)).rejects.toThrow('Invalid document reader limits')
    expect(spawn).not.toHaveBeenCalled()
    await control()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('starts a real child with an empty environment and explicit heap bound', async () => {
    await control()
    expect(spawn).toHaveBeenCalledTimes(1)
    const args = vi.mocked(spawn).mock.calls[0]!
    if (process.platform === 'linux') {
      // Linux spawns through the RLIMIT_DATA wrapper: the shell receives the
      // per-architecture limit in $0 and execs the Node binary with the heap
      // flag and entry point.
      expect(args[0]).toBe('/bin/sh')
      expect(args[1]?.slice(0, 3)).toEqual([
        '-c',
        'ulimit -d "$0" && exec "$@"',
        String(dataLimitKiB(768 * MIB, process.arch)),
      ])
      expect(args[1]?.[3]).toBe(process.execPath)
      expect(args[1]?.[4]).toBe('--max-old-space-size=256')
    } else {
      expect(args[0]).toBe(process.execPath)
      expect(args[1]).toContain('--max-old-space-size=256')
    }
    expect(args[2]?.env).toEqual({})
    expect(args[2]?.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc'])
  })

  it('resolves source_bytes before spawning and admits the same bytes below the cap', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    expect(
      await runDocumentJob(
        job(bytes, {
          limits: documentLimits({ maxSourceBytes: bytes.length - 1 }),
        })
      )
    ).toEqual({ ok: false, reason: 'document_limits_exceeded', limit: 'source_bytes' })
    expect(spawn).not.toHaveBeenCalled()
    expect((await runDocumentJob(job(bytes))).ok).toBe(true)
  })

  it('kills a live child on timeout, waits for exit, and resolves time', async () => {
    const pending = runDocumentJob(
      job(await valuesWorkbook(witnessCode()), {
        limits: documentLimits({ timeoutMs: 100 }),
      })
    )
    const child = await liveChild()
    const exited = once(child, 'exit')
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'time',
    })
    await exited
    expect(child.signalCode).toBe('SIGKILL')
    await control()
  })

  it('settles as a defect when kill fails without an exit event', async () => {
    const pending = runDocumentJob(
      job(await valuesWorkbook(witnessCode()), {
        limits: documentLimits({ timeoutMs: 100 }),
      })
    )
    const child = await liveChild()
    const realKill = child.kill.bind(child)
    const kill = vi.spyOn(child, 'kill').mockReturnValueOnce(false)
    try {
      await expect(pending).rejects.toThrow('Document reader worker failed')
      expect(kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      const exited = once(child, 'exit')
      realKill('SIGKILL')
      await exited
    }
    await control()
  })

  it('kills a live child on abort and rejects with the exact signal reason', async () => {
    const controller = new AbortController()
    const reason = new Error('document read cancelled')
    const pending = runDocumentJob(job(await valuesWorkbook(witnessCode())), controller.signal)
    const child = await liveChild()
    const exited = once(child, 'exit')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await exited
    expect(child.signalCode).toBe('SIGKILL')
    await control()
  })

  it('rejects a pre-aborted job without spawning and accepts an active signal', async () => {
    const controller = new AbortController()
    const reason = new Error('document read cancelled before start')
    controller.abort(reason)
    await expect(
      runDocumentJob(job(await valuesWorkbook(witnessCode())), controller.signal)
    ).rejects.toBe(reason)
    expect(spawn).not.toHaveBeenCalled()
    await control()
  })

  it('maps V8 heap exhaustion to heap while the same bytes parse under a normal heap', async () => {
    // 128k unique 256-character shared strings stay live in the child heap for
    // the whole sheet walk: the small heap must exhaust V8 while parsing, and
    // the very same bytes must still produce the witness values when the heap
    // is normal. This does not depend on the workbook's fixed overhead.
    const fixture = await heapPressureWorkbook(131_072, 256, witnessCode())
    const limits = documentLimits({
      maxSourceBytes: fixture.bytes.byteLength,
      maxUncompressedBytes: 96 * MIB,
      timeoutMs: 30_000,
    })
    expect(
      await runDocumentJob(
        job(fixture.bytes, {
          limits: { ...limits, maxHeapMb: 24 },
        })
      )
    ).toEqual({ ok: false, reason: 'document_limits_exceeded', limit: 'heap' })
    const control = (await runDocumentJob(
      job(fixture.bytes, { limits: { ...limits, maxHeapMb: 256 } })
    )) as XlsxOutcome
    expect(control.ok).toBe(true)
    if (!control.ok) throw new Error('Heap-pressure control failed')
    expect(control.sheets[0]!.rows).toEqual([[fixture.first, fixture.last], [fixture.second]])
    expect(control.sheets[0]!.lastRow).toBe(2)
  }, 60_000)

  it('bounds output with a normal-size control', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    expect(
      await runDocumentJob(job(bytes, { limits: documentLimits({ maxOutputBytes: 1 }) }))
    ).toEqual({ ok: false, reason: 'document_limits_exceeded', limit: 'output_bytes' })
    expect((await runDocumentJob(job(bytes))).ok).toBe(true)
  })

  it('accepts document_empty from a real child and reads a non-empty control', async () => {
    expect(await runDocumentJob(job(await emptyWorkbook()))).toEqual({
      ok: false,
      reason: 'document_empty',
    })
    await control()
  })

  it('reports a crashing child as a fixed defect and parses a control', async () => {
    await expect(
      runDocumentJob(
        job(Buffer.alloc(0), {
          kind: 'unknown',
        } as unknown as Partial<DocumentJob>)
      )
    ).rejects.toThrow('Document reader worker failed')
    await control()
  })

  it('fails loud on an unsupported sampler platform and samples the real platform', async () => {
    expect(() => residentMemorySampler('win32')).toThrow(
      'Unsupported document reader resident memory platform'
    )
    const pending = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    const child = await liveChild()
    const sample = await residentMemorySampler(process.platform)(child.pid!)
    expect(sample.rssBytes).toBeGreaterThan(0)
    if (process.platform === 'linux') {
      // VmData comes from the same status read as RSS.
      expect(sample.vmDataBytes).toBeGreaterThan(0)
    } else {
      expect(sample.vmDataBytes).toBeNull()
    }
    expect((await pending).ok).toBe(true)
  })

  it('kills a real child when RSS sampling fails and accepts a working sampler', async () => {
    const sampler = vi
      .spyOn(residentMemory, 'residentMemorySampler')
      .mockImplementationOnce(() => async () => {
        throw new Error('RSS unavailable')
      })
    const pending = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    const child = await liveChild()
    await expect(pending).rejects.toThrow('Document reader worker failed')
    expect(child.signalCode).toBe('SIGKILL')
    sampler.mockRestore()
    await control()
  })

  it('fails loud on an unsupported OOM platform and leaves macOS unmarked', async () => {
    expect(() => oomVictimMarker('win32')).toThrow('Unsupported document reader OOM platform')
    await expect(oomVictimMarker('darwin')(process.pid)).resolves.toBeUndefined()
    await control()
  })

  it.runIf(process.platform === 'linux')(
    'marks the live Linux reader child as the first OOM victim',
    async () => {
      await control()
      vi.mocked(spawn).mockClear()
      const controller = new AbortController()
      const reason = new Error('document read cancelled')
      const pending = runDocumentJob(job(await longRunningWorkbook()), controller.signal)
      const child = await liveChild()
      // Liveness: the pid read below is the live reader, not a recycled pid.
      expect(await readFile(`/proc/${child.pid}/cmdline`, 'utf8')).toMatch(/worker\.(ts|js)/)
      await vi.waitFor(async () =>
        expect((await readFile(`/proc/${child.pid}/oom_score_adj`, 'utf8')).trim()).toBe('1000')
      )
      controller.abort(reason)
      await expect(pending).rejects.toBe(reason)
    },
    20_000
  )

  it('kills a real child when the OOM mark fails and runs a marked control', async () => {
    const marker = vi.spyOn(oomScore, 'oomVictimMarker').mockImplementationOnce(() => async () => {
      throw new Error('oom_score_adj unavailable')
    })
    const pending = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    const child = await liveChild()
    await expect(pending).rejects.toThrow('Document reader worker failed')
    // Liveness: the job did spawn its child, and the failed mark stopped it.
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(child.signalCode).toBe('SIGKILL')
    marker.mockRestore()
    await control()
  })

  it('maps an external SIGKILL of a sent child to heap between real controls', async () => {
    await control()
    vi.mocked(spawn).mockClear()
    const mark = oomVictimMarker(process.platform)
    const marked: number[] = []
    vi.spyOn(oomScore, 'oomVictimMarker').mockReturnValueOnce(async pid => {
      await mark(pid)
      marked.push(pid)
    })
    const pending = runDocumentJob(job(await longRunningWorkbook()))
    const child = await liveChild()
    // The kernel OOM killer acts on a child that is already reading.
    await vi.waitFor(() => expect(marked).toEqual([child.pid]))
    process.kill(child.pid!, 'SIGKILL')
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'heap',
    })
    await control()
  }, 20_000)

  it('bounds an oversized outcome in the parent when the child check is bypassed', async () => {
    const outcome = {
      ok: true,
      sheetNames: ['Sheet1'],
      sheets: [{ ...VALID_SHEET, rows: [['x'.repeat(4_096)]] }],
    }
    const bounded = runDocumentJob(
      job(await valuesWorkbook(witnessCode()), {
        limits: documentLimits({ maxOutputBytes: 1_024 }),
      })
    )
    ;(await liveChild()).emit('message', outcome)
    await expect(bounded).resolves.toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'output_bytes',
    })
    // Liveness: the same outcome under the default limit is delivered.
    vi.mocked(spawn).mockClear()
    const delivered = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    ;(await liveChild()).emit('message', outcome)
    await expect(delivered).resolves.toEqual(outcome)
  })

  it.each([
    ['a malformed message', { unexpected: true }],
    ['an unknown failure reason', { ok: false, reason: 'disk_full' }],
    ['an unknown limit name', { ok: false, reason: 'document_limits_exceeded', limit: 'rows' }],
    ['a limits failure without its limit', { ok: false, reason: 'document_limits_exceeded' }],
    ['a limit on a non-limit failure', { ok: false, reason: 'invalid_range', limit: 'time' }],
    ['a success without sheets', { ok: true, sheetNames: ['Sheet1'] }],
    [
      'an object cell',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [{ name: 'Sheet1', startRow: 1, truncated: false, rows: [[{ formula: 'A1' }]] }],
      },
    ],
    [
      'a continuation without its stop reason',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [VALID_SHEET],
        next: { sheetIndex: 0, row: 8 },
      },
    ],
    [
      'a stop reason without a continuation',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [VALID_SHEET],
        stoppedBy: 'max_rows',
      },
    ],
    [
      'a zero startRow',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [{ name: 'Sheet1', startRow: 0, truncated: false, rows: [['value']] }],
      },
    ],
    [
      'a zero continuation row',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [VALID_SHEET],
        next: { sheetIndex: 0, row: 0 },
        stoppedBy: 'max_rows',
      },
    ],
    [
      'a continuation past sheetNames',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [VALID_SHEET],
        next: { sheetIndex: 1, row: 2 },
        stoppedBy: 'max_rows',
      },
    ],
    [
      'a skipped-row count that disagrees with first',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [
          {
            name: 'Sheet1',
            startRow: 1,
            truncated: false,
            lastRow: 2,
            rows: [[], ['value']],
            skippedRows: { count: 2, first: [1] },
          },
        ],
      },
    ],
    [
      'more skipped rows than the window holds',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [
          {
            name: 'Sheet1',
            startRow: 1,
            truncated: false,
            lastRow: 1,
            rows: [[]],
            skippedRows: { count: 2, first: [1, 2] },
          },
        ],
      },
    ],
    [
      'skipped rows that are not strictly increasing',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [
          {
            name: 'Sheet1',
            startRow: 1,
            truncated: false,
            lastRow: 2,
            rows: [[], []],
            skippedRows: { count: 2, first: [2, 1] },
          },
        ],
      },
    ],
    [
      'a skipped row below the window',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [
          {
            name: 'Sheet1',
            startRow: 2,
            truncated: false,
            lastRow: 3,
            rows: [[], ['value']],
            skippedRows: { count: 1, first: [1] },
          },
        ],
      },
    ],
    [
      'a skipped row at the end of the window',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [
          {
            name: 'Sheet1',
            startRow: 1,
            truncated: false,
            lastRow: 2,
            rows: [[], ['value']],
            skippedRows: { count: 1, first: [3] },
          },
        ],
      },
    ],
    [
      'a skipped row whose slot is not empty',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [
          {
            name: 'Sheet1',
            startRow: 1,
            truncated: false,
            lastRow: 2,
            rows: [['value'], []],
            skippedRows: { count: 1, first: [1] },
          },
        ],
      },
    ],
    [
      'a lastRow before the end of the returned window',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [
          {
            name: 'Sheet1',
            startRow: 1,
            truncated: false,
            lastRow: 1,
            rows: [[], ['value']],
            skippedRows: { count: 1, first: [1] },
          },
        ],
      },
    ],
    [
      'a PDF outcome for an XLSX job',
      {
        ok: true,
        pageCount: 1,
        pages: [{ page: 1, text: 'x', from: 0, to: 1, lowText: false }],
      },
    ],
  ])('rejects %s at the process boundary with a real-child control', async (_name, message) => {
    const pending = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    const child = await liveChild()
    const kill = vi.spyOn(child, 'kill')
    expect(child.listenerCount('message')).toBe(1)
    child.emit('message', message)
    await expect(pending).rejects.toThrow('Document reader worker failed')
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    await control()
  })

  it.each([
    [
      'an XLSX character stop',
      {
        ok: true,
        sheetNames: ['Sheet1'],
        sheets: [{ ...VALID_SHEET, truncated: true }],
        next: { sheetIndex: 0, row: 2 },
        stoppedBy: 'max_extracted_chars',
      },
    ],
    [
      'a first row over the character limit',
      { ok: false, reason: 'document_limits_exceeded', limit: 'row_width' },
    ],
  ])('accepts %s from the XLSX producer, and refuses an unknown stop', async (_name, message) => {
    const accepted = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    ;(await liveChild()).emit('message', message)
    await expect(accepted).resolves.toEqual(message)

    vi.mocked(spawn).mockClear()
    const refused = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    ;(await liveChild()).emit('message', {
      ...message,
      ...(message.ok ? { stoppedBy: 'max_bytes' } : { limit: 'row_bytes' }),
    })
    await expect(refused).rejects.toThrow('Document reader worker failed')
  })

  it('accepts an exhaustive skipped-row window with more than twenty rows', async () => {
    const skipped = 23
    const rows = [...Array.from({ length: skipped }, () => []), ['after-skip'], ['tail']]
    const message = {
      ok: true,
      sheetNames: ['Sheet1'],
      sheets: [
        {
          name: 'Sheet1',
          startRow: 1,
          truncated: false,
          lastRow: rows.length,
          rows,
          skippedRows: {
            count: skipped,
            first: Array.from({ length: skipped }, (_, index) => index + 1),
          },
        },
      ],
    }
    const accepted = runDocumentJob(job(await valuesWorkbook(witnessCode())))
    ;(await liveChild()).emit('message', message)
    await expect(accepted).resolves.toEqual(message)
    // Liveness: a real child still delivers its own valid outcome afterward.
    await control()
  })

  it.each([
    { ok: true, pageCount: 1, pages: [{ page: 0, text: 'x', from: 0, to: 1, lowText: false }] },
    { ok: true, pageCount: 0, pages: [] },
    {
      ok: true,
      pageCount: 1,
      pages: [PAGE],
      next: { page: 0, charOffset: 0 },
      stoppedBy: 'max_pages',
    },
    {
      ok: true,
      pageCount: 1,
      pages: [PAGE],
      next: { page: 2, charOffset: 0 },
      stoppedBy: 'max_pages',
    },
  ])('rejects a non-producer PDF text position %j with a real PDF control', async message => {
    const bytes = await textPdf([witnessCode()])
    const pdfJob = job(bytes, { kind: 'pdf_text', pages: null, start: { page: 1, charOffset: 0 } })
    const pending = runDocumentJob(pdfJob)
    const child = await liveChild()
    child.emit('message', message)
    await expect(pending).rejects.toThrow('Document reader worker failed')
    expect((await runDocumentJob(pdfJob)).ok).toBe(true)
  })

  it.each([
    ['XLSX with no sheets', 'xlsx', { ok: true, sheetNames: ['Sheet1'], sheets: [] }],
    [
      'XLSX whose sheets hold no rows',
      'xlsx',
      { ok: true, sheetNames: ['Sheet1'], sheets: [{ ...VALID_SHEET, rows: [] }] },
    ],
    ['PDF text with no pages', 'pdf_text', { ok: true, pageCount: 1, pages: [] }],
    ['PDF visual with no images', 'pdf_visual', { ok: true, pageCount: 1, images: [] }],
  ] as const)(
    'rejects an empty success (%s) as a defect with a real-child control',
    async (_name, kind, message) => {
      const pdf = await textPdf([witnessCode()])
      const jobs = {
        xlsx: job(await valuesWorkbook(witnessCode())),
        pdf_text: job(pdf, { kind: 'pdf_text', pages: null, start: { page: 1, charOffset: 0 } }),
        pdf_visual: job(pdf, {
          kind: 'pdf_visual',
          pages: null,
          maxDimension: 128,
          maxPixelsPerCall: 128 * 128,
          maxImageBytes: 1_048_576,
          maxTotalImageBytes: 1_048_576,
        }),
      }
      const pending = runDocumentJob(jobs[kind])
      const child = await liveChild()
      child.emit('message', message)
      await expect(pending).rejects.toThrow('Document reader worker failed')
      // Control: the same job's real child delivers non-empty content.
      expect((await runDocumentJob(jobs[kind])).ok).toBe(true)
    }
  )

  it('propagates a typed success from a real PDF child', async () => {
    const outcome = (await runDocumentJob(
      job(await textPdf([witnessCode()]), {
        kind: 'pdf_text',
        pages: null,
        start: { page: 1, charOffset: 0 },
      })
    )) as DocumentJobOutcome<DocumentJob>
    expect(outcome).toMatchObject({ ok: true, pageCount: 1 })
  })

  it('spawns through a data-limited shell only on Linux and reserves per architecture', () => {
    const residentBytes = 130 * MIB + 1
    const x64KiB = Math.ceil((residentBytes + (1_963 + 128) * MIB) / 1_024)
    const arm64KiB = Math.ceil((residentBytes + (1_282 + 128) * MIB) / 1_024)
    const linux = workerSpawnCommand('linux', residentBytes, 256, 'x64')
    const linuxArm64 = workerSpawnCommand('linux', residentBytes, 256, 'arm64')
    const darwin = workerSpawnCommand('darwin', residentBytes, 256, 'x64')
    expect(linux.file).toBe('/bin/sh')
    expect(linux.args.slice(0, 5)).toEqual([
      '-c',
      'ulimit -d "$0" && exec "$@"',
      String(x64KiB),
      process.execPath,
      '--max-old-space-size=256',
    ])
    expect(linuxArm64.args[2]).toBe(String(arm64KiB))
    // "$@" preserves the multiline source bootstrap as one argument.
    expect(linux.args.slice(5)).toEqual(darwin.args.slice(1))
    expect(darwin.file).toBe(process.execPath)
    expect(darwin.args[0]).toBe('--max-old-space-size=256')
    expect(darwin.args.slice(1)).not.toHaveLength(0)
  })

  it('fails loud instead of guessing a reserve for an uncalibrated architecture', () => {
    expect(childVirtualReserveBytes('x64')).toBe((1_963 + 128) * MIB)
    expect(childVirtualReserveBytes('arm64')).toBe((1_282 + 128) * MIB)
    expect(childVirtualReserveBytes('ia32')).toBeNull()
    expect(dataLimitKiB(1, 'x64')).toBe(Math.ceil(((1_963 + 128) * MIB + 1) / 1_024))
    expect(() => dataLimitKiB(1, 'riscv64')).toThrow(
      'Unsupported document reader virtual reserve architecture'
    )
    expect(() => workerSpawnCommand('linux', 1, 256, 's390x')).toThrow(
      'Unsupported document reader virtual reserve architecture'
    )
  })

  it('requires exactly N in ignore_rlimit_data and fails closed otherwise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-rlimit-'))
    temporaryRoots.push(root)
    const parameter = join(root, 'ignore_rlimit_data')
    const missing = join(root, 'missing')
    await writeFile(parameter, '  N\n')
    expect(await rlimitDataEnforced('linux', parameter)).toBe(true)
    // Liveness: the same file read as Y refuses, so N came from its content.
    await writeFile(parameter, 'Y\n')
    expect(await rlimitDataEnforced('linux', parameter)).toBe(false)
    await writeFile(parameter, 'N\nY\n')
    expect(await rlimitDataEnforced('linux', parameter)).toBe(false)
    expect(await rlimitDataEnforced('linux', missing)).toBe(false)
    expect(await rlimitDataEnforced('darwin', missing)).toBe(true)
  })

  it('reads the RLIMIT_DATA premise per job and refuses to spawn when ignored', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const premiseRead = vi.mocked(readFile)
    premiseRead.mockResolvedValueOnce('Y' as never).mockResolvedValueOnce('Y' as never)
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    try {
      expect(await runDocumentJob(job(bytes))).toEqual({
        ok: false,
        reason: 'host_memory_unavailable',
      })
      expect(await runDocumentJob(job(bytes))).toEqual({
        ok: false,
        reason: 'host_memory_unavailable',
      })
      // No cache: two jobs read the parameter twice.
      expect(premiseRead).toHaveBeenCalledTimes(2)
      expect(premiseRead).toHaveBeenCalledWith(
        '/sys/module/kernel/parameters/ignore_rlimit_data',
        'utf8'
      )
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
    await control()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('refuses to spawn on Linux when its architecture has no calibrated reserve', async () => {
    const bytes = await valuesWorkbook(witnessCode())
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
    vi.mocked(readFile).mockResolvedValueOnce('N' as never)
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    Object.defineProperty(process, 'arch', { ...arch, value: 'ia32' })
    try {
      expect(await runDocumentJob(job(bytes))).toEqual({
        ok: false,
        reason: 'host_memory_unavailable',
      })
      // The premise is enforced, but the uncalibrated reserve still refuses.
      expect(vi.mocked(readFile)).toHaveBeenCalledWith(
        '/sys/module/kernel/parameters/ignore_rlimit_data',
        'utf8'
      )
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', platform)
      Object.defineProperty(process, 'arch', arch)
    }
    await control()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('logs one bounded job line without document content or paths', async () => {
    const info = vi.spyOn(logger, 'info')
    await control()
    const line = info.mock.calls.find(
      ([, message]: [Record<string, unknown>, string]) => message === 'document reader job finished'
    )
    expect(line).toBeDefined()
    const [fields] = line!
    const allowed = new Set([
      'outcome',
      'limit',
      'exitSignal',
      'exitCode',
      'residentCapBytes',
      'dataLimitKiB',
      'maxSampledResidentBytes',
      'childVmDataBytes',
    ])
    expect(Object.keys(fields).every(key => allowed.has(key))).toBe(true)
    expect(JSON.stringify(fields)).not.toContain('/')
    expect(fields).toMatchObject({ outcome: 'ok', exitCode: 0, exitSignal: null })
    expect(typeof fields.residentCapBytes).toBe('number')
    expect(typeof fields.maxSampledResidentBytes).toBe('number')
    if (process.platform === 'linux') expect(typeof fields.dataLimitKiB).toBe('number')
    else expect(fields.dataLimitKiB).toBeNull()
  })

  it('logs the real failure outcome and limit of a typed child result', async () => {
    const info = vi.spyOn(logger, 'info')
    expect(
      await runDocumentJob(
        job(await inflatedWorkbook(8 * MIB), {
          limits: documentLimits({ maxUncompressedBytes: MIB }),
        })
      )
    ).toEqual({ ok: false, reason: 'document_limits_exceeded', limit: 'uncompressed_bytes' })
    const failureLine = info.mock.calls.find(
      ([, message]: [Record<string, unknown>, string]) => message === 'document reader job finished'
    )
    expect(failureLine).toBeDefined()
    expect(failureLine![0]).toMatchObject({
      outcome: 'failure',
      limit: 'uncompressed_bytes',
      exitCode: 0,
      exitSignal: null,
    })
    // Liveness: a successful job on the same logging path omits the limit.
    info.mockClear()
    await control()
    const okLine = info.mock.calls.find(
      ([, message]: [Record<string, unknown>, string]) => message === 'document reader job finished'
    )
    expect(okLine).toBeDefined()
    expect(okLine![0]).toMatchObject({ outcome: 'ok' })
    expect(okLine![0].limit).toBeUndefined()
  }, 20_000)

  it.runIf(process.platform === 'linux')(
    'logs the maximum child VmData sampled from a real job',
    async () => {
      const info = vi.spyOn(logger, 'info')
      expect((await runDocumentJob(job(await valuesWorkbook(witnessCode())))).ok).toBe(true)
      const line = info.mock.calls.find(
        ([, message]: [Record<string, unknown>, string]) =>
          message === 'document reader job finished'
      )
      expect(line).toBeDefined()
      // The old single sample was taken before exec and read a shell-sized
      // value; the maximum observed over the whole job must be real Node VmData.
      expect(line![0].childVmDataBytes).toBeGreaterThan(256 * MIB)
    },
    20_000
  )
})
