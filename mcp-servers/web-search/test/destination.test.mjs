import assert from 'node:assert/strict'
import { Resolver } from 'node:dns/promises'
import { test } from 'node:test'
import { isPublicAddress, parsePageUrl, resolvePageAddress } from '../dist/fetchPageDestination.js'

const blocked = [
  '0.1.2.3',
  '10.0.0.1',
  '100.64.0.1',
  '100.127.255.255',
  '127.0.0.1',
  '169.254.1.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.9',
  '192.0.2.1',
  '192.31.196.1',
  '192.52.193.1',
  '192.88.99.1',
  '192.168.1.1',
  '192.175.48.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:8.8.8.8',
  '64:ff9b::a00:1',
  '64:ff9b:1::1',
  '100::1',
  '100:0:0:1::1',
  '2001::1',
  '2001:1ff::1',
  '2001:db8::1',
  '2002:a00:1::1',
  '2620:4f:8000::1',
  '3fff::1',
  '3fff:fff::1',
  '5f00::1',
  'fc00::1',
  'fe80::1',
  'fec0::1',
  'ff02::1',
  '2001:4860:1:2:0:5efe:a00:1',
  '2001:4860:1:2:200:5efe:a00:1',
  'invalid',
  'fe80::1%eth0',
]
for (const ip of blocked) test(`blocks ${ip}`, () => assert.equal(isPublicAddress(ip), false))
for (const ip of [
  '8.8.8.8',
  '100.63.255.255',
  '100.128.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '198.17.255.255',
  '198.20.0.0',
  '2001:4860:4860::8888',
  '2606:4700::1111',
])
  test(`permits ordinary public ${ip}`, () => assert.equal(isPublicAddress(ip), true))
for (const input of [
  'file:///etc/passwd',
  'data:text/plain,ok',
  'ftp://example.test',
  'http://u:p@example.test',
  'http://example.test:0',
  'http://example.test/ a',
  'http://example.test\\@127.0.0.1',
  'http://[fe80::1%25eth0]/',
  `http://example.test/${'a'.repeat(8192)}`,
])
  test('rejects invalid URL ' + input.slice(0, 50), () =>
    assert.throws(() => parsePageUrl(input), { code: 'invalid_url' })
  )
for (const input of ['http://2130706433', 'http://0x7f000001', 'http://127.1', 'http://0177.0.0.1'])
  test('normalizes disguised loopback ' + input, async () =>
    assert.rejects(resolvePageAddress(parsePageUrl(input), new AbortController().signal), {
      code: 'destination_blocked',
    })
  )
test('DNS cannot hide a private AAAA behind public A', async t => {
  t.mock.method(Resolver.prototype, 'resolve4', async () => ['8.8.8.8'])
  t.mock.method(Resolver.prototype, 'resolve6', async () => ['::1'])
  await assert.rejects(
    resolvePageAddress(new URL('http://example.test'), new AbortController().signal),
    { code: 'destination_blocked' }
  )
})
test('record absence is allowed but DNS failures are not', async t => {
  t.mock.method(Resolver.prototype, 'resolve4', async () => ['8.8.8.8'])
  const lookup = t.mock.method(Resolver.prototype, 'resolve6', async () => {
    throw Object.assign(new Error(), { code: 'ENODATA' })
  })
  assert.equal(
    await resolvePageAddress(new URL('http://example.test'), new AbortController().signal),
    '8.8.8.8'
  )
  for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ENOTFOUND']) {
    lookup.mock.mockImplementation(async () => {
      throw Object.assign(new Error(), { code })
    })
    await assert.rejects(
      resolvePageAddress(new URL('http://example.test'), new AbortController().signal),
      { code: 'upstream_failure' }
    )
  }
})
test('already-cancelled resolution performs no DNS work', async t => {
  const lookup = t.mock.method(Resolver.prototype, 'resolve4')
  await assert.rejects(resolvePageAddress(new URL('http://example.test'), AbortSignal.abort()))
  assert.equal(lookup.mock.callCount(), 0)
})
