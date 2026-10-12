'use strict'

const assert = require('node:assert/strict')
const { X509Certificate, createPublicKey } = require('node:crypto')
const { test } = require('node:test')
const {
  PUBLIC_KEYS,
  certificate,
  certificateWithPublic,
  fixtures,
} = require('./crypto-fixtures.cjs')

test('fixture certificates are valid signed X509 public-key carriers', async () => {
  const pair = fixtures()[2048]
  const ownCertificate = new X509Certificate(certificate(pair.privateKey))
  assert.equal(
    ownCertificate.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  )
  assert.equal(ownCertificate.verify(pair.publicKey), true)
  assert.equal(ownCertificate.verify(fixtures().decoy.publicKey), false)

  const carrier = certificateWithPublic(PUBLIC_KEYS.rpc)
  assert.equal(carrier instanceof Promise, true)
  const historicalCertificate = new X509Certificate(await carrier)
  const expectedPublic = createPublicKey(PUBLIC_KEYS.rpc).export({ type: 'spki', format: 'der' })
  assert.equal(
    historicalCertificate.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    expectedPublic.toString('base64')
  )
  assert.equal(historicalCertificate.verify(pair.publicKey), true)
  assert.equal(historicalCertificate.verify(fixtures().decoy.publicKey), false)
})
