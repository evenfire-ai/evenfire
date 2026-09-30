import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDesktopEnvironmentLink,
  buildEvenfireDesktopAppContentSecurityPolicy,
  buildEvenfireDesktopAppLink,
  buildEvenfireDesktopAppRedirectDocument,
  navigateToDesktopApp,
} from '../lib/desktopAppLinks'

test('buildDesktopEnvironmentLink defaults the tenant name to Evenfire', () => {
  const link = buildDesktopEnvironmentLink({
    externalRestApiBaseUrl: 'https://api.example.com',
    rpcProxyBaseUrl: '',
    appName: '',
  })

  assert.ok(link)
  const parsedLink = new URL(link)
  assert.equal(parsedLink.searchParams.get('tenantName'), 'Evenfire')
})

test('buildDesktopEnvironmentLink omits an empty RPC proxy URL', () => {
  const link = buildDesktopEnvironmentLink({
    externalRestApiBaseUrl: 'https://api.example.com',
    rpcProxyBaseUrl: '',
    appName: 'Example tenant',
  })

  assert.ok(link)
  const parsedLink = new URL(link)
  assert.equal(parsedLink.searchParams.get('rpcProxyBaseUrl'), null)
})

test('navigateToDesktopApp assigns the protocol URL to the browser location', () => {
  const location = { href: 'https://profile.example.com/settings' }
  const desktopHref =
    'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.com&tenantName=Example+Tenant'

  navigateToDesktopApp(desktopHref, location)

  assert.equal(location.href, desktopHref)
})

test('buildEvenfireDesktopAppLink preserves a nested app pathname and team', () => {
  assert.equal(
    buildEvenfireDesktopAppLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'agentic-task-board',
      path: '/tasks/task-42',
      teamId: 'team-123',
    }),
    'evenfire://app/sandbox-recipes/agentic-task-board' + '?path=%2Ftasks%2Ftask-42&team=team-123'
  )
})

test('buildEvenfireDesktopAppLink rejects unsafe routes', () => {
  assert.equal(
    buildEvenfireDesktopAppLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'agentic-task-board',
      path: '//outside.example',
    }),
    null
  )
  assert.equal(
    buildEvenfireDesktopAppLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'agentic-task-board',
      path: '/tasks?authorization=secret',
    }),
    null
  )
  assert.equal(
    buildEvenfireDesktopAppLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'agentic-task-board',
      path: '/safe/%2e%2e/admin',
    }),
    null
  )
})

test('buildEvenfireDesktopAppLink leaves an omitted route to the recipe default', () => {
  assert.equal(
    buildEvenfireDesktopAppLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'agentic-task-board',
    }),
    'evenfire://app/sandbox-recipes/agentic-task-board'
  )
})

test('buildEvenfireDesktopAppRedirectDocument creates an unauthenticated protocol handoff', () => {
  const deepLink =
    'evenfire://app/sandbox-recipes/agentic-task-board' + '?path=%2Ftasks%2Ftask-42&team=team-123'
  const scriptNonce = 'dGVzdC1ub25jZQ=='
  const document = buildEvenfireDesktopAppRedirectDocument(deepLink, scriptNonce)

  assert.doesNotMatch(document, /http-equiv="refresh"/)
  assert.match(document, /window\.location\.replace/)
  assert.match(document, new RegExp(`<script nonce="${scriptNonce}">`))
  assert.match(document, /evenfire:\/\/app\/sandbox-recipes\/agentic-task-board/)
  assert.match(document, new RegExp(`<style nonce="${scriptNonce}">`))
  assert.match(document, /class="page-card"/)
  assert.match(document, /<h1>Open app in Evenfire<\/h1>/)
  assert.doesNotMatch(document, /agentic-task-board<\/h1>/)
  assert.match(document, /install or update to the latest Evenfire Desktop/)
  assert.match(document, /class="open-button"/)
  assert.doesNotMatch(document, /login|authenticate|authorization/i)
})

test('buildEvenfireDesktopAppContentSecurityPolicy authorizes only the nonce-bearing script', () => {
  const scriptNonce = 'dGVzdC1ub25jZQ=='
  const policy = buildEvenfireDesktopAppContentSecurityPolicy(scriptNonce)

  assert.match(policy, new RegExp(`script-src 'nonce-${scriptNonce}'`))
  assert.match(policy, new RegExp(`style-src 'nonce-${scriptNonce}'`))
  assert.doesNotMatch(policy, /script-src 'unsafe-inline'/)
  assert.doesNotMatch(policy, /style-src 'unsafe-inline'/)
})

test('buildEvenfireDesktopAppRedirectDocument rejects unrelated protocols', () => {
  assert.throws(
    () => buildEvenfireDesktopAppRedirectDocument('https://example.com/app', 'dGVzdC1ub25jZQ=='),
    /invalid desktop app link/
  )
})

test('buildEvenfireDesktopAppRedirectDocument rejects an invalid script nonce', () => {
  assert.throws(
    () =>
      buildEvenfireDesktopAppRedirectDocument(
        'evenfire://app/sandbox-recipes/agentic-task-board?path=%2F',
        '"><script>alert(1)</script>'
      ),
    /invalid script nonce/
  )
})
