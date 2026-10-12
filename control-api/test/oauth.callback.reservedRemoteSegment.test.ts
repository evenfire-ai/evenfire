import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import type { PinnedRawResponse } from '../src/http/pinnedFetch.js'
import { buildAuthorizeUrl } from '../src/oauth/authorizeUrlHelper.js'
import {
  type CallbackDeps,
  type McpServerOAuthReader,
  type McpServerOAuthSubject,
  REMOTE_CALLBACK_CLIENT_SEGMENT,
  type SecretReader,
  handleOAuthCallback,
} from '../src/oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import {
  getCredentialSchema,
  getDigest,
  getEntryVersion,
  reportInstall,
} from '../src/services/registryClient.js'
import { MockGateway } from './mockGateway.js'

/**
 * RP-R4-SC2-01 — the stable remote callback segment (`/oauth-callback/remote`)
 * waives the segment==id check, so it must only accept states of REMOTE subjects.
 * A baked/generic state delivered there is a `binding_mismatch`, rejected BEFORE
 * the single-use code is exchanged (T4: no token-endpoint call, nothing persisted).
 *
 * T1: nothing here is hand-built wire data. The CRs come from the real registry
 * install route (MockGateway), the subject from `resolveServerOAuthSubject`, and
 * the state from `buildAuthorizeUrl` — the same minter the consent route uses.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

vi.mock('../src/services/registryClient.js', () => ({
  searchEntries: vi.fn(),
  getEntry: vi.fn(),
  getEntryVersion: vi.fn(),
  getCredentialSchema: vi.fn(),
  getCategories: vi.fn(),
  reportInstall: vi.fn(),
  downloadBundle: vi.fn(),
  getDigest: vi.fn(),
  uploadArtifacts: vi.fn(),
  updateVersionMetadata: vi.fn(),
  deleteVersion: vi.fn(),
  publishEntry: vi.fn(),
  resolvePublishScope: vi.fn(),
  applyPublishScope: vi.fn((name: string | undefined) => name),
}))

const MCP_NS = 'mcp-server'
const CONTEXT = 'default-context'
const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)
const USER_ID = 'user-9'
const GENERIC_KNOBS = {
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token',
  tokenRequestFormat: 'form',
  tokenAuthMethod: 'body',
  scopeSeparator: 'space',
  sendScope: true,
  usePkce: true,
  includeResponseType: true,
  supportsRefresh: true,
}

let savedCallbackBaseUrl: string

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getDigest).mockResolvedValue({ digest: null })
  vi.mocked(getCredentialSchema).mockRejectedValue(new Error('No credential schema endpoint'))
  vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true })
  savedCallbackBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = 'https://control.example.com'
})

afterEach(() => {
  config.oauthCallbackBaseUrl = savedCallbackBaseUrl
})

function catalogEntry(oauth: Record<string, unknown>) {
  return {
    id: '1',
    name: 'some-mcp',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'OAuth MCP server',
    author: 'clerum',
    origin: 'official',
    category: 'productivity',
    tags: [],
    trust_level: 'high',
    quality_tier: 'verified',
    status: 'published',
    server_mode: 'local',
    transport: 'streamableHttp',
    recipe_type: null,
    mcp_server_meta: { imageRef: 'clerum/some-mcp:1.0.0', port: 3000, oauth },
    recipe_meta: null,
    artifact_refs: null,
    downloads: 0,
    installs: 0,
    created_at: '2026-03-01T00:00:00Z',
  }
}

function makeInstallApp() {
  const gw = new MockGateway(MCP_NS)
  gw.createResource('contexts', {
    metadata: { name: CONTEXT },
    spec: { contextId: CONTEXT, mcpServers: [] },
  })
  const app = express()
  app.use(express.json())
  app.use(
    createAdminRegistryRouter(gw as unknown as import('../src/k8s.js').K8sGateway, {
      uninstallDb: { query: async () => ({ rows: [], rowCount: 0 }) },
    })
  )
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return { app, gw }
}

type Lane = 'generic' | 'baked'

/** Install a server through the REAL registry route and return its stored CR. */
async function installServer(lane: Lane, serverName: string) {
  const { app, gw } = makeInstallApp()
  if (lane === 'generic') {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(catalogEntry({ provider: 'generic' }))
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName,
        contextRef: CONTEXT,
        registryEntryName: 'some-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { scopes: ['read'], generic: GENERIC_KNOBS },
      })
      .expect(201)
  } else {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(catalogEntry({ provider: 'google' }))
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName,
        contextRef: CONTEXT,
        registryEntryName: 'some-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          secret: { mode: 'managed', clientId: 'cid-value', clientSecret: 'csec-value' },
        },
      })
      .expect(201)
  }
  const cr = (await gw.getResource('mcpservers', serverName, MCP_NS)) as Parameters<
    typeof resolveServerOAuthSubject
  >[0]
  return { gw, cr }
}

