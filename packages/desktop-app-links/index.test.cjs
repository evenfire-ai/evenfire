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

const EDGE_FIXTURE_PATH = path.join(
  __dirname,
  '../../external-rest-api/test/fixtures/oidc-desktop-sign-in/edge.json'
)
const SIGN_IN_URL = 'https://profile.example.test/desktop-login'
const CHALLENGE = 'c'.repeat(43)
const STATE = 's'.repeat(43)
const CODE = 'k'.repeat(43)
const ENVIRONMENT = 'https://edge-fixture.example.test'
const EXPECTED_ERRORS = ['refused', 'cancelled', 'unavailable', 'failed']
const EXPECTED_REFUSAL_REASONS = [
  'account_disabled',
  'identity_conflict',
  'account_needs_attention',
  'email_claim_missing',
  'email_unverified',
  'not_eligible',
  'no_account',
  'provider_configuration',
]
const BASE64URL_ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_']
const desktopLoginValueArbitrary = fc.string({
  unit: fc.constantFrom(...BASE64URL_ALPHABET),
  minLength: 43,
  maxLength: 43,
})
const hostArbitrary = fc
  .array(
    fc.string({
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'),
      minLength: 1,
      maxLength: 20,
    }),
    { minLength: 1, maxLength: 3 }
  )
  .map(labels => `${labels.join('.')}.example.test`)
const portSuffixArbitrary = fc.option(
  fc
    .integer({ min: 1, max: 65535 })
    .filter(port => port !== 80 && port !== 443)
    .map(port => `:${port}`),
  { nil: '' }
)
// A canonical signInUrl: the parser returns origin + path, so no default port.
const signInUrlArbitrary = fc
  .tuple(hostArbitrary, portSuffixArbitrary)
  .map(([host, port]) => `https://${host}${port}/desktop-login`)
// An environment comes back unchanged, so its path may hold characters the
// link has to percent-encode.
const environmentArbitrary = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    hostArbitrary,
    portSuffixArbitrary,
    fc.option(
      fc
        .string({ unit: fc.constantFrom(...'az09-._~/+&=% é中'), maxLength: 30 })
        .map(pathValue => `/${pathValue}`),
      { nil: '' }
    )
  )
  .map(([scheme, host, port, pathValue]) => `${scheme}://${host}${port}${pathValue}`)

function readEdgeFixture(key) {
  const records = JSON.parse(fs.readFileSync(EDGE_FIXTURE_PATH, 'utf8'))
  assert.ok(records[key], `edge fixture record ${key}`)
  return records[key]
}

function desktopLoginLink(query) {
  return `evenfire://desktop-login?${query}`
}

test('the Desktop sign-in constants hold the contract values', () => {
  assert.equal(links.DESKTOP_LOGIN_PATH, '/desktop-login')
  assert.equal(links.DESKTOP_LOGIN_DEEP_LINK_HOST, 'desktop-login')
  assert.deepEqual([...links.DESKTOP_LOGIN_ERRORS], EXPECTED_ERRORS)
  assert.deepEqual([...links.DESKTOP_LOGIN_REFUSAL_REASONS], EXPECTED_REFUSAL_REASONS)
  assert.equal(Object.isFrozen(links.DESKTOP_LOGIN_ERRORS), true)
  assert.equal(Object.isFrozen(links.DESKTOP_LOGIN_REFUSAL_REASONS), true)
  assert.equal(links.DESKTOP_LOGIN_REFUSAL_REASONS.includes('invitation_email_mismatch'), false)
})

