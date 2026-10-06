import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
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
  if (mode === 'lease' || mode === 'emptyLease' || mode === 'pin') {
    const callerRoot = path.join(root, 'users', 'caller-a');
    fs.mkdirSync(callerRoot, { recursive: true, mode: 0o700 });
    let receipt;
    if (mode === 'lease' || mode === 'pin') {
    const bytes = Buffer.from('fixture');
    const transfer = await store.createTransfer({ callerIdentity: 'caller-a', callerWorkspacePath: callerRoot,
      source: ${JSON.stringify(source)}, sizeBytes: bytes.length, expiresAt: new Date(Date.now() + (mode === 'pin' ? 60000 : 1000)).toISOString(),
      retentionOwnerId: mode === 'pin' ? '11111111-1111-4111-8111-111111111111' : undefined });
    fs.writeFileSync(path.join(callerRoot, transfer.partialPath), bytes);
    receipt = await store.publish(transfer.id, 'caller-a', createHash('sha256').update(bytes).digest('hex'));
    }
    if (mode === 'pin') {
      await store.reusableReceipt('caller-a', ${JSON.stringify(source)}, 7, { retentionOwnerId: '22222222-2222-4222-8222-222222222222' });
      process.send({ receipt });
      setInterval(() => {}, 1000);
      return;
    }
    const lease = await store.processingLeaseProvider('caller-a').acquireProcessingLease({ durationMs: 500 });
    const executor = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    executor.unref();
    process.send({ receipt, lease, executorPid: executor.pid });
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
async function fixture(store: GfsDownloadStore, retentionOwnerId?: string) {
  const callerRoot = path.join(root, 'users', 'caller-a')
  await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
  const transfer = await store.createTransfer({
    callerIdentity: 'caller-a',
    callerWorkspacePath: callerRoot,
    source,
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

  it('preserves inherited copies while a detached executor survives Host death past both deadlines', async () => {
    const { child, message } = await childStore('lease')
    expect(message.error).toBeUndefined()
    executors.push(message.executorPid)
    await kill(child)
    expect(() => process.kill(message.executorPid, 0)).not.toThrow()
    const reopened = freshStore()
    await reopened.initialize()
    await reopened.cleanupExpired(
      Math.max(Date.parse(message.receipt.expiresAt), Date.parse(message.lease.expiresAt)) + 1
    )
    expect(() => process.kill(message.executorPid, 0)).not.toThrow()
    expect(reopened.debugRecord(message.receipt.id)).toMatchObject({
      state: 'quarantined',
      sizeBytes: 7,
    })
    expect(reopened.debugUsage().bytes).toBe(7)
    expect(
      await fs.readFile(path.join(root, 'users', 'caller-a', message.receipt.path), 'utf8')
    ).toBe('fixture')
    await expect(
      reopened.processingLeaseProvider('caller-a').releaseProcessingLease(message.lease)
    ).rejects.toMatchObject({ code: 'download_busy' })
  })

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

  it('durably protects an execution admitted before the first retained download', async () => {
    const store = freshStore()
    await store.initialize()
    const provider = store.processingLeaseProvider('caller-a')
    const lease = await provider.acquireProcessingLease({ durationMs: 500 })
    const ledger = JSON.parse(
      await fs.readFile(path.join(root, '.gfs-download-store', 'ledger-v1.json'), 'utf8')
    )
    expect(ledger.processingLeases[lease.leaseId].recordIds).toEqual([])
    await expect(store.close(0)).rejects.toMatchObject({ code: 'download_busy' })
    await provider.releaseProcessingLease(lease)
    await store.close()
  })

  it('fences Host-wide managed work after an inherited empty execution', async () => {
    const { child, message } = await childStore('emptyLease')
    expect(message.error).toBeUndefined()
    executors.push(message.executorPid)
    await kill(child)
    const reopened = freshStore()
    await reopened.initialize()
    const callerRoot = path.join(root, 'users', 'caller-a')
    const input = {
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    await reopened.cleanupExpired(Date.parse(message.lease.expiresAt) + 1)
    expect(() => process.kill(message.executorPid, 0)).not.toThrow()
    await expect(reopened.createTransfer(input)).rejects.toMatchObject({ code: 'download_busy' })
    await expect(reopened.reusableReceipt('caller-a', source, 7)).rejects.toMatchObject({
      code: 'download_busy',
    })
    await expect(
      reopened.processingLeaseProvider('caller-a').acquireProcessingLease()
    ).rejects.toMatchObject({ code: 'download_busy' })
    await expect(fs.stat(path.join(callerRoot, '.gfs-downloads'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const callerBRoot = path.join(root, 'users', 'caller-b')
    await fs.mkdir(callerBRoot, { recursive: true, mode: 0o700 })
    await expect(
      reopened.createTransfer({
        ...input,
        callerIdentity: 'caller-b',
        callerWorkspacePath: callerBRoot,
      })
    ).rejects.toMatchObject({ code: 'download_busy' })
    await expect(
      reopened.processingLeaseProvider('caller-b').acquireProcessingLease()
    ).rejects.toMatchObject({ code: 'download_busy' })
    expect(reopened.isAvailable()).toBe(false)
    expect(reopened.debugUsage().bytes).toBe(0)
  })

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
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
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
