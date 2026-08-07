'use strict'

const assert = require('node:assert/strict')
const fc = require('fast-check')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const links = require('./index.cjs')

test('runtime exports and constant values stay aligned with the declaration file', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declaredRuntimeExports = Array.from(
    declarations.matchAll(/export (?:declare )?(?:const|function)\s+([A-Za-z0-9_]+)/g),
    match => match[1]
  ).sort()

  assert.deepEqual(Object.keys(links).sort(), declaredRuntimeExports)
  assert.equal(links.CLERUM_OAUTH_PROTOCOL, 'clerum:')
  assert.equal(links.SANDBOX_UI_DEEP_LINK_PROTOCOL, 'evenfire:')
  assert.equal(links.SANDBOX_UI_DEEP_LINK_HOST, 'app')
  assert.equal(links.SANDBOX_UI_WEB_LINK_PATH, '/open/apps')
  assert.match(
    declarations,
    /buildSandboxUiWebLink\(\s*profileUiBaseUrl: string,\s*parts: SandboxUiDeepLinkParts\s*\): string/
  )
  assert.match(
    declarations,
    /parseSandboxUiDeepLink\(rawUrl: string\): SandboxUiDeepLinkTarget \| null/
  )
})

test('web and desktop links use the same canonical route contract', () => {
  const target = {
    recipeNs: 'sandbox-recipes',
    recipeName: 'task-board',
    path: '/tasks/42',
    teamId: 'team-1',
  }

  assert.equal(
    links.buildSandboxUiWebLink('https://profile.example.com', target),
    'https://profile.example.com/open/apps/sandbox-recipes/task-board' +
      '?path=%2Ftasks%2F42&team=team-1'
  )
  assert.deepEqual(links.parseSandboxUiDeepLink(links.buildSandboxUiDeepLink(target)), {
    appRef: 'sandbox-recipes/task-board',
    path: '/tasks/42',
    teamId: 'team-1',
  })
})

test('route normalization canonicalizes safe percent-encoded paths once', () => {
  for (const [input, expected] of [
    ['/café', '/café'],
    ['/caf%C3%A9', '/café'],
    ['/space here', '/space here'],
    ['/space%20here', '/space here'],
    ['/literal%percent', '/literal%percent'],
    ['/literal%25percent', '/literal%percent'],
    ['/already%2520encoded', '/already encoded'],
  ]) {
    assert.equal(links.normalizeSandboxUiRoute(input), expected)
  }

  const unicode = links.parseSandboxUiDeepLink(
    links.buildSandboxUiDeepLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/caf%C3%A9',
    })
  )
  const decoded = links.parseSandboxUiDeepLink(
    links.buildSandboxUiDeepLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/café',
    })
  )

  assert.deepEqual(unicode, {
    appRef: 'sandbox-recipes/task-board',
    path: '/café',
  })
  assert.deepEqual(decoded, unicode)
  assert.equal(links.sandboxUiDeepLinkTargetsEqual(unicode, decoded), true)
})

test('route normalization rejects unstable segment-edge whitespace', () => {
  for (const input of ['/report ', '/report%20', '/%20report', '/.%20']) {
    assert.equal(links.normalizeSandboxUiRoute(input), null)
  }

  const canonical = links.normalizeSandboxUiRoute('/report summary')
  assert.equal(canonical, '/report summary')
  assert.equal(links.normalizeSandboxUiRoute(canonical), canonical)

  const parsed = links.parseSandboxUiDeepLink(
    links.buildSandboxUiDeepLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'reporting',
      path: canonical,
    })
  )
  assert.deepEqual(parsed, {
    appRef: 'sandbox-recipes/reporting',
    path: canonical,
  })
  assert.equal(
    links.sandboxUiDeepLinkTargetsEqual(
      { appRef: 'sandbox-recipes/reporting', path: canonical },
      parsed
    ),
    true
  )
})

