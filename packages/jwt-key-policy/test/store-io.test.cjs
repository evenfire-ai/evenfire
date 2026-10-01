'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const policy = require('../index.cjs')
const storeApi = require('../dev-store.cjs')
const { errno, expectReason, fixture, keyPair, publishPair, snapshot, withFsPatches } = require('./store-fixtures.cjs')
const pair = keyPair()
const fingerprint = policy.publicKeyPemFingerprint(pair.publicKey)
const childFixture = path.join(__dirname, 'store-process-fixture.cjs')

test('lexical directory spellings reject the same final symlink', t => {
  const { root, store } = fixture(t)
  publishPair(store, pair)
  const before = snapshot(store)
  const link = path.join(root, 'directory-link')
  fs.symlinkSync(store, link)
  for (const suffix of ['', '/', '/.', '/./']) {
    expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', link + suffix), 'symbolic_link')
    expectReason(() => storeApi.readDevVerifierMaterial('rpc', link + suffix), 'symbolic_link')
  }
  assert.equal(storeApi.loadOrCreateDevSigningMaterial('rpc', store + '/./').fingerprint, fingerprint)
  assert.deepEqual(snapshot(store), before)
})

test('a trusted ancestor alias is allowed without following the final component', t => {
  const { root, store } = fixture(t)
  publishPair(store, pair)
  const alias = path.join(root, 'ancestor')
  fs.symlinkSync(root, alias)
  const directory = path.join(alias, 'store')
  assert.equal(storeApi.loadOrCreateDevSigningMaterial('rpc', directory).fingerprint, fingerprint)
  assert.equal(storeApi.readDevVerifierMaterial('rpc', directory).fingerprint, fingerprint)
})

test('directory ownership, type and permissions are validated', t => {
  const { root, store } = fixture(t)
  publishPair(store, pair)
  const regular = path.join(root, 'ordinary-file')
  fs.writeFileSync(regular, 'synthetic directory fixture', { mode: 0o600 })
  for (const operation of [storeApi.loadOrCreateDevSigningMaterial, storeApi.readDevVerifierMaterial]) {
    expectReason(() => operation('rpc', regular), 'invalid_directory')
    fs.chmodSync(store, 0o755)
    expectReason(() => operation('rpc', store), 'insecure_directory')
    fs.chmodSync(store, 0o700)
    withFsPatches({ lstatSync: original => (...args) => {
      const stats = original(...args)
      return args[0] === store ? Object.assign(Object.create(stats), { uid: process.geteuid() + 1 }) : stats
    } }, () => expectReason(() => operation('rpc', store), 'directory_owner_mismatch'))
  }
})

test('stricter and owner-executable existing permissions retain compatibility', t => {
  const { store } = fixture(t)
  publishPair(store, pair)
  for (const modes of [[0o500, 0o400, 0o444], [0o700, 0o700, 0o555], [0o1700, 0o600, 0o644]]) {
    fs.chmodSync(path.join(store, 'rpc.pem'), modes[1])
    fs.chmodSync(path.join(store, 'rpc.public.pem'), modes[2])
    fs.chmodSync(store, modes[0])
    try {
      const before = snapshot(store)
      assert.equal(storeApi.loadOrCreateDevSigningMaterial('rpc', store).fingerprint, fingerprint)
      assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, fingerprint)
      assert.deepEqual(snapshot(store), before)
    } finally { fs.chmodSync(store, 0o700) }
  }
})

for (const [filename, mode] of [['rpc.pem', 0o644], ['rpc.public.pem', 0o664]]) {
  test(`${filename} unsafe permissions fail without rewriting files`, t => {
    const { store } = fixture(t)
    publishPair(store, pair)
    fs.chmodSync(path.join(store, filename), mode)
    const before = snapshot(store)
    expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), 'insecure_file')
    assert.deepEqual(snapshot(store), before)
  })
}

for (const filename of ['rpc.pem', 'rpc.public.pem']) {
  for (const shape of ['directory', 'symlink']) {
    test(`${filename} rejects an unsuitable ${shape} fixture`, t => {
      const { root, store } = fixture(t)
      publishPair(store, pair)
      const target = path.join(store, filename)
      fs.unlinkSync(target)
      if (shape === 'directory') fs.mkdirSync(target, { mode: 0o700 })
      else {
        const source = path.join(root, 'other-owned-store')
        fs.mkdirSync(source, { mode: 0o700 })
        publishPair(source, pair)
        fs.symlinkSync(path.join(source, filename), target)
      }
      const before = snapshot(store)
      expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), shape === 'directory' ? 'not_regular_file' : 'symbolic_link')
      assert.deepEqual(snapshot(store), before)
    })
  }

  test(`${filename} validates the owner of the opened descriptor`, t => {
    const { store } = fixture(t)
    publishPair(store, pair)
    const opened = new Map()
    let checked = false
    withFsPatches({
      openSync: original => (file, ...args) => { const fd = original(file, ...args); opened.set(fd, file); return fd },
      closeSync: original => fd => { opened.delete(fd); return original(fd) },
      fstatSync: original => fd => {
        const stats = original(fd)
        if (opened.get(fd) === path.join(store, filename)) {
          checked = true
          return Object.assign(Object.create(stats), { uid: process.geteuid() + 1 })
        }
        return stats
      },
    }, () => expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), 'file_owner_mismatch'))
    assert.equal(checked, true)
    assert.equal(opened.size, 0)
  })
}

