import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { childVirtualDataBytes, residentMemorySampler } from '../residentMemory'

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
    expect(await sample(123)).toBe(2_097_152)
    expect(readFile).toHaveBeenCalledWith('/proc/123/status', 'utf8')
  })

  it('propagates a kernel read failure and reads a normal status afterward', async () => {
    const sample = residentMemorySampler('linux')
    const reason = new Error('kernel RSS access denied')
    vi.mocked(readFile).mockRejectedValueOnce(reason)
    await expect(sample(123)).rejects.toBe(reason)
    vi.mocked(readFile).mockResolvedValueOnce('VmRSS:\t1024 kB\n')
    expect(await sample(123)).toBe(1_048_576)
  })

  it('recognizes a reaped resident set while sampling a live process normally', async () => {
    const sample = residentMemorySampler('linux')
    vi.mocked(readFile).mockResolvedValueOnce('State:\tZ (zombie)\n')
    expect(await sample(123)).toBe(0)
    vi.mocked(readFile).mockResolvedValueOnce('State:\tR (running)\nVmRSS:\t1024 kB\n')
    expect(await sample(123)).toBe(1_048_576)
  })

  it('recognizes an exiting process that has released its address space', async () => {
    const sample = residentMemorySampler('linux')
    // Observed on Linux between address-space release and the zombie state.
    vi.mocked(readFile).mockResolvedValueOnce('Name:\tnode\nState:\tR (running)\nThreads:\t1\n')
    expect(await sample(123)).toBe(0)
    vi.mocked(readFile).mockResolvedValueOnce('Name:\tnode\nState:\tR (running)\nVmRSS:\t1024 kB\n')
    expect(await sample(123)).toBe(1_048_576)
  })
})

describe('Linux child virtual data', () => {
  it('reads VmData and omits it for a reaped or exiting process', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      'Name:\tnode\nState:\tR (running)\nVmData:\t2048 kB\n'
    )
    expect(await childVirtualDataBytes(123, 'linux')).toBe(2_097_152)
    expect(readFile).toHaveBeenLastCalledWith('/proc/123/status', 'utf8')
    vi.mocked(readFile).mockResolvedValueOnce('State:\tZ (zombie)\n')
    expect(await childVirtualDataBytes(123, 'linux')).toBeNull()
    vi.mocked(readFile).mockResolvedValueOnce('Name:\tnode\nState:\tR (running)\nThreads:\t1\n')
    expect(await childVirtualDataBytes(123, 'linux')).toBeNull()
    vi.mocked(readFile).mockResolvedValueOnce('Name:\tnode\nState:\tR (running)\n')
    expect(await childVirtualDataBytes(123, 'linux')).toBeNull()
  })

  it('leaves macOS without procfs and rejects an unsupported platform', async () => {
    expect(await childVirtualDataBytes(123, 'darwin')).toBeNull()
    expect(() => childVirtualDataBytes(123, 'win32')).toThrow(
      'Unsupported document reader resident memory platform'
    )
  })

  it('propagates a kernel read failure and reads a live process afterward', async () => {
    const reason = new Error('kernel VmData access denied')
    vi.mocked(readFile).mockRejectedValueOnce(reason)
    await expect(childVirtualDataBytes(123, 'linux')).rejects.toBe(reason)
    vi.mocked(readFile).mockResolvedValueOnce('VmData:\t1024 kB\n')
    expect(await childVirtualDataBytes(123, 'linux')).toBe(1_048_576)
  })
})
