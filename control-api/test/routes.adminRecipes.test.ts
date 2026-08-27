import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express, Response as ExpressResponse, NextFunction, Request } from 'express'
import jwt from 'jsonwebtoken'
import http from 'node:http'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminRecipesRouter } from '../src/routes/admin/recipes.js'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '../src/routes/admin/registryImagePullSecret.js'
import { MockGateway } from './mockGateway.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34' }]),
}))

const MCP_NS = 'mcp-server'
const SANDBOX_NS = 'sandbox-recipes'
const WORKFLOW_TEAM_ID_LABEL = 'clerum.io/workflow-team-id'
const WORKFLOW_TEAM_ID = '11111111-1111-4111-8111-111111111111'
const NON_TRANSPORT_PUBLIC_WEB_MESSAGE =
  'public-web is only supported on MCP transport workloads; non-transport workloads must use exact-host egressBindings'

const VALID_RECIPE = {
  metadata: { name: 'my-recipe' },
  spec: {
    workloads: [{ id: 'svc', type: 'deployment', image: 'my-image:latest' }],
  },
}

function nonTransportEgressRecipe(name: string, egressBinding: Record<string, unknown>) {
  return {
    metadata: { name },
    spec: {
      workloads: [
        {
          id: 'worker',
          type: 'deployment',
          image: 'worker:latest',
          egressBindings: [egressBinding],
        },
      ],
    },
  }
}

function clusterLocalEgressRecipe(name: string, dns = 'db.sandbox-recipes.svc.cluster.local') {
  return {
    metadata: { name },
    spec: {
      workloads: [
        {
          id: 'api',
          type: 'deployment',
          image: 'api:latest',
          egressBindings: [{ dns, port: 5432, protocol: 'TCP' }],
        },
        {
          id: 'db',
          type: 'statefulset',
          image: 'postgres:16',
          port: 5432,
        },
      ],
    },
  }
}

const SNIPPET_RECIPE_WITH_SECRET = {
  metadata: { name: 'snippet-secret-recipe' },
  spec: {
    triggers: { onDemand: { allowedActors: ['user', 'autonomous'] } },
    steps: [
      {
        id: 'fetch-price',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return { ok: true }',
          capabilities: {
            secrets: [
              {
                alias: 'coingecko_api_key',
                secretRef: { name: 'coingecko-api', key: 'apiKey' },
              },
            ],
          },
        },
      },
    ],
  },
}

const WORKLOAD_RECIPE_WITH_ENV_SECRET = {
  metadata: { name: 'workload-env-secret-recipe' },
  spec: {
    workloads: [
      {
        id: 'api',
        type: 'deployment',
        image: 'my-api:latest',
        envSecret: {
          name: 'workflow-api-credentials',
          keys: [
            { secretKey: 'apiKey', envVar: 'API_KEY' },
            { secretKey: 'dbPassword', envVar: 'DB_PASSWORD' },
          ],
        },
      },
    ],
  },
}

const TRANSPORT_WORKLOAD_RECIPE_WITH_ENV_SECRET = {
  metadata: { name: 'transport-workload-env-secret-recipe' },
  spec: {
    workloads: [
      {
        id: 'mock-tools',
        type: 'deployment',
        image: 'clerum/mock-mcp-server:test',
        transport: { type: 'streamableHttp' },
        envSecret: {
          name: 'workflow-api-credentials',
          keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
        },
      },
    ],
  },
}

function makeWorkflowSteps(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    instruction: `Run step ${i}`,
  }))
}

const SCHEDULED_RECIPE_SPEC = {
  steps: [{ id: 'report', instruction: 'generate report' }],
  triggers: {
    schedule: {
      cron: '0 9 * * *',
      timezone: 'UTC',
    },
  },
}

function makeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRecipesRouter(gateway as never))
  return app
}

// Variant that injects a fake admin auth claim the way the real
// requireAuthForControlUI middleware would. Used by the artifact
// download tests, which read req.adminAuth.sub.
function makeAuthedApp(gateway: MockGateway, adminSub = 'admin-alice') {
  const app = express()
  app.use(express.json())
  app.use(
    (
      req: Request & {
        adminAuth?: { sub: string; role: string; jti: string; exp: number; typ: 'user' }
      },
      _res: ExpressResponse,
      next: NextFunction
    ) => {
      req.adminAuth = {
        sub: adminSub,
        role: 'admin',
        jti: 'test-jti',
        exp: 9999999999,
        typ: 'user',
      }
      next()
    }
  )
  app.use(createAdminRecipesRouter(gateway as never))
  return app
}

type TestApi = ReturnType<typeof request>

function startTestServer(app: Express): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0)
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

