'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

test('CommonJS and native ESM consumers load the public package contract', async () => {
  const commonJs = require('@clerum/jwt-key-policy')
  const nativeEsm = await import('@clerum/jwt-key-policy')
  for (const name of [
    'normalizePem', 'parseSigningMaterial', 'parseVerifierMaterial',
    'publicKeyPemFingerprint', 'isBannedSigningKeyPem', 'isBannedPublicKeyPem', 'JwtKeyMaterialError',
  ]) {
    assert.equal(typeof commonJs[name], 'function', name)
    assert.equal(nativeEsm[name] === commonJs[name], true, name)
  }
  assert.equal(nativeEsm.MAX_PEM_MATERIAL_BYTES, 65536)
  assert.equal(nativeEsm.HISTORICAL_PUBLIC_KEY_FINGERPRINTS === commonJs.HISTORICAL_PUBLIC_KEY_FINGERPRINTS, true)
})
