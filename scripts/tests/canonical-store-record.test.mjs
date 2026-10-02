import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess, { execFileSync } from 'node:child_process'
import test from 'node:test'
import { openCanonicalStoreRecordDirectory, readCanonicalStoreRecord } from '../e2e/_lib/canonical-store-record.cjs'
import { readBoundRecord, validateBarrierDirectory } from '../e2e/_lib/canonical-store-lifecycle.mjs'

const runId = '30000000-0000-4000-8000-000000000002'
const record = { runId, sequence: 1, phase: 'canonical-activated', uiVerified: true }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-record-contract-'))
  fs.chmodSync(directory, 0o700)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, filename: path.join(directory, '1.json') }
}
function publish(filename, value = record) {
  const temporary = filename + '.next'
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, filename)
}

test('absent records keep ENOENT and atomic publication preserves the same-run wire contract', t => {
  const f = fixture(t)
  assert.throws(() => readCanonicalStoreRecord(f.filename), { code: 'ENOENT' })
  publish(f.filename)
  assert.deepEqual(readCanonicalStoreRecord(f.filename), record)
  assert.deepEqual(readBoundRecord(f.filename, record), record)
  publish(path.join(f.directory, 'binding.json'), { runId })
  assert.equal(validateBarrierDirectory(f.directory, runId), fs.realpathSync(f.directory))
  execFileSync(process.execPath, [
    path.resolve('scripts/e2e/_lib/canonical-store-lifecycle.mjs'), 'ack',
    f.filename, runId, record.phase, '1',
  ], { timeout: 5000, stdio: 'pipe' })
})

test('symlinks, hardlinks and permissive files cannot become an ACK', t => {
  const f = fixture(t)
  publish(f.filename)
  const alias = path.join(f.directory, 'alias.json')
  fs.symlinkSync(f.filename, alias)
  assert.throws(() => readCanonicalStoreRecord(alias))
  fs.unlinkSync(alias)
  fs.linkSync(f.filename, alias)
  assert.throws(() => readCanonicalStoreRecord(alias), /Unsafe canonical-store record/)
  assert.throws(() => readBoundRecord(f.filename, record), /Unsafe canonical-store record/)
  fs.unlinkSync(alias)
  fs.chmodSync(f.filename, 0o644)
  assert.throws(() => readCanonicalStoreRecord(f.filename), /Unsafe canonical-store record/)
  fs.chmodSync(f.filename, 0o600)
  assert.deepEqual(readCanonicalStoreRecord(f.filename), record)
})

test('FIFOs and directories are rejected without blocking the reader', t => {
  const f = fixture(t)
  execFileSync('mkfifo', [f.filename], { timeout: 5000 })
  fs.chmodSync(f.filename, 0o600)
  assert.throws(() => readCanonicalStoreRecord(f.filename), /Unsafe canonical-store record/)
  const directoryRecord = path.join(f.directory, 'directory.json')
  fs.mkdirSync(directoryRecord, { mode: 0o700 })
  assert.throws(() => readCanonicalStoreRecord(directoryRecord), /Unsafe canonical-store record/)
  fs.unlinkSync(f.filename)
  publish(f.filename)
  assert.deepEqual(readCanonicalStoreRecord(f.filename), record)
})

test('oversized, empty and non-object JSON records fail without echoing their bytes', t => {
  const f = fixture(t)
  fs.writeFileSync(f.filename, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 })
  assert.throws(() => readCanonicalStoreRecord(f.filename), /Unsafe canonical-store record/)
  fs.writeFileSync(f.filename, '')
  assert.throws(() => readCanonicalStoreRecord(f.filename), /Unsafe canonical-store record/)
  for (const value of [null, [], 'scalar']) {
    fs.writeFileSync(f.filename, JSON.stringify(value))
    assert.throws(() => readCanonicalStoreRecord(f.filename), /Invalid canonical-store record object/)
  }
  fs.writeFileSync(f.filename, 'private-record-content-not-json')
  assert.throws(
    () => readCanonicalStoreRecord(f.filename),
    error => error.message === 'Invalid canonical-store record JSON' && error.cause === undefined
  )
})

