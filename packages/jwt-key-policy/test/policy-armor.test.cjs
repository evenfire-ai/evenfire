'use strict'

const assert = require('node:assert/strict')
const { generateKeyPairSync, randomUUID } = require('node:crypto')
const { test } = require('node:test')
const {
  MAX_PEM_MATERIAL_BYTES, JwtKeyMaterialError, normalizePem,
  parseSigningMaterial, parseVerifierMaterial,
} = require('../index.cjs')
const { fixtures, pem, encodings } = require('./crypto-fixtures.cjs')

function rejected(action, reason) {
  assert.throws(action, error => error instanceof JwtKeyMaterialError && error.code === 'ERR_JWT_KEY_INVALID' && error.reason === reason)
}

test('normalization accepts every supported raw and escaped newline representation', () => {
  const publicPem = pem(fixtures()[2048].publicKey, 'spki')
  for (const encoding of ['lf', 'crlf', 'cr', 'escapedLf', 'escapedCrlf', 'escapedCr', 'bom', 'outsideWhitespace']) {
    assert.ok(normalizePem(encodings(publicPem)[encoding]) === publicPem, encoding)
  }
})

test('complete single objects reject unmatched, truncated and unsupported armor', () => {
  const publicPem = pem(fixtures()[2048].publicKey, 'spki')
  for (const raw of [
    publicPem.replace(/-----END [^-]+-----/, ''),
    publicPem.replace('END PUBLIC KEY', 'END CERTIFICATE'),
    publicPem.replace(/^-----BEGIN [^-]+-----/, ''),
    publicPem.split('\n').reverse().join('\n'),
  ]) rejected(() => parseVerifierMaterial(raw, 'ARMOR_CONTRACT'), 'invalid_pem')
  for (const raw of [
    publicPem + '\n-----BEGIN CERTIFICATE----',
    '-----END CERTIFICATE----\n' + publicPem,
    publicPem + '\n-----begin malformed armor',
  ]) rejected(() => parseVerifierMaterial(raw, 'EXTRA_ARMOR_CONTRACT'), 'multiple_pem_objects')
  // Invalid-body fixtures intentionally exercise armor/type rejection before crypto parsing.
  for (const label of ['OPENSSH PRIVATE KEY', 'DSA PUBLIC KEY', 'UNKNOWN OBJECT']) {
    const raw = `-----BEGIN ${label}-----\nAA==\n-----END ${label}-----`
    rejected(() => parseVerifierMaterial(raw, 'UNSUPPORTED_ARMOR_CONTRACT'), 'unsupported_pem_type')
    rejected(() => parseSigningMaterial(raw, 'UNSUPPORTED_SIGNER_CONTRACT'), 'unsupported_pem_type')
  }
  const invalidBody = publicPem.replace(/\n[\s\S]+\n-----END/, '\ninvalid-generated-body\n-----END')
  rejected(() => parseVerifierMaterial(invalidBody, 'INVALID_BODY_CONTRACT'), 'invalid_pem')
})

test('public-only sources cannot supply signing keys and stores cannot accept private carriers', () => {
  const pair = fixtures()[2048]
  rejected(() => parseSigningMaterial(pem(pair.publicKey, 'spki'), 'WRONG_SIGNER_ROLE'), 'wrong_key_role')
  for (const type of ['pkcs8', 'pkcs1']) {
    const signing = pem(pair.privateKey, type)
    rejected(() => parseVerifierMaterial(signing, 'WRONG_STORE_ROLE', { origin: 'store' }), 'wrong_key_role')
    assert.equal(typeof parseVerifierMaterial(signing, 'LEGACY_ENV_ROLE').fingerprint, 'string')
  }
})

test('every role rejects RSA below 2048 bits and non-RSA signing/verifying objects', () => {
  const weak = fixtures()[1024]
  rejected(() => parseSigningMaterial(pem(weak.privateKey, 'pkcs8'), 'WEAK_SIGNER'), 'undersized_rsa_key')
  for (const origin of ['environment', 'store']) {
    rejected(() => parseVerifierMaterial(pem(weak.publicKey, 'spki'), 'WEAK_VERIFIER', { origin }), 'undersized_rsa_key')
  }
  const alternatives = [
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    generateKeyPairSync('ed25519'),
    generateKeyPairSync('dsa', { modulusLength: 2048, divisorLength: 256 }),
    generateKeyPairSync('rsa-pss', { modulusLength: 2048, hashAlgorithm: 'sha256', mgf1HashAlgorithm: 'sha256', saltLength: 32 }),
  ]
  for (const pair of alternatives) {
    rejected(() => parseSigningMaterial(pem(pair.privateKey, 'pkcs8'), 'NON_RSA_SIGNER'), 'non_rsa_key')
    for (const origin of ['environment', 'store']) {
      rejected(() => parseVerifierMaterial(pem(pair.publicKey, 'spki'), 'NON_RSA_VERIFIER', { origin }), 'non_rsa_key')
    }
  }
})