test('unsupported POSIX effective-user guarantees fail before filesystem access', () => {
  const original = process.geteuid
  process.geteuid = undefined
  try {
    withFsPatches({ lstatSync: () => () => { throw new Error('unexpected filesystem access') } }, () => {
      expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', '/unused'), 'unsupported_platform')
      expectReason(() => storeApi.readDevVerifierMaterial('rpc', '/unused'), 'unsupported_platform')
      assert.equal(storeApi.resolveDevKeyStoreDir('/service'), '/service/.dev-keys')
    })
  } finally { process.geteuid = original }
})

for (const stage of ['fstatSync', 'readSync']) {
  test(`${stage} errors close the descriptor and preserve the primary failure`, t => {
    const { store } = fixture(t)
    publishPair(store, pair)
    const primary = errno('EIO')
    const held = new Set()
    withFsPatches({
      openSync: original => (...args) => { const fd = original(...args); held.add(fd); return fd },
      closeSync: original => fd => { held.delete(fd); return original(fd) },
      [stage]: () => () => { throw primary },
    }, () => assert.throws(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), failure => failure === primary))
    assert.equal(held.size, 0)
  })
}

test('initial oversize and growth past the bound fail with closed descriptors', t => {
  const { store } = fixture(t)
  publishPair(store, pair)
  const file = path.join(store, 'rpc.public.pem')
  fs.writeFileSync(file, 'x'.repeat(policy.MAX_PEM_MATERIAL_BYTES + 1))
  expectReason(() => storeApi.readDevVerifierMaterial('rpc', store), 'material_too_large')
  fs.writeFileSync(file, pair.publicKey)
  const held = new Set()
  let grew = false
  withFsPatches({
    openSync: original => (...args) => { const fd = original(...args); held.add(fd); return fd },
    closeSync: original => fd => { held.delete(fd); return original(fd) },
    readSync: original => (...args) => {
      if (!grew) { grew = true; fs.appendFileSync(file, 'x'.repeat(policy.MAX_PEM_MATERIAL_BYTES)) }
      return original(...args)
    },
  }, () => expectReason(() => storeApi.readDevVerifierMaterial('rpc', store), 'material_too_large'))
  assert.equal(grew, true)
  assert.equal(held.size, 0)
})

test('exact-bound valid material and short reads use a single bounded buffer', t => {
  const { store } = fixture(t)
  const file = path.join(store, 'rpc.public.pem')
  const padding = policy.MAX_PEM_MATERIAL_BYTES - Buffer.byteLength(pair.publicKey)
  fs.writeFileSync(file, pair.publicKey + ' '.repeat(padding), { mode: 0o644 })
  assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, fingerprint)
  fs.writeFileSync(file, pair.publicKey)
  let allocated
  let reads = 0
  withFsPatches({ readSync: original => (fd, buffer, offset, length, position) => {
    allocated ??= buffer
    assert.equal(buffer === allocated, true)
    assert.equal(buffer.length, policy.MAX_PEM_MATERIAL_BYTES + 1)
    reads += 1
    return original(fd, buffer, offset, Math.min(1, length), position)
  } }, () => assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, fingerprint))
  assert.equal(reads > 1, true)
})

for (const [filename, operation] of [['rpc.pem', 'sign'], ['rpc.public.pem', 'sign'], ['rpc.public.pem', 'verify']]) {
  test(`${operation} rejects a ${filename} FIFO within a finite child deadline`, t => {
    const { store } = fixture(t)
    publishPair(store, pair)
    const run = () => spawnSync(process.execPath, [childFixture, operation, store], { encoding: 'utf8', timeout: 2500, env: { PATH: process.env.PATH } })
    const positive = run()
    assert.equal(positive.status, 0)
    assert.deepEqual(JSON.parse(positive.stdout), { outcome: 'accepted', fingerprint })
    const file = path.join(store, filename)
    fs.unlinkSync(file)
    assert.equal(spawnSync('/usr/bin/mkfifo', ['-m', '600', file]).status, 0)
    const negative = run()
    assert.equal(negative.error?.code === 'ETIMEDOUT', false)
    assert.equal(negative.status, 0)
    assert.deepEqual(JSON.parse(negative.stdout), { outcome: 'rejected', reason: 'not_regular_file', code: 'ERR_JWT_DEV_STORE' })
    assert.equal(fs.lstatSync(file).isFIFO(), true)
  })
}
