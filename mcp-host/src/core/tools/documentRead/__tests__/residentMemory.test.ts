import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { residentMemorySampler } from '../residentMemory'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn() }
})
afterEach(() => vi.clearAllMocks())

describe('Linux resident-memory sampler', () => {
  it.each([
    'Name:\treader\nState:\tR (running)\nVmSize:\t4096 kB\n',
    '',
    'VmRSS:\t-1 kB\n',
    'VmRSS:\t999999999999999999999 kB\n',
  ])('rejects unavailable or invalid RSS %j and reads valid kernel data', async status => {
    const sample = residentMemorySampler('linux')
    vi.mocked(readFile).mockResolvedValueOnce(status)
    await expect(sample(123)).rejects.toThrow('Document reader resident memory unavailable')
    vi.mocked(readFile).mockResolvedValueOnce('Name:\treader\nVmRSS:\t2048 kB\n')
    expect(await sample(123)).toEqual({ rssBytes: 2_097_152, vmDataBytes: null })
    expect(readFile).toHaveBeenCalledWith('/proc/123/status', 'utf8')
  })

  it('reads VmData from the same status read as RSS', async () => {
    const sample = residentMemorySampler('linux')
    vi.mocked(readFile).mockResolvedValueOnce(
      'Name:\treader\nState:\tR (running)\nVmRSS:\t2048 kB\nVmData:\t8388608 kB\n'
    )
    expect(await sample(123)).toEqual({ rssBytes: 2_097_152, vmDataBytes: 8_589_934_592 })
    // Liveness: one open satisfies both fields, so no second read per tick.
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('propagates a kernel read failure and reads a normal status afterward', async () => {
    const sample = residentMemorySampler('linux')
    const reason = new Error('kernel RSS access denied')
    vi.mocked(readFile).mockRejectedValueOnce(reason)
    await expect(sample(123)).rejects.toBe(reason)
    vi.mocked(readFile).mockResolvedValueOnce('VmRSS:\t1024 kB\n')
    expect(await sample(123)).toEqual({ rssBytes: 1_048_576, vmDataBytes: null })
  })

  it('recognizes a reaped resident set while sampling a live process normally', async () => {
    const sample = residentMemorySampler('linux')
    vi.mocked(readFile).mockResolvedValueOnce('State:\tZ (zombie)\n')
    expect(await sample(123)).toEqual({ rssBytes: 0, vmDataBytes: null })
    vi.mocked(readFile).mockResolvedValueOnce('State:\tR (running)\nVmRSS:\t1024 kB\n')
    expect(await sample(123)).toEqual({ rssBytes: 1_048_576, vmDataBytes: null })
  })

  it('recognizes an exiting process that has released its address space', async () => {
    const sample = residentMemorySampler('linux')
    // Observed on Linux between address-space release and the zombie state.
    vi.mocked(readFile).mockResolvedValueOnce('Name:\tnode\nState:\tR (running)\nThreads:\t1\n')
    expect(await sample(123)).toEqual({ rssBytes: 0, vmDataBytes: null })
    vi.mocked(readFile).mockResolvedValueOnce('Name:\tnode\nState:\tR (running)\nVmRSS:\t1024 kB\n')
    expect(await sample(123)).toEqual({ rssBytes: 1_048_576, vmDataBytes: null })
  })
})

describe('macOS resident-memory sampler', () => {
  it.runIf(process.platform === 'darwin')(
    'reports RSS without VmData because macOS has no procfs',
    async () => {
      const sample = await residentMemorySampler('darwin')(process.pid)
      expect(sample.rssBytes).toBeGreaterThan(0)
      expect(sample.vmDataBytes).toBeNull()
    }
  )

  it('fails loud on an unsupported platform', () => {
    expect(() => residentMemorySampler('win32')).toThrow(
      'Unsupported document reader resident memory platform'
    )
  })
})