test('accepted generated routes preserve their canonical deep-link target', () => {
  const segmentArbitrary = fc
    .array(
      fc.constantFrom('a', 'Z', '0', '-', '_', '.', 'é', '中', '+', '%', ' ', '%20', '%2520'),
      { minLength: 1, maxLength: 8 }
    )
    .map(tokens => tokens.join(''))
  const routeArbitrary = fc
    .array(segmentArbitrary, { minLength: 1, maxLength: 6 })
    .map(segments => `/${segments.join('/')}`)

  fc.assert(
    fc.property(routeArbitrary, input => {
      const canonical = links.normalizeSandboxUiRoute(input)
      if (canonical === null || canonical === undefined) return

      assert.equal(links.normalizeSandboxUiRoute(canonical), canonical)

      const target = { appRef: 'sandbox-recipes/property-app', path: canonical }
      const parsed = links.parseSandboxUiDeepLink(
        links.buildSandboxUiDeepLink({
          recipeNs: 'sandbox-recipes',
          recipeName: 'property-app',
          path: canonical,
        })
      )
      assert.deepEqual(parsed, target)
      assert.equal(links.sandboxUiDeepLinkTargetsEqual(target, parsed), true)
    }),
    { numRuns: 1_000 }
  )
})

test('route contract covers canonical tokens and rejects unsafe encoded forms', () => {
  for (const [input, expected] of [
    ['/space%20here', '/space here'],
    ['/already%2520encoded', '/already encoded'],
    ['/literal%percent', '/literal%percent'],
    ['/literal%25percent', '/literal%percent'],
    ['/plus+sign', '/plus+sign'],
    ['/café', '/café'],
  ]) {
    assert.equal(links.normalizeSandboxUiRoute(input), expected)
  }

  for (const input of [
    '/%20leading',
    '/trailing%20',
    '/%2520recursive-leading',
    '/recursive-trailing%2520',
    '/safe/..',
    '/safe/%252e%252e',
    '/safe%252Fadmin',
    '/control%2500',
  ]) {
    assert.equal(links.normalizeSandboxUiRoute(input), null)
  }
})

test('shared app links carry only client-side pathnames', () => {
  for (const pathValue of [
    '/tasks?authorization=secret',
    '/tasks#access-token',
    '//outside.example',
    '/safe/../admin',
    '/safe/%2e%2e/admin',
    '/safe/%252e%252e/admin',
    '/safe/%25252e%25252e/admin',
    '/safe/%2F..%2Fadmin',
    '/safe\\admin',
    '/tasks\u2028admin',
    '/tasks\u2029admin',
  ]) {
    assert.throws(
      () =>
        links.buildSandboxUiDeepLink({
          recipeNs: 'sandbox-recipes',
          recipeName: 'task-board',
          path: pathValue,
        }),
      /Cannot create a deep link/
    )
  }
})

test('parser rejects recursively encoded route traversal payloads', () => {
  for (const rawUrl of [
    'evenfire://app/sandbox-recipes/task-board?path=%2Fsafe%2F%25252e%25252e%2Fadmin',
    'evenfire://app/sandbox-recipes/task-board?path=%2Fsafe%2F%252F..%252Fadmin',
    'evenfire://app/sandbox-recipes/task-board?path=%2Ftasks%25E2%2580%25A8admin',
    'evenfire://app/sandbox-recipes/task-board?path=%2Ftasks%25E2%2580%25A9admin',
  ]) {
    assert.equal(links.parseSandboxUiDeepLink(rawUrl), null)
  }
})

test('parser accepts a case-insensitive host and rejects non-canonical targets', () => {
  assert.deepEqual(links.parseSandboxUiDeepLink('evenfire://APP/sandbox-recipes/task-board'), {
    appRef: 'sandbox-recipes/task-board',
  })
  for (const rawUrl of [
    'evenfire://app/sandbox-recipes/task-board/',
    'evenfire://app:444/sandbox-recipes/task-board',
    'evenfire://app/sandbox-recipes/task-board?team=other%2Fteam',
    'https://profile.example/open/apps/sandbox-recipes/task-board',
  ]) {
    assert.equal(links.parseSandboxUiDeepLink(rawUrl), null)
  }
})

test('web handoffs require a root-mounted HTTP(S) Profile UI', () => {
  const parts = { recipeNs: 'sandbox-recipes', recipeName: 'task-board' }
  for (const baseUrl of [
    'https://profile.example/settings',
    'https://profile.example/?token=secret',
    'https://user:pass@profile.example/',
    'javascript:alert(1)',
  ]) {
    assert.throws(
      () => links.buildSandboxUiWebLink(baseUrl, parts),
      /Cannot create a shareable link/
    )
  }
})
