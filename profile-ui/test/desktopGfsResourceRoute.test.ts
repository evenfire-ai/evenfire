import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGfsResourceWebLink } from '@clerum/desktop-app-links'
import { GET } from '../app/open/files/route'

function extractCspScriptNonce(policy: string | null): string {
  assert.ok(policy, 'expected Content-Security-Policy header')
  const match = policy.match(/script-src 'nonce-([^']+)'/)
  assert.ok(match?.[1], 'expected script-src nonce in Content-Security-Policy header')
  return match[1]
}

test('EvenDrive handoff encodes and redirects a canonical resource identity', async () => {
  const response = await GET(
    new Request(
      buildGfsResourceWebLink(
        'https://profile.example',
        'gfs://main/0123456789abcdef0123456789ABCDEF'
      )
    )
  )
  const body = await response.text()
  const nonce = extractCspScriptNonce(response.headers.get('content-security-policy'))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(body.includes(`<script nonce="${nonce}">`))
  assert.match(body, /evenfire:\/\/files\?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef/)
  assert.match(body, /Open resource in Evenfire/)
  assert.match(body, /install or update to the latest Evenfire Desktop/)
  assert.doesNotMatch(body, /0123456789abcdef0123456789abcdef<\/h1>/)
})

test('EvenDrive handoff rejects malformed identities and extra query data', async () => {
  for (const url of [
    'https://profile.example/open/files?uri=' +
      encodeURIComponent('gfs://main/name-0123456789abcdef0123456789abcdef'),
    'https://profile.example/open/files?uri=' +
      encodeURIComponent('gfs://main/0123456789abcdef0123456789abcdef') +
      '&return=https://evil.example',
    'https://profile.example/open/files?uri=' +
      encodeURIComponent('gfs://main/0123456789abcdef0123456789abcdef') +
      '&uri=' +
      encodeURIComponent('gfs://main/0123456789abcdef0123456789abcdef'),
  ]) {
    const response = await GET(new Request(url))
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  }
})
