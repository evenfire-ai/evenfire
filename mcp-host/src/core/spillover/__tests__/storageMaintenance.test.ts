import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { SpilloverStorage } from '../storage'

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})
let actual: typeof import('fs/promises')
beforeAll(async () => {
  actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
})
const roots: string[] = []
afterEach(async () => {
  vi.mocked(fs.rm).mockImplementation(actual.rm)
  for (const root of roots.splice(0)) await actual.rm(root, { recursive: true, force: true })
})
async function setup() {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'spillover-maintenance-'))
  roots.push(workspacePath)
  const storage = new SpilloverStorage({
    workspacePath,
    thresholdBytes: 1,
    ttlMs: 1,
    gcIntervalMs: 0,
  })
  await storage.maybePersist({
    taskId: 'task',
    toolCallId: 'call',
    toolName: 'file_read',
    content: 'expired fixture',
    isError: false,
  })
  const file = path.join(workspacePath, 'spillover', 'task', 'call.json')
  await fs.utimes(file, new Date(0), new Date(0))
  return { storage, file }
}

describe('spillover maintenance drain', () => {
  it('blocks a report/drain until an already-started actual removal finishes', async () => {
    const f = await setup()
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    let finish!: () => void
    const pending = new Promise<void>(resolve => {
      finish = resolve
    })
    vi.mocked(fs.rm).mockImplementationOnce(async (file, options) => {
      entered()
      await pending
      await actual.rm(file, options)
    })
    const sweep = f.storage.sweep()
    await started
    f.storage.stopGc()
    let drained = false
    const drain = f.storage.drainGc().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(f.storage.sweep()).rejects.toThrow('SpilloverMaintenanceHeld')
    finish()
    await sweep
    await drain
    expect(drained).toBe(true)
  })
  it('does not claim quiescence after a real sweep operation failed', async () => {
    const f = await setup()
    vi.mocked(fs.rm).mockRejectedValueOnce(
      Object.assign(new Error('fixture access denied'), { code: 'EACCES' })
    )
    await expect(f.storage.sweep()).rejects.toThrow('fixture access denied')
    await expect(f.storage.drainGc()).rejects.toThrow('SpilloverMaintenanceSweepFailed')
  })
  it('keeps normal first-boot behavior and requires explicit activation after hold', async () => {
    const f = await setup()
    await f.storage.drainGc()
    await expect(f.storage.sweep()).rejects.toThrow('SpilloverMaintenanceHeld')
    f.storage.startGc()
    expect((await f.storage.sweep()).filesDeleted).toBe(1)
  })
})