test('substituting a symlink before native open never reads its target', t => {
  const f = fixture(t)
  publish(f.filename)
  const target = path.join(f.directory, 'foreign.json')
  publish(target, { ...record, foreign: true })
  const spawn = childProcess.spawnSync
  let substituted = false
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (!substituted) {
      substituted = true
      fs.unlinkSync(f.filename)
      fs.symlinkSync(target, f.filename)
    }
    return spawn(command, args, options)
  })
  assert.throws(() => readCanonicalStoreRecord(f.filename), /Unsafe canonical-store record/)
  assert.equal(substituted, true)
  t.mock.restoreAll()
  assert.deepEqual(readCanonicalStoreRecord(target), { ...record, foreign: true })
})

test('a held parent descriptor preserves the original directory after pathname replacement', t => {
  const f = fixture(t)
  publish(f.filename)
  const retained = f.directory + '-retained'
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-record-foreign-'))
  fs.chmodSync(foreign, 0o700)
  publish(path.join(foreign, '1.json'), { ...record, foreign: true })
  t.after(() => {
    fs.rmSync(retained, { recursive: true, force: true })
    fs.rmSync(foreign, { recursive: true, force: true })
  })
  const directory = openCanonicalStoreRecordDirectory(f.directory)
  try {
    fs.renameSync(f.directory, retained)
    fs.symlinkSync(foreign, f.directory)
    assert.deepEqual(readCanonicalStoreRecord(f.filename, directory), record)
    assert.throws(() => readCanonicalStoreRecord(f.filename))
  } finally { fs.closeSync(directory) }
})

function injectNativeRace(t, source, replacement) {
  const spawn = childProcess.spawnSync
  let injected = false
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    const modified = [...args]
    assert.equal(modified[3].split(source).length - 1, 1)
    modified[3] = modified[3].replace(source, replacement)
    injected = true
    return spawn(command, modified, options)
  })
  return () => assert.equal(injected, true, 'native read seam was actually exercised')
}

test('replacement after native descriptor validation cannot substitute a foreign record', t => {
  const f = fixture(t)
  publish(f.filename)
  publish(path.join(f.directory, 'foreign.json'), { ...record, foreign: true })
  const exercised = injectNativeRace(t, '    before = checked_stat(descriptor)',
    '    before = checked_stat(descriptor)\n' +
    '    os.unlink(name, dir_fd=3)\n' +
    '    os.symlink("foreign.json", name, dir_fd=3)')
  assert.throws(() => readCanonicalStoreRecord(f.filename), /Unsafe canonical-store record/)
  exercised()
})

test('same-size writes retain mtime but are rejected by native nanosecond ctime', t => {
  const f = fixture(t)
  publish(f.filename)
  const value = JSON.stringify({ ...record, sequence: 2 })
  const source = '        chunk = os.read(descriptor, before.st_size + 1 - length)'
  const exercised = injectNativeRace(t, source, source + '\n' +
    '        if chunk:\n' +
    '            writer = os.open(name, os.O_WRONLY, dir_fd=3)\n' +
    '            try:\n' +
    '                os.write(writer, ' + JSON.stringify(value) + '.encode())\n' +
    '                os.fsync(writer)\n' +
    '            finally:\n' +
    '                os.close(writer)\n' +
    '            os.utime(name, ns=(before.st_atime_ns, before.st_mtime_ns), dir_fd=3)')
  assert.throws(() => readCanonicalStoreRecord(f.filename), /changed during read/)
  exercised()
})

test('a transient hardlink cannot disappear between checks without changing native ctime', t => {
  const f = fixture(t)
  publish(f.filename)
  const source = '        chunk = os.read(descriptor, before.st_size + 1 - length)'
  const exercised = injectNativeRace(t, source, source + '\n' +
    '        if chunk:\n' +
    '            os.link(name, "transient.json", src_dir_fd=3, dst_dir_fd=3)\n' +
    '            os.unlink("transient.json", dir_fd=3)')
  assert.throws(() => readCanonicalStoreRecord(f.filename), /changed during read/)
  exercised()
})

test('stale run, sequence and phase remain rejected through the actual bound reader', t => {
  const f = fixture(t)
  publish(f.filename)
  for (const changed of [
    { runId: '30000000-0000-4000-8000-000000000003' },
    { sequence: 2 }, { phase: 'another-phase' }, { uiVerified: false },
  ]) assert.throws(() => readBoundRecord(f.filename, { ...record, ...changed }))
  assert.deepEqual(readBoundRecord(f.filename, record), record)
})