function closeTestServer(server: http.Server | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server?.listening) {
      resolve()
      return
    }
    server.close(err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function makeGatewayProxy(getGateway: () => MockGateway | undefined): MockGateway {
  return new Proxy({} as MockGateway, {
    get(_target, prop) {
      const gateway = getGateway()
      if (!gateway) throw new Error('MockGateway fixture is not initialized')
      const value = (gateway as unknown as Record<PropertyKey, unknown>)[prop]
      return typeof value === 'function' ? value.bind(gateway) : value
    },
  })
}

describe.sequential('routes/admin/recipes', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof makeApp>
  let server: http.Server
  let api: TestApi

  beforeAll(async () => {
    // Own one server per suite; repeated implicit/per-test servers can flake
    // when Vitest reuses workers and ports under pressure.
    app = makeApp(makeGatewayProxy(() => gateway))
    server = await startTestServer(app)
    api = request(server)
  })

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
  })

  afterAll(async () => {
    await closeTestServer(server)
  })

  // ── CRUD happy path ──────────────────────────────────────────────────────

  it('POST /admin/recipes — CRD always lands in sandbox-recipes (canonical) when metadata.namespace is omitted', async () => {
    const res = await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    expect(res.body.metadata.name).toBe('my-recipe')
    // Canonical CRD storage namespace is `sandbox-recipes`, co-located with
    // the workflow runtime pods it orchestrates. Rendered workload placement
    // is still split by the reconciler (MCP → mcp-server, non-MCP →
    // sandbox-recipes), but the CRD itself lives in one place.
    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
  })

  function codexSubscriptionRecipe(name: string, connectionRef?: string) {
    return {
      metadata: {
        name,
        ...(connectionRef !== undefined
          ? { annotations: { 'clerum.io/codex-connection-ref': connectionRef } }
          : {}),
      },
      spec: {
        agent: { provider: 'codex-subscription', model: 'gpt-5.1' },
        triggers: { onDemand: { allowedActors: ['user'] } },
        steps: [{ id: 'draft', instruction: 'Write', timeoutSeconds: 600 }],
      },
    }
  }

  it('POST /admin/recipes — stamps a named Codex grant annotation', async () => {
    const res = await api
      .post('/admin/recipes')
      .send(codexSubscriptionRecipe('codex-granted', 'team-plus'))
      .expect(201)
    expect(res.body.metadata.annotations).toEqual({
      'clerum.io/codex-connection-ref': 'team-plus',
    })
  })

  it('POST /admin/recipes — rejects a Codex recipe without a named grant', async () => {
    const res = await api
      .post('/admin/recipes')
      .send(codexSubscriptionRecipe('codex-missing'))
      .expect(422)
    expect(res.body.errors[0].rule).toBe('codexRecipeGrantRequired')
  })

  it('POST /admin/recipes/validate — rejects a Codex recipe with an unassigned grant', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send(codexSubscriptionRecipe('codex-unassigned', 'unassigned'))
      .expect(422)
    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0].rule).toBe('codexRecipeGrantRequired')
  })

  it('PUT /admin/recipes/:name — clears a leftover Codex grant when the agent is no longer Codex', async () => {
    await api
      .post('/admin/recipes')
      .send(codexSubscriptionRecipe('codex-then-openai', 'team-plus'))
      .expect(201)
    const res = await api
      .put('/admin/recipes/codex-then-openai')
      .send({
        spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'my-image:latest' }] },
      })
      .expect(200)
    expect(res.body.metadata.annotations).toEqual({
      'clerum.io/codex-connection-ref': '',
    })
  })

  it('POST /admin/recipes — accepts declared cluster-local sibling egressBindings', async () => {
    const res = await api
      .post('/admin/recipes')
      .send(clusterLocalEgressRecipe('internal-egress'))
      .expect(201)

    expect(res.body.metadata.name).toBe('internal-egress')
    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
    expect(res.body.spec.workloads[0].egressBindings).toEqual([
      { dns: 'db.sandbox-recipes.svc.cluster.local', port: 5432, protocol: 'TCP' },
    ])
  })

  it('POST /admin/recipes — accepts metadata.namespace=sandbox-recipes when it matches the canonical value', async () => {
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: { name: 'explicit-sandbox', namespace: SANDBOX_NS },
        spec: {
          workloads: [
            { id: 'svc', type: 'deployment', image: 'img:1', transport: { type: 'http' } },
          ],
        },
      })
      .expect(201)
    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
  })

  it('POST /admin/recipes — ignores metadata.namespace=mcp-server and stores the CRD in sandbox-recipes', async () => {
    // mcp-server is where rendered MCP transport children go, but NOT where
    // the CRD itself lives. Author YAML cannot select placement; control-api
    // strips metadata.namespace and writes to sandbox-recipes.
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: { name: 'explicit-mcp', namespace: MCP_NS },
        spec: { workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16' }] },
      })
      .expect(201)
    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
    await expect(gateway.getResource('workflowrecipes', 'explicit-mcp', MCP_NS)).rejects.toThrow()
  })

  it('POST /admin/recipes — accepts the 100-step workflow limit boundary', async () => {
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: { name: 'hundred-steps' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['user'] } },
          steps: makeWorkflowSteps(100),
        },
      })
      .expect(201)

    expect(res.body.spec.steps).toHaveLength(100)
  })

  it('GET /admin/recipes — lists recipes from sandbox-recipes', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await api.get('/admin/recipes').expect(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].metadata.name).toBe('my-recipe')
  })

  it('GET /admin/recipes/:name/status — returns latest child run status, not stale parent status', async () => {
    // Parent — installed catalog template, has a stale reconcile-time status
    // (left over from an earlier reconcile pass).
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    const parent = (await gateway.getResource('workflowrecipes', 'my-recipe', SANDBOX_NS)) as {
      status?: Record<string, unknown>
    }
    parent.status = {
      phase: 'failed',
      message: 'old stale failure from prior reconcile',
      workflowExecution: { phase: 'failed' },
    }

    // Two child runs, the second one created later. Both belong to the parent.
    await gateway.createResource(
      'workflowrecipes',
      {
        metadata: {
          name: 'my-recipe-aaaaaaaa',
          labels: { 'clerum.io/parent-recipe': 'my-recipe' },
          creationTimestamp: '2026-05-03T10:00:00Z',
        },
        spec: VALID_RECIPE.spec,
        status: { phase: 'failed', workflowExecution: { phase: 'failed' } },
      },
      SANDBOX_NS
    )
    await gateway.createResource(
      'workflowrecipes',
      {
        metadata: {
          name: 'my-recipe-bbbbbbbb',
          labels: { 'clerum.io/parent-recipe': 'my-recipe' },
          creationTimestamp: '2026-05-03T11:00:00Z',
        },
        spec: VALID_RECIPE.spec,
        status: { phase: 'active', workflowExecution: { phase: 'completed' } },
      },
      SANDBOX_NS
    )

    const res = await api.get('/admin/recipes/my-recipe/status').expect(200)
    expect(res.body.phase).toBe('active')
    expect(res.body.workflowExecution.phase).toBe('completed')
    expect(res.body.message).toBeUndefined()
  })

  it('GET /admin/recipes/:name/artifacts — returns artifacts from latest child run, not stale parent', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    const parent = (await gateway.getResource('workflowrecipes', 'my-recipe', SANDBOX_NS)) as {
      status?: Record<string, unknown>
    }
    parent.status = { artifacts: [{ name: 'old-stale.pdf' }] }

    await gateway.createResource(
      'workflowrecipes',
      {
        metadata: {
          name: 'my-recipe-cccccccc',
          labels: { 'clerum.io/parent-recipe': 'my-recipe' },
          creationTimestamp: '2026-05-03T11:00:00Z',
        },
        spec: VALID_RECIPE.spec,
        status: { artifacts: [{ name: 'fresh.docx' }, { name: 'fresh.pdf' }] },
      },
      SANDBOX_NS
    )

    const res = await api.get('/admin/recipes/my-recipe/artifacts').expect(200)
    const names = (res.body.artifacts as Array<{ name: string }>).map(a => a.name)
    expect(names).toEqual(['fresh.docx', 'fresh.pdf'])
  })

  it("GET /admin/recipes/:name/status — falls back to parent's own status when no child runs exist", async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    const parent = (await gateway.getResource('workflowrecipes', 'my-recipe', SANDBOX_NS)) as {
      status?: Record<string, unknown>
    }
    parent.status = { phase: 'active', message: 'parent reconciled' }

    const res = await api.get('/admin/recipes/my-recipe/status').expect(200)
    expect(res.body.phase).toBe('active')
    expect(res.body.message).toBe('parent reconciled')
  })

  it('GET /admin/recipes — excludes per-run child recipes (clerum.io/workflow-run-id label)', async () => {
    // Parent — installed catalog template, listed.
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    // Child — created by workflow-recipes per WorkflowRun row, not user-installed,
    // must not appear in the recipes list.
    await gateway.createResource(
      'workflowrecipes',
      {
        metadata: {
          name: 'my-recipe-b765623f',
          labels: {
            'clerum.io/workflow-run-id': 'b765623f-d9ec-43f3-89c4-4e931895b771',
            'clerum.io/trigger-source': 'onDemand',
          },
        },
        spec: VALID_RECIPE.spec,
      },
      SANDBOX_NS
    )

    const res = await api.get('/admin/recipes').expect(200)
    const names = (res.body.items as Array<{ metadata: { name: string } }>).map(
      i => i.metadata.name
    )
    expect(names).toEqual(['my-recipe'])
  })

  it('GET /admin/recipes/:name — returns the recipe', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await api.get('/admin/recipes/my-recipe').expect(200)
    expect(res.body.metadata.name).toBe('my-recipe')
  })

  it('GET /admin/recipes/:name — 404 for unknown recipe', async () => {
    await api.get('/admin/recipes/not-found').expect(404)
  })

  it('PUT /admin/recipes/:name — updates spec', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await api
      .put('/admin/recipes/my-recipe')
      .send({ spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'my-image:v2' }] } })
      .expect(200)

    expect((res.body.spec.workloads as Array<{ image: string }>)[0].image).toBe('my-image:v2')
  })

  it('PUT /admin/recipes/:name — returns pendingCredentials for deferred workload credentials', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await api
      .put('/admin/recipes/my-recipe')
      .send({ spec: WORKLOAD_RECIPE_WITH_ENV_SECRET.spec })
      .expect(200)

    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowEnvSecret',
        secretName: 'workflow-api-credentials',
        namespace: SANDBOX_NS,
        keys: ['apiKey', 'dbPassword'],
        field: 'spec.workloads[0].envSecret',
      },
    ])
  })

  it('PUT /admin/recipes/:name — retries transient Kubernetes resourceVersion conflicts', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const originalUpdate = gateway.updateResource.bind(gateway)
    const conflict = Object.assign(new Error('object has been modified'), {
      code: 409,
      statusCode: 409,
    })
    const updateSpy = vi.spyOn(gateway, 'updateResource')
    updateSpy.mockRejectedValueOnce(conflict)
    updateSpy.mockImplementation((plural, name, body, namespace) =>
      originalUpdate(plural, name, body, namespace)
    )

    try {
      const res = await api
        .put('/admin/recipes/my-recipe')
        .send({ spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'my-image:v2' }] } })
        .expect(200)

      expect((res.body.spec.workloads as Array<{ image: string }>)[0].image).toBe('my-image:v2')
      expect(updateSpy).toHaveBeenCalledTimes(2)
    } finally {
      updateSpy.mockRestore()
    }
  })

  it('PUT /admin/recipes/:name — returns 409 when Kubernetes conflicts persist', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const conflict = Object.assign(new Error('object has been modified'), {
      code: 409,
      statusCode: 409,
    })
    const updateSpy = vi.spyOn(gateway, 'updateResource').mockRejectedValue(conflict)

    try {
      const res = await api
        .put('/admin/recipes/my-recipe')
        .send({ spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'my-image:v2' }] } })
        .expect(409)

      expect(res.body.error).toBe('conflict')
      expect(updateSpy).toHaveBeenCalledTimes(3)
    } finally {
      updateSpy.mockRestore()
    }
  })

  it('DELETE /admin/recipes/:name — removes the recipe', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    await api.delete('/admin/recipes/my-recipe').expect(200)
    await api.get('/admin/recipes/my-recipe').expect(404)
  })

  it('GET /admin/recipes/:name/status — returns status subfield', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    // status is absent → empty object
    const res = await api.get('/admin/recipes/my-recipe/status').expect(200)
    expect(res.body).toEqual({})
  })

  // ── Canonical namespace listing ─────────────────────────────────────────

  it('GET /admin/recipes — lists WorkflowRecipe CRDs only from sandbox-recipes', async () => {
    // A manually seeded mcp-server WorkflowRecipe represents the historical
    // bug class. The admin API must not discover it because that would keep
    // the old placement alive.
    await gateway.createResource(
      'workflowrecipes',
      {
        metadata: { name: 'mcp-recipe' },
        spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'img:1' }] },
      },
      MCP_NS
    )
    await gateway.createResource(
      'workflowrecipes',
      {
        metadata: { name: 'sandbox-recipe' },
        spec: { workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16' }] },
      },
      SANDBOX_NS
    )

    const res = await api.get('/admin/recipes').expect(200)
    const names = (res.body.items as Array<{ metadata: { name: string } }>).map(
      i => i.metadata.name
    )
    expect(names).not.toContain('mcp-recipe')
    expect(names).toContain('sandbox-recipe')
    expect(res.body.items).toHaveLength(1)
  })

  // ── Namespace audit: caller namespace is silently ignored ────────────────

  it('ignores ?namespace= query parameter on every route (route handlers never read it)', async () => {
    // Query-param namespace is ignored because routes never read req.query.namespace;
    // canonical lookup is performed server-side via findRecipeNamespace().
    // Requests MUST still succeed (no 400 about namespace).
    await api.get('/admin/recipes?namespace=evil').expect(200)
    await api.post('/admin/recipes?namespace=evil').send(VALID_RECIPE).expect(201)
    await api.get('/admin/recipes/my-recipe?namespace=evil').expect(200)
    await api
      .put('/admin/recipes/my-recipe?namespace=evil')
      .send({ spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'img:v2' }] } })
      .expect(200)
    await api.delete('/admin/recipes/my-recipe?namespace=evil').expect(200)
    // 400 from name validation, not namespace
    await api.get('/admin/recipes/INVALID_NAME/status?namespace=evil').expect(400)
    await api.get('/admin/recipes/INVALID_NAME/artifacts?namespace=evil').expect(400)
  })

  it('POST /admin/recipes ignores arbitrary metadata.namespace and stores in sandbox-recipes', async () => {
    // The CRD always goes to sandbox-recipes. Anything else (control-plane,
    // kube-system, mcp-server, attacker-chosen) is discarded before the
    // Kubernetes write, so author YAML never controls placement.
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: { name: 'evil', namespace: 'control-plane' },
        spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'img:1' }] },
      })
      .expect(201)
    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
    await expect(gateway.getResource('workflowrecipes', 'evil', 'control-plane')).rejects.toThrow()
  })

  it('POST /admin/recipes preserves the scheduled workflow team label only', async () => {
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: {
          name: 'scheduled-report',
          namespace: 'control-plane',
          labels: {
            [WORKFLOW_TEAM_ID_LABEL]: WORKFLOW_TEAM_ID,
            'clerum.io/workflow-run-id': 'must-not-survive',
          },
        },
        spec: SCHEDULED_RECIPE_SPEC,
      })
      .expect(201)

    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
    expect(res.body.metadata.labels).toEqual({ [WORKFLOW_TEAM_ID_LABEL]: WORKFLOW_TEAM_ID })
  })

  it('POST /admin/recipes rejects scheduled recipes without a workflow team label', async () => {
    const createSpy = vi.spyOn(gateway, 'createResource')

    try {
      const res = await api
        .post('/admin/recipes')
        .send({
          metadata: { name: 'scheduled-without-team' },
          spec: SCHEDULED_RECIPE_SPEC,
        })
        .expect(422)

      expect(res.body.errors[0].field).toBe(`metadata.labels.${WORKFLOW_TEAM_ID_LABEL}`)
      expect(createSpy.mock.calls.filter(call => call[0] === 'workflowrecipes')).toHaveLength(0)
    } finally {
      createSpy.mockRestore()
    }
  })

  it('POST /admin/recipes rejects scheduled recipes with a non-UUID workflow team label', async () => {
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: {
          name: 'scheduled-bad-team',
          labels: { [WORKFLOW_TEAM_ID_LABEL]: 'control-plane-admin-ui' },
        },
        spec: SCHEDULED_RECIPE_SPEC,
      })
      .expect(422)

    expect(res.body.errors[0].field).toBe(`metadata.labels.${WORKFLOW_TEAM_ID_LABEL}`)
  })

  it('PUT /admin/recipes/:name — ignores arbitrary metadata.namespace and updates sandbox-recipes', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await api
      .put('/admin/recipes/my-recipe')
      .send({
        metadata: { namespace: 'control-plane' },
        spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'img:2' }] },
      })
      .expect(200)

    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
    expect((res.body.spec.workloads as Array<{ image: string }>)[0].image).toBe('img:2')
  })

  it('PUT /admin/recipes/:name preserves scheduled workflow team labels', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await api
      .put('/admin/recipes/my-recipe')
      .send({
        metadata: {
          labels: {
            [WORKFLOW_TEAM_ID_LABEL]: WORKFLOW_TEAM_ID,
            'clerum.io/workflow-run-id': 'must-not-survive',
          },
        },
        spec: SCHEDULED_RECIPE_SPEC,
      })
      .expect(200)

    expect(res.body.metadata.labels).toEqual({ [WORKFLOW_TEAM_ID_LABEL]: WORKFLOW_TEAM_ID })
  })

  it('PUT /admin/recipes/:name removes stale workflow team labels after schedule removal', async () => {
    await gateway.createResource(
      'workflowrecipes',
      {
        metadata: {
          name: 'catalog-scheduled',
          labels: {
            [WORKFLOW_TEAM_ID_LABEL]: WORKFLOW_TEAM_ID,
            'clerum.io/catalog-id': 'daily-report',
          },
        },
        spec: SCHEDULED_RECIPE_SPEC,
      },
      SANDBOX_NS
    )

    const res = await api
      .put('/admin/recipes/catalog-scheduled')
      .send({
        spec: {
          steps: [{ id: 'report', instruction: 'generate report' }],
          triggers: { onDemand: { allowedActors: ['user'] } },
        },
      })
      .expect(200)

    expect(res.body.metadata.labels).toEqual({ 'clerum.io/catalog-id': 'daily-report' })
  })

  it('POST /admin/recipes/validate rejects scheduled recipes without a workflow team label', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'scheduled-validate' },
        spec: SCHEDULED_RECIPE_SPEC,
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0].field).toBe(`metadata.labels.${WORKFLOW_TEAM_ID_LABEL}`)
  })

  it('PUT /admin/recipes/:name — ignores metadata.namespace=mcp-server and keeps sandbox-recipes', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await api
      .put('/admin/recipes/my-recipe')
      .send({
        metadata: { namespace: MCP_NS },
        spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'img:2' }] },
      })
      .expect(200)
    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
    await expect(gateway.getResource('workflowrecipes', 'my-recipe', MCP_NS)).rejects.toThrow()
  })

  it('PUT /admin/recipes/:name — accepts metadata.namespace=sandbox-recipes (canonical)', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    const res = await api
      .put('/admin/recipes/my-recipe')
      .send({
        metadata: { namespace: SANDBOX_NS },
        spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'img:2' }] },
      })
      .expect(200)
    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
  })

  // ── mcp-server isolation guard ──────────────────────────────────────────

  it('GET /admin/recipes/:name does not discover WorkflowRecipe CRDs from mcp-server', async () => {
    await gateway.createResource(
      'workflowrecipes',
      {
        metadata: { name: 'mcp-only' },
        spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'img:1' }] },
      },
      MCP_NS
    )

    await api.get('/admin/recipes/mcp-only').expect(404)
    await api.get('/admin/recipes/mcp-only/status').expect(404)
    await api.get('/admin/recipes/mcp-only/artifacts').expect(404)
  })

  it('PUT and DELETE /admin/recipes/:name do not mutate mcp-server WorkflowRecipe stragglers', async () => {
    await gateway.createResource(
      'workflowrecipes',
      {
        metadata: { name: 'mcp-only' },
        spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'img:1' }] },
      },
      MCP_NS
    )

    await api
      .put('/admin/recipes/mcp-only')
      .send({ spec: { workloads: [{ id: 'svc', type: 'deployment', image: 'img:2' }] } })
      .expect(404)
    await api.delete('/admin/recipes/mcp-only').expect(404)

    const fetched = (await gateway.getResource('workflowrecipes', 'mcp-only', MCP_NS)) as {
      spec: { workloads: Array<{ image: string }> }
    }
    expect(fetched.spec.workloads[0].image).toBe('img:1')
  })

  // ── Probe error-propagation guard ────────────────────────────────────────
  // Regression guard for the parallel `findRecipeNamespace` probe: when ONE
  // namespace lookup fails for a non-404 reason (RBAC 403, network timeout,
  // parse error) the helper MUST surface that error to the caller as a 5xx,
  // never silently mask it as a 404. Masking a real failure would hide RBAC
  // misconfigs and transient outages from operators.
  it('GET /admin/recipes/:name propagates non-404 errors from the namespace probe', async () => {
    // Override getResource to throw a non-`K8sNotFoundError` error from the
    // canonical namespace probe (sandbox-recipes). The recipe does NOT exist
    // in mcp-server either, so without proper error propagation the helper
    // would (incorrectly) return 404. With the fix, it must surface the RBAC
    // error as a 5xx instead.
    const originalGetResource = gateway.getResource.bind(gateway)
    gateway.getResource = (async (
      plural: Parameters<typeof originalGetResource>[0],
      name: Parameters<typeof originalGetResource>[1],
      ns?: Parameters<typeof originalGetResource>[2]
    ) => {
      if (ns === SANDBOX_NS) {
        throw new Error('forbidden: user cannot get workflowrecipes in sandbox-recipes (RBAC 403)')
      }
      return originalGetResource(plural, name, ns)
    }) as typeof gateway.getResource

    const res = await api.get('/admin/recipes/any-name')
    expect(res.status).not.toBe(404) // MUST NOT be masked as "not found"
    expect(res.status).toBeGreaterThanOrEqual(500) // MUST surface as 5xx
  })

  // ── POST /admin/recipes/validate ─────────────────────────────────────────

  it('POST /admin/recipes/validate — valid body returns { valid: true }', async () => {
    const res = await api.post('/admin/recipes/validate').send(VALID_RECIPE).expect(200)
    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts declared cluster-local sibling egressBindings', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send(clusterLocalEgressRecipe('validate-internal-egress'))
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — rejects cluster-local sibling egressBindings in another namespace', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send(clusterLocalEgressRecipe('validate-wrong-namespace', 'db.other.svc.cluster.local'))
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].egressBindings[0].dns',
        message: expect.stringContaining('targets namespace "other"'),
      })
    )
  })

  it('POST /admin/recipes/validate — rejects workflow steps without triggers', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'missing-trigger' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'report', instruction: 'generate report' }],
        },
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.triggers',
        message:
          'workflow recipes with steps must declare spec.triggers.onDemand or spec.triggers.schedule',
      })
    )
  })

  it('POST /admin/recipes/validate — rejects invalid on-demand actor values', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'invalid-trigger-actor' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['admin'] } },
          steps: [{ id: 'report', instruction: 'generate report' }],
        },
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.triggers.onDemand.allowedActors[0]',
        message: 'must be one of: user, autonomous, scheduled',
      })
    )
  })

  it('POST /admin/recipes/validate — rejects legacy run.handler fields', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'legacy-handler' },
        spec: {
          steps: [
            {
              id: 'legacy',
              run: {
                type: 'snippet',
                language: 'typescript',
                code: 'return {}',
                handler: 'noop',
              },
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.steps[0].run.handler',
        message: 'unsupported run field',
      })
    )
  })

  it('POST /admin/recipes/validate — rejects inline sensitive workload env values', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'inline-secret-env' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'COINGECKO_API_KEY', value: 'CG-very-secret-token' }],
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].env[0].value',
        rule: 'workflowInlineSecretEnv',
      })
    )
  })

  it('POST /admin/recipes/validate — rejects explicit token-like workload env values', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'inline-token-env' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'EXTERNAL_REFERENCE', value: 'sk-testTokenValue1234567890' }],
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].env[0].value',
        rule: 'workflowInlineSecretEnv',
      })
    )
  })

  it('POST /admin/recipes/validate — rejects literal credentials embedded in workload env URL values', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'inline-url-env' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'DATABASE_URL', value: 'postgres://app:literal-value@db' }],
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].env[0].value',
        rule: 'workflowInlineSecretEnv',
      })
    )
  })

  it('POST /admin/recipes/validate — accepts sensitive input templates in workload env URL values', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'template-url-env' },
        spec: {
          inputContract: {
            properties: {
              db_password: { type: 'string' },
            },
          },
          inputs: {
            db_password: 'placeholder',
          },
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'DATABASE_URL', value: 'postgres://app:{{inputs.db_password}}@db' }],
            },
          ],
        },
      })
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts sensitive env names when value is a sensitive input template', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'template-sensitive-env-name' },
        spec: {
          inputContract: {
            properties: {
              db_password: { type: 'string' },
            },
          },
          inputs: {
            db_password: 'placeholder',
          },
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [{ name: 'POSTGRES_PASSWORD', value: '{{inputs.db_password}}' }],
            },
          ],
        },
      })
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts benign long workload env values', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'long-env-value' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:latest',
              env: [
                {
                  name: 'INTERNAL_BUILD_METADATA',
                  value: 'some-long-build-metadata-value-for-tracking-purposes-20260512',
                },
              ],
            },
          ],
        },
      })
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts custom coordinator image without explicit output', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'implicit-custom-output' },
        spec: {
          coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
          triggers: { onDemand: { allowedActors: ['user'] } },
          steps: [{ id: 'emit' }],
        },
      })
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts Layer 3B custom coordinator templates', async () => {
    await gateway.createResource(
      'workflowrecipepolicies' as never,
      { metadata: { name: 'allow-layer3b-context' }, spec: { allowContextRef: true } },
      SANDBOX_NS
    )

    const recipes = [
      {
        metadata: {
          name: 'layer3b-custom-coordinator-deterministic',
          annotations: {
            'clerum.io/template-note': 'Advanced E2E template: requires locally built test images.',
          },
        },
        spec: {
          coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
          runtimeEgress: { http: { allowedHosts: ['api.github.com'] } },
          triggers: { onDemand: { allowedActors: ['user'] } },
          workloads: [
            {
              id: 'business-api',
              type: 'deployment',
              image: 'clerum/mock-mcp-server:test',
              port: 3001,
              healthCheck: { type: 'tcp', port: 3001 },
            },
          ],
          output: {
            destination: 'pvc',
            name: 'custom-coordinator-output',
            format: 'json',
            storageSize: '128Mi',
          },
          steps: [{ id: 'prepare' }, { id: 'emit-artifacts', dependsOn: ['prepare'] }],
        },
      },
      {
        metadata: {
          name: 'layer3b-custom-coordinator-broker-backed',
          annotations: {
            'clerum.io/template-note': 'Advanced E2E template: requires locally built test images.',
          },
        },
        spec: {
          coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
          contextRef: 'context1',
          security: { allowContextRef: true },
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['user'] } },
          workloads: [
            {
              id: 'business-api',
              type: 'deployment',
              image: 'clerum/mock-mcp-server:test',
              port: 3001,
              healthCheck: { type: 'tcp', port: 3001 },
            },
            {
              id: 'mock-tools',
              type: 'deployment',
              image: 'clerum/mock-mcp-server:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
              healthCheck: { type: 'tcp', port: 3001 },
            },
          ],
          output: {
            destination: 'pvc',
            name: 'custom-coordinator-broker-output',
            format: 'multi',
            storageSize: '256Mi',
          },
          steps: [
            { id: 'prepare' },
            {
              id: 'call-mcp',
              dependsOn: ['prepare'],
              instruction: 'Use the mock-tools add tool exactly once.',
              mcpServers: ['mock-tools'],
              allowedTools: { include: ['mock-tools__add'] },
            },
            { id: 'emit-artifacts', dependsOn: ['call-mcp'] },
          ],
        },
      },
    ]

    for (const recipe of recipes) {
      const res = await api.post('/admin/recipes/validate').send(recipe).expect(200)
      expect(res.body.valid).toBe(true)
    }
  })

  it('POST /admin/recipes/validate — rejects invalid output destination', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'bad-output' },
        spec: {
          ...VALID_RECIPE.spec,
          output: { destination: 's3' },
        },
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.output.destination',
      })
    )
  })

  it('POST /admin/recipes/validate — accepts external workflow output PVC claim names', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'external-output-claim' },
        spec: {
          ...VALID_RECIPE.spec,
          output: { destination: 'pvc', claimName: 'shared-workflow-output' },
        },
      })
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — rejects output claimName without pvc destination', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'bad-output-claim' },
        spec: {
          ...VALID_RECIPE.spec,
          output: { destination: 'stdout', claimName: 'shared-workflow-output' },
        },
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.output.claimName',
        message: 'claimName requires spec.output.destination=pvc',
      })
    )
  })

  it('POST /admin/recipes/validate — rejects runRetention ttl above the 30 day maximum', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'ttl-too-long' },
        spec: {
          ...VALID_RECIPE.spec,
          runRetention: { ttlSecondsAfterFinished: 2_592_001 },
        },
      })
      .expect(422)

    expect(res.body).toEqual({
      valid: false,
      errors: [
        {
          field: 'spec.runRetention.ttlSecondsAfterFinished',
          message: 'must be an integer between 0 and 2592000 seconds (30 days)',
        },
      ],
    })
  })

  it.each([
    [
      'workflow steps',
      {
        metadata: { name: 'too-many-steps' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['user'] } },
          steps: makeWorkflowSteps(101),
        },
      },
      [{ field: 'spec.steps', message: 'must contain at most 100 items' }],
    ],
    [
      'step dependency fan-in',
      {
        metadata: { name: 'too-many-step-dependencies' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['user'] } },
          steps: [
            { id: 's0', instruction: 'Step 0' },
            {
              id: 'aggregate',
              instruction: 'Aggregate',
              dependsOn: Array.from({ length: 101 }, () => 's0'),
            },
          ],
        },
      },
      [{ field: 'spec.steps[1].dependsOn', message: 'must contain at most 100 items' }],
    ],
    [
      'step MCP server refs',
      {
        metadata: { name: 'too-many-step-mcp-servers' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['user'] } },
          steps: [
            {
              id: 'research',
              instruction: 'Research',
              mcpServers: Array.from({ length: 21 }, (_, i) => `srv${i}`),
            },
          ],
        },
      },
      [{ field: 'spec.steps[0].mcpServers', message: 'must contain at most 20 items' }],
    ],
    [
      'step allowed tools include list',
      {
        metadata: { name: 'too-many-step-allowed-tools' },
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['user'] } },
          steps: [
            {
              id: 'research',
              instruction: 'Research',
              allowedTools: { include: Array.from({ length: 51 }, (_, i) => `web__tool${i}`) },
            },
          ],
        },
      },
      [
        {
          field: 'spec.steps[0].allowedTools.include',
          message: 'must contain at most 50 items',
        },
      ],
    ],
  ])(
    'POST /admin/recipes/validate — rejects %s above the runtime limit',
    async (_name, body, errors) => {
      const res = await api.post('/admin/recipes/validate').send(body).expect(422)

      expect(res.body).toEqual({ valid: false, errors })
    }
  )

  it('POST /admin/recipes/validate — honors configured lower runtime limits', async () => {
    const previous = config.workflowStepAllowedToolsMaxItems
    config.workflowStepAllowedToolsMaxItems = 2
    try {
      const res = await api
        .post('/admin/recipes/validate')
        .send({
          metadata: { name: 'configured-limit' },
          spec: {
            agent: { provider: 'zai', model: 'glm-4.7' },
            triggers: { onDemand: { allowedActors: ['user'] } },
            steps: [
              {
                id: 'research',
                instruction: 'Research',
                allowedTools: { include: ['web__a', 'web__b', 'web__c'] },
              },
            ],
          },
        })
        .expect(422)

      expect(res.body).toEqual({
        valid: false,
        errors: [
          {
            field: 'spec.steps[0].allowedTools.include',
            message: 'must contain at most 2 items',
          },
        ],
      })
    } finally {
      config.workflowStepAllowedToolsMaxItems = previous
    }
  })

  it('PUT /admin/recipes/:name — rejects allowedTools above the configured runtime limit', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    const tools = Array.from({ length: 51 }, (_, i) => `web__tool${i}`)

    const res = await api
      .put('/admin/recipes/my-recipe')
      .send({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['user'] } },
          mcpServers: [{ id: 'web', endpoint: 'http://web.test/mcp' }],
          steps: [
            {
              id: 'research',
              instruction: 'Research',
              mcpServers: ['web'],
              allowedTools: { include: tools },
            },
          ],
        },
      })
      .expect(422)

    expect(res.body).toEqual({
      errors: [
        {
          field: 'spec.steps[0].allowedTools.include',
          message: 'must contain at most 50 items',
        },
      ],
    })
  })

  it('POST /admin/recipes/validate — missing spec returns 422', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({ metadata: { name: 'x' } })
      .expect(422)
    expect(res.body.valid).toBe(false)
    expect(res.body.errors.some((e: { field: string }) => e.field === 'spec')).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts non-transport exact-host egressBindings', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send(nonTransportEgressRecipe('non-transport-egress', { dns: 'api.example.com', port: 443 }))
      .expect(200)

    expect(res.body).toEqual({ valid: true, pendingCredentials: [] })
  })

  it('POST /admin/recipes/validate — rejects non-transport public-web egressBindings', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send(nonTransportEgressRecipe('non-transport-public-web', { egressClass: 'public-web' }))
      .expect(422)

    const matches = res.body.errors.filter(
      (error: { field?: string; message?: string }) =>
        error.field === 'spec.workloads[0].egressBindings[0].egressClass' &&
        error.message === NON_TRANSPORT_PUBLIC_WEB_MESSAGE
    )
    expect(matches).toHaveLength(1)
  })

  it('POST /admin/recipes — accepts non-transport exact-host egressBindings', async () => {
    const res = await api
      .post('/admin/recipes')
      .send(
        nonTransportEgressRecipe('non-transport-egress-create', {
          dns: 'api.example.com',
          port: 443,
        })
      )
      .expect(201)

    expect(res.body.spec.workloads[0].egressBindings).toEqual([
      { dns: 'api.example.com', port: 443 },
    ])
  })

  it('POST /admin/recipes — rejects non-transport public-web egressBindings', async () => {
    const res = await api
      .post('/admin/recipes')
      .send(
        nonTransportEgressRecipe('non-transport-public-web-create', {
          egressClass: 'public-web',
        })
      )
      .expect(422)

    expect(res.body.errors).toContainEqual({
      field: 'spec.workloads[0].egressBindings[0].egressClass',
      message: NON_TRANSPORT_PUBLIC_WEB_MESSAGE,
    })
  })

  it('PUT /admin/recipes/:name — accepts non-transport exact-host egressBindings', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await api
      .put('/admin/recipes/my-recipe')
      .send({
        spec: {
          workloads: [
            {
              id: 'worker',
              type: 'deployment',
              image: 'worker:latest',
              egressBindings: [{ dns: 'api.example.com', port: 443 }],
            },
          ],
        },
      })
      .expect(200)

    expect(res.body.spec.workloads[0].egressBindings).toEqual([
      { dns: 'api.example.com', port: 443 },
    ])
  })

  it('PUT /admin/recipes/:name — rejects non-transport public-web egressBindings', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await api
      .put('/admin/recipes/my-recipe')
      .send({
        spec: {
          workloads: [
            {
              id: 'worker',
              type: 'deployment',
              image: 'worker:latest',
              egressBindings: [{ egressClass: 'public-web' }],
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.errors).toContainEqual({
      field: 'spec.workloads[0].egressBindings[0].egressClass',
      message: NON_TRANSPORT_PUBLIC_WEB_MESSAGE,
    })
  })

  it('POST /admin/recipes/secrets — creates workflow snippet Secret in sandbox-recipes without echoing values', async () => {
    const res = await request(app)
      .post('/admin/recipes/secrets')
      .send({
        name: 'coingecko-api',
        ownership: { kind: 'owner-recipe', recipeName: 'snippet-secret-recipe' },
        stringData: { apiKey: 'CG-test-secret' },
      })
      .expect(201)

    expect(res.body).toEqual({
      name: 'coingecko-api',
      namespace: SANDBOX_NS,
      keys: ['apiKey'],
      ownership: { kind: 'owner-recipe', recipeName: 'snippet-secret-recipe' },
      created: true,
    })
    expect(JSON.stringify(res.body)).not.toContain('CG-test-secret')
    const stored = (await gateway.getSecret('coingecko-api', SANDBOX_NS)) as {
      stringData?: Record<string, string>
    }
    expect(stored.stringData?.apiKey).toBe('CG-test-secret')
    await expect(gateway.getSecret('coingecko-api', MCP_NS)).rejects.toThrow()
  })

  it('POST /admin/recipes/secrets — creates transport workload Secret in mcp-server when requested', async () => {
    const res = await request(app)
      .post('/admin/recipes/secrets')
      .send({
        name: 'workflow-api-credentials',
        ownership: { kind: 'owner-recipe', recipeName: 'transport-workload-secret-recipe' },
        namespace: MCP_NS,
        stringData: { apiKey: 'transport-secret' },
      })
      .expect(201)

    expect(res.body).toEqual({
      name: 'workflow-api-credentials',
      namespace: MCP_NS,
      keys: ['apiKey'],
      ownership: { kind: 'owner-recipe', recipeName: 'transport-workload-secret-recipe' },
      created: true,
    })
    expect(JSON.stringify(res.body)).not.toContain('transport-secret')
    const stored = (await gateway.getSecret('workflow-api-credentials', MCP_NS)) as {
      stringData?: Record<string, string>
    }
    expect(stored.stringData?.apiKey).toBe('transport-secret')
    await expect(gateway.getSecret('workflow-api-credentials', SANDBOX_NS)).rejects.toThrow()
  })

  it('POST /admin/recipes/secrets — rejects namespaces outside WorkflowRecipe runtime namespaces', async () => {
    await request(app)
      .post('/admin/recipes/secrets')
      .send({
        name: 'coingecko-api',
        ownership: { kind: 'owner-recipe', recipeName: 'snippet-secret-recipe' },
        namespace: 'default',
        stringData: { apiKey: 'CG-test-secret' },
      })
      .expect(400)

    await expect(gateway.getSecret('coingecko-api', 'default')).rejects.toThrow()
  })

  it('POST /admin/recipes/secrets — updates existing workflow snippet Secret and preserves current data keys', async () => {
    gateway.seedSecret('coingecko-api', SANDBOX_NS, {
      data: { existingKey: 'ZXhpc3Rpbmc=' },
    })

    const res = await request(app)
      .post('/admin/recipes/secrets')
      .send({
        name: 'coingecko-api',
        ownership: { kind: 'owner-recipe', recipeName: 'snippet-secret-recipe' },
        stringData: { apiKey: 'CG-test-secret' },
      })
      .expect(200)

    expect(res.body.created).toBe(false)
    const stored = (await gateway.getSecret('coingecko-api', SANDBOX_NS)) as {
      data?: Record<string, string>
      stringData?: Record<string, string>
    }
    expect(stored.data?.existingKey).toBe('ZXhpc3Rpbmc=')
    expect(stored.stringData?.apiKey).toBe('CG-test-secret')
  })

  it('POST /admin/recipes/secrets — rejects platform-managed workflow Secret names', async () => {
    await request(app)
      .post('/admin/recipes/secrets')
      .send({ name: 'wf-example-coordinator-token', stringData: { apiKey: 'CG-test-secret' } })
      .expect(400)

    await expect(gateway.getSecret('wf-example-coordinator-token', SANDBOX_NS)).rejects.toThrow()
  })

  it('POST /admin/recipes/secrets — rejects the platform registry pull Secret name', async () => {
    // This endpoint writes Opaque + WORKFLOW_SECRET_LABELS, which carry the same
    // `clerum.io/managed-by: control-api` marker the pull-secret service reads as its own
    // ownership. Left unreserved, a request here would relabel (or shadow) the live
    // credential; today only K8s type immutability stands in the way.
    // Ownership is supplied so the ONLY thing that can reject this is the reserved name.
    const res = await request(app)
      .post('/admin/recipes/secrets')
      .send({
        name: EVENFIRE_REGISTRY_PULL_SECRET_NAME,
        ownership: { kind: 'owner-recipe', recipeName: 'my-recipe' },
        stringData: { token: 'not-a-pull-key' },
      })
      .expect(400)

    expect(res.body.error).toMatch(/platform-managed/)

    await expect(
      gateway.getSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, SANDBOX_NS)
    ).rejects.toThrow()
  })

  it('POST /admin/recipes/secrets — refuses a pull-secret-shaped payload', async () => {
    // This route writes `type: Opaque`, and the kubelet honors ONLY
    // kubernetes.io/dockerconfigjson (or .dockercfg) for image pulls. Storing the key on an
    // Opaque Secret would be accepted here and then SILENTLY ignored at pull time — an
    // unexplained ImagePullBackOff long after the 201 that caused it.
    for (const key of ['.dockerconfigjson', '.dockercfg']) {
      const res = await request(app)
        .post('/admin/recipes/secrets')
        .send({
          name: 'third-party-pull',
          ownership: { kind: 'owner-recipe', recipeName: 'snippet-secret-recipe' },
          stringData: { [key]: '{"auths":{}}' },
        })
        .expect(400)

      expect(res.body.error).toMatch(/Kubernetes ignores for image pulls/)
      await expect(gateway.getSecret('third-party-pull', SANDBOX_NS)).rejects.toThrow()
    }
  })

  it('POST /admin/recipes/secrets — rejects invalid keys and non-string values', async () => {
    await request(app)
      .post('/admin/recipes/secrets')
      .send({
        name: 'coingecko-api',
        ownership: { kind: 'owner-recipe', recipeName: 'snippet-secret-recipe' },
        stringData: { 'bad/key': 'CG-test-secret' },
      })
      .expect(400)

    await request(app)
      .post('/admin/recipes/secrets')
      .send({
        name: 'coingecko-api',
        ownership: { kind: 'owner-recipe', recipeName: 'snippet-secret-recipe' },
        stringData: { apiKey: 123 },
      })
      .expect(400)

    await expect(gateway.getSecret('coingecko-api', SANDBOX_NS)).rejects.toThrow()
  })

  it('POST /admin/recipes/validate — accepts pending snippet secretRef for post-create materialization', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(SNIPPET_RECIPE_WITH_SECRET)
      .expect(200)

    expect(res.body.valid).toBe(true)
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowSnippetSecret',
        secretName: 'coingecko-api',
        namespace: SANDBOX_NS,
        keys: ['apiKey'],
        field: 'spec.steps[0].run.capabilities.secrets[0].secretRef',
      },
    ])
  })

  it('POST /admin/recipes/validate — accepts pending snippet secretRef key for post-create materialization', async () => {
    gateway.seedSecret('coingecko-api', SANDBOX_NS, {
      data: { otherKey: 'dmFsdWU=' },
    })

    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(SNIPPET_RECIPE_WITH_SECRET)
      .expect(200)

    expect(res.body.valid).toBe(true)
    expect(res.body.pendingCredentials).toEqual([
      expect.objectContaining({
        kind: 'workflowSnippetSecret',
        secretName: 'coingecko-api',
        keys: ['apiKey'],
      }),
    ])
  })

  it('POST /admin/recipes/validate — rejects snippet secretRef with invalid key syntax', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        ...SNIPPET_RECIPE_WITH_SECRET,
        spec: {
          ...SNIPPET_RECIPE_WITH_SECRET.spec,
          steps: [
            {
              id: 'fetch-price',
              run: {
                type: 'snippet',
                language: 'typescript',
                code: 'return { ok: true }',
                capabilities: {
                  secrets: [
                    {
                      alias: 'coingecko_api_key',
                      secretRef: { name: 'coingecko-api', key: 'bad/key' },
                    },
                  ],
                },
              },
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowSnippetSecretKeyInvalid',
      field: 'spec.steps[0].run.capabilities.secrets[0].secretRef.key',
    })
  })

  it('POST /admin/recipes/validate — rejects snippet secretRef to platform-managed workflow Secret names', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        ...SNIPPET_RECIPE_WITH_SECRET,
        spec: {
          ...SNIPPET_RECIPE_WITH_SECRET.spec,
          steps: [
            {
              id: 'fetch-price',
              run: {
                type: 'snippet',
                language: 'typescript',
                code: 'return { ok: true }',
                capabilities: {
                  secrets: [
                    {
                      alias: 'runtime_token',
                      secretRef: { name: 'wf-example-coordinator-token', key: 'token' },
                    },
                  ],
                },
              },
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowSnippetSecretRefReserved',
      field: 'spec.steps[0].run.capabilities.secrets[0].secretRef.name',
    })
  })

  it('POST /admin/recipes/validate — accepts user-managed Secret names that mention coordinator-token', async () => {
    gateway.seedSecret('api-coordinator-token-rotator', SANDBOX_NS, {
      data: { token: 'dmFsdWU=' },
    })

    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        ...SNIPPET_RECIPE_WITH_SECRET,
        spec: {
          ...SNIPPET_RECIPE_WITH_SECRET.spec,
          steps: [
            {
              id: 'fetch-price',
              run: {
                type: 'snippet',
                language: 'typescript',
                code: 'return { ok: true }',
                capabilities: {
                  secrets: [
                    {
                      alias: 'api_key',
                      secretRef: { name: 'api-coordinator-token-rotator', key: 'token' },
                    },
                  ],
                },
              },
            },
          ],
        },
      })
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts snippet secretRef when Secret and key exist', async () => {
    gateway.seedSecret('coingecko-api', SANDBOX_NS, {
      data: { apiKey: 'dmFsdWU=' },
    })

    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(SNIPPET_RECIPE_WITH_SECRET)
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts pending workload envSecret for post-create materialization', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(200)

    expect(res.body.valid).toBe(true)
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowEnvSecret',
        secretName: 'workflow-api-credentials',
        namespace: SANDBOX_NS,
        keys: ['apiKey', 'dbPassword'],
        field: 'spec.workloads[0].envSecret',
      },
    ])
  })

  it('POST /admin/recipes/validate — accepts pending workload envSecret key for post-create materialization', async () => {
    gateway.seedSecret('workflow-api-credentials', SANDBOX_NS, {
      data: { apiKey: 'dmFsdWU=' },
    })

    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(200)

    expect(res.body.valid).toBe(true)
    expect(res.body.pendingCredentials).toEqual([
      expect.objectContaining({
        kind: 'workflowEnvSecret',
        secretName: 'workflow-api-credentials',
        keys: ['dbPassword'],
      }),
    ])
  })

  it('POST /admin/recipes/validate — rejects workload envSecret owned by a different recipe (Issue #637)', async () => {
    gateway.seedSecret('workflow-api-credentials', SANDBOX_NS, {
      data: { apiKey: 'dmFsdWU=', dbPassword: 'dmFsdWU=' },
      labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
    })

    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowWorkloadSecretOwnershipDenied',
      field: 'spec.workloads[0].envSecret.name',
    })
    expect(res.body.errors[0].message).toMatch(/owned by recipe "some-other-recipe"/)
  })

  it('POST /admin/recipes/validate — accepts workload envSecret owned by this recipe', async () => {
    gateway.seedSecret('workflow-api-credentials', SANDBOX_NS, {
      data: { apiKey: 'dmFsdWU=', dbPassword: 'dmFsdWU=' },
      labels: { 'clerum.io/owner-recipe': 'workload-env-secret-recipe' },
    })

    await request(app)
      .post('/admin/recipes/validate')
      .send(WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(200)
  })

  it('POST /admin/recipes/validate — accepts workload envSecret from a shared Secret', async () => {
    gateway.seedSecret('workflow-api-credentials', SANDBOX_NS, {
      data: { apiKey: 'dmFsdWU=', dbPassword: 'dmFsdWU=' },
      labels: { 'clerum.io/shared': 'true' },
    })

    await request(app)
      .post('/admin/recipes/validate')
      .send(WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(200)
  })

  it('POST /admin/recipes/validate — accepts workload envSecret from an unlabeled Secret (deferred labeling; reconciler is authoritative)', async () => {
    gateway.seedSecret('workflow-api-credentials', SANDBOX_NS, {
      data: { apiKey: 'dmFsdWU=', dbPassword: 'dmFsdWU=' },
    })

    await request(app)
      .post('/admin/recipes/validate')
      .send(WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(200)
  })

  it('POST /admin/recipes/validate — rejects an imagePullSecret owned by a different recipe (Issue #637)', async () => {
    gateway.seedSecret('foreign-pull-secret', SANDBOX_NS, {
      type: 'kubernetes.io/dockerconfigjson',
      data: { '.dockerconfigjson': 'e30=' },
      labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
    })

    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'pull-secret-recipe' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'my-api:latest',
              imagePullSecrets: ['foreign-pull-secret'],
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        rule: 'workflowWorkloadSecretOwnershipDenied',
        field: 'spec.workloads[0].imagePullSecrets[0]',
      })
    )
  })

  it('POST /admin/recipes/validate — rejects missing imagePullSecrets before creation', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'private-image-recipe' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'private/api:latest',
              imagePullSecrets: ['pull-creds'],
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        rule: 'workflowWorkloadSecretNotFound',
        field: 'spec.workloads[0].imagePullSecrets[0]',
      })
    )
  })

  it('POST /admin/recipes/validate — rejects missing imagePullSecret even when envSecret can be pending', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'private-image-pending-env-recipe' },
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'private/api:latest',
              imagePullSecrets: ['pull-creds'],
              envSecret: {
                name: 'workflow-api-credentials',
                keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
              },
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.pendingCredentials).toBeUndefined()
    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        rule: 'workflowWorkloadSecretNotFound',
        field: 'spec.workloads[0].imagePullSecrets[0]',
      })
    )
  })

  it('POST /admin/recipes/validate — rejects workload envSecret invalid key syntax', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        ...WORKLOAD_RECIPE_WITH_ENV_SECRET,
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'my-api:latest',
              envSecret: {
                name: 'workflow-api-credentials',
                keys: [{ secretKey: 'bad/key', envVar: 'API_KEY' }],
              },
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowWorkloadSecretKeyInvalid',
      field: 'spec.workloads[0].envSecret.keys[0].secretKey',
    })
  })

  it('POST /admin/recipes/validate — rejects workload envSecret invalid Secret name syntax', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        ...WORKLOAD_RECIPE_WITH_ENV_SECRET,
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'my-api:latest',
              envSecret: {
                name: 'Bad_Secret_Name',
                keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
              },
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowWorkloadSecretRefInvalid',
      field: 'spec.workloads[0].envSecret.name',
    })
  })

  it('POST /admin/recipes/validate — rejects workload envSecret platform-managed names', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        ...WORKLOAD_RECIPE_WITH_ENV_SECRET,
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'my-api:latest',
              envSecret: {
                name: 'wf-example-coordinator-token',
                keys: [{ secretKey: 'token', envVar: 'API_TOKEN' }],
              },
            },
          ],
        },
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowWorkloadSecretRefReserved',
      field: 'spec.workloads[0].envSecret.name',
    })
  })

  // ── The platform registry pull Secret is reserved, like the wf- prefix ────
  //
  // control-api writes `evenfire-registry-pull` into the platform workload namespaces and
  // WRC injects the reference itself, after the #637 ownership filter. A recipe that names
  // it is asking for something it will never legitimately get: a declared imagePullSecret
  // is stripped as unowned (and re-injected anyway), while the same name in `envSecret` is
  // an attempt to read the org's registry credential into a container's environment.
  // Reject at the door — a declaration we silently ignore is worse than a 422.
  const PLATFORM_PULL_SECRET_ENV_RECIPE = {
    metadata: { name: 'pull-secret-env-recipe' },
    spec: {
      workloads: [
        {
          id: 'api',
          type: 'deployment',
          image: 'my-api:latest',
          envSecret: {
            name: EVENFIRE_REGISTRY_PULL_SECRET_NAME,
            keys: [{ secretKey: '.dockerconfigjson', envVar: 'DOCKER_CONFIG' }],
          },
        },
      ],
    },
  }

  const PLATFORM_PULL_SECRET_IMAGE_RECIPE = {
    metadata: { name: 'pull-secret-image-recipe' },
    spec: {
      workloads: [
        {
          id: 'api',
          type: 'deployment',
          image: 'my-api:latest',
          imagePullSecrets: [EVENFIRE_REGISTRY_PULL_SECRET_NAME],
        },
      ],
    },
  }

  it('POST /admin/recipes/validate — rejects workload envSecret naming the platform pull Secret', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(PLATFORM_PULL_SECRET_ENV_RECIPE)
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowWorkloadSecretRefReserved',
      field: 'spec.workloads[0].envSecret.name',
    })
  })

  it('POST /admin/recipes/validate — rejects imagePullSecrets naming the platform pull Secret', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(PLATFORM_PULL_SECRET_IMAGE_RECIPE)
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowWorkloadSecretRefReserved',
      field: 'spec.workloads[0].imagePullSecrets[0]',
    })
  })

  it('POST /admin/recipes — refuses to persist a recipe naming the platform pull Secret', async () => {
    const res = await request(app)
      .post('/admin/recipes')
      .send(PLATFORM_PULL_SECRET_IMAGE_RECIPE)
      .expect(422)

    expect(res.body.errors[0]).toMatchObject({ rule: 'workflowWorkloadSecretRefReserved' })
    await expect(
      gateway.getResource('workflowrecipes', 'pull-secret-image-recipe', SANDBOX_NS)
    ).rejects.toThrow()
  })

  it('PUT /admin/recipes/:name — refuses an update naming the platform pull Secret', async () => {
    await request(app).post('/admin/recipes').send(VALID_RECIPE).expect(201)

    const res = await request(app)
      .put('/admin/recipes/my-recipe')
      .send({ spec: PLATFORM_PULL_SECRET_ENV_RECIPE.spec })
      .expect(422)

    expect(res.body.errors[0]).toMatchObject({ rule: 'workflowWorkloadSecretRefReserved' })
    const stored = (await gateway.getResource('workflowrecipes', 'my-recipe', SANDBOX_NS)) as {
      spec: { workloads: Array<{ envSecret?: unknown }> }
    }
    expect(stored.spec.workloads[0].envSecret).toBeUndefined()
  })

  it('POST /admin/recipes/validate — accepts workload envSecret when Secret and keys exist', async () => {
    gateway.seedSecret('workflow-api-credentials', SANDBOX_NS, {
      data: { apiKey: 'dmFsdWU=', dbPassword: 'cGFzcw==' },
    })

    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts pending transport workload envSecret in mcp-server namespace', async () => {
    gateway.seedSecret('workflow-api-credentials', SANDBOX_NS, {
      data: { apiKey: 'dmFsdWU=' },
    })

    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(TRANSPORT_WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts transport workload envSecret when Secret exists in mcp-server', async () => {
    gateway.seedSecret('workflow-api-credentials', MCP_NS, {
      data: { apiKey: 'dmFsdWU=' },
    })

    const res = await request(app)
      .post('/admin/recipes/validate')
      .send(TRANSPORT_WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — accepts workload templates in env.value, command, and args', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'template-resolution' },
        spec: {
          triggers: { onDemand: { allowedActors: ['user'] } },
          inputContract: {
            properties: {
              db_name: { type: 'string', default: 'clerum' },
            },
          },
          computed: [{ name: 'db_mode', expression: "'readonly'" }],
          workloads: [
            { id: 'postgres', type: 'statefulset', image: 'postgres:16', port: 5432 },
            {
              id: 'qa-api',
              type: 'deployment',
              image: 'qa-api:test',
              env: [
                {
                  name: 'DATABASE_URL',
                  value: 'postgres://{{postgres:host}}:{{postgres:port}}/{{inputs.db_name}}',
                },
                { name: 'DB_MODE', value: '{{computed.db_mode}}' },
              ],
              command: ['node'],
              args: ['server.js', '--db-host={{postgres:host}}'],
            },
          ],
          steps: [{ id: 'run-qa', instruction: 'Validate QA API.' }],
        },
      })
      .expect(200)

    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — rejects unresolved workload templates with field path', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'bad-template-resolution' },
        spec: {
          triggers: { onDemand: { allowedActors: ['user'] } },
          workloads: [
            {
              id: 'qa-api',
              type: 'deployment',
              image: 'qa-api:test',
              args: ['--db-host={{postgres:host}}'],
            },
          ],
          steps: [{ id: 'run-qa', instruction: 'Validate QA API.' }],
        },
      })
      .expect(422)

    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowTemplateUnresolved',
      field: 'spec.workloads[0].args[0]',
      message: 'Unresolved template reference "postgres:host"',
    })
  })

  it('POST /admin/recipes/validate — rejects unresolved env templates with env-name field path', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'bad-env-template-resolution' },
        spec: {
          triggers: { onDemand: { allowedActors: ['user'] } },
          workloads: [
            {
              id: 'worker',
              type: 'deployment',
              image: 'worker:test',
            },
            {
              id: 'qa-api',
              type: 'deployment',
              image: 'qa-api:test',
              env: [{ name: 'WORKER_HOST', value: '{{worker:host}}' }],
            },
          ],
          steps: [{ id: 'run-qa', instruction: 'Validate QA API.' }],
        },
      })
      .expect(422)

    expect(res.body.errors[0]).toMatchObject({
      rule: 'workflowTemplateUnresolved',
      field: 'spec.workloads[1].env[WORKER_HOST].value',
      message: 'Unresolved template reference "worker:host"',
    })
  })

  it('POST /admin/recipes/validate — rejects host and port references to portless workloads', async () => {
    const baseRecipe = {
      metadata: { name: 'portless-template-resolution' },
      spec: {
        triggers: { onDemand: { allowedActors: ['user'] } },
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:test',
          },
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate QA API.' }],
      },
    }

    const hostRes = await request(app)
      .post('/admin/recipes/validate')
      .send({
        ...baseRecipe,
        spec: {
          ...baseRecipe.spec,
          workloads: [
            baseRecipe.spec.workloads[0],
            {
              ...baseRecipe.spec.workloads[1],
              args: ['--worker-host={{worker:host}}'],
            },
          ],
        },
      })
      .expect(422)

    expect(hostRes.body.errors[0]).toMatchObject({
      rule: 'workflowTemplateUnresolved',
      field: 'spec.workloads[1].args[0]',
      message: 'Unresolved template reference "worker:host"',
    })

    const portRes = await request(app)
      .post('/admin/recipes/validate')
      .send({
        ...baseRecipe,
        spec: {
          ...baseRecipe.spec,
          workloads: [
            baseRecipe.spec.workloads[0],
            {
              ...baseRecipe.spec.workloads[1],
              args: ['--worker-port={{worker:port}}'],
            },
          ],
        },
      })
      .expect(422)

    expect(portRes.body.errors[0]).toMatchObject({
      rule: 'workflowTemplateUnresolved',
      field: 'spec.workloads[1].args[0]',
      message: 'Unresolved template reference "worker:port"',
    })
  })

  it('POST /admin/recipes/validate — requires shared snippet and transport Secret refs in both runtime namespaces', async () => {
    const sharedRecipe = {
      metadata: { name: 'shared-secret-recipe' },
      spec: {
        triggers: { onDemand: { allowedActors: ['user'] } },
        workloads: [
          {
            id: 'mock-tools',
            type: 'deployment',
            image: 'clerum/mock-mcp-server:test',
            transport: { type: 'streamableHttp' },
            envSecret: {
              name: 'shared-credentials',
              keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
            },
          },
        ],
        steps: [
          {
            id: 'load',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: {
                secrets: [
                  {
                    alias: 'api_key',
                    secretRef: { name: 'shared-credentials', key: 'apiKey' },
                  },
                ],
              },
            },
          },
        ],
      },
    }

    gateway.seedSecret('shared-credentials', SANDBOX_NS, {
      data: { apiKey: 'dmFsdWU=' },
    })

    const pendingMcp = await request(app)
      .post('/admin/recipes/validate')
      .send(sharedRecipe)
      .expect(200)

    expect(pendingMcp.body.valid).toBe(true)

    gateway.seedSecret('shared-credentials', MCP_NS, {
      data: { apiKey: 'dmFsdWU=' },
    })

    const ok = await request(app).post('/admin/recipes/validate').send(sharedRecipe).expect(200)
    expect(ok.body.valid).toBe(true)
  })

  it('POST /admin/recipes — creates recipe with pending snippet secretRef', async () => {
    const createSpy = vi.spyOn(gateway, 'createResource')
    const res = await request(app)
      .post('/admin/recipes')
      .send(SNIPPET_RECIPE_WITH_SECRET)
      .expect(201)

    expect(res.body.metadata.name).toBe('snippet-secret-recipe')
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowSnippetSecret',
        secretName: 'coingecko-api',
        namespace: SANDBOX_NS,
        keys: ['apiKey'],
        field: 'spec.steps[0].run.capabilities.secrets[0].secretRef',
      },
    ])
    expect(createSpy.mock.calls.filter(call => call[0] === 'workflowrecipes')).toHaveLength(1)
    createSpy.mockRestore()
  })

  it('POST /admin/recipes — creates recipe with pending workload envSecret', async () => {
    const createSpy = vi.spyOn(gateway, 'createResource')
    const res = await request(app)
      .post('/admin/recipes')
      .send(WORKLOAD_RECIPE_WITH_ENV_SECRET)
      .expect(201)

    expect(res.body.metadata.name).toBe('workload-env-secret-recipe')
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowEnvSecret',
        secretName: 'workflow-api-credentials',
        namespace: SANDBOX_NS,
        keys: ['apiKey', 'dbPassword'],
        field: 'spec.workloads[0].envSecret',
      },
    ])
    expect(createSpy.mock.calls.filter(call => call[0] === 'workflowrecipes')).toHaveLength(1)
    createSpy.mockRestore()
  })

  it('POST /admin/recipes/validate — accepts binding from MCP transport workload to backend', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'binding-valid' },
        spec: {
          workloads: [
            {
              id: 'mcp-api',
              type: 'deployment',
              image: 'mcp:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
            },
            { id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 },
          ],
          bindings: [{ from: 'mcp-api', to: 'db', port: 5432 }],
        },
      })
      .expect(200)
    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes/validate — rejects binding with unknown workload reference', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'binding-missing' },
        spec: {
          workloads: [
            {
              id: 'mcp-api',
              type: 'deployment',
              image: 'mcp:latest',
              port: 3000,
              transport: { type: 'streamableHttp' },
            },
          ],
          bindings: [{ from: 'mcp-api', to: 'missing-db', port: 5432 }],
        },
      })
      .expect(422)
    expect(res.body.valid).toBe(false)
    expect(res.body.errors.some((e: { field: string }) => e.field === 'spec.bindings[0].to')).toBe(
      true
    )
  })

  it('POST /admin/recipes/validate — rejects binding without one transport endpoint', async () => {
    const res = await api
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'binding-no-transport' },
        spec: {
          workloads: [
            { id: 'app', type: 'deployment', image: 'app:latest', port: 8080 },
            { id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 },
          ],
          bindings: [{ from: 'app', to: 'db', port: 5432 }],
        },
      })
      .expect(422)
    expect(res.body.valid).toBe(false)
    expect(res.body.errors.some((e: { field: string }) => e.field === 'spec.bindings[0]')).toBe(
      true
    )
  })

  it('POST /admin/recipes/validate — backgroundAccess without the provider offline scope → 422 with rule', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'bg-no-offline-scope' },
        spec: {
          oauthClients: [
            {
              id: 'sf',
              provider: 'salesforce',
              clientIdRef: { name: 'sf-creds', key: 'client-id' },
              clientSecretRef: { name: 'sf-creds', key: 'client-secret' },
              scopes: ['api'],
              backgroundAccess: true,
            },
          ],
        },
      })
      .expect(422)
    expect(res.body.valid).toBe(false)
    expect(
      res.body.errors.some(
        (e: { field: string; rule?: string }) =>
          e.field === 'spec.oauthClients[0].scopes' &&
          e.rule === 'background_access_missing_offline_scope'
      )
    ).toBe(true)
  })

  it('POST /admin/recipes/validate — backgroundAccess with the provider offline scope → 200', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'bg-with-offline-scope' },
        spec: {
          oauthClients: [
            {
              id: 'sf',
              provider: 'salesforce',
              clientIdRef: { name: 'sf-creds', key: 'client-id' },
              clientSecretRef: { name: 'sf-creds', key: 'client-secret' },
              scopes: ['api', 'refresh_token'],
              backgroundAccess: true,
            },
          ],
        },
      })
      .expect(200)
    expect(res.body.valid).toBe(true)
  })

  const BG_OAUTH_CLIENT = {
    id: 'sf',
    provider: 'salesforce',
    clientIdRef: { name: 'sf-creds', key: 'client-id' },
    clientSecretRef: { name: 'sf-creds', key: 'client-secret' },
    scopes: ['api', 'refresh_token'],
    backgroundAccess: true,
  }

  it('POST /admin/recipes/validate — workload oauthClientRefs to a backgroundAccess client → 200', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'bg-ref-ok' },
        spec: {
          oauthClients: [BG_OAUTH_CLIENT],
          workloads: [
            { id: 'sync', type: 'cronjob', image: 'sync:latest', oauthClientRefs: ['sf'] },
          ],
        },
      })
      .expect(200)
    expect(res.body.valid).toBe(true)
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowOauthClientSecret',
        secretName: 'sf-creds',
        namespace: SANDBOX_NS,
        keys: ['client-id', 'client-secret'],
        field: 'spec.oauthClients[0].clientIdRef',
        fields: ['spec.oauthClients[0].clientIdRef', 'spec.oauthClients[0].clientSecretRef'],
      },
    ])
  })

  it('POST /admin/recipes/validate — oauthClientRefs to an undeclared client → 422 with rule', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'bg-ref-unknown' },
        spec: {
          oauthClients: [BG_OAUTH_CLIENT],
          workloads: [
            { id: 'sync', type: 'cronjob', image: 'sync:latest', oauthClientRefs: ['nope'] },
          ],
        },
      })
      .expect(422)
    expect(
      res.body.errors.some(
        (e: { field: string; rule?: string }) =>
          e.field === 'spec.workloads[0].oauthClientRefs' && e.rule === 'oauth_client_ref_unknown'
      )
    ).toBe(true)
  })

  it('POST /admin/recipes/validate — oauthClientRefs on an MCP transport workload → 422 with rule', async () => {
    const res = await request(app)
      .post('/admin/recipes/validate')
      .send({
        metadata: { name: 'bg-ref-mcp' },
        spec: {
          oauthClients: [BG_OAUTH_CLIENT],
          workloads: [
            {
              id: 'mcp',
              type: 'deployment',
              image: 'mcp:latest',
              transport: { type: 'streamableHttp' },
              oauthClientRefs: ['sf'],
            },
          ],
        },
      })
      .expect(422)
    expect(
      res.body.errors.some(
        (e: { field: string; rule?: string }) => e.rule === 'oauth_client_ref_invalid_workload'
      )
    ).toBe(true)
  })

  // ── Policy invariant: agentic workflows cannot use an explicit Context

  const AGENTIC_CTXREF_BODY = {
    metadata: { name: 'agentic-block' },
    spec: {
      triggers: { onDemand: { allowedActors: ['user'] } },
      steps: [{ id: 's1', instruction: 'do x' }],
      contextRef: 'ctx1',
    },
  } as const

  const AGENTIC_CTXREF_ALLOWED_BODY = {
    metadata: { name: 'agentic-allow' },
    spec: {
      triggers: { onDemand: { allowedActors: ['user'] } },
      steps: [{ id: 's1', instruction: 'do x' }],
      contextRef: 'ctx1',
      security: { allowContextRef: true },
    },
  } as const

  it('POST /admin/recipes/validate — agentic + contextRef + no flag → 422 with rule', async () => {
    const res = await api.post('/admin/recipes/validate').send(AGENTIC_CTXREF_BODY).expect(422)
    expect(res.body.valid).toBe(false)
    expect(res.body.errors[0].rule).toBe('agenticWorkflowContextRefBlocked')
    expect(res.body.errors[0].field).toBe('spec.contextRef')
  })

  it('POST /admin/recipes/validate — agentic + flag + matching policy (in canonical ns) → 200', async () => {
    // checkPolicyInvariant reads policies from the CRD canonical namespace
    // (SANDBOX_NS). Seeding the policy there mirrors what an operator would
    // do — recipe + governance policy co-locate with the coordinator pods.
    await gateway.createResource(
      'workflowrecipepolicies' as never,
      { metadata: { name: 'allow-ctx' }, spec: { allowContextRef: true } },
      SANDBOX_NS
    )
    const res = await api
      .post('/admin/recipes/validate')
      .send(AGENTIC_CTXREF_ALLOWED_BODY)
      .expect(200)
    expect(res.body.valid).toBe(true)
  })

  it('POST /admin/recipes — agentic + contextRef + no flag → 422, CRD not created', async () => {
    const createSpy = vi.spyOn(gateway, 'createResource')
    const res = await api.post('/admin/recipes').send(AGENTIC_CTXREF_BODY).expect(422)
    expect(res.body.errors[0].rule).toBe('agenticWorkflowContextRefBlocked')
    // Helper is permitted to touch workflowrecipepolicies (listResource), but
    // must NOT create the WorkflowRecipe when the invariant rejects the body.
    const createdRecipe = createSpy.mock.calls.find(call => call[0] === 'workflowrecipes')
    expect(createdRecipe).toBeUndefined()
    createSpy.mockRestore()
  })

  it('POST /admin/recipes — agentic + flag + matching policy → 201 (CRD lands in canonical ns)', async () => {
    // Policy seeded in SANDBOX_NS (canonical) — both recipe and policy
    // co-locate here for governance clarity alongside the coordinator pods.
    await gateway.createResource(
      'workflowrecipepolicies' as never,
      { metadata: { name: 'allow-ctx' }, spec: { allowContextRef: true } },
      SANDBOX_NS
    )
    const res = await api.post('/admin/recipes').send(AGENTIC_CTXREF_ALLOWED_BODY).expect(201)
    expect(res.body.metadata.name).toBe('agentic-allow')
    expect(res.body.metadata.namespace).toBe(SANDBOX_NS)
  })

  // ── Name collision pre-flight ────────────────────────────────────────────

  it('POST /admin/recipes/validate?mode=create — collision → 422 with rule', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    const res = await api.post('/admin/recipes/validate?mode=create').send(VALID_RECIPE).expect(422)
    expect(res.body.errors[0].rule).toBe('recipeNameTaken')
    expect(res.body.errors[0].field).toBe('metadata.name')
  })

  it('POST /admin/recipes/validate?mode=edit — collision is not flagged (expected existing)', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    await api.post('/admin/recipes/validate?mode=edit').send(VALID_RECIPE).expect(200)
  })

  it('POST /admin/recipes — collision short-circuits before gateway.createResource', async () => {
    await api.post('/admin/recipes').send(VALID_RECIPE).expect(201)
    const createSpy = vi.spyOn(gateway, 'createResource')
    const res = await api.post('/admin/recipes').send(VALID_RECIPE).expect(422)
    expect(res.body.errors[0].rule).toBe('recipeNameTaken')
    // First createResource in the spy window — the one from this test, not
    // the setup seed — must not have been called (setup ran before the spy).
    expect(createSpy.mock.calls.filter(call => call[0] === 'workflowrecipes')).toHaveLength(0)
    createSpy.mockRestore()
  })

  // ── Validation rejection cases ───────────────────────────────────────────

  it('POST /admin/recipes — rejects invalid workload type', async () => {
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: { name: 'bad-recipe' },
        spec: { workloads: [{ id: 'svc', type: 'invalidtype', image: 'img:1' }] },
      })
      .expect(422)

    const typeErr = (res.body.errors as Array<{ field: string }>).find(
      e => e.field === 'spec.workloads[0].type'
    )
    expect(typeErr).toBeDefined()
  })

  it('POST /admin/recipes — rejects root UID (runAsUser: 0)', async () => {
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: { name: 'root-recipe' },
        spec: {
          workloads: [
            {
              id: 'svc',
              type: 'deployment',
              image: 'img:1',
              security: { runAsUser: 0 },
            },
          ],
        },
      })
      .expect(422)

    const uidErr = (res.body.errors as Array<{ field: string }>).find(
      e => e.field === 'spec.workloads[0].security.runAsUser'
    )
    expect(uidErr).toBeDefined()
  })

  it('POST /admin/recipes — rejects disallowed Linux capability', async () => {
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: { name: 'cap-recipe' },
        spec: {
          workloads: [
            {
              id: 'svc',
              type: 'deployment',
              image: 'img:1',
              security: { addCapabilities: ['SYS_ADMIN'] },
            },
          ],
        },
      })
      .expect(422)

    const capErr = (res.body.errors as Array<{ field: string }>).find(
      e => e.field === 'spec.workloads[0].security.addCapabilities[0]'
    )
    expect(capErr).toBeDefined()
  })

  it('POST /admin/recipes — rejects privilege-boundary capabilities', async () => {
    const deniedCapabilities = ['SETUID', 'SETGID', 'SYS_CHROOT', 'KILL', 'AUDIT_WRITE']
    const res = await api
      .post('/admin/recipes')
      .send({
        metadata: { name: 'denied-cap-recipe' },
        spec: {
          workloads: [
            {
              id: 'svc',
              type: 'deployment',
              image: 'img:1',
              security: { addCapabilities: deniedCapabilities },
            },
          ],
        },
      })
      .expect(422)

    const errors = res.body.errors as Array<{ field: string; message: string }>
    deniedCapabilities.forEach((cap, index) => {
      const field = `spec.workloads[0].security.addCapabilities[${index}]`
      expect(errors.some(e => e.field === field && e.message.includes(cap))).toBe(true)
    })
  })

  it('GET /admin/recipes/INVALID-NAME — returns 400', async () => {
    await api.get('/admin/recipes/INVALID_NAME').expect(400)
  })

  it('PUT /admin/recipes/INVALID-NAME — returns 400', async () => {
    await api.put('/admin/recipes/INVALID_NAME').send({ spec: {} }).expect(400)
  })

  it('DELETE /admin/recipes/INVALID-NAME — returns 400', async () => {
    await api.delete('/admin/recipes/INVALID_NAME').expect(400)
  })
})

