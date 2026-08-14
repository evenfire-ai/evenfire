import assert from 'node:assert/strict'
import test from 'node:test'
import { GET } from '../app/open/apps/[recipeNs]/[recipeName]/route'

const routeContext = {
  params: Promise.resolve({
    recipeNs: 'sandbox-recipes',
    recipeName: 'agentic-task-board',
  }),
}

function extractCspScriptNonce(policy: string | null): string {
  assert.ok(policy, 'expected Content-Security-Policy header')
  const match = policy.match(/script-src 'nonce-([^']+)'/)
  assert.ok(match?.[1], 'expected script-src nonce in Content-Security-Policy header')
  return match[1]
}

function extractHtmlScriptNonce(body: string): string {
  const match = body.match(/<script nonce="([^"]+)">/)
  assert.ok(match?.[1], 'expected script nonce in desktop handoff HTML')
  return match[1]
}

test('desktop app handoff leaves an omitted path to the recipe default', async () => {
  const response = await GET(new Request('https://profile.example/open/apps/ns/app'), routeContext)
  const body = await response.text()
  const cspNonce = extractCspScriptNonce(response.headers.get('content-security-policy'))
  const htmlNonce = extractHtmlScriptNonce(body)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(htmlNonce, cspNonce)
  assert.match(body, /evenfire:\/\/app\/sandbox-recipes\/agentic-task-board/)
  assert.doesNotMatch(body, /[?&]path=/)
  assert.match(body, /Open app in Evenfire/)
})

test('desktop app handoff rejects dot-segment routes with hardened error headers', async () => {
  const request = new Request(
    'https://profile.example/open/apps/ns/app?path=%2Fsafe%2F%252e%252e%2Fadmin'
  )
  const response = await GET(request, routeContext)

  assert.equal(response.status, 400)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
})

test('desktop app handoff rejects query or fragment data inside the shared app path', async () => {
  const response = await GET(
    new Request('https://profile.example/open/apps/ns/app?path=%2Ftasks%3Fauthorization%3Dsecret'),
    routeContext
  )

  assert.equal(response.status, 400)
})
