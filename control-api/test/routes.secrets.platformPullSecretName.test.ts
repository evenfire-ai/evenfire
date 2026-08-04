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

function createGateway() {
  return {
    listSecrets: vi.fn(async () => []),
    listResource: vi.fn(async () => [] as unknown[]),
    getSecret: vi.fn(async () => null),
    createSecret: vi.fn(async (body: unknown) => body),
    updateSecret: vi.fn(async (body: unknown) => body),
    deleteSecret: vi.fn(async (_name: string, _namespace?: string) => ({ deleted: true })),
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

  it('still deletes an ordinary connector Secret whose name merely resembles it', async () => {
    const gateway = createGateway()

    await request(makeApp(gateway))
      .delete(`/admin/mcp-secrets/${EVENFIRE_REGISTRY_PULL_SECRET_NAME}-backup`)
      .expect(200)

    expect(gateway.deleteSecret).toHaveBeenCalledWith(
      `${EVENFIRE_REGISTRY_PULL_SECRET_NAME}-backup`,
      'mcp-server'
    )
  })
})