function gatewaySecretReader(gw: MockGateway): SecretReader {
  return {
    read: async (name, namespace) => {
      const secret = (await gw.getSecret(name, namespace)) as { data?: Record<string, string> }
      return Object.fromEntries(
        Object.entries(secret.data ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64').toString()])
      )
    },
  }
}

const TOKEN_RESPONSE = JSON.stringify({
  access_token: 'AT',
  refresh_token: 'RT',
  expires_in: 3600,
  token_type: 'Bearer',
})

/**
 * Mint a state with the real minter for the installed server, then hand it to the
 * callback on the given URL segment. Every token-endpoint path (baked `fetchFn`,
 * generic/remote `pinnedTransport`) is observable.
 */
async function deliverState(lane: Lane, serverName: string, segment: string) {
  const { gw, cr } = await installServer(lane, serverName)
  const resolved = resolveServerOAuthSubject(cr, 'consent')
  if (!resolved) throw new Error('installed CR must resolve to an OAuth subject')
  const mcpServerReader: McpServerOAuthReader = {
    read: vi.fn(async () => ({ namespace: MCP_NS, ...resolved }) as McpServerOAuthSubject),
  }
  const secretReader = gatewaySecretReader(gw)

  const minted = await buildAuthorizeUrl(
    {
      subjectKind: 'mcp',
      mcpServerName: serverName,
      oauthClientId: resolved.decl.id,
      userId: USER_ID,
      grantKind: 'user',
      background: false,
      redirectUri: `https://control.example.com/api/v1/oauth-callback/${resolved.decl.id}`,
    },
    {
      recipeReader: { read: vi.fn(async () => null) },
      mcpServerReader,
      secretReader,
      stateSecret: STATE_SECRET,
    }
  )
  if (minted.kind !== 'ok') throw new Error(`authorize url not minted: ${minted.kind}`)
  const state = new URL(minted.authorizeUrl).searchParams.get('state')
  if (!state) throw new Error('minted authorize url carries no state')

  const fetchFn = vi.fn(
    async () =>
      new Response(TOKEN_RESPONSE, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  )
  const pinnedTransport = vi.fn(
    async (): Promise<PinnedRawResponse> => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: TOKEN_RESPONSE,
    })
  )
  const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'grant-1' }], rowCount: 1 }) }
  const deps: CallbackDeps = {
    db: db as unknown as CallbackDeps['db'],
    recipeReader: { read: vi.fn(async () => null) },
    secretReader,
    mcpServerReader,
    userContextsReader: vi.fn(async () => ({ contextIds: [CONTEXT] })),
    fetchFn: fetchFn as unknown as typeof fetch,
    stateSecret: STATE_SECRET,
    encryptionKey: ENCRYPTION_KEY,
    resolveDns: async () => ['93.184.216.34'],
    pinnedTransport,
  }

  const result = await handleOAuthCallback(
    {
      // The route maps the reserved segment to the shared remote callback.
      target:
        segment === REMOTE_CALLBACK_CLIENT_SEGMENT
          ? { kind: 'remote-shared', origin: 'https://control.example.com' }
          : {
              kind: 'client',
              id: segment,
              redirectUri: `https://control.example.com/api/v1/oauth-callback/${segment}`,
            },
      code: 'AUTH_CODE',
      state,
    },
    deps
  )
  return { result, fetchFn, pinnedTransport, db }
}

describe('handleOAuthCallback — reserved remote segment requires a remote subject (RP-R4-SC2-01)', () => {
  it.each<Lane>(['generic', 'baked'])(
    'rejects a %s state delivered on /oauth-callback/remote WITHOUT exchanging the code',
    async lane => {
      const { result, fetchFn, pinnedTransport, db } = await deliverState(
        lane,
        'my-idp',
        REMOTE_CALLBACK_CLIENT_SEGMENT
      )

      expect(result).toEqual({ kind: 'invalid_state', reason: 'binding_mismatch' })
      expect(fetchFn).not.toHaveBeenCalled()
      expect(pinnedTransport).not.toHaveBeenCalled()
      expect(db.query).not.toHaveBeenCalled()
    }
  )

  it.each<Lane>(['generic', 'baked'])(
    'still completes a %s state delivered on its own client-id segment',
    async lane => {
      const { result, fetchFn, pinnedTransport, db } = await deliverState(lane, 'my-idp', 'my-idp')

      expect(result.kind).toBe('ok')
      expect(fetchFn.mock.calls.length + pinnedTransport.mock.calls.length).toBe(1)
      expect(String(db.query.mock.calls[0]?.[0])).toContain('INSERT INTO oauth_grants')
    }
  )
})

