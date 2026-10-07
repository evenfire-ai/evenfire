import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { register } from 'prom-client'
import { ShellTool } from '../core/tools/shell'
import { logger } from '../logger'
import type { GfsImageSource } from '../visualInput/policy'
import { GfsDownloadStore } from './gfsDownloadStore'

const source: GfsImageSource = {
  kind: 'gfs',
  drive: 'main',
  resourceId: 'a'.repeat(32),
  gfsUri: `gfs://main/${'a'.repeat(32)}`,
  name: 'input.csv',
  version: 7,
}
const storeModule = path.join(__dirname, 'gfsDownloadStore.ts')
const childProgram = `
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const content = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  module._compile(content, filename);
};
const { GfsDownloadStore } = require(process.argv[1]);
const path = require('node:path');
const { createHash } = require('node:crypto');
(async () => {
  const root = process.argv[2];
  const mode = process.argv[3];
  const store = new GfsDownloadStore(root);
  await store.initialize();
  if (mode === 'pin' || mode === 'transfer') {
    const callerRoot = path.join(root, 'users', 'caller-a');
    fs.mkdirSync(callerRoot, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from('fixture');
    const transfer = await store.createTransfer({ callerIdentity: 'caller-a', callerWorkspacePath: callerRoot,
      source: ${JSON.stringify(source)}, sizeBytes: bytes.length, expiresAt: new Date(Date.now() + 60000).toISOString(),
      retentionOwnerId: mode === 'pin' ? '11111111-1111-4111-8111-111111111111' : undefined });
    if (mode === 'transfer') {
      // The Host dies here, mid-transfer: the record stays 'transferring'.
      process.send({ transferId: transfer.id });
      setInterval(() => {}, 1000);
      return;
    }
    fs.writeFileSync(path.join(callerRoot, transfer.partialPath), bytes);
    const receipt = await store.publish(transfer.id, 'caller-a', createHash('sha256').update(bytes).digest('hex'));
    await store.reusableReceipt('caller-a', ${JSON.stringify(source)}, 7, { retentionOwnerId: '22222222-2222-4222-8222-222222222222' });
    process.send({ receipt });
  } else process.send({ ready: true });
  setInterval(() => {}, 1000);
})().catch(error => { process.send({ error: error.code || String(error), transientWriterContention: error.transientWriterContention === true }); process.exit(1); });
`

let root: string
let stores: GfsDownloadStore[]
let children: ChildProcess[]
let executors: number[]
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'gfs-store-recovery-'))
  stores = []
  children = []
  executors = []
})
afterEach(async () => {
  for (const pid of executors) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* fixture exited */
    }
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) await kill(child)
  }
  for (const store of stores) await store.close(1).catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true })
})
function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  return new Promise(resolve => {
    child.once('exit', () => resolve())
    child.kill(signal)
  })
}
async function childStore(mode = 'hold'): Promise<{ child: ChildProcess; message: any }> {
  const child = spawn(process.execPath, ['-e', childProgram, storeModule, root, mode], {
    cwd: path.resolve(__dirname, '../..'),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.push(child)
  const message = await new Promise<any>((resolve, reject) => {
    let errors = ''
    child.stderr?.on('data', chunk => {
      errors += String(chunk)
    })
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(errors || `child exit ${code}`))
    })
  })
  return { child, message }
}
function freshStore(): GfsDownloadStore {
  const store = new GfsDownloadStore(root)
  stores.push(store)
  return store
}
async function fixture(
  store: GfsDownloadStore,
  retentionOwnerId?: string,
  fixtureSource: GfsImageSource = source
) {
  const callerRoot = path.join(root, 'users', 'caller-a')
  await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
  const transfer = await store.createTransfer({
    callerIdentity: 'caller-a',
    callerWorkspacePath: callerRoot,
    source: fixtureSource,
    sizeBytes: 7,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    retentionOwnerId,
  })
  await fs.writeFile(path.join(callerRoot, transfer.partialPath), 'fixture')
  return store.publish(
    transfer.id,
    'caller-a',
    createHash('sha256').update('fixture').digest('hex')
  )
}

