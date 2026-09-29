import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import {
  getCredentialSchema,
  getDigest,
  getEntryVersion,
  reportInstall,
} from '../src/services/registryClient.js'
import {
  REGISTRY_SPEC_DIGEST_ANNOTATION,
  canonicalRegistryJson,
  registrySpecDigest,
} from '../src/services/registryMutation.js'
import { MockGateway } from './mockGateway.js'

// Invariant behind the dismissal of CodeQL alert #1554 (js/insufficient-password-hash,
// docs/how-to/codeql-js-insufficient-password-hash.md): registrySpecDigest is a
// SHA-256 content fingerprint of the McpServer spec, and that spec carries only
// Secret REFERENCES for the OAuth client. If an install path ever inlines the
// client secret into spec.oauth, the digest becomes an unsalted hash of a
// credential and the alert becomes real. These cases fail at that moment.

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

function makeInstallApp() {
  const gw = new MockGateway('mcp-server')
  gw.createResource('contexts', {
    metadata: { name: 'default-context' },
    spec: { contextId: 'default-context', mcpServers: [] },
  })
  const app = express()
  app.use(express.json())
  app.use(
    createAdminRegistryRouter(gw as unknown as import('../src/k8s.js').K8sGateway, {
      uninstallDb: { query: async () => ({ rows: [], rowCount: 0 }) },
    })
  )
  return { app, gw }
}

function oauthEntry(oauth: Record<string, unknown>) {
  return {
    id: '1',
    name: 'gmail-mcp',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Gmail MCP server',
    author: 'clerum',
    origin: 'official',
    category: 'productivity',
    tags: ['gmail'],
    trust_level: 'high',
    quality_tier: 'verified',
    status: 'published',
    server_mode: 'local',
    transport: 'streamableHttp',
    recipe_type: null,
    mcp_server_meta: { imageRef: 'clerum/gmail-mcp:1.0.0', port: 3000, oauth },
    recipe_meta: null,
    hook_meta: null,
    artifact_refs: null,
    downloads: 0,
    installs: 0,
    created_at: '2026-03-01T00:00:00Z',
  }
}

const GENERIC_KNOBS = {
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token',
  tokenRequestFormat: 'form',
  tokenAuthMethod: 'basic',
  scopeSeparator: 'space',
  sendScope: true,
  usePkce: true,
  includeResponseType: true,
  supportsRefresh: true,
}

const CLIENT_ID_VALUE = 'digest-invariant-client-id-7f3a'
const CLIENT_SECRET_VALUE = 'digest-invariant-client-secret-9c1e'

describe('POST /admin/registry/install — the spec digest never covers OAuth client credentials', () => {
  it.each([
    {
      lane: 'baked provider, managed secret',
      catalogOAuth: { provider: 'google', scopes: [] },
      generic: undefined,
    },
    {
      lane: 'generic confidential client, managed secret',
      catalogOAuth: { provider: 'generic' },
      generic: GENERIC_KNOBS,
    },
  ])('$lane', async ({ catalogOAuth, generic }) => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry(catalogOAuth))
    const { app, gw } = makeInstallApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'digest-srv',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['read'],
          secret: { mode: 'managed', clientId: CLIENT_ID_VALUE, clientSecret: CLIENT_SECRET_VALUE },
          ...(generic ? { generic } : {}),
        },
      })
      .expect(201)

    const server = (await gw.getResource('mcpservers', 'digest-srv', 'mcp-server')) as {
      metadata: { annotations?: Record<string, string> }
      spec: Record<string, unknown> & { oauth?: Record<string, unknown> }
    }

    // Witness: the persisted digest annotation is the digest of exactly this spec,
    // so the spec read back is the input registrySpecDigest hashed.
    expect(server.metadata.annotations?.[REGISTRY_SPEC_DIGEST_ANNOTATION]).toBe(
      registrySpecDigest(server.spec)
    )
    // Witness: the credentials were received and routed to the managed Secret.
    const secret = (await gw.getSecret('digest-srv-oauth-client', 'mcp-server')) as {
      data?: Record<string, string>
    }
    expect(secret.data?.client_secret).toBe(Buffer.from(CLIENT_SECRET_VALUE).toString('base64'))
    expect(secret.data?.client_id).toBe(Buffer.from(CLIENT_ID_VALUE).toString('base64'))
    // The spec points at that Secret by reference.
    expect(server.spec.oauth?.clientSecretRef).toEqual({
      name: 'digest-srv-oauth-client',
      key: 'client_secret',
    })

    const hashedInput = canonicalRegistryJson(server.spec)
    expect(hashedInput).not.toContain(CLIENT_SECRET_VALUE)
    expect(hashedInput).not.toContain(CLIENT_ID_VALUE)
  })
})
