#!/usr/bin/env node
/**
 * Phases run by scripts/dev/gfs-store-rollback-check.sh, one Node process each.
 * The orchestrator passes every path; this file never guesses one.
 *
 *   legacy-crash   <oldDist> <host> <out>   the dev store (74e0d81d9) writes a
 *                                           ledger, then the process is killed
 *   legacy-restart <oldDist> <host> <out>   the dev Host startup (bootstrapGfsRuntime)
 *                                           reopens that volume and stops cleanly
 *   new-state      <newDist> <host> <out>   the #1028 store retires the dev store
 *                                           and leaves its own state, then is killed
 *   old-on-new     <oldDist> <host> <out>   rollback: the dev Host starts on the
 *                                           #1028 state and completes a download
 *   roll-forward   <newDist> <host> <out>   the #1028 store starts on the
 *                                           post-rollback volume
 *   manifest       <host> <out>             every entry under <host>: type, mode, size, sha256
 *   compare        <before> <after> <out>   entries removed or changed between two manifests
 *   write-fixture  <crashedHost> <restartedHost> <crashOut> <restartOut> <commit> <fixtureDir> <out>
 *                                           copies the dev-store snapshots into the fixture
 *
 * Every phase writes <out> as JSON with `assertions` and `failed`; the
 * orchestrator refuses a phase with zero assertions. A failed assertion throws.
 */
'use strict'

const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

let assertions = 0
const results = {}

function check(condition, label, detail) {
  assertions += 1
  if (!condition) {
    console.error(`ASSERT_FAIL ${label} ${JSON.stringify(detail ?? null)}`)
    throw new Error(`assertion failed: ${label}`)
  }
  console.log(`ASSERT_OK ${label}`)
}

