'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

function keyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-jwt-store-test-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = path.join(root, 'store')
  fs.mkdirSync(store, { mode: 0o700 })
  return { root, store }
}

function publishPair(directory, pair, slot = 'rpc') {
  fs.writeFileSync(path.join(directory, `${slot}.pem`), pair.privateKey, { mode: 0o600 })
  fs.writeFileSync(path.join(directory, `${slot}.public.pem`), pair.publicKey, { mode: 0o644 })
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function snapshotFile(file) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    if (error.code !== 'ELOOP') throw error
    const stats = fs.lstatSync(file)
    return { mode: stats.mode & 0o7777, type: stats.isSymbolicLink() ? 'symlink' : 'other', hash: null }
  }
  try {
    const stats = fs.fstatSync(fd)
    const result = { mode: stats.mode & 0o7777, type: stats.isFile() ? 'file' : 'other', hash: null }
    if (!stats.isFile()) return result
    // Fault fixtures intentionally exceed the production 64 KiB bound. Hash
    // their actual bytes through the opened descriptor, never reopen a path.
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(8192)
    let total = 0
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      total += read
      assert.ok(total <= 1024 * 1024, 'Snapshot fixture exceeds its 1 MiB bound')
      hash.update(buffer.subarray(0, read))
    }
    result.hash = hash.digest('hex')
    return result
  } finally {
    fs.closeSync(fd)
  }
}

function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name)
    return [name, snapshotFile(file)]
  }))
}

function expectReason(run, reason) {
  assert.throws(run, error => error.reason === reason)
}

function withFsPatches(patches, run) {
  const originals = {}
  for (const [name, build] of Object.entries(patches)) {
    originals[name] = fs[name]
    fs[name] = build(originals[name])
  }
  try { return run() } finally {
    for (const [name, original] of Object.entries(originals)) fs[name] = original
  }
}

function storeWithPolicy(transform) {
  // Execute the unchanged store with a locally scoped policy wrapper. The
  // wrapper delegates to the real parser with generated fingerprint vectors;
  // neither exported policy state nor production dependency seams are mutated.
  const filename = require.resolve('../dev-store.cjs')
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  const ordinaryRequire = loaded.require.bind(loaded)
  loaded.require = name => name === './index.cjs'
    ? transform(require('../index.cjs'))
    : ordinaryRequire(name)
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename)
  return loaded.exports
}

function errno(code, label = 'injected local filesystem failure') {
  return Object.assign(new Error(label), { code })
}

function temporaries(directory) {
  return fs.readdirSync(directory).filter(name => name.includes('.tmp-'))
}

module.exports = {
  digest,
  errno,
  expectReason,
  fixture,
  keyPair,
  publishPair,
  snapshot,
  storeWithPolicy,
  temporaries,
  withFsPatches,
}
