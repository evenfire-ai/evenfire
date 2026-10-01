'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const policy = require('../index.cjs')
const storeApi = require('../dev-store.cjs')
const { expectReason, fixture, keyPair, publishPair, snapshot, storeWithPolicy, temporaries, withFsPatches } = require('./store-fixtures.cjs')
const { certificate, PUBLIC_KEYS } = require('./crypto-fixtures.cjs')
const pair = keyPair()
const anotherPair = keyPair()
const fingerprint = policy.publicKeyPemFingerprint(pair.publicKey)

test('store resolution is lexical, absolute and free of filesystem access', () => {
  withFsPatches({ lstatSync: () => () => { throw new Error('unexpected directory access') }, mkdirSync: () => () => { throw new Error('unexpected creation') } }, () => {
    for (const override of [undefined, '', ' \t\n ']) {
      assert.equal(storeApi.resolveDevKeyStoreDir('/service-root', override), '/service-root/.dev-keys')
    }
    assert.equal(storeApi.resolveDevKeyStoreDir('/unused-root', ' /absolute/store/./ '), '/absolute/store')
    expectReason(() => storeApi.resolveDevKeyStoreDir('/service-root', 'relative'), 'relative_store_path')
    expectReason(() => storeApi.resolveDevKeyStoreDir('relative'), 'relative_store_path')
  })
})

test('closed slots and relative paths fail before any filesystem operation', () => {
  withFsPatches({ lstatSync: () => () => { throw new Error('unexpected filesystem access') } }, () => {
    for (const slot of ['', '../rpc', 'voucher', undefined]) {
      expectReason(() => storeApi.loadOrCreateDevSigningMaterial(slot, '/unused'), 'invalid_slot')
      expectReason(() => storeApi.readDevVerifierMaterial(slot, '/unused'), 'invalid_slot')
    }
    expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', 'relative'), 'relative_store_path')
    expectReason(() => storeApi.readDevVerifierMaterial('rpc', 'relative'), 'relative_store_path')
  })
})

test('missing directory and empty slot create a complete canonical pair', t => {
  const { root } = fixture(t)
  const directory = path.join(root, 'missing')
  const material = storeApi.loadOrCreateDevSigningMaterial('rpc', directory)
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(directory, 'rpc.pem')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(directory, 'rpc.public.pem')).mode & 0o777, 0o644)
  assert.equal(policy.publicKeyPemFingerprint(material.privatePem), material.fingerprint)
  assert.equal(policy.publicKeyPemFingerprint(material.publicPem), material.fingerprint)
  assert.equal(storeApi.readDevVerifierMaterial('rpc', directory).fingerprint, material.fingerprint)
  assert.deepEqual(temporaries(directory), [])
})

test('complete pairs and independent slots preserve their existing identities and bytes', t => {
  const { store } = fixture(t)
  publishPair(store, pair)
  const before = snapshot(store)
  const first = storeApi.loadOrCreateDevSigningMaterial('rpc', store)
  const second = storeApi.loadOrCreateDevSigningMaterial('rpc', store)
  assert.equal(first.fingerprint, fingerprint)
  assert.equal(second.fingerprint, fingerprint)
  assert.deepEqual(snapshot(store), before)
  const session = storeApi.loadOrCreateDevSigningMaterial('session', store)
  assert.notEqual(session.fingerprint, first.fingerprint)
})

test('private-only state publishes its public half without rewriting the private', t => {
  const { store } = fixture(t)
  fs.writeFileSync(path.join(store, 'rpc.pem'), pair.privateKey, { mode: 0o600 })
  const before = snapshot(store)['rpc.pem']
  assert.equal(storeApi.loadOrCreateDevSigningMaterial('rpc', store).fingerprint, fingerprint)
  assert.deepEqual(snapshot(store)['rpc.pem'], before)
  assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, fingerprint)
})

test('equivalent PKCS1, CRLF and X509 public carriers are reused without rewriting either file', t => {
  const { root } = fixture(t)
  const forms = [
    crypto.createPublicKey(pair.publicKey).export({ type: 'pkcs1', format: 'pem' }).toString(),
    pair.publicKey.replace(/\n/g, '\r\n'),
    certificate(crypto.createPrivateKey(pair.privateKey)),
  ]
  for (let index = 0; index < forms.length; index++) {
    const directory = path.join(root, `encoding-${index}`)
    fs.mkdirSync(directory, { mode: 0o700 })
    publishPair(directory, { ...pair, publicKey: forms[index] })
    const before = snapshot(directory)
    const result = storeApi.loadOrCreateDevSigningMaterial('rpc', directory)
    assert.equal(result.fingerprint, fingerprint)
    assert.equal(storeApi.readDevVerifierMaterial('rpc', directory).fingerprint, fingerprint)
    assert.deepEqual(snapshot(directory), before)
  }
})

