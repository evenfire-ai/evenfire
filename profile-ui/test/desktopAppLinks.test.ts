import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import { buildDesktopLoginCodeLink } from '@clerum/desktop-app-links'
import { DESKTOP_SIGN_IN_COPY } from '../app/constants/oidc'
import {
  buildDesktopEnvironmentLink,
  buildDesktopLoginHandoffDocument,
  buildEvenfireDesktopAppContentSecurityPolicy,
  buildEvenfireDesktopAppLink,
  buildEvenfireDesktopAppRedirectDocument,
  buildEvenfireDesktopGfsResourceRedirectDocument,
  navigateToDesktopApp,
} from '../lib/desktopAppLinks'
import { edgeRecord } from './edgeFixtures'

function withDesktopHandoffEnabled<T>(run: () => T): T {
  const original = process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED
  try {
    process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED = 'true'
    return run()
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED
    else process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED = original
  }
}

test('buildDesktopEnvironmentLink is disabled unless the rollout flag is enabled', () => {
  const original = process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED
  const environment = {
    externalRestApiBaseUrl: 'https://api.example.com',
    rpcProxyBaseUrl: '',
    appName: 'Example tenant',
  }

  try {
    delete process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED
    assert.equal(buildDesktopEnvironmentLink(environment), null)

    process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED = 'false'
    assert.equal(buildDesktopEnvironmentLink(environment), null)

    process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED = 'true'
    assert.ok(buildDesktopEnvironmentLink(environment))
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED
    else process.env.NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED = original
  }
})

test('buildDesktopEnvironmentLink defaults the tenant name to Evenfire', () => {
  withDesktopHandoffEnabled(() => {
    const link = buildDesktopEnvironmentLink({
      externalRestApiBaseUrl: 'https://api.example.com',
      rpcProxyBaseUrl: '',
      appName: '',
    })

    assert.ok(link)
    const parsedLink = new URL(link)
    assert.equal(parsedLink.searchParams.get('tenantName'), 'Evenfire')
  })
})

test('buildDesktopEnvironmentLink does not include the RPC proxy URL', () => {
  withDesktopHandoffEnabled(() => {
    const link = buildDesktopEnvironmentLink({
      externalRestApiBaseUrl: 'https://api.example.com',
      rpcProxyBaseUrl: 'https://rpc.example.com',
      appName: 'Example tenant',
    })

    assert.ok(link)
    const parsedLink = new URL(link)
    assert.equal(parsedLink.searchParams.get('rpcProxyBaseUrl'), null)
  })
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

test('the app and resource handoff documents keep their bytes on the shared shell', () => {
  // sha256 of each document as e9ba60538 rendered it, before the shell was shared. A change to
  // the handoff page changes these on purpose.
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  const scriptNonce = 'dGVzdC1ub25jZQ=='
  assert.equal(
    sha256(
      buildEvenfireDesktopAppRedirectDocument(
        'evenfire://app/sandbox-recipes/agentic-task-board?path=%2Ftasks%2Ftask-42&team=team-123',
        scriptNonce
      )
    ),
    '6f8d3ab6624138e875b70cd01b09cfdb3d65c7a564a0e79501584744fce39548'
  )
  assert.equal(
    sha256(
      buildEvenfireDesktopGfsResourceRedirectDocument(
        'gfs://main/0123456789abcdef0123456789abcdef',
        scriptNonce
      )
    ),
    'd73af696264c9f9001be835fe537c1d5a1ce8eb4537952a1b51566ccd42d34f3'
  )
})

const HANDOFF_COPY = {
  title: DESKTOP_SIGN_IN_COPY.handoffTitle,
  message: DESKTOP_SIGN_IN_COPY.handoffMessage,
}

/**
 * A code link built by the package from External REST's recorded desktop_code_issued answer
 * (external-rest-api/test/fixtures/oidc-desktop-sign-in/edge.json), for a fresh Desktop state.
 */
function desktopCodeLink(): Readonly<{ link: string; code: string }> {
  const { code, environment } = edgeRecord(
    'POST /api/v1/oidc/profile-flow/complete desktop-code-issued'
  ).body as { code: string; environment: string }
  const state = randomBytes(32).toString('base64url')
  return { link: buildDesktopLoginCodeLink({ state, code, environment }), code }
}

test('the Desktop handoff document has no anchor, a scripted button and the link once', () => {
  const { link, code } = desktopCodeLink()
  const scriptNonce = 'dGVzdC1ub25jZQ=='
  const body = buildDesktopLoginHandoffDocument(link, scriptNonce, HANDOFF_COPY)
  const scripts = [...body.matchAll(/<script nonce="([^"]+)">([^<]*)<\/script>/g)]
  const cspNonce = buildEvenfireDesktopAppContentSecurityPolicy(scriptNonce).match(
    /script-src 'nonce-([^']+)'/
  )?.[1]

  assert.equal(body.split(code).length - 1, 1)
  assert.ok(!/<a\b/i.test(body))
  assert.match(
    body,
    /<button type="button" id="open-evenfire-desktop"[^>]*>Open Evenfire Desktop<\/button>/
  )
  assert.ok(body.includes(`<h1>${HANDOFF_COPY.title}</h1>`))
  assert.ok(body.includes(`<p class="body-copy">${HANDOFF_COPY.message}</p>`))
  assert.equal((body.match(/<script\b/g) ?? []).length, 1)
  assert.equal(scripts.length, 1)
  assert.equal(scripts[0][1], cspNonce)

  // Runs the one script against a stand-in window and button.
  const replaced: string[] = []
  const location = { href: 'about:blank', replace: (url: string) => void replaced.push(url) }
  const clickListeners: Array<() => void> = []
  const button = {
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'click') clickListeners.push(listener)
    },
  }
  const getElementById = (id: string) => (id === 'open-evenfire-desktop' ? button : null)
  new Function('window', 'document', scripts[0][2])({ location }, { getElementById })
  assert.deepEqual(replaced, [link])
  assert.equal(location.href, 'about:blank')
  assert.equal(clickListeners.length, 1)
  clickListeners[0]()
  assert.equal(location.href, link)
  assert.deepEqual(replaced, [link])
})

test('the Desktop handoff document refuses https and evenfire://app links', () => {
  const { link } = desktopCodeLink()
  const query = link.slice(link.indexOf('?'))
  for (const [label, refused] of [
    ['an https link with the same query', `https://profile.example.test/desktop-login${query}`],
    ['an evenfire://app link', 'evenfire://app/sandbox-recipes/agentic-task-board'],
    ['a code link with an extra parameter', `${link}&extra=1`],
  ] as const) {
    assert.throws(
      () => buildDesktopLoginHandoffDocument(refused, 'dGVzdC1ub25jZQ==', HANDOFF_COPY),
      /invalid Desktop sign-in link/,
      label
    )
  }
})
