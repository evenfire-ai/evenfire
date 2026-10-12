import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { config } from '../src/config.js'
import type { PinnedRawResponse, PinnedTransportInput } from '../src/http/pinnedFetch.js'
import {
  type CallbackDeps,
  type CallbackTarget,
  type McpServerOAuthSubject,
  handleOAuthCallback,
} from '../src/oauth/callback.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import { getDynamicClientBinding } from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  type McpServerOAuthSpecInput,
  resolveServerOAuthSubject,
} from '../src/oauth/mcpServerOAuthSpec.js'
import { signOAuthState } from '../src/oauth/state.js'
import {
  discoverPilot,
  installRemoteServer,
  seedContext,
  withRfc9207,
} from './fixtures/perServerInstall.js'
import {
  ATLASSIAN_V2_PILOT,
  PILOTS,
  dcrPilot,
  makeInMemoryDynamicClientsDb,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * Callback of the per-server remote variant (`/oauth-callback/remote/<serverName>
 * [/<installNonce>]`), used when the AS does not return RFC 9207 `iss`. There the
 * redirect URI is the mix-up defence, so the handler must:
 *   - refuse a code delivered to one server's URI with another server's state BEFORE
 *     reading any CR or exchanging the code;
 *   - accept only the URI this installation registered (DCR: the nonce of the row bound
 *     to this CR; pre-registered: no nonce), and only for a per-server CR;
 *   - validate an `iss` the AS sends anyway, rejecting a malformed one;
 *   - replay on the token exchange the URI rebuilt from the signed state and the CR.
 *
 * T1: servers are installed through the real admin install route (CR, uid, row and
 * nonce from the saga); discovery by the real client over probe fixtures; the state by
 * the real signer. The AS token endpoint is the only network edge, recorded here.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

// Capture what the callback logs when it rejects an `iss`, to pin that no request data
// (code, state, the query) reaches the log.
const logged = vi.hoisted(() => ({ warns: [] as unknown[][] }))
vi.mock('../src/observability/logger.js', async importActual => {
  const actual = await importActual<typeof import('../src/observability/logger.js')>()
  const root = actual.rootLogger
  const wrapped = Object.create(root) as typeof root
  wrapped.child = ((bindings: Record<string, unknown>, options?: unknown) => {
    const child = root.child(bindings, options as never)
    if (bindings?.module === 'oauth-callback') {
      const warn = child.warn.bind(child)
      child.warn = ((...args: unknown[]) => {
        logged.warns.push(args)
        return (warn as (...a: unknown[]) => void)(...args)
      }) as typeof child.warn
    }
    return child
  }) as unknown as typeof root.child
  return { ...actual, rootLogger: wrapped }
})

const NS = config.mcpServersNamespace
const ORIGIN = 'https://control.example.com'
const CONTEXT = 'ctx-a'
const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

// Atlassian v2: CIMD + DCR, no RFC 9207, one site → per-server DCR (public).
let atlassian: DiscoveryResult
// Notion: no RFC 9207 → per-server when pre-registered.
let notion: DiscoveryResult
// A DCR AS that returns RFC 9207 → shared.
let sharedDcr: DiscoveryResult

beforeAll(async () => {
  atlassian = await discoverPilot(ATLASSIAN_V2_PILOT)
  notion = await discoverPilot(PILOTS.notion)
  sharedDcr = await discoverPilot(withRfc9207(dcrPilot('public')))
})

let gateway: MockGateway
let db: ReturnType<typeof makeInMemoryDynamicClientsDb>['db']
let savedBaseUrl: string

beforeEach(async () => {
  savedBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = ORIGIN
  gateway = new MockGateway(NS)
  await seedContext(gateway, NS, CONTEXT)
  db = makeInMemoryDynamicClientsDb().db
  logged.warns.length = 0
})

afterEach(() => {
  config.oauthCallbackBaseUrl = savedBaseUrl
})

interface Installed {
  name: string
  redirectUri: string
  /** Last path segment of a DCR redirect URI; undefined for pre-registered. */
  nonce?: string
}

async function installDcr(
  name: string,
  discovery = atlassian,
  baseUrl = ATLASSIAN_V2_PILOT.mcpUrl
): Promise<Installed> {
  const res = await installRemoteServer({
    gateway,
    db,
    discovery,
    body: { serverName: name, contextRef: CONTEXT, baseUrl, mode: 'dcr' },
  })
  if (res.status !== 201) throw new Error(`install failed: ${JSON.stringify(res.body)}`)
  const redirectUri = String(res.body.redirectUri)
  return { name, redirectUri, nonce: redirectUri.split('/').pop() }
}

async function installPreRegistered(name: string): Promise<Installed> {
  const res = await installRemoteServer({
    gateway,
    db,
    discovery: notion,
    body: {
      serverName: name,
      contextRef: CONTEXT,
      baseUrl: PILOTS.notion.mcpUrl,
      mode: 'pre-registered',
      clientId: `client-${name}`,
      clientSecret: `secret-${name}`,
    },
  })
  if (res.status !== 201) throw new Error(`install failed: ${JSON.stringify(res.body)}`)
  return { name, redirectUri: String(res.body.redirectUri) }
}

async function oauthOf(name: string): Promise<Record<string, unknown>> {
  const cr = (await gateway.getResource('mcpservers', name, NS)) as {
    spec: { oauth: Record<string, unknown> }
  }
  return cr.spec.oauth
}

/** The state the authorize-url mint signs for this server: its CR's client id. */
async function stateFor(name: string): Promise<string> {
  return signOAuthState(STATE_SECRET, {
    subjectKind: 'mcp',
    mcpServerName: name,
    userId: 'user-9',
    oauthClientId: String((await oauthOf(name)).id),
    grantKind: 'user',
    background: false,
  } as Parameters<typeof signOAuthState>[1])
}

function perServer(
  serverName: string,
  installNonce?: string,
  origin: string | null = ORIGIN
): CallbackTarget {
  return { kind: 'remote-per-server', serverName, installNonce, origin }
}

function harness() {
  const tokenPosts: { url: string; body: string }[] = []
  const pinnedTransport = vi.fn(async (input: PinnedTransportInput): Promise<PinnedRawResponse> => {
    tokenPosts.push({ url: input.url, body: input.body ?? '' })
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
    }
  })
  // The production subject reader (routes/external/oauthCallback.ts) over the gateway.
  const read = vi.fn(async (name: string): Promise<McpServerOAuthSubject | null> => {
    const cr = (await gateway.getResource('mcpservers', name, NS)) as McpServerOAuthSpecInput
    const resolved = resolveServerOAuthSubject(cr, 'consent')
    return resolved ? { namespace: NS, ...resolved } : null
  })
  const recipeRead = vi.fn(async () => null)
  const deps: CallbackDeps = {
    db,
    recipeReader: { read: recipeRead },
    secretReader: {
      async read(name, namespace) {
        const raw = (await gateway.getSecret(name, namespace)) as { data?: Record<string, string> }
        return Object.fromEntries(
          Object.entries(raw.data ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64').toString()])
        )
      },
    },
    mcpServerReader: { read },
    userContextsReader: async () => ({ contextIds: [CONTEXT] }),
    fetchFn: (async () => {
      throw new Error('the remote lane must not use fetchFn')
    }) as unknown as typeof fetch,
    stateSecret: STATE_SECRET,
    encryptionKey: KEY,
    resolveDns: async () => ['93.184.216.34'],
    pinnedTransport,
  }
  return { deps, read, recipeRead, tokenPosts }
}

function redirectUriOf(post: { body: string }): string | null {
  return new URLSearchParams(post.body).get('redirect_uri')
}

describe('per-server callback — success', () => {
  it('DCR: the registered /remote/<name>/<nonce> exchanges, replaying that exact URI', async () => {
    const srv = await installDcr('atlassian')
    const h = harness()

    const result = await handleOAuthCallback(
      { target: perServer(srv.name, srv.nonce), code: 'CODE', state: await stateFor(srv.name) },
      h.deps
    )

    expect(result).toMatchObject({ kind: 'ok', source: 'mcp', mcpServerName: 'atlassian' })
    expect(h.tokenPosts).toHaveLength(1)
    expect(redirectUriOf(h.tokenPosts[0])).toBe(srv.redirectUri)
  })

  it('pre-registered: /remote/<name> exchanges with the confidential secret', async () => {
    const srv = await installPreRegistered('hubspot')
    const h = harness()

    const result = await handleOAuthCallback(
      { target: perServer(srv.name), code: 'CODE', state: await stateFor(srv.name) },
      h.deps
    )

    expect(result.kind).toBe('ok')
    expect(h.tokenPosts).toHaveLength(1)
    expect(redirectUriOf(h.tokenPosts[0])).toBe(`${ORIGIN}/api/v1/oauth-callback/remote/hubspot`)
    expect(redirectUriOf(h.tokenPosts[0])).toBe(srv.redirectUri)
    expect(new URLSearchParams(h.tokenPosts[0].body).get('client_secret')).toBe('secret-hubspot')
  })
})

describe('per-server callback — a code for one server never binds to another (I2)', () => {
  it('DCR: /remote/a/<nonceA> with the state of b → binding_mismatch, b never read, no exchange', async () => {
    const a = await installDcr('server-a')
    await installDcr('server-b')
    const h = harness()

    const result = await handleOAuthCallback(
      { target: perServer(a.name, a.nonce), code: 'CODE', state: await stateFor('server-b') },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.read).not.toHaveBeenCalled()
    expect(h.tokenPosts).toHaveLength(0)
  })

  it('pre-registered: /remote/a with the state of b → binding_mismatch, b never read, no exchange', async () => {
    const a = await installPreRegistered('server-a')
    await installPreRegistered('server-b')
    const h = harness()

    const result = await handleOAuthCallback(
      { target: perServer(a.name), code: 'CODE', state: await stateFor('server-b') },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.read).not.toHaveBeenCalled()
    expect(h.tokenPosts).toHaveLength(0)
  })

  it('a recipe state on a per-server URI → binding_mismatch, no recipe read', async () => {
    const a = await installPreRegistered('server-a')
    const h = harness()
    const state = signOAuthState(STATE_SECRET, {
      recipeNamespace: config.sandboxNamespace,
      recipeName: 'server-a',
      userId: 'user-9',
      oauthClientId: 'client-server-a',
      grantKind: 'user',
      background: false,
    })

    const result = await handleOAuthCallback(
      { target: perServer(a.name), code: 'CODE', state },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.recipeRead).not.toHaveBeenCalled()
    expect(h.tokenPosts).toHaveLength(0)
  })
})

describe('per-server callback — only the URI this installation registered', () => {
  it('DCR with a nonce that is not the bound row’s → binding_mismatch, no exchange', async () => {
    const srv = await installDcr('atlassian')
    const h = harness()

    const result = await handleOAuthCallback(
      { target: perServer(srv.name, randomUUID()), code: 'CODE', state: await stateFor(srv.name) },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.tokenPosts).toHaveLength(0)
  })

  it('DCR on the nonce-less URI → binding_mismatch (a DCR client never registered it)', async () => {
    const srv = await installDcr('atlassian')
    const h = harness()

    const result = await handleOAuthCallback(
      { target: perServer(srv.name), code: 'CODE', state: await stateFor(srv.name) },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.tokenPosts).toHaveLength(0)
  })

  it('pre-registered with a nonce → binding_mismatch (the operator registered /remote/<name>)', async () => {
    const srv = await installPreRegistered('hubspot')
    const h = harness()

    const result = await handleOAuthCallback(
      { target: perServer(srv.name, randomUUID()), code: 'CODE', state: await stateFor(srv.name) },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.tokenPosts).toHaveLength(0)
  })

  // I6: an AS that returns `iss` is bound on the shared callback; reaching it through a
  // per-server URI would skip the issuer check.
  it('a shared (RFC 9207) server on a per-server URI → binding_mismatch, even with the right iss', async () => {
    const srv = await installDcr('shared-dcr', sharedDcr, dcrPilot('public').mcpUrl)
    expect(srv.redirectUri).toBe(`${ORIGIN}/api/v1/oauth-callback/remote`)
    const h = harness()
    const iss = String((await oauthOf(srv.name)).issForCallback)

    for (const target of [perServer(srv.name), perServer(srv.name, randomUUID())]) {
      const result = await handleOAuthCallback(
        { target, code: 'CODE', state: await stateFor(srv.name), iss },
        h.deps
      )
      expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    }
    expect(h.tokenPosts).toHaveLength(0)
  })

  // I6 with the shared server's REAL bound nonce: the nonce and row checks pass, so only
  // the variant check stands between this request and an exchange with no `iss` at all.
  it('a shared (RFC 9207) server on its own bound nonce, no iss → binding_mismatch, no exchange', async () => {
    const srv = await installDcr('shared-dcr', sharedDcr, dcrPilot('public').mcpUrl)
    const row = await getDynamicClientBinding(db, { serverNamespace: NS, serverName: srv.name })
    expect(row?.installId).toMatch(/^[0-9a-f-]{36}$/)
    const h = harness()

    const result = await handleOAuthCallback(
      {
        target: perServer(srv.name, row?.installId),
        code: 'CODE',
        state: await stateFor(srv.name),
      },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.tokenPosts).toHaveLength(0)
  })

  // A CR deleted and recreated outside the uninstall (kubectl, GitOps) leaves the old
  // row behind with the same nonce and client id; only its cr_uid no longer matches.
  it('DCR: a CR recreated over a surviving row → binding_mismatch on the old nonce, no exchange', async () => {
    const srv = await installDcr('atlassian')
    const cr = (await gateway.getResource('mcpservers', srv.name, NS)) as {
      metadata: { name: string; uid: string; labels?: Record<string, string> }
      spec: Record<string, unknown>
    }
    await gateway.deleteResource('mcpservers', srv.name, NS)
    await gateway.createResource(
      'mcpservers',
      { metadata: { name: cr.metadata.name, labels: cr.metadata.labels }, spec: cr.spec },
      NS
    )
    const recreated = (await gateway.getResource('mcpservers', srv.name, NS)) as {
      metadata: { uid: string }
    }
    expect(recreated.metadata.uid).not.toBe(cr.metadata.uid)
    const row = await getDynamicClientBinding(db, { serverNamespace: NS, serverName: srv.name })
    expect(row?.installId).toBe(srv.nonce)
    expect(row?.crUid).toBe(cr.metadata.uid)
    const h = harness()

    const result = await handleOAuthCallback(
      { target: perServer(srv.name, srv.nonce), code: 'CODE', state: await stateFor(srv.name) },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.tokenPosts).toHaveLength(0)
  })

  // The CR's client id rewritten in place (same uid): the row still belongs to this CR
  // but was registered for another client, so its nonce binds nothing.
  it('DCR: a bound row registered for another client id → binding_mismatch, no exchange', async () => {
    const srv = await installDcr('atlassian')
    const cr = (await gateway.getResource('mcpservers', srv.name, NS)) as {
      metadata: { uid: string; resourceVersion?: string }
      spec: { oauth: Record<string, unknown> } & Record<string, unknown>
    }
    await gateway.updateResource(
      'mcpservers',
      srv.name,
      {
        metadata: { uid: cr.metadata.uid, resourceVersion: cr.metadata.resourceVersion },
        spec: { ...cr.spec, oauth: { ...cr.spec.oauth, id: 'rewritten-client-id' } },
      },
      NS
    )
    const h = harness()

    const result = await handleOAuthCallback(
      { target: perServer(srv.name, srv.nonce), code: 'CODE', state: await stateFor(srv.name) },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.tokenPosts).toHaveLength(0)
  })

  it('a remote server on /oauth-callback/<oauthClientId> → binding_mismatch, no exchange', async () => {
    const srv = await installDcr('atlassian')
    const h = harness()
    const id = String((await oauthOf(srv.name)).id)

    const result = await handleOAuthCallback(
      {
        target: { kind: 'client', id, redirectUri: `${ORIGIN}/api/v1/oauth-callback/${id}` },
        code: 'CODE',
        state: await stateFor(srv.name),
      },
      h.deps
    )

    expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
    expect(h.tokenPosts).toHaveLength(0)
  })

  it.each([
    ['no configured origin', null],
    ['a configured origin that is not bare', `${ORIGIN}/base`],
  ])('%s → callback_base_url_unconfigured, no exchange', async (_label, origin) => {
    const srv = await installDcr('atlassian')
    const h = harness()

    const result = await handleOAuthCallback(
      {
        target: perServer(srv.name, srv.nonce, origin),
        code: 'CODE',
        state: await stateFor(srv.name),
      },
      h.deps
    )

    expect(result).toEqual({ kind: 'callback_base_url_unconfigured' })
    expect(h.tokenPosts).toHaveLength(0)
  })
})

describe('per-server callback — an iss the AS sends anyway (I8)', () => {
  async function deliverWithIss(iss: unknown) {
    const srv = await installDcr('atlassian')
    const h = harness()
    const result = await handleOAuthCallback(
      {
        target: perServer(srv.name, srv.nonce),
        code: 'CODE-VALUE',
        state: await stateFor(srv.name),
        iss,
      },
      h.deps
    )
    return { result, h }
  }

  it('equal to the pinned issuer → exchanges', async () => {
    const { result, h } = await deliverWithIss(atlassian.issuer)
    expect(result.kind).toBe('ok')
    expect(h.tokenPosts).toHaveLength(1)
  })

  it('absent → exchanges (the AS does not implement RFC 9207)', async () => {
    const { result, h } = await deliverWithIss(undefined)
    expect(result.kind).toBe('ok')
    expect(h.tokenPosts).toHaveLength(1)
  })

  it.each<[string, () => unknown]>([
    ['a different issuer', () => 'https://evil.example.test'],
    ['an empty value', () => ''],
    ['a repeated parameter', () => [atlassian.issuer, 'https://evil.example.test']],
    ['a repeated parameter with equal values', () => [atlassian.issuer, atlassian.issuer]],
    ['a bracketed parameter', () => ({ a: 'b' })],
  ])('%s → issuer_mismatch, no exchange, log carries only server and reason', async (_l, iss) => {
    const { result, h } = await deliverWithIss(iss())

    expect(result).toEqual({ kind: 'issuer_mismatch' })
    expect(h.tokenPosts).toHaveLength(0)
    expect(logged.warns).toHaveLength(1)
    const [fields] = logged.warns[0] as [Record<string, unknown>]
    expect(Object.keys(fields).sort()).toEqual(['reason', 'serverName'])
    expect(fields.serverName).toBe('atlassian')
    expect(JSON.stringify(logged.warns[0])).not.toContain('CODE-VALUE')
  })
})
