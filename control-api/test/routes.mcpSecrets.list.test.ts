import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminSecretsRouter } from '../src/routes/admin/secrets.js'
import { SecretService } from '../src/services/secretService.js'

// Derive the gateway.listSecrets fixture from the REAL producer
// (SecretService.listSecrets), fed underlying Secrets that DO carry base64
// values. The producer projects to metadata + key NAMES only, so this proves
// the GET route forwards exactly what the producer emits — never values. A
// hand-built row (e.g. one with a stray `data` field the producer never emits)
// would test an impossible leak path instead of the real one.
async function listSecretsOutput(
  secrets: Array<{ name: string; data: Record<string, string> }>
): Promise<unknown[]> {
  const fakeCoreApi = {
    listNamespacedSecret: async ({ namespace }: { namespace: string }) => ({
      items: secrets.map(s => ({
        metadata: { name: s.name, namespace, labels: {}, annotations: {} },
        type: 'Opaque',
        data: s.data,
      })),
    }),
  }
  const service = new SecretService(fakeCoreApi as never, 'mcp-server')
  return service.listSecrets('mcp-server')
}

function makeApp(rows: unknown[]) {
  const gateway = {
    listSecrets: vi.fn(async () => rows),
  }
  const app = express()
  app.use(express.json())
  app.use(createAdminSecretsRouter(gateway as never))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return { app, gateway }
}

describe('GET /admin/mcp-secrets (E-16.1)', () => {
  it('forwards names + keys from the real listSecrets producer', async () => {
    const rows = await listSecretsOutput([
      // base64 of 'idval' / 'secval' — real stored values the producer must strip.
      { name: 'gmail-oauth-client', data: { client_id: 'aWR2YWw=', client_secret: 'c2VjdmFs' } },
      { name: 'other-creds', data: { API_KEY: 'a2V5' } },
    ])
    const { app, gateway } = makeApp(rows)
    const res = await request(app).get('/admin/mcp-secrets').expect(200)
    expect(gateway.listSecrets).toHaveBeenCalledWith('mcp-server')
    expect(res.body.items).toEqual([
      { name: 'gmail-oauth-client', keys: ['client_id', 'client_secret'] },
      { name: 'other-creds', keys: ['API_KEY'] },
    ])
  })

  it('never surfaces Secret values (producer strips them, route forwards names-only)', async () => {
    const rows = await listSecretsOutput([
      { name: 'gmail-oauth-client', data: { client_id: 'aWR2YWw=', client_secret: 'c2VjdmFs' } },
    ])
    const { app } = makeApp(rows)
    const res = await request(app).get('/admin/mcp-secrets').expect(200)
    const raw = JSON.stringify(res.body)
    // Neither the base64 nor the projected item carries any value.
    expect(raw).not.toContain('c2VjdmFs')
    expect(raw).not.toContain('aWR2YWw=')
    expect(res.body.items[0]).not.toHaveProperty('data')
    expect(res.body.items[0]).not.toHaveProperty('stringData')
  })
})