const DISCARDED_COUNTER = 'clerum_gfs_legacy_processing_leases_discarded_total'
const QUARANTINED_GAUGE = 'clerum_gfs_download_store_quarantined_records'
const FOREIGN_WRITER_SESSION = '33333333-3333-4333-8333-333333333333'
const LEGACY_LEASE_ID = '44444444-4444-4444-8444-444444444444'
const otherSource: GfsImageSource = {
  ...source,
  resourceId: 'b'.repeat(32),
  gfsUri: `gfs://main/${'b'.repeat(32)}`,
  name: 'other.csv',
}

function ledgerFile(): string {
  return path.join(root, '.gfs-download-store', 'ledger-v1.json')
}

async function counterValue(name: string): Promise<number> {
  const metric = register.getSingleMetric(name)
  if (metric === undefined) throw new Error(`metric ${name} is not registered`)
  const { values } = await metric.get()
  return values.reduce((sum, sample) => sum + sample.value, 0)
}

/** A processing lease exactly as a pre-#1019 Host wrote it, by default expired and empty. */
function legacyLease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leaseId: LEGACY_LEASE_ID,
    callerIdentity: 'caller-a',
    recordIds: [],
    acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    writerSessionId: FOREIGN_WRITER_SESSION,
    ...overrides,
  }
}

/** Writes legacy leases into the ledger of a closed store, as an older build left them. */
async function seedLegacyLeases(leases: Record<string, unknown>[]): Promise<string> {
  const ledger = JSON.parse(await fs.readFile(ledgerFile(), 'utf8'))
  ledger.processingLeases = Object.fromEntries(leases.map(lease => [lease.leaseId, lease]))
  const raw = JSON.stringify(ledger)
  await fs.writeFile(ledgerFile(), raw, { mode: 0o600 })
  return raw
}

async function closedStore(): Promise<void> {
  const store = freshStore()
  await store.initialize()
  await store.close()
}

function discardWarnings(calls: unknown[][]): unknown[][] {
  return calls.filter(
    call => typeof call[1] === 'string' && call[1].includes('legacy processing lease')
  )
}

