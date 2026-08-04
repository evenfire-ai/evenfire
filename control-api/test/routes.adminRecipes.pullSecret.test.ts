/**
 * Route-level coverage for image-pull-secret provisioning on the GENERIC recipe routes.
 *
 * `POST /admin/recipes` and `PUT /admin/recipes/:name` persist the same WorkflowRecipe CRD
 * the registry install path does, and WRC injects the platform pull-secret reference for
 * any workload whose image is ours — it does not care which route wrote the recipe. So a
 * recipe authored or edited here must provision too, or the pod references a Secret that
 * was never minted: ImagePullBackOff behind a green 201.
 *
 * The main `routes.adminRecipes` suite runs in the default `managed` connection mode,
 * where provisioning short-circuits to `'skipped'`; these force `self-hosted`, the only
 * mode where the hook does anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminRecipesRouter } from '../src/routes/admin/recipes.js'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '../src/routes/admin/registryImagePullSecret.js'
import {
  RegistryProxyError,
  mintOrgPullCredential,
  resolvePublishScope,
} from '../src/services/registryClient.js'
import { isRegistryAuthActive } from '../src/services/registryConnectionDb.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/db.js', () => ({
  // The provisioner takes a cross-process advisory lock; without this the suite reaches a
  // real Postgres and every test times out. The lock itself is asserted in
  // registryPullSecretService.test.ts.
  withTransaction: (work: (db: unknown) => unknown) =>
    work({ query: async () => ({ rows: [], rowCount: 0 }) }),
}))

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34' }]),
}))
vi.mock('../src/services/registryClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/registryClient.js')>()),
  resolvePublishScope: vi.fn(),
  mintOrgPullCredential: vi.fn(),
}))
vi.mock('../src/services/registryConnectionDb.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/registryConnectionDb.js')>()),
  isRegistryAuthActive: vi.fn(),
}))

const REGISTRY_HOST = 'registry.evenfire.ai'
const MCP_NS = 'mcp-server'
const SANDBOX_NS = 'sandbox-recipes'
const PLATFORM_NAMESPACES = [MCP_NS, SANDBOX_NS, 'sandbox-ui']

/** A workload image on the configured platform registry — needs the pull credential. */
function platformRecipe(name: string) {
  return {
    metadata: { name },
    spec: {
      workloads: [{ id: 'svc', type: 'deployment', image: `${REGISTRY_HOST}/acme/plugin:1.0` }],
    },
  }
}

/** Same shape, third-party image — the platform credential is none of its business. */
function foreignRecipe(name: string) {
  return {
    metadata: { name },
    spec: {
      workloads: [{ id: 'svc', type: 'deployment', image: 'ghcr.io/acme/plugin:1.0' }],
    },
  }
}

function makeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRecipesRouter(gateway as never))
  return app
}

let savedMode: typeof config.registryConnectionMode
let savedUrl: string

beforeEach(() => {
  vi.clearAllMocks()
  savedMode = config.registryConnectionMode
  savedUrl = config.registryUrl
  config.registryConnectionMode = 'self-hosted'
  config.registryUrl = `https://${REGISTRY_HOST}`
  vi.mocked(isRegistryAuthActive).mockResolvedValue(true)
  vi.mocked(resolvePublishScope).mockResolvedValue({
    curator: false,
    orgName: 'acme',
    scope: '@acme',
  })
  vi.mocked(mintOrgPullCredential).mockResolvedValue({ key: 'efrk_recipe_route_key' })
})

afterEach(() => {
  config.registryConnectionMode = savedMode
  config.registryUrl = savedUrl
})

