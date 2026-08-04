/**
 * Route-level coverage for image-pull-secret self-provisioning on the install path.
 *
 * The main `routes.registryInstall` suite runs in the default `managed` connection mode,
 * where `ensureRegistryPullSecret` short-circuits to `'skipped'` before doing anything —
 * so none of it can catch a regression in the wiring. These tests force `self-hosted`,
 * which is the only mode where the hook actually runs, and pin the properties the wiring
 * is supposed to guarantee:
 *   - it provisions even when the plugin needs NO credentials (outside `credRequired`)
 *   - it provisions BEFORE the McpServer CRD that references the Secret
 *   - a provisioning failure fails the install loudly and persists NOTHING
 *   - it does not run at all for images that are not evenfire-hosted
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '../src/routes/admin/registryImagePullSecret.js'
import {
  getCredentialSchema,
  getDigest,
  getEntryVersion,
  mintOrgPullCredential,
  reportInstall,
  resolvePublishScope,
} from '../src/services/registryClient.js'
import { isRegistryAuthActive } from '../src/services/registryConnectionDb.js'
import { MockGateway } from './mockGateway.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
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
  applyPublishScope: vi.fn((name?: string) => name),
  mintOrgPullCredential: vi.fn(),
  RegistryProxyError: class RegistryProxyError extends Error {
    constructor(
      readonly status: number,
      readonly body: unknown
    ) {
      super(`Registry ${status}`)
      this.name = 'RegistryProxyError'
    }
  },
}))
vi.mock('../src/services/registryConnectionDb.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/registryConnectionDb.js')>()),
  isRegistryAuthActive: vi.fn(),
}))

const REGISTRY_HOST = 'registry.evenfire.ai'
const NS = 'mcp-server'

function makeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gateway as unknown as import('../src/k8s.js').K8sGateway))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

function makeInstallApp() {
  const gw = new MockGateway(NS)
  gw.createResource('contexts', {
    metadata: { name: 'default-context' },
    spec: { contextId: 'default-context', mcpServers: [] },
  })
  return { app: makeApp(gw), gw }
}

/** A local-mode entry whose image lives on the configured evenfire registry. */
function evenfireEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    name: 'forecast',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Forecast MCP',
    author: 'acme',
    server_mode: 'local' as const,
    transport: 'streamableHttp',
    mcp_server_meta: { imageRef: `${REGISTRY_HOST}/acme/forecast:1.2.3`, port: 3000 },
    ...overrides,
  }
}

function installBody() {
  return {
    serverName: 'forecast',
    contextRef: 'default-context',
    registryEntryName: 'forecast',
    registryEntryVersion: '1.0.0',
  }
}

let savedMode: typeof config.registryConnectionMode
let savedUrl: string

beforeEach(() => {
  vi.resetAllMocks()
  savedMode = config.registryConnectionMode
  savedUrl = config.registryUrl
  ;(config as { registryConnectionMode: string }).registryConnectionMode = 'self-hosted'
  ;(config as { registryUrl: string }).registryUrl = `https://${REGISTRY_HOST}`

  vi.mocked(getDigest).mockResolvedValue({ digest: null })
  // No credentials required — proves provisioning is NOT gated on `credRequired`.
  vi.mocked(getCredentialSchema).mockResolvedValue({
    required: false,
    authType: 'none',
    keys: [],
  } as never)
  vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true } as never)
  vi.mocked(isRegistryAuthActive).mockResolvedValue(true)
  vi.mocked(resolvePublishScope).mockResolvedValue({
    curator: false,
    orgName: 'acme',
    scope: '@acme',
  } as never)
  vi.mocked(mintOrgPullCredential).mockResolvedValue({ key: 'efrk_route_key' } as never)
})

afterEach(() => {
  ;(config as { registryConnectionMode: string }).registryConnectionMode = savedMode
  ;(config as { registryUrl: string }).registryUrl = savedUrl
})

describe('POST /admin/registry/install — pull-secret provisioning (self-hosted)', () => {
  it('provisions the pull Secret for a credential-less private plugin', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(evenfireEntry() as never)
    const { app, gw } = makeInstallApp()

    await request(app).post('/admin/registry/install').send(installBody()).expect(201)

    // The Secret must exist in the plugin namespace, keyed on the image host.
    const secret = (await gw.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)) as {
      type?: string
      data?: Record<string, string>
    }
    expect(secret.type).toBe('kubernetes.io/dockerconfigjson')
    const blob = JSON.parse(
      Buffer.from(secret.data?.['.dockerconfigjson'] as string, 'base64').toString('utf8')
    ) as { auths: Record<string, unknown> }
    expect(Object.keys(blob.auths)).toEqual([REGISTRY_HOST])

    // ...and the CRD must reference it.
    const mcp = (await gw.getResource('mcpservers', 'forecast', NS)) as {
      spec: { imagePullSecrets?: Array<{ name: string }> }
    }
    expect(mcp.spec.imagePullSecrets).toEqual([{ name: EVENFIRE_REGISTRY_PULL_SECRET_NAME }])
  })

  it('fails the install loudly and persists NO McpServer when minting fails', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(evenfireEntry() as never)
    vi.mocked(mintOrgPullCredential).mockRejectedValueOnce(new Error('registry unavailable'))
    const { app, gw } = makeInstallApp()

    const res = await request(app).post('/admin/registry/install').send(installBody())
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.body.error).toBe('registry_pull_secret_provision_failed')

    // Nothing may be persisted — an McpServer referencing an absent Secret is exactly the
    // silent ImagePullBackOff this mechanism exists to prevent.
    await expect(gw.getResource('mcpservers', 'forecast', NS)).rejects.toBeTruthy()
  })

  it('surfaces an actionable error when the deployment has no org bound yet', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(evenfireEntry() as never)
    vi.mocked(resolvePublishScope).mockResolvedValue({
      curator: false,
      orgName: null,
      scope: null,
    } as never)
    const { app, gw } = makeInstallApp()

    const res = await request(app).post('/admin/registry/install').send(installBody())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      error: 'registry_pull_secret_provision_failed',
      reason: 'org_unresolved',
    })
    await expect(gw.getResource('mcpservers', 'forecast', NS)).rejects.toBeTruthy()
  })

  it('does not provision for an image that is not evenfire-hosted', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      evenfireEntry({
        mcp_server_meta: { imageRef: 'ghcr.io/acme/forecast:1.2.3', port: 3000 },
      }) as never
    )
    const { app, gw } = makeInstallApp()

    await request(app).post('/admin/registry/install').send(installBody()).expect(201)

    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    await expect(gw.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, NS)).rejects.toBeTruthy()
    const mcp = (await gw.getResource('mcpservers', 'forecast', NS)) as {
      spec: { imagePullSecrets?: unknown }
    }
    expect(mcp.spec.imagePullSecrets).toBeUndefined()
  })
})