describe('legacy processing leases after #1019', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('S1: discards an expired foreign-session lease left by a crashed Host and admits downloads', async () => {
    await closedStore()
    await seedLegacyLeases([legacyLease()])
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue(DISCARDED_COUNTER)
    const reopened = freshStore()
    await reopened.initialize()
    // The persisted discard is the claim; the counter and the log follow it.
    const onDisk = JSON.parse(await fs.readFile(ledgerFile(), 'utf8'))
    expect(onDisk.records).toEqual({})
    expect(onDisk).not.toHaveProperty('processingLeases')
    expect((await counterValue(DISCARDED_COUNTER)) - before).toBe(1)
    expect(discardWarnings(warn.mock.calls)).toEqual([
      [
        { component: 'GfsDownloadStore', discarded: 1 },
        'GFS download store discarded 1 legacy processing lease(s) at initialize',
      ],
    ])
    expect(reopened.isAvailable()).toBe(true)
    const receipt = await fixture(reopened)
    expect(reopened.debugRecord(receipt.id)?.state).toBe('completed')
    expect(reopened.debugUsage()).toMatchObject({ bytes: 7, files: 1 })
  })

  it('S2: re-verifies records a discarded lease protected, reusing the intact copy and quarantining the altered one', async () => {
    const store = freshStore()
    await store.initialize()
    const intact = await fixture(store)
    const altered = await fixture(store, undefined, otherSource)
    await store.close()
    await seedLegacyLeases([
      legacyLease({
        recordIds: [intact.id, altered.id],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    ])
    await fs.writeFile(path.join(root, 'users', 'caller-a', altered.path), 'changed')
    const before = await counterValue(DISCARDED_COUNTER)
    const reopened = freshStore()
    await reopened.initialize()
    const onDisk = JSON.parse(await fs.readFile(ledgerFile(), 'utf8'))
    expect(onDisk).not.toHaveProperty('processingLeases')
    expect(Object.keys(onDisk.records).sort()).toEqual([intact.id, altered.id].sort())
    expect((await counterValue(DISCARDED_COUNTER)) - before).toBe(1)
    expect(reopened.isAvailable()).toBe(true)
    expect(await reopened.reusableReceipt('caller-a', source, 7)).toMatchObject({
      id: intact.id,
      sha256: intact.sha256,
    })
    expect(reopened.debugRecord(intact.id)?.state).toBe('completed')
    expect(reopened.debugRecord(altered.id)?.state).toBe('quarantined')
    expect(await reopened.reusableReceipt('caller-a', otherSource, 7)).toBeUndefined()
  })

  it.each([
    ['a lease id that is not a UUID', { leaseId: 'not-a-uuid' }],
    [
      'an expiry that does not follow acquisition',
      { acquiredAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z' },
    ],
  ])(
    'S3: fails closed on a malformed legacy lease (%s) without touching the ledger',
    async (_label, overrides) => {
      await closedStore()
      const raw = await seedLegacyLeases([legacyLease(overrides)])
      const before = await counterValue(DISCARDED_COUNTER)
      await expect(freshStore().initialize()).rejects.toMatchObject({
        code: 'corrupt_store_ledger',
      })
      expect(await fs.readFile(ledgerFile(), 'utf8')).toBe(raw)
      expect((await counterValue(DISCARDED_COUNTER)) - before).toBe(0)
    }
  )

  it('S4: a clean restart discards nothing', async () => {
    const store = freshStore()
    await store.initialize()
    await fixture(store)
    await store.close()
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue(DISCARDED_COUNTER)
    const reopened = freshStore()
    await reopened.initialize()
    expect(reopened.isAvailable()).toBe(true)
    expect(reopened.debugUsage()).toMatchObject({ bytes: 7, files: 1 })
    const onDisk = JSON.parse(await fs.readFile(ledgerFile(), 'utf8'))
    expect(onDisk).not.toHaveProperty('processingLeases')
    expect(Object.keys(onDisk.records)).toHaveLength(1)
    expect((await counterValue(DISCARDED_COUNTER)) - before).toBe(0)
    expect(discardWarnings(warn.mock.calls)).toEqual([])
  })

  // Store behaviour only: this shell has no store reference, so the test shows
  // that close() is unaffected by a concurrent shell run. Decoupling of the
  // shell from the store is proven by the TaskExecutor-level X3-TE test.
  it('S5: close() is blocked only by its own transfers and is unaffected by a concurrent shell run', async () => {
    const store = freshStore()
    await store.initialize()
    const callerRoot = path.join(root, 'users', 'caller-a')
    await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await expect(store.close(0)).rejects.toMatchObject({ code: 'download_busy' })
    expect(store.isAvailable()).toBe(true)
    await store.fail(transfer.id, 'caller-a')

    const shell = new ShellTool(callerRoot, 30_000, ['PATH'], () => ({}), undefined, true)
    const controller = new AbortController()
    const pidFile = path.join(callerRoot, 'shell.pid')
    const running = shell.execute(
      { command: `echo $$ > ${JSON.stringify(pidFile)}; exec sleep 30` },
      { signal: controller.signal, onOutput: () => undefined }
    )
    let pid = ''
    for (const deadline = Date.now() + 5_000; pid === '' && Date.now() < deadline; ) {
      pid = (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim()
      if (pid === '') await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(pid).toMatch(/^[0-9]+$/)
    await store.close(0)
    expect(store.isAvailable()).toBe(false)
    // Witness: the shell was still running when close() resolved.
    expect(() => process.kill(Number(pid), 0)).not.toThrow()
    controller.abort()
    const result = await running
    expect(result.is_error).toBe(true)
  })

  it('S8: a discard whose persist fails before the rename leaves the ledger byte-identical and is retried by the next initialize', async () => {
    await closedStore()
    const raw = await seedLegacyLeases([legacyLease()])
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue(DISCARDED_COUNTER)
    const interrupted = freshStore()
    const privateStore = interrupted as unknown as {
      ledger: { processingLeases?: Record<string, unknown> }
      persist: () => Promise<void>
      reconcile: () => Promise<void>
    }
    let leasesAtFailedPersist: unknown = 'persist not reached'
    const persist = vi.spyOn(privateStore, 'persist').mockImplementationOnce(async () => {
      leasesAtFailedPersist = privateStore.ledger.processingLeases
      throw new Error('injected persist failure')
    })
    const reconcile = vi.spyOn(privateStore, 'reconcile')
    await expect(interrupted.initialize()).rejects.toThrow('injected persist failure')
    expect(persist).toHaveBeenCalledTimes(1)
    // The failing persist is the discard's own: the lease map was already
    // removed from memory when it ran, and initialize stopped before reconcile.
    expect(leasesAtFailedPersist).toBeUndefined()
    expect(reconcile).not.toHaveBeenCalled()
    expect(privateStore.ledger.processingLeases?.[LEGACY_LEASE_ID]).toBeDefined()
    expect(interrupted.isAvailable()).toBe(false)
    expect(await fs.readFile(ledgerFile(), 'utf8')).toBe(raw)
    expect(JSON.parse(raw).processingLeases[LEGACY_LEASE_ID]).toBeDefined()
    expect((await counterValue(DISCARDED_COUNTER)) - before).toBe(0)
    expect(discardWarnings(warn.mock.calls)).toEqual([
      [
        { component: 'GfsDownloadStore', legacyProcessingLeases: 1, outcome: 'unknown' },
        'GFS download store could not confirm the discard of 1 legacy processing lease(s) at initialize; the discard may already be visible on disk because the persist can fail after the ledger rename',
      ],
    ])

    const retried = freshStore()
    await retried.initialize()
    expect(retried.isAvailable()).toBe(true)
    expect(JSON.parse(await fs.readFile(ledgerFile(), 'utf8'))).not.toHaveProperty(
      'processingLeases'
    )
    expect((await counterValue(DISCARDED_COUNTER)) - before).toBe(1)
    expect(
      discardWarnings(warn.mock.calls).filter(
        call =>
          JSON.stringify(call[0]) ===
          JSON.stringify({ component: 'GfsDownloadStore', discarded: 1 })
      )
    ).toHaveLength(1)
  })

  it('S8b: a discard whose directory sync fails after the rename warns with an unknown outcome and does not count the discard', async () => {
    await closedStore()
    await seedLegacyLeases([legacyLease()])
    const storeDirectory = await fs.stat(path.join(root, '.gfs-download-store'))
    const probe = await fs.open(ledgerFile(), 'r')
    const prototype = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    const originalSync = prototype.sync
    let injected = 0
    // Only the store-directory fsync that follows the ledger rename fails: the
    // writer lease also syncs this directory, but before the discard the
    // visible ledger still carries the legacy lease.
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const info = await this.stat()
      if (injected === 0 && info.isDirectory() && info.ino === storeDirectory.ino) {
        const visible = JSON.parse(await fs.readFile(ledgerFile(), 'utf8'))
        if (!('processingLeases' in visible)) {
          injected += 1
          throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' })
        }
      }
      return originalSync.call(this)
    })
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue(DISCARDED_COUNTER)
    const interrupted = freshStore()
    await expect(interrupted.initialize()).rejects.toThrow('injected directory sync failure')
    expect(injected).toBe(1)
    expect(interrupted.isAvailable()).toBe(false)
    // Witness that the rename happened: the visible ledger is already lease-free.
    expect(JSON.parse(await fs.readFile(ledgerFile(), 'utf8'))).not.toHaveProperty(
      'processingLeases'
    )
    expect(discardWarnings(warn.mock.calls)).toEqual([
      [
        { component: 'GfsDownloadStore', legacyProcessingLeases: 1, outcome: 'unknown' },
        'GFS download store could not confirm the discard of 1 legacy processing lease(s) at initialize; the discard may already be visible on disk because the persist can fail after the ledger rename',
      ],
    ])
    expect((await counterValue(DISCARDED_COUNTER)) - before).toBe(0)
  })

  it('S9: reports the current quarantined-record count after reconcile without double counting across boots', async () => {
    const { child, message } = await childStore('transfer')
    expect(message.transferId).toMatch(/^[0-9a-f-]{36}$/)
    await kill(child)
    const warn = vi.spyOn(logger, 'warn')
    const quarantineWarnings = () =>
      warn.mock.calls.filter(
        call =>
          JSON.stringify(call[0]) ===
          JSON.stringify({ component: 'GfsDownloadStore', quarantined: 1 })
      )
    const recovering = freshStore()
    await recovering.initialize()
    // The boot that quarantines the interrupted transfer reports it.
    expect(recovering.debugRecord(message.transferId)?.state).toBe('quarantined')
    expect(await counterValue(QUARANTINED_GAUGE)).toBe(1)
    expect(quarantineWarnings()).toHaveLength(1)
    await recovering.close()

    const next = freshStore()
    await next.initialize()
    // The same backlog on the next boot keeps the gauge at 1, not 2.
    expect(next.debugRecord(message.transferId)?.state).toBe('quarantined')
    expect(await counterValue(QUARANTINED_GAUGE)).toBe(1)
    expect(quarantineWarnings()).toHaveLength(2)
    expect(next.debugUsage().bytes).toBe(7)
  })
})

describe('GFS writer recovery and filesystem invariants', () => {
  it.each(['SIGKILL', 'SIGTERM'] as const)(
    'excludes another process and recovers after %s on the same inode',
    async signal => {
      const { child, message } = await childStore()
      expect(message).toEqual({ ready: true })
      const databasePath = path.join(root, '.gfs-download-store', 'writer-v2.sqlite')
      const before = await fs.stat(databasePath)
      await expect(freshStore().initialize()).rejects.toMatchObject({ code: 'writer_locked' })
      await kill(child, signal)
      const reopened = freshStore()
      await reopened.initialize()
      const after = await fs.stat(databasePath)
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
      await reopened.close()
      expect((await fs.stat(databasePath)).ino).toBe(before.ino)
      await expect(
        fs.open(
          path.join(root, '.gfs-download-store', 'writer.lock'),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        )
      ).rejects.toMatchObject({ code: 'EEXIST' })
    }
  )

  it('labels verified v2 contention and reinitializes the same store after the old process settles', async () => {
    const { child } = await childStore()
    const store = freshStore()
    const storeRoot = path.join(root, '.gfs-download-store')
    const before = await fs.stat(path.join(storeRoot, 'writer-v2.sqlite'), { bigint: true })
    const ledgerBefore = await fs.readFile(path.join(storeRoot, 'ledger-v1.json'), 'utf8')
    await expect(store.initialize()).rejects.toMatchObject({
      code: 'writer_locked',
      transientWriterContention: true,
    })
    expect(store.isAvailable()).toBe(false)
    expect(await fs.readFile(path.join(storeRoot, 'ledger-v1.json'), 'utf8')).toBe(ledgerBefore)
    await kill(child)
    await store.initialize()
    expect(store.isAvailable()).toBe(true)
    expect(store.debugUsage().files).toBe(0)
    const after = await fs.stat(path.join(storeRoot, 'writer-v2.sqlite'), { bigint: true })
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    const contender = await childStore()
    expect(contender.message).toEqual({ error: 'writer_locked', transientWriterContention: true })
  })

  it('labels a verified same-process active v2 writer as contention without exposing transfers', async () => {
    const first = freshStore()
    await first.initialize()
    const second = freshStore()
    await expect(second.initialize()).rejects.toMatchObject({
      code: 'writer_locked',
      transientWriterContention: true,
    })
    await first.close()
    await second.initialize()
    expect(second.isAvailable()).toBe(true)
  })

  it.each(['ledger', 'marker', 'inode'] as const)(
    'never labels corrupt or replaced v2 state as transient (%s)',
    async kind => {
      const { child } = await childStore()
      const storeRoot = path.join(root, '.gfs-download-store')
      if (kind === 'ledger') await fs.writeFile(path.join(storeRoot, 'ledger-v1.json'), '{bad')
      if (kind === 'marker') await fs.writeFile(path.join(storeRoot, 'writer.lock'), '{bad')
      if (kind === 'inode') {
        await fs.rename(
          path.join(storeRoot, 'writer-v2.sqlite'),
          path.join(storeRoot, 'writer-v2.sqlite.saved')
        )
        await fs.writeFile(path.join(storeRoot, 'writer-v2.sqlite'), '', { mode: 0o600 })
      }
      await expect(freshStore().initialize()).rejects.toMatchObject({
        code: kind === 'ledger' ? 'corrupt_store_ledger' : 'writer_locked',
        transientWriterContention: false,
      })
      await kill(child)
    }
  )

  it('reauthorizes a clean v2 cold-resume copy for the exact task owner and preserves every other pin', async () => {
    const { child, message } = await childStore('pin')
    await kill(child)
    const ledgerPath = path.join(root, '.gfs-download-store', 'ledger-v1.json')
    const ownerId = '11111111-1111-4111-8111-111111111111'
    const otherId = '22222222-2222-4222-8222-222222222222'
    const before = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
    const reopened = freshStore()
    await reopened.initialize()
    expect(reopened.isAvailable()).toBe(true)
    expect(reopened.debugRecord(message.receipt.id)?.state).toBe('completed')
    // The download boundary freshly authorizes this exact remote source before
    // invoking reuse; trusted task identity comes from persisted TaskExecutor.
    const receipt = await reopened.reusableReceipt('caller-a', source, 7, {
      retentionOwnerId: ownerId,
    })
    expect(receipt).toMatchObject({ id: message.receipt.id, sha256: message.receipt.sha256 })
    const after = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
    expect(after.retentionOwners[ownerId].writerSessionId).not.toBe(
      before.retentionOwners[ownerId].writerSessionId
    )
    expect(after.retentionOwners[otherId]).toEqual(before.retentionOwners[otherId])
    await reopened.releaseReceiptOwner(ownerId, 'caller-a')
    await reopened.cleanupExpired(Date.parse(message.receipt.expiresAt) + 1)
    expect(reopened.debugUsage().bytes).toBe(7)
    await expect(reopened.releaseReceiptOwner(otherId, 'caller-b')).rejects.toMatchObject({
      code: 'caller_mismatch',
    })
    await reopened.releaseReceiptOwner(otherId, 'caller-a')
    await reopened.cleanupExpired(Date.parse(message.receipt.expiresAt) + 1)
    expect(reopened.debugUsage().bytes).toBe(0)
  })

  it.each(['caller', 'version', 'size', 'hash'] as const)(
    'does not adopt an inherited pin when fresh reuse validation fails (%s)',
    async kind => {
      const { child, message } = await childStore('pin')
      await kill(child)
      const ledgerPath = path.join(root, '.gfs-download-store', 'ledger-v1.json')
      const ownerId = '11111111-1111-4111-8111-111111111111'
      const before = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
      if (kind === 'hash')
        await fs.writeFile(path.join(root, 'users', 'caller-a', message.receipt.path), 'changed')
      const reopened = freshStore()
      await reopened.initialize()
      if (kind === 'caller') {
        await expect(
          reopened.reusableReceipt('caller-b', source, 7, { retentionOwnerId: ownerId })
        ).rejects.toMatchObject({ code: 'caller_mismatch' })
      } else {
        const receipt = await reopened.reusableReceipt(
          'caller-a',
          kind === 'version' ? { ...source, version: source.version + 1 } : source,
          kind === 'size' ? 8 : 7,
          { retentionOwnerId: ownerId }
        )
        expect(receipt).toBeUndefined()
      }
      const after = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
      expect(after.retentionOwners[ownerId]).toEqual(before.retentionOwners[ownerId])
      expect(reopened.debugUsage().bytes).toBe(7)
    }
  )

  it('keeps kernel ownership after busy close and admits another process only after consumers settle', async () => {
    const store = freshStore()
    await store.initialize()
    const receipt = await fixture(store, 'live-task')
    await expect(store.close(0)).rejects.toMatchObject({ code: 'download_busy' })
    expect(store.isAvailable()).toBe(true)
    const contender = await childStore()
    expect(contender.message).toEqual({ error: 'writer_locked', transientWriterContention: true })
    expect(store.debugUsage()).toMatchObject({ bytes: 7, files: 1 })
    expect(await store.inspect(receipt.path, 'caller-a')).toMatchObject({ id: receipt.id })
    await store.releaseReceiptOwner('live-task', 'caller-a')
    await store.close()
    const successor = await childStore()
    expect(successor.message).toEqual({ ready: true })
    await kill(successor.child)
  })

  it('releases an idle kernel writer after a real failed close journal without deleting its fence', async () => {
    const store = freshStore()
    await store.initialize()
    const receipt = await fixture(store)
    const storeRoot = path.join(root, '.gfs-download-store')
    const ledgerPath = path.join(storeRoot, 'ledger-v1.json')
    const ledger = await fs.readFile(ledgerPath)
    await fs.rename(ledgerPath, `${ledgerPath}.saved`)
    await fs.mkdir(ledgerPath, { mode: 0o700 })
    await expect(store.close(0)).rejects.toMatchObject({ code: 'EISDIR' })
    expect(store.isAvailable()).toBe(false)
    await store.close(0)
    // Fixture operator restores the exact ledger after proving the old writer closed.
    await fs.rmdir(ledgerPath)
    await fs.writeFile(ledgerPath, ledger, { mode: 0o600 })
    const reopened = freshStore()
    await reopened.initialize()
    expect(await reopened.inspect(receipt.path, 'caller-a')).toMatchObject({ id: receipt.id })
    await expect(
      fs.open(
        path.join(storeRoot, 'writer.lock'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      )
    ).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('keeps ambiguous legacy ownership untouched and rejects rollback through O_EXCL', async () => {
    const storeRoot = path.join(root, '.gfs-download-store')
    await fs.mkdir(storeRoot, { mode: 0o700 })
    const legacy = JSON.stringify({
      pid: 123,
      leaseId: 'legacy',
      acquiredAt: new Date(0).toISOString(),
    })
    await fs.writeFile(path.join(storeRoot, 'writer.lock'), legacy, { mode: 0o600 })
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(freshStore().initialize()).rejects.toMatchObject({
        code: 'writer_locked',
        transientWriterContention: false,
      })
    expect(await fs.readFile(path.join(storeRoot, 'writer.lock'), 'utf8')).toBe(legacy)
    expect(await fs.readdir(storeRoot)).toEqual(['writer.lock'])
  })

  it('requires an operator transition for an unfenced legacy ledger even without writer.lock', async () => {
    const storeRoot = path.join(root, '.gfs-download-store')
    await fs.mkdir(storeRoot, { mode: 0o700 })
    const legacyLedger = JSON.stringify({ schemaVersion: 1, records: {}, processingLeases: {} })
    await fs.writeFile(path.join(storeRoot, 'ledger-v1.json'), legacyLedger, { mode: 0o600 })
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(freshStore().initialize()).rejects.toMatchObject({
        code: 'unsupported_store_schema',
      })
    expect(await fs.readFile(path.join(storeRoot, 'ledger-v1.json'), 'utf8')).toBe(legacyLedger)
    expect(await fs.readdir(storeRoot)).toEqual(['ledger-v1.json'])
  })

  it('rejects a missing or replaced lock database rather than creating a second inode', async () => {
    const store = freshStore()
    await store.initialize()
    await store.close()
    const databasePath = path.join(root, '.gfs-download-store', 'writer-v2.sqlite')
    await fs.rename(databasePath, `${databasePath}.old`)
    await expect(freshStore().initialize()).rejects.toMatchObject({ code: 'workspace_unavailable' })
    // Exclusive creation proves initialization left the target absent in the
    // same atomic operation. An unexpected second inode fails with EEXIST.
    let replacementDatabase: FileHandle | undefined
    try {
      replacementDatabase = await fs.open(databasePath, 'wx', 0o600)
    } finally {
      await replacementDatabase?.close()
    }
    await expect(freshStore().initialize()).rejects.toMatchObject({ code: 'writer_locked' })
  })

  it('restores only verified owned fsGroup transformations without relaxing privacy', async () => {
    const store = freshStore()
    await store.initialize()
    const receipt = await fixture(store)
    await store.close()
    const storeRoot = path.join(root, '.gfs-download-store')
    const cacheRoot = path.join(root, 'users', 'caller-a', '.gfs-downloads')
    for (const directory of [
      storeRoot,
      cacheRoot,
      path.dirname(path.join(root, 'users', 'caller-a', receipt.path)),
    ])
      await fs.chmod(directory, 0o2770)
    for (const filename of ['writer.lock', 'writer-v2.sqlite', 'ledger-v1.json'])
      await fs.chmod(path.join(storeRoot, filename), 0o660)
    const sourcePath = path.join(root, 'users', 'caller-a', receipt.path)
    await fs.chmod(sourcePath, 0o660)
    const reopened = freshStore()
    await reopened.initialize()
    expect((await fs.stat(storeRoot)).mode & 0o7777).toBe(0o700)
    expect((await fs.stat(sourcePath)).mode & 0o7777).toBe(0o600)
    expect(await reopened.reusableReceipt('caller-a', source, 7)).toMatchObject({ id: receipt.id })
  })

  it.each(['mode', 'hardlink', 'symlink', 'hash'] as const)(
    'quarantines untrusted completed content (%s)',
    async kind => {
      const store = freshStore()
      await store.initialize()
      const receipt = await fixture(store)
      await store.close()
      const sourcePath = path.join(root, 'users', 'caller-a', receipt.path)
      if (kind === 'mode') await fs.chmod(sourcePath, 0o644)
      if (kind === 'hardlink') await fs.link(sourcePath, path.join(root, 'other-link'))
      if (kind === 'symlink') {
        await fs.rename(sourcePath, path.join(root, 'other-file'))
        await fs.symlink(path.join(root, 'other-file'), sourcePath)
      }
      if (kind === 'hash') {
        await fs.writeFile(sourcePath, 'changed')
        await fs.chmod(sourcePath, 0o660)
      }
      const reopened = freshStore()
      await reopened.initialize()
      expect(reopened.debugRecord(receipt.id)).toMatchObject({ state: 'quarantined' })
      expect(reopened.debugUsage().bytes).toBe(7)
      await reopened.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
      expect(reopened.debugUsage().bytes).toBe(7)
      if (kind === 'hash') expect((await fs.stat(sourcePath)).mode & 0o7777).toBe(0o660)
    }
  )
})
