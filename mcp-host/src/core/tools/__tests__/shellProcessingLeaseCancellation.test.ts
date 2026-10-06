import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  GfsProcessingLease,
  GfsProcessingLeaseProvider,
} from '../../../internalTools/gfsProcessingLease'
import { executeWithTimeout } from '../../orchestration/toolExecutionTimeout'
import { ShellTool } from '../shell'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
// The delayed lease is the race under test; no process may start in this suite.
vi.mock('child_process', () => ({ spawn: mocks.spawn }))

beforeEach(() => vi.clearAllMocks())

const managedHosts: string[] = []

function managedWorkspace(): string {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-managed-cancellation-'))
  managedHosts.push(host)
  const workspace = path.join(host, 'users', 'caller')
  fs.mkdirSync(workspace, { recursive: true })
  return workspace
}

afterEach(() => {
  for (const host of managedHosts.splice(0)) fs.rmSync(host, { recursive: true, force: true })
})

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
  const tool = new ShellTool(managedWorkspace(), 5_000, [], () => ({}), undefined, provider)
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
  const tool = new ShellTool(managedWorkspace(), 5_000, [], () => ({}), undefined, provider)
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

it('joins the actual late shell lease through the outer cancellation boundary', async () => {
  const { provider, lease, finishAcquisition } = delayedLease()
  const controller = new AbortController()
  const reason = new Error('cancelled while acquiring the shell lease')
  const tool = new ShellTool(managedWorkspace(), 5_000, [], () => ({}), undefined, provider)
  let completed = false
  const execution = executeWithTimeout(
    tool,
    { command: 'printf done' },
    {
      onOutput: () => {},
    },
    5_000,
    controller.signal
  ).catch(error => {
    completed = true
    return error
  })
  controller.abort(reason)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(completed).toBe(false)
  expect(provider.releaseProcessingLease).not.toHaveBeenCalled()
  finishAcquisition(lease)

  expect(await execution).toBe(reason)
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(provider.releaseProcessingLease).toHaveBeenCalledExactlyOnceWith(lease)
})
