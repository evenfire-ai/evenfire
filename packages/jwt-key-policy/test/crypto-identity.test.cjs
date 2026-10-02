'use strict'

const assert = require('node:assert/strict')
const { createPrivateKey, createPublicKey, sign, verify } = require('node:crypto')
const { test } = require('node:test')
const {
  HISTORICAL_PUBLIC_KEY_FINGERPRINTS,
  JwtKeyMaterialError,
  parseSigningMaterial,
  parseVerifierMaterial,
  publicKeyPemFingerprint,
  isBannedSigningKeyPem,
  isBannedPublicKeyPem,
} = require('../index.cjs')
const { PUBLIC_KEYS, pem, fixtures, encodings, certificate, certificateWithPublic } = require('./crypto-fixtures.cjs')

function rejected(action, reason, label) {
  assert.throws(action, error => error instanceof JwtKeyMaterialError && error.reason === reason, label)
}
function provesSignature(material, expectedPublic, label) {
  const payload = Buffer.from('JWT policy RSA identity proof')
  const signature = sign('RSA-SHA256', payload, material.privatePem)
  assert.equal(verify('RSA-SHA256', payload, material.publicPem, signature), true, label)
  assert.equal(verify('RSA-SHA256', payload, expectedPublic, signature), true, label)
  assert.equal(material.fingerprint, publicKeyPemFingerprint(expectedPublic), label)
  // Compare private bytes only as a boolean; assertion failures cannot print them.
  assert.ok(material.privatePem === pem(createPrivateKey(material.privatePem), 'pkcs8'), label)
  assert.ok(material.publicPem === pem(createPublicKey(createPrivateKey(material.privatePem)), 'spki'), label)
}

for (const bits of [2048, 4096]) {
  test(`RSA-${bits} PKCS8/PKCS1 signing variants preserve the actual identity`, () => {
    const pair = fixtures()[bits]
    const expectedPublic = pem(pair.publicKey, 'spki')
    for (const type of ['pkcs8', 'pkcs1']) {
      for (const [encoding, value] of Object.entries(encodings(pem(pair.privateKey, type)))) {
        const label = `${bits}/${type}/${encoding}`
        provesSignature(parseSigningMaterial(value, 'SIGNING_CONTRACT'), expectedPublic, label)
      }
    }
  })
  test(`RSA-${bits} verifier carriers and encodings canonicalize before consumption`, () => {
    const pair = fixtures()[bits]
    const expectedPublic = pem(pair.publicKey, 'spki')
    const carriers = {
      spki: expectedPublic, pkcs1Public: pem(pair.publicKey, 'pkcs1'), x509: certificate(pair.privateKey),
      pkcs8Private: pem(pair.privateKey, 'pkcs8'), pkcs1Private: pem(pair.privateKey, 'pkcs1'),
    }
    const payload = Buffer.from('JWT policy verifier carrier proof')
    const signature = sign('RSA-SHA256', payload, pair.privateKey)
    for (const [carrier, raw] of Object.entries(carriers)) {
      for (const [encoding, value] of Object.entries(encodings(raw))) {
        for (const origin of ['environment', 'store']) {
          const label = `${bits}/${carrier}/${encoding}/${origin}`
          if (origin === 'store' && carrier.endsWith('Private')) {
            rejected(() => parseVerifierMaterial(value, 'PUBLIC_STORE_CONTRACT', { origin }), 'wrong_key_role', label)
            continue
          }
          const material = parseVerifierMaterial(value, 'VERIFIER_CONTRACT', { origin })
          assert.ok(material.publicPem === expectedPublic, label)
          assert.equal(material.fingerprint, publicKeyPemFingerprint(expectedPublic), label)
          assert.equal(verify('RSA-SHA256', payload, material.publicPem, signature), true, label)
          assert.equal(Object.hasOwn(material, 'privatePem'), false, label)
        }
      }
    }
  })
}

test('historical defaults have one immutable owner and metadata remains identifiable', () => {
  assert.equal(Object.isFrozen(HISTORICAL_PUBLIC_KEY_FINGERPRINTS), true)
  assert.equal(HISTORICAL_PUBLIC_KEY_FINGERPRINTS.length, 3)
  assert.throws(() => HISTORICAL_PUBLIC_KEY_FINGERPRINTS.push('0'.repeat(64)), TypeError)
  for (const publicPem of Object.values(PUBLIC_KEYS)) {
    assert.equal(HISTORICAL_PUBLIC_KEY_FINGERPRINTS.includes(publicKeyPemFingerprint(publicPem)), true)
    assert.equal(isBannedPublicKeyPem(publicPem), true)
  }
})

