import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminSecretsRouter } from '../src/routes/admin/secrets.js'
import { SecretService } from '../src/services/secretService.js'

// Integration guard for the names-only write contract (SECURITY). Unlike the
// unit route tests (which mock the K8sGateway and so bypass the trim), this wires
// the REAL SecretService behind the REAL admin secrets router and mocks ONLY the
// external Kubernetes CoreV1Api — the correct boundary to mock. The mocked k8s
// client returns FULL V1Secrets with base64 `.data`, so the ONLY reason the HTTP
// response is names-only is the SecretService trim. These tests go RED if the
// service ever stops trimming (i.e. the leak returns), even though no route code
// changed for the sibling endpoints.

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

const LEAK = 'leak-me-please'
const OTHER = 'other-provider-secret'

function fullSecret(
  name: string,
  namespace: string,
  data: Record<string, string>,
  labels: Record<string, string> = {}
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace, resourceVersion: '7', labels },
    type: 'Opaque',
    data,
  }
}

function makeApp(opts: {
  existing?: Record<string, unknown> | null
  written: Record<string, unknown>
}): { app: express.Express; core: Record<string, ReturnType<typeof vi.fn>> } {
  const core = {
    createNamespacedSecret: vi.fn(async () => opts.written),
    readNamespacedSecret: vi.fn(async () => {
      if (opts.existing == null) {
        throw Object.assign(new Error('not found'), { statusCode: 404 })
      }
      return opts.existing
    }),
    replaceNamespacedSecret: vi.fn(async () => opts.written),
    patchNamespacedSecret: vi.fn(async () => opts.written),
    deleteNamespacedSecret: vi.fn(async () => ({ kind: 'Status', status: 'Success' })),
    listNamespacedSecret: vi.fn(async () => ({ items: [] })),
  }
  const svc = new SecretService(core as never, 'mcp-host')
  // Minimal gateway facade delegating secret ops to the REAL service; only the
  // methods the routes under test touch are provided.
  const gateway = {
    listSecrets: (ns?: string) => svc.listSecrets(ns),
    getSecret: (n: string, ns?: string) => svc.getSecret(n, ns),
    createSecret: (r: never) => svc.createSecret(r),
    updateSecret: (r: never) => svc.updateSecret(r),
    deleteSecret: (n: string, ns?: string) => svc.deleteSecret(n, ns),
    listResource: vi.fn(async () => []),
  }
  const app = express()
  app.use(express.json())
  app.use(createAdminSecretsRouter(gateway as never))
  return { app, core }
}

// Asserts an HTTP body carries no secret value at any depth and no `.data` field.
function expectNoSecretValues(body: unknown): void {
  const serialized = JSON.stringify(body)
  for (const needle of [LEAK, OTHER, b64(LEAK), b64(OTHER)]) {
    expect(serialized).not.toContain(needle)
  }
  expect((body as { data?: unknown }).data).toBeUndefined()
}

describe('SECURITY (integration): admin secret-write responses are names-only', () => {
  it('POST /admin/secrets does not echo the created Secret .data', async () => {
    const { app } = makeApp({
      written: fullSecret('svc-token', 'mcp-host', { token: b64(LEAK) }),
    })
    const res = await request(app)
      .post('/admin/secrets')
      .send({ name: 'svc-token', stringData: { token: LEAK } })
      .expect(201)

    expect(res.body).toMatchObject({ name: 'svc-token', keys: ['token'] })
    expect(res.body).not.toHaveProperty('data')
    expectNoSecretValues(res.body)
  })

  it('PUT /admin/secrets (full-replace) does not echo the replaced Secret .data', async () => {
    const { app } = makeApp({
      // getSecret (validation-only label read) + updateSecret read-then-replace.
      existing: fullSecret('svc-token', 'mcp-host', { token: b64('old') }),
      written: fullSecret('svc-token', 'mcp-host', { token: b64(LEAK) }),
    })
    const res = await request(app)
      .put('/admin/secrets')
      .send({ name: 'svc-token', stringData: { token: LEAK } })
      .expect(200)

    expect(res.body).toMatchObject({ name: 'svc-token', keys: ['token'] })
    expectNoSecretValues(res.body)
  })

  it('PUT /admin/recipe-secrets does not echo merged .data (incl. keys the caller did not send)', async () => {
    const { app } = makeApp({
      // Existing recipe secret carries a key the caller does NOT send this time;
      // the merge-patch response would include it — only its NAME may surface.
      existing: fullSecret(
        'r1',
        'sandbox-recipes',
        { EXISTING: b64(OTHER) },
        { 'clerum.io/recipe-secret': 'true', 'clerum.io/shared': 'true' }
      ),
      written: fullSecret(
        'r1',
        'sandbox-recipes',
        { EXISTING: b64(OTHER), TOKEN: b64(LEAK) },
        { 'clerum.io/recipe-secret': 'true', 'clerum.io/shared': 'true' }
      ),
    })
    const res = await request(app)
      .put('/admin/recipe-secrets')
      .send({ name: 'r1', data: { TOKEN: LEAK } })
      .expect(200)

    // Names-only, and the resulting keyset includes the pre-existing key by NAME
    // only (never its value) — proving the merge response was trimmed.
    expect(res.body).toMatchObject({ name: 'r1', keys: ['EXISTING', 'TOKEN'] })
    expectNoSecretValues(res.body)
  })

  it('DELETE /admin/secrets/:name returns a names-only summary, not a Secret body', async () => {
    const { app } = makeApp({
      written: fullSecret('svc-token', 'mcp-host', { token: b64(LEAK) }),
    })
    const res = await request(app).delete('/admin/secrets/svc-token').expect(200)
    expect(res.body).toMatchObject({ name: 'svc-token', deleted: true })
    expectNoSecretValues(res.body)
  })
})
