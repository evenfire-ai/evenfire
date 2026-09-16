import assert from 'node:assert/strict'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import test from 'node:test'
import { createFixtureTls } from '../e2e/_lib/hcc-watch-tls.mjs'

for (const hostname of ['proxy-fixture.test-fixture.svc', '127.0.0.1', '::1']) {
  test(`direct fixture signing validates its key and exact identity: ${hostname}`, () => {
    const result = createFixtureTls(hostname)
    const cert = new X509Certificate(result.cert)
    assert.equal(cert.checkPrivateKey(createPrivateKey(result.key)), true)
    assert.equal(cert.checkHost('unrelated.invalid'), undefined)
    assert.equal(result.cert.includes('PRIVATE KEY'), false)
    assert.equal(result.key.includes('CERTIFICATE'), false)
  })
}

for (const hostname of [undefined, null, true, '', '-flag', 'valid;echo injected',
  'valid/../../path', 'a..b', 'a\nb', 'a'.repeat(64) + '.svc', 'x.'.repeat(127) + 'x']) {
  test(`invalid TLS identity is rejected before signing: ${JSON.stringify(hostname)}`, () => {
    assert.throws(() => createFixtureTls(hostname), /invalid_fixture_hostname/)
  })
}
