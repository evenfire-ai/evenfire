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
  assert.equal(links.GFS_RESOURCE_DEEP_LINK_HOST, 'files')
  assert.equal(links.GFS_RESOURCE_WEB_LINK_PATH, '/open/files')
  assert.match(
    declarations,
    /buildSandboxUiWebLink\(\s*profileUiBaseUrl: string,\s*parts: SandboxUiDeepLinkParts\s*\): string/
  )
  assert.match(
    declarations,
    /parseSandboxUiDeepLink\(rawUrl: string\): SandboxUiDeepLinkTarget \| null/
  )
  assert.match(
    declarations,
    /buildGfsResourceWebLink\(profileUiBaseUrl: string, uri: string\): string/
  )
  assert.match(
    declarations,
    /parseGfsResourceDeepLink\(rawUrl: string\): GfsResourceDeepLinkTarget \| null/
  )
})

test('GFS resource links preserve canonical identity in web and desktop handoffs', () => {
  const uri = 'gfs://main/0123456789abcdef0123456789ABCDEF'
  const desktopLink = links.buildGfsResourceDeepLink(uri)
  const webLink = links.buildGfsResourceWebLink('https://profile.example.com', uri)

  assert.equal(
    desktopLink,
    'evenfire://files?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef'
  )
  assert.equal(
    webLink,
    'https://profile.example.com/open/files?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef'
  )
  assert.deepEqual(links.parseGfsResourceDeepLink(desktopLink), {
    uri: 'gfs://main/0123456789abcdef0123456789abcdef',
  })
})

test('GFS resource-link parsing rejects malformed identities and untrusted URL components', () => {
  for (const uri of [
    'gfs://main/name-0123456789abcdef0123456789abcdef',
    'gfs://main/0123456789abcdef0123456789abcdef/child',
    'gfs://main/0123456789abcdef0123456789abcdef?token=secret',
    'gfs://main/0123456789abcdef0123456789abcdef#fragment',
    'https://profile.example.com/open/files?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef',
  ]) {
    assert.equal(links.normalizeGfsResourceUri(uri), null)
  }

  for (const rawUrl of [
    'evenfire://files:444?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef',
    'evenfire://files/extra?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef',
    'evenfire://files?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef&uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef',
    'evenfire://files?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef&return=https%3A%2F%2Fevil.example',
    'evenfire://files?uri=https%3A%2F%2Fevil.example',
  ]) {
    assert.equal(links.parseGfsResourceDeepLink(rawUrl), null)
  }
})

