import { beforeEach, expect, it, vi } from 'vitest'
import * as os from 'node:os'
import type {
  GfsProcessingLease,
  GfsProcessingLeaseProvider,
} from '../../../internalTools/gfsProcessingLease'
import { ShellTool } from '../shell'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
// The delayed lease is the race under test; no process may start in this suite.
vi.mock('child_process', () => ({ spawn: mocks.spawn }))

beforeEach(() => vi.clearAllMocks())

function delayedLease() {
  let finishAcquisition!: (lease: GfsProcessingLease) => void
  const pending = new Promise<GfsProcessingLease>(resolve => {
    finishAcquisition = resolve
  })
  const provider: GfsProcessingLeaseProvider = {
    acquireProcessingLease: vi.fn(() => pending),
    releaseProcessingLease: vi.fn(async () => undefined),
  }
  const lease = {
    leaseId: 'cancelled-admission',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  return { provider, lease, finishAcquisition }
}

it('does not spawn and releases a lease acquired after cancellation', async () => {
  const { provider, lease, finishAcquisition } = delayedLease()
  const controller = new AbortController()
  const reason = new Error('cancelled during processing lease acquisition')
  const tool = new ShellTool(os.tmpdir(), 5_000, [], () => ({}), undefined, provider)
  const execution = tool.execute(
    { command: 'printf done' },
    { signal: controller.signal, onOutput: vi.fn() }
  )
  expect(provider.acquireProcessingLease).toHaveBeenCalledOnce()

  controller.abort(reason)
  finishAcquisition(lease)

  await expect(execution).rejects.toBe(reason)
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(provider.releaseProcessingLease).toHaveBeenCalledExactlyOnceWith(lease)
})

it('keeps cancellation before spawn when releasing the admitted lease fails', async () => {
  const { provider, lease, finishAcquisition } = delayedLease()
  vi.mocked(provider.releaseProcessingLease).mockRejectedValueOnce(new Error('ledger unavailable'))
  const controller = new AbortController()
  const tool = new ShellTool(os.tmpdir(), 5_000, [], () => ({}), undefined, provider)
  const execution = tool.execute(
    { command: 'printf done' },
    { signal: controller.signal, onOutput: vi.fn() }
  )

  controller.abort()
  finishAcquisition(lease)

  const result = await execution
  expect(result.is_error).toBe(true)
  expect(result.content).toContain('processing_lease_release_failed')
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(provider.releaseProcessingLease).toHaveBeenCalledExactlyOnceWith(lease)
})