test('every Desktop sign-in builder round-trips through its parser', () => {
  fc.assert(
    fc.property(
      signInUrlArbitrary,
      desktopLoginValueArbitrary,
      desktopLoginValueArbitrary,
      (signInUrl, challenge, state) => {
        assert.equal(links.parseDesktopLoginSignInUrl(signInUrl), signInUrl)
        const pageUrl = links.buildDesktopLoginPageUrl(signInUrl, { challenge, state })
        assert.deepEqual(links.parseDesktopLoginPageUrl(pageUrl), { signInUrl, challenge, state })
        assert.deepEqual(links.parseDesktopLoginFragment(new URL(pageUrl).hash), {
          valid: true,
          challenge,
          state,
        })
      }
    ),
    { numRuns: 500 }
  )

  fc.assert(
    fc.property(
      desktopLoginValueArbitrary,
      desktopLoginValueArbitrary,
      environmentArbitrary,
      (state, code, environment) => {
        const link = links.buildDesktopLoginCodeLink({ state, code, environment })
        assert.deepEqual(links.parseDesktopLoginLink(link), {
          kind: 'code',
          state,
          code,
          environment,
        })
      }
    ),
    { numRuns: 500 }
  )

  fc.assert(
    fc.property(
      desktopLoginValueArbitrary,
      fc.constantFrom(...EXPECTED_ERRORS),
      fc.option(fc.oneof(fc.constantFrom(...EXPECTED_REFUSAL_REASONS), fc.string()), {
        nil: undefined,
      }),
      (state, error, reason) => {
        const link = links.buildDesktopLoginErrorLink({
          state,
          error,
          ...(reason === undefined ? {} : { reason }),
        })
        let expected = { kind: 'error', state, error }
        if (error === 'refused') {
          expected = EXPECTED_REFUSAL_REASONS.includes(reason)
            ? { kind: 'error', state, error: 'refused', reason }
            : { kind: 'error', state, error: 'failed' }
        }
        assert.deepEqual(links.parseDesktopLoginLink(link), expected)
      }
    ),
    { numRuns: 500 }
  )
})

test('the page URL carries the values in the fragment and none in the query', () => {
  const built = links.buildDesktopLoginPageUrl(SIGN_IN_URL, { challenge: CHALLENGE, state: STATE })

  assert.equal(built, `${SIGN_IN_URL}#challenge=${CHALLENGE}&state=${STATE}`)
  const url = new URL(built)
  assert.equal(url.search, '')
  assert.equal(built.includes('?'), false)
  assert.equal(url.pathname, '/desktop-login')
  assert.equal(url.hash, `#challenge=${CHALLENGE}&state=${STATE}`)
  assert.equal(
    links.parseDesktopLoginPageUrl(`${SIGN_IN_URL}?challenge=${CHALLENGE}&state=${STATE}`),
    null
  )
  assert.equal(
    links.parseDesktopLoginPageUrl(`${SIGN_IN_URL}?#challenge=${CHALLENGE}&state=${STATE}`),
    null
  )
  assert.equal(links.parseDesktopLoginPageUrl(SIGN_IN_URL), null)

  for (const [signInUrl, values] of [
    ['http://profile.example.test/desktop-login', { challenge: CHALLENGE, state: STATE }],
    [`${SIGN_IN_URL}?`, { challenge: CHALLENGE, state: STATE }],
    [SIGN_IN_URL, { challenge: CHALLENGE.slice(1), state: STATE }],
    [SIGN_IN_URL, { challenge: CHALLENGE, state: `${STATE.slice(1)}=` }],
  ]) {
    assert.throws(
      () => links.buildDesktopLoginPageUrl(signInUrl, values),
      /Cannot create a Desktop sign-in page URL/
    )
  }
})

test('the fragment parser rejects duplicates, extra keys and bad values, and keeps a well-formed state', () => {
  const valid = { valid: true, challenge: CHALLENGE, state: STATE }
  assert.deepEqual(links.parseDesktopLoginFragment(`#challenge=${CHALLENGE}&state=${STATE}`), valid)
  assert.deepEqual(links.parseDesktopLoginFragment(`challenge=${CHALLENGE}&state=${STATE}`), valid)
  assert.deepEqual(links.parseDesktopLoginFragment(`#state=${STATE}&challenge=${CHALLENGE}`), valid)

  for (const hash of [
    `#challenge=${CHALLENGE}&challenge=${CHALLENGE}&state=${STATE}`,
    `#challenge=${CHALLENGE}&state=${STATE}&extra=1`,
    `#challenge=${CHALLENGE}&state=${STATE}&`,
    `#challenge=${CHALLENGE.slice(1)}&state=${STATE}`,
    `#challenge=${CHALLENGE}!&state=${STATE}`,
    `#challenge=${CHALLENGE.slice(3)}%41%41%41&state=${STATE}`,
    `#challenge&state=${STATE}`,
    `#state=${STATE}`,
    `##challenge=${CHALLENGE}&state=${STATE}`,
  ]) {
    assert.deepEqual(links.parseDesktopLoginFragment(hash), { valid: false, state: STATE }, hash)
  }

  for (const hash of [
    `#challenge=${CHALLENGE}&state=${STATE}&state=${STATE}`,
    `#challenge=${CHALLENGE}&state=${STATE.slice(1)}`,
    `#challenge=${CHALLENGE}&state=${STATE}+`,
    `#challenge=${CHALLENGE}&state`,
    `#challenge=${CHALLENGE}`,
    '#',
    '',
  ]) {
    assert.deepEqual(links.parseDesktopLoginFragment(hash), { valid: false, state: null }, hash)
  }
  for (const hash of [undefined, null, 42, {}, [`challenge=${CHALLENGE}&state=${STATE}`]]) {
    assert.deepEqual(links.parseDesktopLoginFragment(hash), { valid: false, state: null })
  }
})

