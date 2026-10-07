import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type GfsRuntime, bootstrapGfsRuntime } from '../gfsRuntime'
import { GfsDownloadStore } from '../internalTools/gfsDownloadStore'

/**
 * The live writer publishes every ledger by writing a temporary file and
 * renaming it over `ledger-v1.json`. A standby that reads the ledger during
 * writer contention can open the old inode and then `lstat` the name after the
 * rename. This hook performs that real rename at exactly that point, once.
 */
const race = vi.hoisted(() => ({
  armed: false,
  fired: 0,
  publish: undefined as undefined | ((ledgerPath: string) => Promise<void>),
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const lstat = (async (target: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
    if (race.armed && String(target).endsWith('/.gfs-download-store/ledger-v1.json')) {
      race.armed = false
      race.fired += 1
      await race.publish?.(String(target))
    }
    return (actual.lstat as (...args: unknown[]) => unknown)(target, ...rest)
  }) as typeof actual.lstat
  return { ...actual, lstat, default: { ...actual, lstat } }
})

/** Same file operations as the live writer's persist(): new inode, then rename. */
async function publishLedgerCopy(ledgerPath: string): Promise<void> {
  const raw = await fs.readFile(ledgerPath, 'utf8')
  const temporary = `${ledgerPath}.tmp-${randomUUID()}`
  await fs.writeFile(temporary, raw, { flag: 'wx', mode: 0o600 })
  await fs.rename(temporary, ledgerPath)
}

const roots: string[] = []
const stores: GfsDownloadStore[] = []
const runtimes: GfsRuntime[] = []

async function root() {
  const value = await fs.mkdtemp(join(tmpdir(), 'gfs-ledger-race-'))
  roots.push(value)
  return value
}

async function ledgerInode(value: string): Promise<bigint> {
  const real = await fs.realpath(value)
  return (await fs.stat(join(real, '.gfs-download-store', 'ledger-v1.json'), { bigint: true })).ino
}

afterEach(async () => {
  race.armed = false
  race.fired = 0
  race.publish = undefined
  for (const runtime of runtimes.splice(0)) await runtime.stop()
  for (const store of stores.splice(0)) await store.close()
  vi.restoreAllMocks()
  for (const value of roots.splice(0)) await fs.rm(value, { recursive: true, force: true })
})

describe('GFS ledger publication during writer contention', () => {
  it('reports a ledger renamed by the live writer as transient contention, not corruption', async () => {
    const value = await root()
    const first = new GfsDownloadStore(value)
    stores.push(first)
    await first.initialize()
    const before = await ledgerInode(value)
    race.publish = publishLedgerCopy
    race.armed = true

    const second = new GfsDownloadStore(value)
    await expect(second.initialize()).rejects.toMatchObject({
      code: 'writer_locked',
      transientWriterContention: true,
    })

    // Witness: the rename really happened between the standby's open and lstat.
    expect(race.fired).toBe(1)
    expect(await ledgerInode(value)).not.toBe(before)
  })

  it('keeps retrying through a ledger publication and starts cleanup after the old writer releases', async () => {
    const value = await root()
    const first = new GfsDownloadStore(value)
    stores.push(first)
    await first.initialize()
    let resolveCleanup!: () => void
    const cleanupStarted = new Promise<void>(resolve => {
      resolveCleanup = resolve
    })
    const cleanup = vi
      .spyOn(GfsDownloadStore.prototype, 'cleanupExpired')
      .mockImplementation(async () => {
        resolveCleanup()
      })
    race.publish = publishLedgerCopy
    race.armed = true

    const runtime = await bootstrapGfsRuntime(value, { retryDelayMs: 25, maxRetryAttempts: 40 })
    runtimes.push(runtime)
    expect(race.fired).toBe(1)
    expect(runtime.store.isAvailable()).toBe(false)

    await first.close()
    await cleanupStarted
    expect(runtime.store.isAvailable()).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