// ── Artifact download: delegation JWT → WRC proxy ──────────────────────────
// These tests cover the Lane Y Step 2 refactor: control-api signs a
// delegation JWT, proxies the request to workflow-recipes over HTTP, and
// streams the body back to the admin. They mock global fetch so we can
// assert on what control-api actually sent without standing up WRC.
describe.sequential('routes/admin/recipes — artifact download (delegation JWT)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof makeAuthedApp>
  let server: http.Server
  let api: TestApi
  const fetchMock = vi.fn<typeof fetch>()

  beforeAll(async () => {
    app = makeAuthedApp(
      makeGatewayProxy(() => gateway),
      'admin-alice'
    )
    server = await startTestServer(app)
    api = request(server)
  })

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  afterAll(async () => {
    await closeTestServer(server)
  })

  // Build a minimal Response-like object the route handler consumes.
  // tsconfig "lib": ES2022 does not include DOM, so `new Response(...)` is
  // not available in test scope — we only need to satisfy the subset of
  // the fetch Response interface that recipes.ts actually reads:
  //   { ok, status, headers.get(), arrayBuffer() }
  function mockFetchResponse(
    body: Buffer | string,
    status: number,
    headers: Record<string, string> = {}
  ): Response {
    const buf = typeof body === 'string' ? Buffer.from(body) : body
    const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
      },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as unknown as Response
  }

  // Derive the public key the same way delegationToken.ts does so we can
  // verify the JWT that control-api sent to WRC without importing any
  // private helpers.
  async function verifyDelegationTokenFromHeader(authHeader: string | undefined) {
    expect(authHeader).toBeDefined()
    expect(authHeader!.startsWith('Bearer ')).toBe(true)
    const token = authHeader!.slice('Bearer '.length)
    const { createPublicKey } = await import('node:crypto')
    const pem = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const decoded = jwt.verify(token, pem, {
      algorithms: ['RS256'],
      issuer: 'control-api',
      audience: 'clerum-wrc',
    }) as jwt.JwtPayload
    return decoded
  }

  it('sends Authorization: Bearer <delegation-jwt> to WRC and streams back the body', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake-pdf-body')
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(pdfBytes, 200, { 'content-type': 'application/pdf' })
    )

    // Recipe must exist in the sandbox namespace so enforceNamespace accepts it.
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'market-report' }, spec: {} },
      SANDBOX_NS
    )

    const res = await api
      .get('/admin/recipes/market-report/artifacts/report.pdf/download')
      .expect(200)

    expect(res.headers['content-type']).toContain('application/pdf')
    expect(res.headers['content-disposition']).toContain('filename="report.pdf"')
    expect(res.body).toBeInstanceOf(Buffer)
    expect(Buffer.compare(res.body as Buffer, pdfBytes)).toBe(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/market-report/artifacts/report.pdf'
    )
    const headers = (init as RequestInit).headers as Record<string, string>

    // X-Service-Token must NOT be present — the old bypass path is gone.
    expect(headers['X-Service-Token']).toBeUndefined()
    expect(headers['x-service-token']).toBeUndefined()

    // Authorization header must carry a verifiable delegation JWT.
    const decoded = await verifyDelegationTokenFromHeader(headers['Authorization'])
    expect(decoded.sub).toBe('admin:admin-alice')
    expect(decoded.recipeName).toBe('market-report')
    // recipeNamespace MUST be present — WRC rejects tokens without it
    // ("JWT missing required claim: recipeNamespace"). This claim was the
    // exact cause of the 401 artifact-download bug fixed in 0233ce8.
    expect(decoded.recipeNamespace).toBe(SANDBOX_NS)
    expect(decoded.artifactName).toBe('report.pdf')
    expect(decoded.scopes).toEqual(['admin:artifact_read'])
  })

  it('returns 404 when WRC responds 404', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r3' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('not found', 404))
    const res = await api.get('/admin/recipes/r3/artifacts/missing.pdf/download').expect(404)
    expect(res.body.error).toContain('not found')
  })

  it('returns 401 when WRC responds 401 (invalid delegation token path)', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r4' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('denied', 401))
    await api.get('/admin/recipes/r4/artifacts/a.pdf/download').expect(401)
  })

  it('collapses WRC 5xx to 502', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r5' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('boom', 503))
    const res = await api.get('/admin/recipes/r5/artifacts/a.pdf/download').expect(502)
    expect(res.body.error).toContain('Upstream')
  })

  it('rejects invalid recipe name before calling WRC', async () => {
    await api.get('/admin/recipes/INVALID_NAME/artifacts/a.pdf/download').expect(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects artifact name with path traversal before calling WRC', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r6' }, spec: {} },
      SANDBOX_NS
    )
    await api.get('/admin/recipes/r6/artifacts/..%2Fetc%2Fpasswd/download').expect(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signs a fresh delegation token (unique jti) per request', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r7' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse(Buffer.from('a'), 200))
      .mockResolvedValueOnce(mockFetchResponse(Buffer.from('b'), 200))

    await api.get('/admin/recipes/r7/artifacts/a.txt/download').expect(200)
    await api.get('/admin/recipes/r7/artifacts/b.txt/download').expect(200)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const h1 = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    const h2 = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    const d1 = await verifyDelegationTokenFromHeader(h1['Authorization'])
    const d2 = await verifyDelegationTokenFromHeader(h2['Authorization'])
    expect(d1.jti).not.toBe(d2.jti)
    expect(d1.artifactName).toBe('a.txt')
    expect(d2.artifactName).toBe('b.txt')
  })
})