test('the error builder maps an unknown or missing refusal reason to failed', () => {
  const failed = desktopLoginLink(`state=${STATE}&error=failed`)

  assert.equal(
    links.buildDesktopLoginErrorLink({
      state: STATE,
      error: 'refused',
      reason: 'invitation_email_mismatch',
    }),
    failed
  )
  assert.equal(links.buildDesktopLoginErrorLink({ state: STATE, error: 'refused' }), failed)
  assert.equal(
    links.buildDesktopLoginErrorLink({ state: STATE, error: 'refused', reason: '' }),
    failed
  )
  assert.equal(
    links.buildDesktopLoginErrorLink({ state: STATE, error: 'refused', reason: 'no_account' }),
    desktopLoginLink(`state=${STATE}&error=refused&reason=no_account`)
  )
})

test('the link parser reads a refused link with an unknown or missing reason as failed', () => {
  const failed = { kind: 'error', state: STATE, error: 'failed' }

  assert.deepEqual(
    links.parseDesktopLoginLink(
      desktopLoginLink(`state=${STATE}&error=refused&reason=invitation_email_mismatch`)
    ),
    failed
  )
  assert.deepEqual(
    links.parseDesktopLoginLink(desktopLoginLink(`state=${STATE}&error=refused`)),
    failed
  )
  assert.deepEqual(
    links.parseDesktopLoginLink(desktopLoginLink(`state=${STATE}&error=refused&reason=`)),
    failed
  )
  assert.deepEqual(
    links.parseDesktopLoginLink(desktopLoginLink(`state=${STATE}&error=refused&reason=no_account`)),
    { kind: 'error', state: STATE, error: 'refused', reason: 'no_account' }
  )
  for (const error of ['cancelled', 'unavailable', 'failed']) {
    assert.deepEqual(
      links.parseDesktopLoginLink(desktopLoginLink(`state=${STATE}&error=${error}`)),
      { kind: 'error', state: STATE, error }
    )
  }
})

test('the link parser rejects unknown errors, extra or duplicate parameters, a reason on a non-refused error, and mixed code and error links', () => {
  const environment = encodeURIComponent(ENVIRONMENT)
  const codeQuery = `state=${STATE}&code=${CODE}&environment=${environment}`
  assert.deepEqual(links.parseDesktopLoginLink(desktopLoginLink(codeQuery)), {
    kind: 'code',
    state: STATE,
    code: CODE,
    environment: ENVIRONMENT,
  })

  for (const rawUrl of [
    desktopLoginLink(`state=${STATE}&error=denied`),
    desktopLoginLink(`state=${STATE}&error=failed&extra=1`),
    desktopLoginLink(`${codeQuery}&extra=1`),
    desktopLoginLink(`state=${STATE}&state=${STATE}&error=failed`),
    desktopLoginLink(`${codeQuery}&code=${CODE}`),
    desktopLoginLink(`state=${STATE}&error=refused&reason=no_account&reason=no_account`),
    desktopLoginLink(`state=${STATE}&error=cancelled&reason=no_account`),
    desktopLoginLink(`state=${STATE}&error=failed&reason=`),
    desktopLoginLink(`state=${STATE}&code=${CODE}&error=failed`),
    desktopLoginLink(`${codeQuery}&error=failed`),
    desktopLoginLink(`${codeQuery}&reason=no_account`),
    desktopLoginLink(`state=${STATE}&code=${CODE}`),
    desktopLoginLink(`state=${STATE}&environment=${environment}`),
    desktopLoginLink(`state=${STATE}`),
    desktopLoginLink(`error=failed`),
    desktopLoginLink(`state=${STATE.slice(1)}&error=failed`),
    desktopLoginLink(`state=${STATE}&code=${CODE.slice(1)}&environment=${environment}`),
    desktopLoginLink(`state=${STATE}&code=${CODE}&environment=ftp%3A%2F%2Fedge.example.test`),
    `evenfire://desktop-login?${codeQuery}#`,
    `evenfire://desktop-login?${codeQuery}#fragment`,
    `evenfire://desktop-login/?state=${STATE}&error=failed`,
    `evenfire://desktop-login/extra?state=${STATE}&error=failed`,
    `evenfire://desktop-login:444?state=${STATE}&error=failed`,
    `evenfire://fixture-user@desktop-login?state=${STATE}&error=failed`,
    `evenfire://DESKTOP-LOGIN?state=${STATE}&error=failed`,
    `evenfire://desktop-setup?state=${STATE}&error=failed`,
    `clerum://desktop-login?state=${STATE}&error=failed`,
    `https://desktop-login/?state=${STATE}&error=failed`,
    'not a link',
    undefined,
    42,
    {},
  ]) {
    assert.equal(links.parseDesktopLoginLink(rawUrl), null, String(rawUrl))
  }
})

