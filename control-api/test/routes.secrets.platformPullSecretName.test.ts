/**
 * The reserved platform Secret name, on the mcp-secret / recipe-secret surfaces.
 *
 * `evenfire-registry-pull` is control-api's own image-pull credential, self-provisioned
 * into every platform workload namespace. These routes write into that SAME set of
 * namespaces (`RECIPE_SECRET_NAMESPACES` is set-identical to `platformWorkloadNamespaces()`),
 * so the name is reachable from here — and squatting it is unrepairable: the provisioner
 * refuses to overwrite a Secret it does not own, so a foreign `Opaque` object under the
 * reserved name makes every private-image install into that namespace 409 permanently.
 *
 * The recipe routes in `routes/admin/recipes.ts` already reserve the name; these three did
 * not. The DELETE is the sharp one — it deletes by name with no ownership guard at all.
 */
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '@clerum/workflow-runtime-core'
import { createAdminSecretsRouter } from '../src/routes/admin/secrets.js'

function writeSummary(body: unknown) {
  const write = body as {
    name: string
    namespace?: string
    data?: Record<string, string>
    stringData?: Record<string, string>
  }
  return {
    name: write.name,
    namespace: write.namespace || 'mcp-server',
    keys: [...new Set([...Object.keys(write.data ?? {}), ...Object.keys(write.stringData ?? {})])],
  }
}

function createGateway() {
  return {
    listSecrets: vi.fn(async () => []),
    listResource: vi.fn(async () => [] as unknown[]),
    getSecret: vi.fn(async () => null),
    createSecret: vi.fn(async (body: unknown) => writeSummary(body)),
    updateSecret: vi.fn(async (body: unknown) => writeSummary(body)),
    deleteSecret: vi.fn(async (name: string, namespace?: string) => ({
      name,
      namespace: namespace || 'mcp-server',
      deleted: true as const,
    })),
  }
}

function makeApp(gateway: ReturnType<typeof createGateway>) {
  const app = express()
  app.use(express.json())
  app.use(createAdminSecretsRouter(gateway as never))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

describe('platform-managed Secret name is reserved', () => {
  it('POST /admin/recipe-secrets refuses the reserved name and writes nothing', async () => {
    const gateway = createGateway()

    const res = await request(makeApp(gateway))
      .post('/admin/recipe-secrets')
      .send({
        name: EVENFIRE_REGISTRY_PULL_SECRET_NAME,
        data: { token: 'squat' },
        ownership: { kind: 'shared' },
        targetNamespace: 'mcp-server',
      })
      .expect(400)

    expect(res.body.error).toMatch(/platform-managed/)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('POST /admin/mcp-secrets refuses the reserved name and writes nothing', async () => {
    const gateway = createGateway()

    const res = await request(makeApp(gateway))
      .post('/admin/mcp-secrets')
      .send({ name: EVENFIRE_REGISTRY_PULL_SECRET_NAME, data: { token: 'squat' } })
      .expect(400)

    expect(res.body.error).toMatch(/platform-managed/)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('DELETE /admin/mcp-secrets/:name refuses the reserved name and deletes nothing', async () => {
    const gateway = createGateway()

    const res = await request(makeApp(gateway))
      .delete(`/admin/mcp-secrets/${EVENFIRE_REGISTRY_PULL_SECRET_NAME}`)
      .expect(400)

    expect(res.body.error).toMatch(/platform-managed/)
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  // The gap this file's own header missed. POST and DELETE were reserved; the MERGE path
  // was not, and it is the one that can quietly replace `.dockerconfigjson` with anything —
  // every private image pull in `mcp-server`, broken through a route whose stated job is to
  // refuse this name. The recipe-secret label check inside the handler does NOT cover it:
  // the platform Secret carries `clerum.io/managed-by`, not the recipe label, so it passes.
  it('PUT /admin/mcp-secrets/:name refuses the reserved name and merges nothing', async () => {
    const gateway = createGateway()
    // Shaped like the real platform Secret: present, and NOT a recipe secret — the exact
    // state in which every other guard in the handler waves it through.
    gateway.getSecret = vi.fn(async () => ({
      metadata: {
        name: EVENFIRE_REGISTRY_PULL_SECRET_NAME,
        namespace: 'mcp-server',
        labels: { 'clerum.io/managed-by': 'control-api' },
      },
      type: 'kubernetes.io/dockerconfigjson',
      data: { '.dockerconfigjson': 'e30=' },
    })) as never
    const mergeSecret = vi.fn(async (body: unknown) => writeSummary(body))
    ;(gateway as unknown as { mergeSecret: unknown }).mergeSecret = mergeSecret

    const res = await request(makeApp(gateway))
      .put(`/admin/mcp-secrets/${EVENFIRE_REGISTRY_PULL_SECRET_NAME}`)
      .send({ data: { '.dockerconfigjson': 'bm90LWEtY3JlZGVudGlhbA==' } })
      .expect(400)

    expect(res.body.error).toMatch(/platform-managed/)
    expect(mergeSecret).not.toHaveBeenCalled()
  })

  it('still merges into an ordinary connector Secret whose name merely resembles it', async () => {
    const gateway = createGateway()
    gateway.getSecret = vi.fn(async () => ({
      metadata: { name: `${EVENFIRE_REGISTRY_PULL_SECRET_NAME}-backup`, namespace: 'mcp-server' },
      type: 'Opaque',
      data: {},
    })) as never
    const mergeSecret = vi.fn(async (body: unknown) => writeSummary(body))
    ;(gateway as unknown as { mergeSecret: unknown }).mergeSecret = mergeSecret

    await request(makeApp(gateway))
      .put(`/admin/mcp-secrets/${EVENFIRE_REGISTRY_PULL_SECRET_NAME}-backup`)
      .send({ data: { token: 'fine' } })
      .expect(200)

    expect(mergeSecret).toHaveBeenCalled()
  })

  it('still deletes an ordinary connector Secret whose name merely resembles it', async () => {
    const gateway = createGateway()
    gateway.getSecret = vi.fn(async () => ({
      metadata: {
        name: `${EVENFIRE_REGISTRY_PULL_SECRET_NAME}-backup`,
        namespace: 'mcp-server',
        labels: {},
      },
    })) as never

    await request(makeApp(gateway))
      .delete(`/admin/mcp-secrets/${EVENFIRE_REGISTRY_PULL_SECRET_NAME}-backup`)
      .expect(200)

    expect(gateway.deleteSecret).toHaveBeenCalledWith(
      `${EVENFIRE_REGISTRY_PULL_SECRET_NAME}-backup`,
      'mcp-server'
    )
  })
})