test('encrypted private material is rejected without password handling or fallback', () => {
  for (const type of ['pkcs8', 'pkcs1']) {
    const options = Object.fromEntries([['type', type], ['format', 'pem'], ['cipher', 'aes-256-cbc'], ['passphrase', randomUUID()]])
    const encrypted = fixtures()[2048].privateKey.export(options).toString()
    rejected(() => parseSigningMaterial(encrypted, 'ENCRYPTED_SIGNER'), 'encrypted_private_key')
    rejected(() => parseVerifierMaterial(encrypted, 'ENCRYPTED_ENV'), 'encrypted_private_key')
  }
})

test('DER, JWK and OpenSSH representations cannot enter the PEM contract', () => {
  const pair = fixtures()[2048]
  const values = [
    pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    JSON.stringify(pair.publicKey.export({ format: 'jwk' })),
    'ssh-rsa ' + pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  ]
  for (const raw of values) {
    rejected(() => parseSigningMaterial(raw, 'NON_PEM_SIGNER'), 'invalid_pem')
    rejected(() => parseVerifierMaterial(raw, 'NON_PEM_VERIFIER'), 'invalid_pem')
  }
})

test('the raw UTF8 bound is applied before parsing or escape normalization', () => {
  assert.equal(MAX_PEM_MATERIAL_BYTES, 65536)
  const publicPem = pem(fixtures()[2048].publicKey, 'spki')
  const exact = 'x'.repeat(MAX_PEM_MATERIAL_BYTES - Buffer.byteLength(publicPem) - 1) + '\n' + publicPem
  assert.equal(Buffer.byteLength(exact), MAX_PEM_MATERIAL_BYTES)
  assert.equal(typeof parseVerifierMaterial(exact, 'EXACT_BOUND').fingerprint, 'string')
  for (const raw of [exact + 'x', '\\r'.repeat(MAX_PEM_MATERIAL_BYTES / 2) + publicPem, 'é'.repeat(MAX_PEM_MATERIAL_BYTES / 2) + publicPem]) {
    rejected(() => parseSigningMaterial(raw, 'OVERSIZED_SIGNER'), 'material_too_large')
    rejected(() => parseVerifierMaterial(raw, 'OVERSIZED_VERIFIER'), 'material_too_large')
    rejected(() => normalizePem(raw), 'material_too_large')
  }
})

test('safe contextual failures contain neither input material nor native crypto errors', () => {
  const signing = pem(fixtures()[2048].privateKey, 'pkcs8')
  assert.throws(() => parseVerifierMaterial(signing, signing, { origin: 'store' }), error => {
    assert.equal(error instanceof JwtKeyMaterialError, true)
    assert.equal(error.code, 'ERR_JWT_KEY_INVALID')
    assert.equal(error.source, 'JWT key material')
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.equal(error.message.includes(signing.slice(0, 60)), false)
    assert.equal(JSON.stringify(error).includes(signing.split('\n')[1]), false)
    assert.equal(/OSSL|DECODER|asn1/i.test(error.message), false)
    return true
  })
  assert.throws(() => parseVerifierMaterial('invalid', 'VERIFIER_SOURCE'), error =>
    error instanceof JwtKeyMaterialError && error.message.includes('VERIFIER_SOURCE'))
  rejected(() => parseVerifierMaterial('invalid', 'VERIFIER_SOURCE', { origin: 'unknown' }), 'invalid_type')
  for (const raw of [undefined, null, Buffer.from('invalid'), 1]) {
    rejected(() => parseSigningMaterial(raw, 'INVALID_TYPE'), 'invalid_type')
  }
  for (const fingerprints of [null, 1, {}, ['not-an-identity']]) {
    rejected(() => parseSigningMaterial(signing, 'INVALID_POLICY_OPTIONS', { fingerprints }), 'invalid_type')
  }
})

test('unsafe diagnostic sources are redacted in parser errors and serialized metadata', () => {
  // Synthetic labels exercise redaction without embedding any credentials.
  for (const source of [
    undefined, null, 1, {}, '', '/synthetic/dev-store/rpc.pem', '9invalid',
    '.invalid', 'A'.repeat(161), 'label-----suffix', 'Bearer x', 'Basic x',
    'label bEaReR x', 'label bAsIc x', 'label\nsecond line', 'label?query',
  ]) {
    for (const parse of [parseSigningMaterial, parseVerifierMaterial]) {
      assert.throws(() => parse('invalid', source), error => {
        assert.equal(error instanceof JwtKeyMaterialError, true)
        assert.equal(error.source, 'JWT key material')
        assert.equal(error.message.startsWith('JWT key material '), true)
        if (typeof source === 'string' && source !== '') {
          assert.equal(error.message.includes(source), false)
          assert.equal(JSON.stringify(error).includes(source), false)
        }
        return true
      })
    }
  }
})

test('safe diagnostic sources retain their context through the maximum label length', () => {
  for (const source of ['VERIFIER_SOURCE', 'rpc.pem', 'dev JWT signing key (rpc.pem)', 'A'.repeat(160)]) {
    for (const parse of [parseSigningMaterial, parseVerifierMaterial]) {
      assert.throws(() => parse('invalid', source), error => {
        assert.equal(error.source, source)
        assert.equal(error.message.startsWith(source + ' '), true)
        return true
      })
    }
  }
})