test('the link builders refuse a bad state, code, environment or error', () => {
  for (const values of [
    { state: STATE.slice(1), code: CODE, environment: ENVIRONMENT },
    { state: STATE, code: `${CODE.slice(1)}/`, environment: ENVIRONMENT },
    { state: STATE, code: CODE, environment: 'ftp://edge-fixture.example.test' },
    { state: STATE, code: CODE, environment: 'https://fixture-user@edge-fixture.example.test' },
    { state: STATE, code: CODE, environment: 'https://:fixture@edge-fixture.example.test' },
    { state: STATE, code: CODE, environment: `${ENVIRONMENT}?` },
    { state: STATE, code: CODE, environment: `${ENVIRONMENT}#` },
    { state: STATE, code: CODE, environment: 'not a url' },
    { state: STATE, code: CODE },
  ]) {
    assert.throws(
      () => links.buildDesktopLoginCodeLink(values),
      /Cannot create a Desktop sign-in link/
    )
  }
  for (const values of [
    { state: STATE.slice(1), error: 'failed' },
    { state: undefined, error: 'cancelled' },
    { state: STATE, error: 'denied' },
    { state: STATE },
  ]) {
    assert.throws(
      () => links.buildDesktopLoginErrorLink(values),
      /Cannot create a Desktop sign-in link/
    )
  }
  // A reason belongs only to a refusal, so another error's link carries none.
  assert.equal(
    links.buildDesktopLoginErrorLink({ state: STATE, error: 'cancelled', reason: 'no_account' }),
    desktopLoginLink(`state=${STATE}&error=cancelled`)
  )
})

test('a link environment is http or https with no user info, query or fragment, and comes back unchanged', () => {
  const roundTrip = environment =>
    links.parseDesktopLoginLink(
      links.buildDesktopLoginCodeLink({ state: STATE, code: CODE, environment })
    )
  const pathPrefix = 'https://edge-fixture.example.test/'

  for (const environment of [
    ENVIRONMENT,
    'http://edge-fixture.example.test',
    'https://edge-fixture.example.test:8443/rest',
    // 2048 characters whose percent-encoding is the longest a link can carry.
    `${pathPrefix}${'中'.repeat(2048 - pathPrefix.length)}`,
    `${pathPrefix}${'/'.repeat(2048 - pathPrefix.length)}`,
  ]) {
    assert.deepEqual(roundTrip(environment), {
      kind: 'code',
      state: STATE,
      code: CODE,
      environment,
    })
  }

  const tooLong = `${pathPrefix}${'a'.repeat(2049 - pathPrefix.length)}`
  assert.equal(tooLong.length, 2049)
  assert.throws(
    () => links.buildDesktopLoginCodeLink({ state: STATE, code: CODE, environment: tooLong }),
    /Cannot create a Desktop sign-in link/
  )
  for (const environment of [
    tooLong,
    'ftp://edge-fixture.example.test',
    'https://fixture-user@edge-fixture.example.test',
    'https://:fixture@edge-fixture.example.test',
    `${ENVIRONMENT}?`,
    `${ENVIRONMENT}?a=1`,
    `${ENVIRONMENT}#`,
    `${ENVIRONMENT}#a`,
    'edge-fixture.example.test',
  ]) {
    assert.equal(
      links.parseDesktopLoginLink(
        desktopLoginLink(
          `state=${STATE}&code=${CODE}&environment=${encodeURIComponent(environment)}`
        )
      ),
      null,
      environment
    )
  }
})