describe('POST /admin/registry/install — reserved oauth.id (RP-R4-SC2-01)', () => {
  it.each<Lane>(['generic', 'baked'])(
    'rejects a %s install whose serverName derives the reserved oauth.id, before any write',
    async lane => {
      const { app, gw } = makeInstallApp()
      const createSecretSpy = vi.spyOn(gw, 'createSecret')
      vi.mocked(getEntryVersion).mockResolvedValueOnce(
        catalogEntry({ provider: lane === 'generic' ? 'generic' : 'google' })
      )
      const oauth =
        lane === 'generic'
          ? {
              scopes: ['read'],
              secret: { mode: 'managed', clientId: 'cid', clientSecret: 'csec' },
              generic: GENERIC_KNOBS,
            }
          : {
              scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
              secret: { mode: 'managed', clientId: 'cid', clientSecret: 'csec' },
            }

      const res = await request(app).post('/admin/registry/install').send({
        serverName: REMOTE_CALLBACK_CLIENT_SEGMENT,
        contextRef: CONTEXT,
        registryEntryName: 'some-mcp',
        registryEntryVersion: '1.0.0',
        oauth,
      })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('oauth_id_reserved')
      expect(createSecretSpy).not.toHaveBeenCalled()
      await expect(
        gw.getResource('mcpservers', REMOTE_CALLBACK_CLIENT_SEGMENT, MCP_NS)
      ).rejects.toThrow()
    }
  )
})

describe('handleOAuthCallback — recipe clients are outside the reservation (RP-R4-SC2-01)', () => {
  // A recipe's `oauthClients[]` is operator-authored CR data (admin CRUD passes it
  // through verbatim), so there is no control-api producer to derive it from. The
  // waiver is mcp-only, so a recipe client literally named `remote` still takes the
  // segment==id path and must keep working.
  it("completes a recipe client whose id is 'remote' on /oauth-callback/remote", async () => {
    const recipe = {
      metadata: { name: 'crm', namespace: 'sandbox-recipes' },
      spec: {
        oauthClients: [
          {
            id: REMOTE_CALLBACK_CLIENT_SEGMENT,
            provider: 'salesforce',
            clientIdRef: { name: 'sf-creds', key: 'client-id' },
            clientSecretRef: { name: 'sf-creds', key: 'client-secret' },
            scopes: ['api'],
          },
        ],
      },
    }
    const recipeReader = { read: vi.fn(async () => recipe) }
    const secretReader: SecretReader = {
      read: vi.fn(async () => ({ 'client-id': 'CID', 'client-secret': 'CSEC' })),
    }
    const redirectUri = `https://control.example.com/api/v1/oauth-callback/${REMOTE_CALLBACK_CLIENT_SEGMENT}`
    const minted = await buildAuthorizeUrl(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: REMOTE_CALLBACK_CLIENT_SEGMENT,
        userId: USER_ID,
        grantKind: 'user',
        background: false,
        redirectUri,
      },
      { recipeReader, secretReader, stateSecret: STATE_SECRET }
    )
    if (minted.kind !== 'ok') throw new Error(`authorize url not minted: ${minted.kind}`)
    const state = new URL(minted.authorizeUrl).searchParams.get('state') ?? ''

    const fetchFn = vi.fn(
      async () =>
        new Response(TOKEN_RESPONSE, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
    const result = await handleOAuthCallback(
      {
        target: { kind: 'remote-shared', origin: 'https://control.example.com' },
        code: 'AUTH_CODE',
        state,
      },
      {
        db: db as unknown as CallbackDeps['db'],
        recipeReader,
        secretReader,
        fetchFn: fetchFn as unknown as typeof fetch,
        stateSecret: STATE_SECRET,
        encryptionKey: ENCRYPTION_KEY,
      } as CallbackDeps
    )

    expect(result.kind).toBe('ok')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // The recipe exchange replays the exact URI its authorize URL carried.
    const tokenInit = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(new URLSearchParams(String(tokenInit.body)).get('redirect_uri')).toBe(redirectUri)
    expect(String(db.query.mock.calls[0]?.[0])).toContain('INSERT INTO oauth_grants')
  })
})