test('resource-link parser accepts only canonical identities and the shared link producers', () => {
  const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
  const desktopLink = links.buildGfsResourceDeepLink(uri)
  const profileLink = links.buildGfsResourceWebLink('https://another-env.example', uri)

  assert.deepEqual(links.parseGfsResourceLink(uri), { uri })
  assert.deepEqual(links.parseGfsResourceLink(desktopLink), { uri })
  assert.deepEqual(links.parseGfsResourceLink(profileLink), { uri })
  assert.deepEqual(links.parseGfsResourceLink(profileLink.replace('main%2F', 'Main%2F')), {
    uri: 'gfs://Main/0123456789abcdef0123456789abcdef',
  })

  for (const rawLink of [
    'gfs://main/folder/report.md',
    'gfs://main/name-0123456789abcdef0123456789abcdef',
    'gfs://main/01234567-89ab-cdef-0123-456789abcdef',
    `https://profile.example/open/files?uri=${encodeURIComponent(encodeURIComponent(uri))}`,
    `${profileLink}#fragment`,
    profileLink.replace('https://another-env.example', 'https://user:secret@another-env.example'),
    `${profileLink}&uri=${encodeURIComponent(uri)}`,
    profileLink.replace('/open/files?', '/wrong/path?'),
    profileLink.replace('https:', 'ftp:'),
  ]) {
    assert.equal(links.parseGfsResourceLink(rawLink), null, rawLink)
  }

  assert.equal(
    links.normalizeGfsResourceUri('gfs://Main/0123456789ABCDEF0123456789ABCDEF'),
    'gfs://Main/0123456789abcdef0123456789abcdef'
  )
  assert.equal(links.parseGfsResourceLink(`${uri}/`), null)
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

test('literal percent routes use the decoded canonical wire representation', () => {
  const deepLink = links.buildSandboxUiDeepLink({
    recipeNs: 'sandbox-recipes',
    recipeName: 'task-board',
    path: '/literal%percent',
  })

  assert.equal(new URL(deepLink).searchParams.get('path'), '/literal%percent')
  assert.deepEqual(links.parseSandboxUiDeepLink(deepLink), {
    appRef: 'sandbox-recipes/task-board',
    path: '/literal%percent',
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

// Generated from the producers and parser these functions replaced; regenerate with
// `node packages/desktop-app-links/generate-desktop-handoff-golden.cjs` from the repo root.
const handoffGolden = require('./desktop-handoff-links.golden.json')

// Reference copies of the replaced formulas. The corpus test below pins each one to the golden
// generated from the original code, so the property tests compare against verified behaviour.
function previousEnvironmentFormula(externalRestApiBaseUrl, tenantName) {
  const params = new URLSearchParams({ externalRestApiBaseUrl, tenantName })
  return `evenfire://desktop-environment?${params.toString()}`
}

function previousSetupFormula(email, authorizationToken) {
  return `evenfire://desktop-setup?email=${encodeURIComponent(email)}&authorizationToken=${encodeURIComponent(authorizationToken)}`
}

function outcome(run) {
  try {
    return { value: run() }
  } catch (error) {
    return { throws: error.constructor.name }
  }
}

const HANDOFF_SENSITIVE_CHARS = [
  ' ',
  '+',
  '&',
  '=',
  '%',
  '!',
  "'",
  '(',
  ')',
  '*',
  '~',
  '#',
  '\t',
  '\n',
  '\u0000',
  'é',
  '😀',
]
const handoffStringArbitrary = fc.oneof(
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: fc.constantFrom(...HANDOFF_SENSITIVE_CHARS) }),
  fc.string({
    unit: fc.oneof(
      fc.constantFrom(...HANDOFF_SENSITIVE_CHARS),
      fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 })
    ),
  })
)

test('desktop handoff hosts are exported for producers and the desktop router', () => {
  assert.equal(links.DESKTOP_ENVIRONMENT_DEEP_LINK_HOST, 'desktop-environment')
  assert.equal(links.DESKTOP_SETUP_DEEP_LINK_HOST, 'desktop-setup')
})

test('desktop-environment builder emits the previous profile-ui link byte for byte', () => {
  assert.ok(handoffGolden.environmentBuilder.length > 0)
  for (const { externalRestApiBaseUrl, tenantName, link } of handoffGolden.environmentBuilder) {
    const label = JSON.stringify({ externalRestApiBaseUrl, tenantName })
    assert.equal(previousEnvironmentFormula(externalRestApiBaseUrl, tenantName), link, label)
    assert.equal(
      links.buildDesktopEnvironmentDeepLink({ externalRestApiBaseUrl, tenantName }),
      link,
      label
    )
  }
})

test('desktop-environment builder ignores caller key order and extra keys', () => {
  const parts = {
    tenantName: 'Acme Corp',
    extra: 'leak',
    externalRestApiBaseUrl: 'https://api.example.com',
  }
  assert.equal(
    links.buildDesktopEnvironmentDeepLink(parts),
    previousEnvironmentFormula('https://api.example.com', 'Acme Corp')
  )
})

test('desktop-setup builder emits the previous profile-ui link byte for byte', () => {
  assert.ok(handoffGolden.setupBuilder.some(entry => 'throws' in entry))
  for (const entry of handoffGolden.setupBuilder) {
    const { email, authorizationToken } = entry
    const expected = 'throws' in entry ? { throws: entry.throws } : { value: entry.value }
    const label = JSON.stringify({ email, authorizationToken })
    assert.deepEqual(
      outcome(() => previousSetupFormula(email, authorizationToken)),
      expected,
      label
    )
    assert.deepEqual(
      outcome(() => links.buildDesktopSetupDeepLink({ email, authorizationToken })),
      expected,
      label
    )
  }
})

test('desktop handoff builders match the previous formulas for arbitrary unicode input', () => {
  fc.assert(
    fc.property(handoffStringArbitrary, handoffStringArbitrary, (first, second) => {
      assert.equal(
        links.buildDesktopEnvironmentDeepLink({
          externalRestApiBaseUrl: first,
          tenantName: second,
        }),
        previousEnvironmentFormula(first, second)
      )
      assert.equal(
        links.buildDesktopSetupDeepLink({ email: first, authorizationToken: second }),
        previousSetupFormula(first, second)
      )
    }),
    { numRuns: 2000 }
  )
  fc.assert(
    fc.property(
      fc.string({ unit: 'binary' }),
      fc.string({ unit: 'binary' }),
      (email, authorizationToken) => {
        assert.deepEqual(
          outcome(() => links.buildDesktopSetupDeepLink({ email, authorizationToken })),
          outcome(() => previousSetupFormula(email, authorizationToken))
        )
      }
    ),
    { numRuns: 2000 }
  )
})

test('desktop handoff links round-trip well-formed non-empty fields', () => {
  const field = handoffStringArbitrary.filter(value => value.length > 0 && value.isWellFormed())
  fc.assert(
    fc.property(field, field, (first, second) => {
      assert.deepEqual(
        links.parseDesktopEnvironmentDeepLink(
          links.buildDesktopEnvironmentDeepLink({
            externalRestApiBaseUrl: first,
            tenantName: second,
          })
        ),
        { externalRestApiBaseUrl: first, appName: second }
      )
      assert.deepEqual(
        links.parseDesktopSetupDeepLink(
          links.buildDesktopSetupDeepLink({ email: first, authorizationToken: second })
        ),
        { email: first, authorizationToken: second }
      )
    }),
    { numRuns: 2000 }
  )
})

test('desktop-setup builder throws URIError for a lone surrogate like the previous builder', () => {
  assert.throws(
    () => links.buildDesktopSetupDeepLink({ email: '\uD800', authorizationToken: 'token-1' }),
    URIError
  )
  assert.throws(
    () =>
      links.buildDesktopSetupDeepLink({ email: 'user@example.com', authorizationToken: '\uDC00' }),
    URIError
  )
})

test('desktop handoff parsers accept exactly what the previous desktop router delivered', () => {
  const urls = handoffGolden.routerParse.map(entry => entry.url)
  for (const required of [
    'evenfire://DESKTOP-SETUP?email=user%40example.test&authorizationToken=token-1',
    'evenfire://desktop-setup:80?email=user%40example.test&authorizationToken=token-1',
    'evenfire://u:p@desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test',
    'evenfire://desktop-environment?externalRestApiBaseUrl=x&tenantName=A&appName=B',
    'evenfire://desktop-environment?externalRestApiBaseUrl=&externalRestApiBaseUrl=x',
  ]) {
    assert.ok(urls.includes(required), `golden is missing ${required}`)
  }
  for (const { url, environment, setup } of handoffGolden.routerParse) {
    assert.deepEqual(links.parseDesktopEnvironmentDeepLink(url), environment, url)
    assert.deepEqual(links.parseDesktopSetupDeepLink(url), setup, url)
  }
})