test('signInUrl parsing refuses http, user info, a query, a fragment and another path', () => {
  assert.equal(links.parseDesktopLoginSignInUrl(SIGN_IN_URL), SIGN_IN_URL)
  assert.equal(
    links.parseDesktopLoginSignInUrl('https://profile.example.test:8443/desktop-login'),
    'https://profile.example.test:8443/desktop-login'
  )
  for (const rawUrl of [
    'http://profile.example.test/desktop-login',
    'ftp://profile.example.test/desktop-login',
    'https://fixture-user@profile.example.test/desktop-login',
    'https://fixture-user:pass@profile.example.test/desktop-login',
    'https://:fixture@profile.example.test/desktop-login',
    'https://profile.example.test/desktop-login?next=1',
    'https://profile.example.test/desktop-login#challenge=1',
    'https://profile.example.test/',
    'https://profile.example.test',
    'https://profile.example.test/login',
    'https://profile.example.test/desktop-login/extra',
    'https://profile.example.test/prefix/desktop-login',
    'https://profile.example.test/desktop-login-extra',
    'not a url',
  ]) {
    assert.equal(links.parseDesktopLoginSignInUrl(rawUrl), null, rawUrl)
  }
})

test('signInUrl parsing refuses the near misses Desktop relies on it for', () => {
  assert.equal(
    links.parseDesktopLoginSignInUrl('https://profile.example.test/desktop-login'),
    'https://profile.example.test/desktop-login'
  )

  // Dot segments normalise to /desktop-login, so these two differ only in length.
  const origin = 'https://profile.example.test'
  const pathValue = '/desktop-login'
  const atLimit = `${origin}${'/.'.repeat((2048 - origin.length - pathValue.length) / 2)}${pathValue}`
  const overLimit = `${origin}${'/..'.repeat((2049 - origin.length - pathValue.length) / 3)}${pathValue}`
  assert.equal(atLimit.length, 2048)
  assert.equal(overLimit.length, 2049)
  assert.equal(new URL(overLimit).pathname, pathValue)
  assert.equal(links.parseDesktopLoginSignInUrl(atLimit), SIGN_IN_URL)

  for (const rawUrl of [
    'https://profile.example.test/desktop-login?',
    'https://profile.example.test/desktop-login#',
    'https://profile.example.test/desktop-login/',
    'https://profile.example.test/Desktop-Login',
    'https://profile.example.test/DESKTOP-LOGIN',
    overLimit,
    undefined,
    42,
    {},
    // Stringifies to a valid signInUrl, so only the type guard refuses it.
    ['https://profile.example.test/desktop-login'],
  ]) {
    assert.equal(links.parseDesktopLoginSignInUrl(rawUrl), null, String(rawUrl))
  }
})

test('the signInUrl in the edge methods fixture parses with the page-URL parser', () => {
  const { body } = readEdgeFixture('GET /api/v1/auth/methods password-and-oidc')
  const signInUrl = links.parseDesktopLoginSignInUrl(body.oidc.signInUrl)

  assert.notEqual(signInUrl, null)
  assert.equal(signInUrl, body.oidc.signInUrl)
  const pageUrl = links.buildDesktopLoginPageUrl(body.oidc.signInUrl, {
    challenge: CHALLENGE,
    state: STATE,
  })
  assert.deepEqual(links.parseDesktopLoginPageUrl(pageUrl), {
    signInUrl: body.oidc.signInUrl,
    challenge: CHALLENGE,
    state: STATE,
  })
})

test('the desktop-code-issued answer in the edge fixture round-trips through a code link', () => {
  const { body } = readEdgeFixture('POST /api/v1/oidc/profile-flow/complete desktop-code-issued')
  assert.equal(body.outcome, 'desktop_code_issued')

  const link = links.buildDesktopLoginCodeLink({
    state: STATE,
    code: body.code,
    environment: body.environment,
  })

  assert.deepEqual(links.parseDesktopLoginLink(link), {
    kind: 'code',
    state: STATE,
    code: body.code,
    environment: body.environment,
  })
})