test('orphan public state fails without generating or altering an identity', t => {
  const { store } = fixture(t)
  fs.writeFileSync(path.join(store, 'rpc.public.pem'), pair.publicKey, { mode: 0o644 })
  const before = snapshot(store)
  const generate = crypto.generateKeyPairSync
  crypto.generateKeyPairSync = () => { throw new Error('unexpected replacement generation') }
  try { expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), 'orphan_public') }
  finally { crypto.generateKeyPairSync = generate }
  assert.deepEqual(snapshot(store), before)
  assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, fingerprint)
})

for (const state of ['corrupt', 'unsafe', 'historical']) {
  test(`public-only ${state} material never creates a replacement signing identity`, t => {
    const { store } = fixture(t)
    const file = path.join(store, 'rpc.public.pem')
    let value = pair.publicKey
    if (state === 'corrupt') value = 'synthetic invalid public fixture'
    if (state === 'historical') value = PUBLIC_KEYS.rpc
    fs.writeFileSync(file, value, { mode: 0o644 })
    if (state === 'unsafe') fs.chmodSync(file, 0o666)
    const before = snapshot(store)
    const generate = crypto.generateKeyPairSync
    crypto.generateKeyPairSync = () => { throw new Error('unexpected replacement generation') }
    try {
      expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), {
        corrupt: 'invalid_pem', unsafe: 'insecure_file', historical: 'banned_identity',
      }[state])
    } finally { crypto.generateKeyPairSync = generate }
    assert.deepEqual(snapshot(store), before)
  })
}

test('a complete cooperating pair appearing after the missing-private read is adopted', t => {
  const { store } = fixture(t)
  const privatePath = path.join(store, 'rpc.pem')
  let first = true
  withFsPatches({ openSync: original => (file, ...args) => {
    if (file === privatePath && first) {
      first = false
      try { return original(file, ...args) } catch (error) {
        if (error.code === 'ENOENT') publishPair(store, pair)
        throw error
      }
    }
    return original(file, ...args)
  } }, () => assert.equal(storeApi.loadOrCreateDevSigningMaterial('rpc', store).fingerprint, fingerprint))
  assert.deepEqual(temporaries(store), [])
})

for (const [name, privateValue, publicValue, reason] of [
  ['corrupt private with public', 'synthetic invalid private', pair.publicKey, 'invalid_pem'],
  ['corrupt private without public', 'synthetic invalid private', undefined, 'invalid_pem'],
  ['public in private slot', pair.publicKey, pair.publicKey, 'wrong_key_role'],
  ['private in public slot', pair.privateKey, pair.privateKey, 'wrong_key_role'],
  ['corrupt public with private', pair.privateKey, 'synthetic invalid public', 'invalid_pem'],
  ['different public identity', pair.privateKey, anotherPair.publicKey, 'public_identity_mismatch'],
]) {
  test(`${name} fails with a specific reason and preserves all files`, t => {
    const { store } = fixture(t)
    fs.writeFileSync(path.join(store, 'rpc.pem'), privateValue, { mode: 0o600 })
    if (publicValue !== undefined) fs.writeFileSync(path.join(store, 'rpc.public.pem'), publicValue, { mode: 0o644 })
    const before = snapshot(store)
    expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), reason)
    assert.deepEqual(snapshot(store), before)
  })
}

for (const half of ['private', 'public']) {
  test(`a generated-denied ${half} identity fails through the real parser and preserves the pair`, t => {
    const { store } = fixture(t)
    publishPair(store, pair)
    const before = snapshot(store)
    const restricted = storeWithPolicy(real => ({ ...real,
      ...(half === 'private'
        ? { parseSigningMaterial: (raw, source) => real.parseSigningMaterial(raw, source, { fingerprints: [fingerprint] }) }
        : { parseVerifierMaterial: (raw, source, options) => real.parseVerifierMaterial(raw, source, { ...options, fingerprints: [fingerprint] }) }),
    }))
    expectReason(() => restricted.loadOrCreateDevSigningMaterial('rpc', store), 'banned_identity')
    assert.deepEqual(snapshot(store), before)
  })
}

test('a verifier never creates missing material or opens private material', t => {
  const { root, store } = fixture(t)
  const missing = path.join(root, 'missing')
  expectReason(() => storeApi.readDevVerifierMaterial('rpc', missing), 'missing_material')
  assert.equal(fs.existsSync(missing), false)
  expectReason(() => storeApi.readDevVerifierMaterial('rpc', store), 'missing_material')
  assert.deepEqual(fs.readdirSync(store), [])
  publishPair(store, pair)
  fs.unlinkSync(path.join(store, 'rpc.pem'))
  withFsPatches({ openSync: original => (file, ...args) => {
    assert.equal(file.endsWith('rpc.pem'), false, 'verifier must not read the signing file')
    return original(file, ...args)
  } }, () => assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, fingerprint))
})