describe('POST /admin/recipes — pull-secret provisioning (self-hosted)', () => {
  it('provisions every platform namespace BEFORE persisting the CRD', async () => {
    const gateway = new MockGateway(MCP_NS)
    const createResource = vi.spyOn(gateway, 'createResource')

    await request(makeApp(gateway)).post('/admin/recipes').send(platformRecipe('plat')).expect(201)

    // Ordering is the point: a CRD persisted first would reference a Secret that does not
    // exist yet, and a provisioning failure after the write leaves it stranded.
    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    expect(vi.mocked(mintOrgPullCredential).mock.invocationCallOrder[0]).toBeLessThan(
      createResource.mock.invocationCallOrder[0]
    )
    for (const ns of PLATFORM_NAMESPACES) {
      const secret = (await gateway.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns)) as {
        type?: string
      }
      expect(secret.type).toBe('kubernetes.io/dockerconfigjson')
    }
  })

  it('provisions nothing for a recipe with no platform-registry image', async () => {
    const gateway = new MockGateway(MCP_NS)

    await request(makeApp(gateway)).post('/admin/recipes').send(foreignRecipe('ext')).expect(201)

    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    await expect(
      gateway.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX_NS)
    ).rejects.toBeTruthy()
  })

  it('maps a provisioning failure to its own status and persists NO recipe', async () => {
    vi.mocked(resolvePublishScope).mockResolvedValue({ curator: false, orgName: null, scope: null })
    const gateway = new MockGateway(MCP_NS)

    const res = await request(makeApp(gateway)).post('/admin/recipes').send(platformRecipe('plat'))

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      error: 'registry_pull_secret_provision_failed',
      reason: 'org_unresolved',
    })
    await expect(gateway.getResource('workflowrecipes', 'plat', SANDBOX_NS)).rejects.toBeTruthy()
  })

  it('maps a registry rejection to 502 registry_rejected, not a bare 500', async () => {
    // The mint endpoint 403s when the registry has not been upgraded to support tenant
    // pull-credential minting, or this deployment lacks `registry:manage-keys`. That is a
    // deploy-ordering problem the operator can act on — collapsing it into a generic 500
    // (which is what a plain K8s-error mapping does, since it cannot read
    // RegistryProxyError.status) makes it look like a control-api bug.
    vi.mocked(mintOrgPullCredential).mockRejectedValue(
      new RegistryProxyError(403, { error: 'forbidden' })
    )
    const gateway = new MockGateway(MCP_NS)

    const res = await request(makeApp(gateway)).post('/admin/recipes').send(platformRecipe('plat'))

    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({
      error: 'registry_pull_secret_provision_failed',
      reason: 'registry_rejected',
      upstreamStatus: 403,
    })
    await expect(gateway.getResource('workflowrecipes', 'plat', SANDBOX_NS)).rejects.toBeTruthy()
  })
})

describe('PUT /admin/recipes/:name — pull-secret provisioning (self-hosted)', () => {
  /** Seed a third-party-image recipe, so the update is what first pulls ours into play. */
  async function seedForeignRecipe(gateway: MockGateway, name: string) {
    await request(makeApp(gateway)).post('/admin/recipes').send(foreignRecipe(name)).expect(201)
    vi.mocked(mintOrgPullCredential).mockClear()
  }

  it('provisions every platform namespace BEFORE persisting the update', async () => {
    const gateway = new MockGateway(MCP_NS)
    await seedForeignRecipe(gateway, 'plat')
    const updateResource = vi.spyOn(gateway, 'updateResource')

    await request(makeApp(gateway))
      .put('/admin/recipes/plat')
      .send({ spec: platformRecipe('plat').spec })
      .expect(200)

    expect(mintOrgPullCredential).toHaveBeenCalledTimes(1)
    expect(vi.mocked(mintOrgPullCredential).mock.invocationCallOrder[0]).toBeLessThan(
      updateResource.mock.invocationCallOrder[0]
    )
    for (const ns of PLATFORM_NAMESPACES) {
      const secret = (await gateway.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, ns)) as {
        type?: string
      }
      expect(secret.type).toBe('kubernetes.io/dockerconfigjson')
    }
  })

  it('mints NOTHING for a PUT naming a recipe that does not exist', async () => {
    const gateway = new MockGateway(MCP_NS)

    const res = await request(makeApp(gateway))
      .put('/admin/recipes/ghost')
      .send({ spec: platformRecipe('ghost').spec })

    // The mint is rotate-on-call — it revokes the org's previous key. A request that was
    // always going to 404 must not spend one, or it strands every namespace already
    // holding a Secret built from the key it just replaced.
    expect(res.status).toBe(404)
    expect(mintOrgPullCredential).not.toHaveBeenCalled()
  })

  it('provisions nothing when the update keeps a third-party image', async () => {
    const gateway = new MockGateway(MCP_NS)
    await seedForeignRecipe(gateway, 'ext')

    await request(makeApp(gateway))
      .put('/admin/recipes/ext')
      .send({ spec: foreignRecipe('ext').spec })
      .expect(200)

    expect(mintOrgPullCredential).not.toHaveBeenCalled()
    await expect(
      gateway.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX_NS)
    ).rejects.toBeTruthy()
  })

  it('maps a provisioning failure to its own status and does NOT persist the update', async () => {
    const gateway = new MockGateway(MCP_NS)
    await seedForeignRecipe(gateway, 'plat')
    vi.mocked(resolvePublishScope).mockResolvedValue({ curator: false, orgName: null, scope: null })

    const res = await request(makeApp(gateway))
      .put('/admin/recipes/plat')
      .send({ spec: platformRecipe('plat').spec })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      error: 'registry_pull_secret_provision_failed',
      reason: 'org_unresolved',
    })
    const stored = (await gateway.getResource('workflowrecipes', 'plat', SANDBOX_NS)) as {
      spec: { workloads: Array<{ image: string }> }
    }
    expect(stored.spec.workloads[0].image).toBe('ghcr.io/acme/plugin:1.0')
  })
})