// ── Artifact delete: delegation JWT → WRC proxy ─────────────────────────────
// Tests cover both the per-file DELETE and bulk DELETE endpoints that proxy
// through WRC with a short-lived delegation JWT carrying admin:artifact_delete.
describe.sequential('routes/admin/recipes — artifact delete (delegation JWT)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof makeAuthedApp>
  let server: http.Server
  let api: TestApi
  let noAuthServer: http.Server
  let noAuthApi: TestApi
  const fetchMock = vi.fn<typeof fetch>()

  beforeAll(async () => {
    const gatewayProxy = makeGatewayProxy(() => gateway)
    app = makeAuthedApp(gatewayProxy, 'admin-alice')
    server = await startTestServer(app)
    api = request(server)
    const noAuthApp = makeApp(gatewayProxy)
    noAuthServer = await startTestServer(noAuthApp)
    noAuthApi = request(noAuthServer)
  })

  beforeEach(() => {
    gateway = new MockGateway(MCP_NS)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  afterAll(async () => {
    await closeTestServer(noAuthServer)
    await closeTestServer(server)
  })

  function mockFetchResponse(
    body: Buffer | string,
    status: number,
    headers: Record<string, string> = {}
  ): Response {
    const buf = typeof body === 'string' ? Buffer.from(body) : body
    const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
      },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as unknown as Response
  }

  async function verifyDelegationTokenFromHeader(authHeader: string | undefined) {
    expect(authHeader).toBeDefined()
    expect(authHeader!.startsWith('Bearer ')).toBe(true)
    const token = authHeader!.slice('Bearer '.length)
    const { createPublicKey } = await import('node:crypto')
    const pem = createPublicKey(config.adminJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    })
    const decoded = jwt.verify(token, pem, {
      algorithms: ['RS256'],
      issuer: 'control-api',
      audience: 'clerum-wrc',
    }) as jwt.JwtPayload
    return decoded
  }

  // ── Per-file DELETE (/admin/recipes/:name/artifacts/:artifactName) ──────

  it('per-file: returns 204 on successful upstream response', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'del-recipe' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('', 204))

    await api.delete('/admin/recipes/del-recipe/artifacts/report.pdf').expect(204)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/del-recipe/artifacts/report.pdf'
    )
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('per-file: rejects invalid recipe name → 400', async () => {
    await api.delete('/admin/recipes/INVALID_NAME/artifacts/report.pdf').expect(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('per-file: rejects path traversal in artifact name → 400', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-pt' }, spec: {} },
      SANDBOX_NS
    )
    await api.delete('/admin/recipes/r-pt/artifacts/..%2Fetc%2Fpasswd').expect(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('per-file: returns 401 when adminAuth.sub is missing', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-noauth' }, spec: {} },
      SANDBOX_NS
    )
    await noAuthApi.delete('/admin/recipes/r-noauth/artifacts/a.pdf').expect(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('per-file: returns 404 when upstream responds 404', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-404' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('not found', 404))
    const res = await api.delete('/admin/recipes/r-404/artifacts/missing.pdf').expect(404)
    expect(res.body.error).toContain('not found')
  })

  it('per-file: returns 401 when upstream responds 401', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-401' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('denied', 401))
    await api.delete('/admin/recipes/r-401/artifacts/a.pdf').expect(401)
  })

  it('per-file: collapses upstream 5xx to 502', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-5xx' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('boom', 503))
    const res = await api.delete('/admin/recipes/r-5xx/artifacts/a.pdf').expect(502)
    expect(res.body.error).toContain('Upstream')
  })

  it('per-file: returns 504 on AbortError (timeout)', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-timeout' }, spec: {} },
      SANDBOX_NS
    )
    const abortErr = new Error('The operation was aborted')
    abortErr.name = 'AbortError'
    fetchMock.mockRejectedValueOnce(abortErr)
    const res = await api.delete('/admin/recipes/r-timeout/artifacts/a.pdf').expect(504)
    expect(res.body.error).toContain('timed out')
  })

  it('per-file: delegation JWT has correct claims (iss, aud, scope, recipeName, recipeNamespace)', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-claims' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('', 204))

    await api.delete('/admin/recipes/r-claims/artifacts/report.pdf').expect(204)

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>

    // X-Service-Token must NOT be present
    expect(headers['X-Service-Token']).toBeUndefined()
    expect(headers['x-service-token']).toBeUndefined()

    const decoded = await verifyDelegationTokenFromHeader(headers['Authorization'])
    expect(decoded.sub).toBe('admin:admin-alice')
    expect(decoded.recipeName).toBe('r-claims')
    // recipeNamespace is required by WRC — missing it was the root cause of
    // the 401 bug fixed in 0233ce8. Verify it's present on the delete path too.
    expect(decoded.recipeNamespace).toBe(SANDBOX_NS)
    expect(decoded.scopes).toEqual(['admin:artifact_delete'])
  })

  it('per-file: signs a fresh jti per request', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-jti' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse('', 204))
      .mockResolvedValueOnce(mockFetchResponse('', 204))

    await api.delete('/admin/recipes/r-jti/artifacts/a.txt').expect(204)
    await api.delete('/admin/recipes/r-jti/artifacts/b.txt').expect(204)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const h1 = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    const h2 = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    const d1 = await verifyDelegationTokenFromHeader(h1['Authorization'])
    const d2 = await verifyDelegationTokenFromHeader(h2['Authorization'])
    expect(d1.jti).not.toBe(d2.jti)
  })

  // ── Bulk DELETE (/admin/recipes/:name/artifacts) ───────────────────────

  it('bulk: returns 204 on successful upstream response', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'bulk-recipe' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('', 204))

    await api.delete('/admin/recipes/bulk-recipe/artifacts').expect(204)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'http://workflow-recipes.control-plane.svc.cluster.local:8082/api/v1/workflow/bulk-recipe/artifacts'
    )
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('bulk: rejects invalid recipe name → 400', async () => {
    await api.delete('/admin/recipes/INVALID_NAME/artifacts').expect(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bulk: returns 401 when adminAuth.sub is missing', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-bulk-noauth' }, spec: {} },
      SANDBOX_NS
    )
    await noAuthApi.delete('/admin/recipes/r-bulk-noauth/artifacts').expect(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bulk: returns 404 when upstream responds 404', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-bulk-404' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('not found', 404))
    const res = await api.delete('/admin/recipes/r-bulk-404/artifacts').expect(404)
    expect(res.body.error).toContain('not found')
  })

  it('bulk: returns 401 when upstream responds 401', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-bulk-401' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('denied', 401))
    await api.delete('/admin/recipes/r-bulk-401/artifacts').expect(401)
  })

  it('bulk: collapses upstream 5xx to 502', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-bulk-5xx' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('boom', 500))
    const res = await api.delete('/admin/recipes/r-bulk-5xx/artifacts').expect(502)
    expect(res.body.error).toContain('Upstream')
  })

  it('bulk: returns 504 on AbortError (timeout)', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-bulk-to' }, spec: {} },
      SANDBOX_NS
    )
    const abortErr = new Error('The operation was aborted')
    abortErr.name = 'AbortError'
    fetchMock.mockRejectedValueOnce(abortErr)
    const res = await api.delete('/admin/recipes/r-bulk-to/artifacts').expect(504)
    expect(res.body.error).toContain('timed out')
  })

  it('bulk: delegation JWT has correct claims (iss, aud, scope, recipeName, recipeNamespace)', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-bulk-claims' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock.mockResolvedValueOnce(mockFetchResponse('', 204))

    await api.delete('/admin/recipes/r-bulk-claims/artifacts').expect(204)

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>

    // X-Service-Token must NOT be present
    expect(headers['X-Service-Token']).toBeUndefined()
    expect(headers['x-service-token']).toBeUndefined()

    const decoded = await verifyDelegationTokenFromHeader(headers['Authorization'])
    expect(decoded.sub).toBe('admin:admin-alice')
    expect(decoded.recipeName).toBe('r-bulk-claims')
    // recipeNamespace is required by WRC — regression guard for 0233ce8.
    expect(decoded.recipeNamespace).toBe(SANDBOX_NS)
    expect(decoded.scopes).toEqual(['admin:artifact_delete'])
  })

  it('bulk: signs a fresh jti per request', async () => {
    await gateway.createResource(
      'workflowrecipes',
      { metadata: { name: 'r-bulk-jti' }, spec: {} },
      SANDBOX_NS
    )
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse('', 204))
      .mockResolvedValueOnce(mockFetchResponse('', 204))

    await api.delete('/admin/recipes/r-bulk-jti/artifacts').expect(204)
    await api.delete('/admin/recipes/r-bulk-jti/artifacts').expect(204)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const h1 = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    const h2 = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    const d1 = await verifyDelegationTokenFromHeader(h1['Authorization'])
    const d2 = await verifyDelegationTokenFromHeader(h2['Authorization'])
    expect(d1.jti).not.toBe(d2.jti)
  })
})