test('all historical identities are rejected across public carriers, encodings and origins', async () => {
  for (const [identity, publicPem] of Object.entries(PUBLIC_KEYS)) {
    const carriers = {
      spki: publicPem, pkcs1: pem(createPublicKey(publicPem), 'pkcs1'), x509: await certificateWithPublic(publicPem),
    }
    for (const [carrier, raw] of Object.entries(carriers)) {
      for (const [encoding, value] of Object.entries(encodings(raw))) {
        for (const origin of ['environment', 'store']) {
          const label = `${identity}/${carrier}/${encoding}/${origin}`
          rejected(() => parseVerifierMaterial(value, 'HISTORICAL_CONTRACT', { origin, fingerprints: [] }), 'banned_identity', label)
        }
        rejected(() => parseSigningMaterial(value, 'HISTORICAL_SIGNER_CONTRACT'), 'wrong_key_role', `${identity}/${carrier}/${encoding}`)
      }
    }
  }
})

test('extra denied identities are scoped, additive and enforced for signers and every verifier origin', () => {
  const pair = fixtures()[2048]
  const signing = pem(pair.privateKey, 'pkcs8')
  const publicPem = pem(pair.publicKey, 'spki')
  const fingerprints = new Set([publicKeyPemFingerprint(publicPem)])
  assert.equal(isBannedSigningKeyPem(signing), false)
  assert.equal(isBannedSigningKeyPem(signing, fingerprints), true)
  assert.equal(isBannedPublicKeyPem(publicPem, fingerprints), true)
  for (const [encoding, value] of Object.entries(encodings(signing))) {
    rejected(() => parseSigningMaterial(value, 'EXTRA_SIGNER_CONTRACT', { fingerprints }), 'banned_identity', encoding)
    rejected(() => parseVerifierMaterial(value, 'EXTRA_ENV_CONTRACT', { fingerprints }), 'banned_identity', encoding)
  }
  for (const origin of ['environment', 'store']) {
    rejected(() => parseVerifierMaterial(publicPem, 'EXTRA_PUBLIC_CONTRACT', { origin, fingerprints }), 'banned_identity', origin)
  }
  fingerprints.clear()
  provesSignature(parseSigningMaterial(signing, 'FRESH_CONTRACT'), publicPem, 'scope does not mutate defaults')
  for (const publicKey of Object.values(PUBLIC_KEYS)) {
    rejected(() => parseVerifierMaterial(publicKey, 'DEFAULT_BAN_CONTRACT', { fingerprints }), 'banned_identity', 'empty overrides retain the default ban')
  }
})

test('canonical signing output cannot select a second certificate or public identity', () => {
  const pair = fixtures()[2048]
  const decoy = fixtures().decoy
  const signing = pem(pair.privateKey, 'pkcs8')
  const otherPublic = pem(decoy.publicKey, 'spki')
  const otherCertificate = certificate(decoy.privateKey)
  for (const second of [otherPublic, otherCertificate, pem(decoy.privateKey, 'pkcs8')]) {
    for (const raw of [signing + '\n' + second, second + '\n' + signing]) {
      for (const value of [raw, raw.replace(/\n/g, '\\r\\n')]) {
        rejected(() => parseSigningMaterial(value, 'MIXED_SIGNER_CONTRACT'), 'multiple_pem_objects', 'mixed signer')
        for (const origin of ['environment', 'store']) {
          rejected(() => parseVerifierMaterial(value, 'MIXED_VERIFIER_CONTRACT', { origin }), 'multiple_pem_objects', origin)
        }
      }
    }
  }
  const canonical = parseSigningMaterial(signing, 'FRESH_SIGNER_CONTRACT')
  const payload = Buffer.from('Distinct public identity proof')
  const signature = sign('RSA-SHA256', payload, canonical.privatePem)
  assert.equal(verify('RSA-SHA256', payload, otherPublic, signature), false)
  provesSignature(canonical, pem(pair.publicKey, 'spki'), 'correct identity remains usable')
})

test('raw-before-normalized historical carrier substitution stays rejected', () => {
  const signing = pem(fixtures()[2048].privateKey, 'pkcs8')
  for (const publicPem of Object.values(PUBLIC_KEYS)) {
    const raw = signing + '\n' + publicPem.replace(/\n/g, '\\n')
    rejected(() => parseVerifierMaterial(raw, 'R1_VERIFIER_CONTRACT'), 'multiple_pem_objects', 'R1 preserved')
  }
})
