import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildEvenfireDesktopAppContentSecurityPolicy,
  buildEvenfireDesktopAppLink,
  buildEvenfireDesktopAppRedirectDocument,
} from '../lib/desktopAppLinks'

test('buildEvenfireDesktopAppLink preserves a nested app route and team', () => {
  assert.equal(
    buildEvenfireDesktopAppLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'agentic-task-board',
      path: '/tasks/task-42?view=detail#activity',
      teamId: 'team-123',
    }),
    'evenfire://app/sandbox-recipes/agentic-task-board' +
      '?path=%2Ftasks%2Ftask-42%3Fview%3Ddetail%23activity&team=team-123'
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
})

test('buildEvenfireDesktopAppRedirectDocument creates an unauthenticated protocol handoff', () => {
  const deepLink =
    'evenfire://app/sandbox-recipes/agentic-task-board' + '?path=%2Ftasks%2Ftask-42&team=team-123'
  const scriptNonce = 'dGVzdC1ub25jZQ=='
  const document = buildEvenfireDesktopAppRedirectDocument(deepLink, scriptNonce)

  assert.match(document, /http-equiv="refresh"/)
  assert.match(document, /window\.location\.replace/)
  assert.match(document, new RegExp(`<script nonce="${scriptNonce}">`))
  assert.match(document, /evenfire:\/\/app\/sandbox-recipes\/agentic-task-board/)
  assert.match(document, /<style>/)
  assert.match(document, /class="page-card"/)
  assert.match(document, /<h1>Open agentic-task-board<\/h1>/)
  assert.match(document, /class="open-button"/)
  assert.doesNotMatch(document, /login|authenticate|authorization/i)
})

test('buildEvenfireDesktopAppContentSecurityPolicy authorizes only the nonce-bearing script', () => {
  const scriptNonce = 'dGVzdC1ub25jZQ=='
  const policy = buildEvenfireDesktopAppContentSecurityPolicy(scriptNonce)

  assert.match(policy, new RegExp(`script-src 'nonce-${scriptNonce}'`))
  assert.doesNotMatch(policy, /script-src 'unsafe-inline'/)
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
