import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import * as documentMemory from '../documentMemory'
import * as residentMemory from '../residentMemory'
import type { XlsxJob } from '../types'
import { runDocumentJob } from '../workerRunner'
import { documentLimits } from './fixtures'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const MIB = 1_048_576
const job: XlsxJob = {
  kind: 'xlsx',
  bytes: new Uint8Array(),
  sheet: null,
  start: null,
  limits: documentLimits(),
}

function childFixture(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    send: vi.fn(() => true),
    kill: vi.fn((signal: NodeJS.Signals) => {
      child.signalCode = signal
      queueMicrotask(() => child.emit('exit', null, signal))
      return true
    }),
  })
  return child as unknown as ChildProcess
}

function finish(child: ChildProcess) {
  child.emit('message', {
    ok: true,
    sheetNames: ['Values'],
    sheets: [{ name: 'Values', startRow: 1, rows: [[42]], truncated: false }],
  })
  Object.assign(child, { exitCode: 0 })
  child.emit('exit', 0, null)
}

function samplers(sample: () => Promise<documentMemory.DocumentCgroupMemory | null>) {
  vi.spyOn(documentMemory, 'documentCgroupSampler').mockReturnValue(sample)
  const rss = vi.fn(async () => MIB)
  vi.spyOn(residentMemory, 'residentMemorySampler').mockReturnValue(rss)
  return rss
}

afterEach(async () => {
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
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('document reader Host memory admission and queue', () => {
  it('keeps the reader slot after a failed kill until the child exit is observed', async () => {
    samplers(vi.fn(async () => null))
    const firstChild = childFixture()
    const secondChild = childFixture()
    vi.mocked(firstChild.kill).mockReturnValueOnce(false)
    vi.mocked(spawn).mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    const first = runDocumentJob({ ...job, limits: documentLimits({ timeoutMs: 100 }) })
    const failure = expect(first).rejects.toThrow('Document reader worker failed')
    await vi.waitFor(() => expect(firstChild.send).toHaveBeenCalledTimes(1))
    await failure
    const second = runDocumentJob(job)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(secondChild.send).toHaveBeenCalledTimes(0)
    firstChild.emit('exit', null, 'SIGKILL')
    Object.assign(firstChild, { signalCode: 'SIGKILL' })
    await vi.waitFor(() => expect(secondChild.send).toHaveBeenCalledTimes(1))
    finish(secondChild)
    expect((await second).ok).toBe(true)
  })

  it('reads headroom and refuses the floor without spawning, then admits a live reader', async () => {
    let currentBytes = 321 * MIB
    const sample = vi.fn(async () => ({ maxBytes: 512 * MIB, currentBytes }))
    samplers(sample)
    const child = childFixture()
    vi.mocked(spawn).mockReturnValueOnce(child)
    expect(await runDocumentJob(job)).toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'heap',
    })
    expect(sample).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(0)
    currentBytes = 256 * MIB
    const admitted = runDocumentJob(job)
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--max-old-space-size=128')
    finish(child)
    expect((await admitted).ok).toBe(true)
  })

  it('rejects unreadable Linux headroom as a defect and admits a measured control', async () => {
    const sample = vi
      .fn<() => Promise<documentMemory.DocumentCgroupMemory | null>>()
      .mockRejectedValueOnce(new Error('unreadable cgroup'))
      .mockResolvedValue({ maxBytes: 512 * MIB, currentBytes: 128 * MIB })
    samplers(sample)
    await expect(runDocumentJob(job)).rejects.toThrow('Document reader worker failed')
    expect(sample).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(0)
    const child = childFixture()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const control = runDocumentJob(job)
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(1))
    finish(child)
    expect((await control).ok).toBe(true)
  })

  it('kills for concurrent Host growth even while the child RSS is below its cap', async () => {
    let currentBytes = 128 * MIB
    const sample = vi.fn(async () => ({ maxBytes: 512 * MIB, currentBytes }))
    const rss = samplers(sample)
    const child = childFixture()
    vi.mocked(spawn).mockReturnValueOnce(child)
    const pending = runDocumentJob(job)
    await vi.waitFor(() => expect(rss).toHaveBeenCalled())
    expect(child.send).toHaveBeenCalledTimes(1)
    expect(child.signalCode).toBeNull()
    currentBytes = 448 * MIB
    expect(await pending).toEqual({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'heap',
    })
    expect(sample.mock.calls.length).toBeGreaterThan(2)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(await rss()).toBe(MIB)
  })

  it('starts the second job only after the first settles and rereads its headroom', async () => {
    const sample = vi.fn(async () => ({ maxBytes: 512 * MIB, currentBytes: 128 * MIB }))
    samplers(sample)
    const firstChild = childFixture()
    const secondChild = childFixture()
    let firstSettled = false
    const secondStartedAfterSettlement: boolean[] = []
    vi.mocked(spawn)
      .mockReturnValueOnce(firstChild)
      .mockImplementationOnce(() => {
        secondStartedAfterSettlement.push(firstSettled)
        return secondChild
      })
    const first = runDocumentJob(job).then(outcome => {
      firstSettled = true
      return outcome
    })
    await vi.waitFor(() => expect(firstChild.send).toHaveBeenCalledTimes(1))
    const second = runDocumentJob(job)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(secondChild.send).toHaveBeenCalledTimes(0)
    const readsBeforeRelease = sample.mock.calls.length
    finish(firstChild)
    expect((await first).ok).toBe(true)
    await vi.waitFor(() => expect(secondChild.send).toHaveBeenCalledTimes(1))
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(secondStartedAfterSettlement).toEqual([true])
    expect(sample.mock.calls.length).toBeGreaterThan(readsBeforeRelease)
    finish(secondChild)
    expect((await second).ok).toBe(true)
  })

  it('rejects an abort while queued with its reason, never spawns it, and runs the next job', async () => {
    const sample = vi.fn(async () => null)
    samplers(sample)
    const firstChild = childFixture()
    const nextChild = childFixture()
    vi.mocked(spawn).mockReturnValueOnce(firstChild).mockReturnValueOnce(nextChild)
    const first = runDocumentJob(job)
    await vi.waitFor(() => expect(firstChild.send).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const reason = new Error('queued document cancelled')
    const queued = runDocumentJob(job, controller.signal)
    const rejection = expect(queued).rejects.toBe(reason)
    controller.abort(reason)
    await rejection
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(firstChild.send).toHaveBeenCalledTimes(1)
    finish(firstChild)
    expect((await first).ok).toBe(true)
    const next = runDocumentJob(job)
    await vi.waitFor(() => expect(nextChild.send).toHaveBeenCalledTimes(1))
    finish(nextChild)
    expect((await next).ok).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
  })
})