describe('POST /admin/registry/install-recipe — pull-secret provisioning (self-hosted)', () => {
  const PLATFORM_NAMESPACES = ['mcp-server', 'sandbox-recipes', 'sandbox-ui']

  function recipeEntry(image: string) {
    return {
      id: 'r1',
      name: 'intel-report',
      version: '1.0.0',
      entry_type: 'recipe',
      description: 'Research + PDF report',
      author: 'acme',
      server_mode: null,
      transport: null,
      recipe_type: 'workflow',
      mcp_server_meta: null,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Intel',
            steps: [{ id: 'research', description: 'Research step' }],
            workloads: [{ id: 'w1', type: 'deployment', image }],
          },
        }),
        stepCount: 1,
        hasAgent: true,
      },
    }
  }

  function recipeBody() {
    return { registryEntryName: 'intel-report', registryEntryVersion: '1.0.0' }
  }

  it('provisions the credential in EVERY platform namespace, minting once', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      recipeEntry(`${REGISTRY_HOST}/acme/plugin:1.0`) as never
    )
    const { app, gw } = makeInstallApp()

    await request(app).post('/admin/registry/install-recipe').send(recipeBody()).expect(201)

    // Recipe workloads split across namespaces by kind, and WRC injects the reference at
    // reconcile time — so all three must hold the credential, from ONE mint (the registry
    // mint is rotate-on-call; a second would revoke the first).
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    for (const ns of PLATFORM_NAMESPACES) {
      const secret = (await gw.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns)) as {
        type?: string
      }
      expect(secret.type).toBe('kubernetes.io/dockerconfigjson')
    }
  })

  it('provisions BEFORE persisting the WorkflowRecipe CRD', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      recipeEntry(`${REGISTRY_HOST}/acme/plugin:1.0`) as never
    )
    const { app, gw } = makeInstallApp()
    // Spy AFTER the fixture context is seeded, so only route writes are recorded.
    const createResource = vi.spyOn(gw, 'createResource')

    await request(app).post('/admin/registry/install-recipe').send(recipeBody()).expect(201)

    // Ordering is the point: a CRD persisted first would reference a Secret that does not
    // exist yet, and a provisioning failure after the write leaves it stranded.
    const recipeWrite = createResource.mock.calls.findIndex(
      ([plural]) => plural === 'workflowrecipes'
    )
    expect(recipeWrite).toBeGreaterThanOrEqual(0)
    expect(vi.mocked(mintOrgPullCredential).mock.invocationCallOrder[0]).toBeLessThan(
      createResource.mock.invocationCallOrder[recipeWrite]
    )
  })

  it('does not provision for a recipe with no platform-registry image', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      recipeEntry('ghcr.io/acme/plugin:1.0') as never
    )
    const { app, gw } = makeInstallApp()

    await request(app).post('/admin/registry/install-recipe').send(recipeBody()).expect(201)

    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    await expect(
      gw.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, 'sandbox-recipes')
    ).rejects.toBeTruthy()
  })

  it('fails the recipe install loudly when provisioning fails', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      recipeEntry(`${REGISTRY_HOST}/acme/plugin:1.0`) as never
    )
    vi.mocked(mintOrgPullCredential).mockRejectedValueOnce(new Error('registry unavailable'))
    const { app, gw } = makeInstallApp()

    const res = await request(app).post('/admin/registry/install-recipe').send(recipeBody())
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.body.error).toBe('registry_pull_secret_provision_failed')
    // No WorkflowRecipe may be persisted referencing a credential that does not exist.
    // Assert on the persisted SET, not on a guessed name: the route derives the CRD name
    // (`recipe-<entry>-v<version>-<hash>`), so a by-name lookup 404s whether the route
    // wrote something or nothing — an assertion that cannot fail.
    const persisted = (await gw.listResource('workflowrecipes', '*')) as Array<{
      metadata: { name: string }
    }>
    expect(persisted.map(r => r.metadata.name)).toEqual([])
  })
})