function writeOut(out, failed) {
  fs.writeFileSync(out, JSON.stringify({ assertions, failed, ...results }, null, 2))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function source(index) {
  const resourceId = index.toString(16).padStart(32, '0')
  return {
    kind: 'gfs',
    drive: 'main',
    resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    name: `rollback-${index}.bin`,
    version: 1,
  }
}

function callerRoot(host, key) {
  const root = path.join(host, 'users', key)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

/** Admits a transfer and writes its partial file the way the GFS client does. */
async function startTransfer(store, host, caller, index) {
  const root = callerRoot(host, caller)
  const bytes = Buffer.alloc(64, index)
  const transfer = await store.createTransfer({
    callerIdentity: caller,
    callerWorkspacePath: root,
    source: source(index),
    sizeBytes: bytes.byteLength,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  })
  fs.writeFileSync(path.join(root, transfer.partialPath), bytes)
  return { transfer, bytes, root }
}

async function completeDownload(store, host, caller, index) {
  const { transfer, bytes, root } = await startTransfer(store, host, caller, index)
  const receipt = await store.publish(transfer.id, caller, sha256(bytes))
  return { receipt, bytes, root }
}

function listHost(host) {
  return fs.readdirSync(host).sort()
}

/** A crash: no close(), no drain. The kernel releases the writer lock. */
function crash(out) {
  writeOut(out, 0)
  process.kill(process.pid, 'SIGKILL')
}

const phases = {
  async 'legacy-crash'([dist, host, out]) {
    const { GfsDownloadStore } = require(path.join(dist, 'internalTools/gfsDownloadStore.js'))
    fs.mkdirSync(host, { recursive: true, mode: 0o700 })
    const store = new GfsDownloadStore(host)
    await store.initialize()
    check(store.isAvailable(), 'legacy-crash: dev store is available on a new volume')

    const completedA = await completeDownload(store, host, 'caller-dev-a', 1)
    const missingA = await completeDownload(store, host, 'caller-dev-a', 2)
    const completedB = await completeDownload(store, host, 'caller-dev-b', 3)
    // A shell command rewrites a published copy with the Host UID; the next
    // reuse check finds the digest changed and marks the record missing.
    fs.writeFileSync(
      path.join(missingA.root, missingA.receipt.path),
      Buffer.alloc(missingA.bytes.byteLength, 0xee)
    )
    const reused = await store.reusableReceipt('caller-dev-a', source(2), missingA.bytes.byteLength)
    check(reused === undefined, 'legacy-crash: a rewritten copy is not reused')
    check(
      store.debugRecord(missingA.receipt.id)?.state === 'missing',
      'legacy-crash: the rewritten copy is recorded missing',
      store.debugRecord(missingA.receipt.id)
    )
    const transferring = await startTransfer(store, host, 'caller-dev-a', 4)

    // A processing lease that runs out before the crash, then one that does not.
    const expired = await store.processingLeaseProvider('caller-dev-b').acquireProcessingLease({
      durationMs: 1_500,
    })
    await new Promise(resolve => setTimeout(resolve, 2_000))
    check(Date.parse(expired.expiresAt) < Date.now(), 'legacy-crash: the first lease has expired')
    const live = await store.processingLeaseProvider('caller-dev-a').acquireProcessingLease({
      durationMs: 3_600_000,
    })
    check(Date.parse(live.expiresAt) > Date.now(), 'legacy-crash: the second lease is live')

    const ledger = JSON.parse(
      fs.readFileSync(path.join(host, '.gfs-download-store', 'ledger-v1.json'), 'utf8')
    )
    const states = Object.fromEntries(
      Object.values(ledger.records).map(record => [record.id, record.state])
    )
    check(
      Object.keys(ledger.processingLeases).length === 2,
      'legacy-crash: the ledger holds both processing leases',
      ledger.processingLeases
    )
    check(
      states[completedA.receipt.id] === 'completed' &&
        states[completedB.receipt.id] === 'completed' &&
        states[missingA.receipt.id] === 'missing' &&
        states[transferring.transfer.id] === 'transferring',
      'legacy-crash: the ledger holds completed, missing and transferring records',
      states
    )
    results.generatedAtMs = Date.now()
    results.records = states
    results.leases = { expired: expired.leaseId, live: live.leaseId }
    crash(out)
  },

  async 'legacy-restart'([dist, host, out]) {
    const { bootstrapGfsRuntime } = require(path.join(dist, 'gfsRuntime.js'))
    const before = JSON.parse(
      fs.readFileSync(path.join(host, '.gfs-download-store', 'ledger-v1.json'), 'utf8')
    )
    const runtime = await bootstrapGfsRuntime(host, { retryDelayMs: 25, maxRetryAttempts: 1 })
    const available = runtime.store.isAvailable()
    // The #1019 state: leases of the killed writer are inherited executors, so
    // the dev Host quarantines every record and disables managed operations.
    check(available === false, 'legacy-restart: the dev Host is unavailable on its own crash state')
    const states = Object.fromEntries(
      Object.keys(before.records).map(id => [id, runtime.store.debugRecord(id)?.state])
    )
    check(
      Object.values(states).length === 4 && Object.values(states).every(s => s === 'quarantined'),
      'legacy-restart: every record is quarantined',
      states
    )
    await runtime.stop()
    const after = JSON.parse(
      fs.readFileSync(path.join(host, '.gfs-download-store', 'ledger-v1.json'), 'utf8')
    )
    check(
      Object.keys(after.processingLeases).length === 2,
      'legacy-restart: the inherited leases stay in the ledger',
      after.processingLeases
    )
    results.oldStoreAvailable = available
    results.records = states
  },

  async 'new-state'([dist, host, out]) {
    // Fault injection for this whole phase: every removal of a retired dev
    // store or of a replaced .gfs-downloads fails with EBUSY, as a busy mount
    // would (the store retries EACCES/EPERM itself, and every sweep retries
    // the removal), so both leftovers are on the volume when the process dies.
    const fsp = require('node:fs/promises')
    const prefixes = ['.gfs-download-store.retired-', '.gfs-downloads.trash-']
    const injected = new Set()
    const realRm = fsp.rm
    fsp.rm = async (target, options) => {
      const name = path.basename(String(target))
      const prefix = prefixes.find(candidate => name.startsWith(candidate))
      if (prefix !== undefined) {
        injected.add(prefix)
        throw Object.assign(new Error('injected rm failure'), { code: 'EBUSY' })
      }
      return realRm(target, options)
    }
    const { GfsDownloadStore } = require(path.join(dist, 'internalTools/gfsDownloadStore.js'))
    const store = new GfsDownloadStore(host)
    await store.initialize()
    check(store.isAvailable(), 'new-state: the #1028 store is available on the dev state')
    check(
      !listHost(host).includes('.gfs-download-store'),
      'new-state: the dev store directory was retired',
      listHost(host)
    )
    const retired = listHost(host).filter(n => n.startsWith('.gfs-download-store.retired-'))
    check(retired.length === 1, 'new-state: one retired dev store is left on disk', listHost(host))

    const published = await completeDownload(store, host, 'caller-new-a', 11)
    await completeDownload(store, host, 'caller-new-b', 12)
    const downloadsB = path.join(host, 'users', 'caller-new-b', '.gfs-downloads')
    // A shell command makes the caller's .gfs-downloads non-private; the next
    // admission replaces it, and the injected failures leave the trash behind.
    fs.chmodSync(downloadsB, 0o755)
    let replacementError
    try {
      await startTransfer(store, host, 'caller-new-b', 13)
    } catch (error) {
      replacementError = error
    }
    const trash = fs
      .readdirSync(path.join(host, 'users', 'caller-new-b'))
      .filter(n => n.startsWith('.gfs-downloads.trash-'))
    check(trash.length === 1, 'new-state: one .gfs-downloads.trash-* is left on disk', trash)
    const incomplete = await startTransfer(store, host, 'caller-new-a', 14)
    check(
      fs.existsSync(path.join(incomplete.root, incomplete.transfer.partialPath)),
      'new-state: an incomplete transfer is on disk'
    )
    check(injected.size === 2, 'new-state: both injected failures fired', [...injected])
    check(
      listHost(host).filter(n => n.startsWith('.gfs-download-store.retired-')).length === 1 &&
        fs
          .readdirSync(path.join(host, 'users', 'caller-new-b'))
          .filter(n => n.startsWith('.gfs-downloads.trash-')).length === 1,
      'new-state: both leftovers are still on disk at the crash'
    )
    results.published = {
      caller: 'caller-new-a',
      path: published.receipt.path,
      id: published.receipt.id,
    }
    results.replacementError = replacementError
      ? { name: replacementError.name, code: replacementError.code }
      : null
    crash(out)
  },

  async 'old-on-new'([dist, host, out, newStateResult]) {
    const previous = JSON.parse(fs.readFileSync(newStateResult, 'utf8'))
    const { bootstrapGfsRuntime } = require(path.join(dist, 'gfsRuntime.js'))
    const runtime = await bootstrapGfsRuntime(host, { retryDelayMs: 25, maxRetryAttempts: 1 })
    const store = runtime.store
    check(store.isAvailable(), 'old-on-new: the dev Host store is available on the #1028 state')
    check(
      fs.existsSync(path.join(host, '.gfs-download-store', 'ledger-v1.json')),
      'old-on-new: the dev store created a new ledger'
    )
    const { receipt, bytes } = await completeDownload(store, host, previous.published.caller, 21)
    const read = await store.readManagedFile(receipt.path, previous.published.caller)
    check(read.equals(bytes), 'old-on-new: the dev store serves its own new download')
    let foreign
    try {
      await store.readManagedFile(previous.published.path, previous.published.caller)
    } catch (error) {
      foreign = error
    }
    check(
      foreign !== undefined && foreign.code === 'caller_mismatch',
      'old-on-new: a copy published by #1028 is unknown to the dev store (caller_mismatch)',
      foreign && { name: foreign.name, code: foreign.code }
    )
    await store.cleanupExpired()
    check(store.isAvailable(), 'old-on-new: the dev store is available after its sweep')
    await runtime.stop()
    results.oldDownload = { id: receipt.id, path: receipt.path }
  },

  async 'roll-forward'([dist, host, out]) {
    const { GfsDownloadStore } = require(path.join(dist, 'internalTools/gfsDownloadStore.js'))
    const store = new GfsDownloadStore(host)
    await store.initialize()
    check(store.isAvailable(), 'roll-forward: the #1028 store is available after a rollback')
    const leftovers = listHost(host).filter(n => n.startsWith('.gfs-download-store'))
    check(
      leftovers.length === 0,
      'roll-forward: the dev store and every retired tree are gone',
      listHost(host)
    )
    const trash = fs
      .readdirSync(path.join(host, 'users', 'caller-new-b'))
      .filter(n => n.startsWith('.gfs-downloads.trash-'))
    check(trash.length === 0, 'roll-forward: the .gfs-downloads.trash-* is gone', trash)
    await completeDownload(store, host, 'caller-new-a', 31)
    await store.close()
    results.hostEntries = listHost(host)
  },

  async manifest([host, out]) {
    const entries = {}
    const walk = relative => {
      const absolute = path.join(host, relative)
      const info = fs.lstatSync(absolute)
      const entry = { mode: (info.mode & 0o777).toString(8) }
      if (info.isDirectory()) {
        entry.type = 'dir'
        for (const name of fs.readdirSync(absolute).sort()) walk(path.join(relative, name))
      } else if (info.isFile()) {
        entry.type = 'file'
        entry.size = info.size
        entry.sha256 = sha256(fs.readFileSync(absolute))
      } else entry.type = 'other'
      if (relative !== '') entries[relative] = entry
    }
    walk('')
    check(Object.keys(entries).length > 0, 'manifest: the host root is not empty')
    results.entries = entries
  },

  /**
   * Copies the two dev-store snapshots into the committed fixture directory.
   * writer.lock names the device and inode of writer-v2.sqlite on the
   * generating machine; both are written as "0" and the test loader rewrites
   * them to the identity of the copied database. Nothing else is changed.
   */
  async 'write-fixture'([
    crashedHost,
    restartedHost,
    crashResult,
    restartResult,
    commit,
    fixture,
    out,
  ]) {
    const crash = JSON.parse(fs.readFileSync(crashResult, 'utf8'))
    const restart = JSON.parse(fs.readFileSync(restartResult, 'utf8'))
    const modes = {}
    for (const [name, host] of [
      ['crashed', crashedHost],
      ['restarted', restartedHost],
    ]) {
      const target = path.join(fixture, name)
      fs.rmSync(target, { recursive: true, force: true })
      fs.cpSync(host, target, { recursive: true })
      const fence = path.join(target, '.gfs-download-store', 'writer.lock')
      const parsed = JSON.parse(fs.readFileSync(fence, 'utf8'))
      check(
        parsed.schemaVersion === 2 && 'databaseDevice' in parsed && 'databaseInode' in parsed,
        `write-fixture: ${name} has a v2 writer fence`,
        parsed
      )
      fs.writeFileSync(
        fence,
        JSON.stringify({ ...parsed, databaseDevice: '0', databaseInode: '0' })
      )
      const walk = relative => {
        const info = fs.lstatSync(path.join(host, relative))
        if (relative !== '') modes[path.join(name, relative)] = (info.mode & 0o777).toString(8)
        if (info.isDirectory())
          for (const entry of fs.readdirSync(path.join(host, relative)).sort())
            walk(path.join(relative, entry))
      }
      walk('')
      for (const file of Object.keys(modes).filter(m => m.startsWith(`${name}/`))) {
        const absolute = path.join(fixture, file)
        if (!fs.lstatSync(absolute).isFile()) continue
        const text = fs.readFileSync(absolute).toString('latin1')
        check(
          !text.includes(crashedHost) && !text.includes(restartedHost) && !text.includes('/Users/'),
          `write-fixture: ${file} holds no absolute path`
        )
      }
    }
    fs.writeFileSync(
      path.join(fixture, 'generation.json'),
      `${JSON.stringify(
        {
          commit,
          generatedAtMs: crash.generatedAtMs,
          crashed: { records: crash.records, leases: crash.leases },
          restarted: { oldStoreAvailable: restart.oldStoreAvailable, records: restart.records },
          modes,
        },
        null,
        2
      )}\n`
    )
    results.files = Object.keys(modes).length
  },

  async compare([before, after, out]) {
    const a = JSON.parse(fs.readFileSync(before, 'utf8')).entries
    const b = JSON.parse(fs.readFileSync(after, 'utf8')).entries
    const removed = Object.keys(a).filter(name => !(name in b))
    const changed = Object.keys(a).filter(
      name => name in b && JSON.stringify(a[name]) !== JSON.stringify(b[name])
    )
    const added = Object.keys(b).filter(name => !(name in a))
    results.removed = removed
    results.changed = changed.map(name => ({ name, before: a[name], after: b[name] }))
    results.added = added
    check(Object.keys(a).length > 0, 'compare: the #1028 state has entries')
    check(
      removed.length === 0,
      'compare: the dev store removed nothing the #1028 store left',
      removed
    )
    check(
      changed.length === 0,
      'compare: the dev store changed nothing the #1028 store left',
      results.changed
    )
  },
}

async function main() {
  const [phase, ...args] = process.argv.slice(2)
  const run = phases[phase]
  if (!run) throw new Error(`unknown phase ${phase}`)
  const out = phase === 'manifest' ? args[1] : phase === 'write-fixture' ? args[6] : args[2]
  if (out === undefined) throw new Error(`phase ${phase}: missing output path`)
  results.phase = phase
  results.runId = randomUUID()
  try {
    await run(args)
  } catch (error) {
    console.error(error)
    writeOut(out, 1)
    process.exit(1)
  }
  writeOut(out, 0)
  process.exit(0)
}

main()
