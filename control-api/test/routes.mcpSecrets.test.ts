import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminSecretsRouter } from '../src/routes/admin/secrets.js'

/**
 * Minimal mock gateway with methods used by the POST /admin/mcp-secrets handler.
 */
function createGateway() {
  return {
    listSecrets: vi.fn(async () => []),
    createSecret: vi.fn(async (body: unknown) => body),
    updateSecret: vi.fn(async (body: unknown) => body),
    deleteSecret: vi.fn(async (_name: string, _namespace?: string) => ({ deleted: true })),
  }
}

function makeApp(gateway: ReturnType<typeof createGateway>) {
  const app = express()
  app.use(express.json())
  app.use(createAdminSecretsRouter(gateway as never))
  // Error handler so gateway errors return 500 instead of crashing
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

describe('POST /admin/mcp-secrets', () => {
  // ── Happy path ──────────────────────────────────────────────────────────

  it('creates a secret with valid name and data', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 'my-db-creds', data: { DB_PASSWORD: 's3cret' } })
      .expect(201)

    expect(res.body.name).toBe('my-db-creds')
    expect(res.body.namespace).toBe('mcp-server') // default mcpServersNamespace
    expect(gateway.createSecret).toHaveBeenCalledOnce()

    // Verify the shape passed to gateway.createSecret
    const arg = gateway.createSecret.mock.calls[0][0] as {
      name: string
      namespace: string
      type: string
      stringData: Record<string, string>
    }
    expect(arg.name).toBe('my-db-creds')
    expect(arg.namespace).toBe('mcp-server')
    expect(arg.type).toBe('Opaque')
    expect(arg.stringData).toEqual({ DB_PASSWORD: 's3cret' })
  })

  it('trims whitespace from name', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: '  trimmed-name  ', data: { KEY: 'val' } })
      .expect(201)

    expect(res.body.name).toBe('trimmed-name')
  })

  // ── Namespace audit: caller namespace is silently ignored ────────────────

  it('silently ignores namespace field in body and uses config namespace', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Namespace in body is silently ignored — request succeeds (201, not 400)
    const res = await request(app)
      .post('/admin/mcp-secrets')
      .send({
        name: 'evil-secret',
        namespace: 'control-plane',
        data: { TOKEN: 'abc' },
      })
      .expect(201)

    // The secret is created in the config namespace, NOT the caller-specified one
    expect(res.body.namespace).toBe('mcp-server')
    expect(gateway.createSecret).toHaveBeenCalledOnce()

    // The actual secret passed to gateway uses config namespace
    const arg = gateway.createSecret.mock.calls[0][0] as {
      name: string
      namespace: string
    }
    expect(arg.namespace).toBe('mcp-server')

    // Security audit was logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"alert":"SECURITY"'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"vector":"body-field"'))

    warnSpy.mockRestore()
  })

  it('creates a secret with multiple key-value pairs', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .post('/admin/mcp-secrets')
      .send({
        name: 'multi-key',
        data: { USER: 'admin', PASS: 'pw', HOST: 'db.local' },
      })
      .expect(201)

    const arg = gateway.createSecret.mock.calls[0][0] as {
      stringData: Record<string, string>
    }
    expect(Object.keys(arg.stringData)).toHaveLength(3)
  })

  // ── Validation: name ────────────────────────────────────────────────────

  it('rejects missing name', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .post('/admin/mcp-secrets')
      .send({ data: { KEY: 'val' } })
      .expect(400)

    expect(res.body.error).toMatch(/name is required/i)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('rejects empty string name', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: '', data: { KEY: 'val' } })
      .expect(400)
  })

  it('rejects whitespace-only name', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: '   ', data: { KEY: 'val' } })
      .expect(400)
  })

  it('rejects invalid K8s names (uppercase)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 'MySecret', data: { KEY: 'val' } })
      .expect(400)

    expect(res.body.error).toMatch(/invalid secret name/i)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('rejects invalid K8s names (underscores)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 'my_secret', data: { KEY: 'val' } })
      .expect(400)
  })

  it('rejects names starting with a hyphen', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: '-starts-bad', data: { KEY: 'val' } })
      .expect(400)
  })

  it('rejects names ending with a hyphen', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 'ends-bad-', data: { KEY: 'val' } })
      .expect(400)
  })

  it('rejects names longer than 253 characters', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const longName = 'a'.repeat(254)
    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: longName, data: { KEY: 'val' } })
      .expect(400)
  })

  it('accepts names exactly 253 characters long', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const maxName = 'a'.repeat(253)
    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: maxName, data: { KEY: 'val' } })
      .expect(201)
  })

  it('rejects non-string name (numeric)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 12345, data: { KEY: 'val' } })
      .expect(400)
  })

  // ── Validation: data ────────────────────────────────────────────────────

  it('rejects empty data object', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 'my-secret', data: {} })
      .expect(400)

    expect(res.body.error).toMatch(/data is required/i)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('rejects missing data field', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app).post('/admin/mcp-secrets').send({ name: 'my-secret' }).expect(400)
  })

  it('rejects data with non-string values', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 'my-secret', data: { KEY: 123 } })
      .expect(400)

    expect(res.body.error).toMatch(/must be a string/i)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('rejects data with boolean values', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 'my-secret', data: { FLAG: true } })
      .expect(400)
  })

  it('rejects null data', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 'my-secret', data: null })
      .expect(400)
  })

  // ── Error propagation ─────────────────────────────────────────────────

  it('returns 500 when gateway.createSecret throws', async () => {
    const gateway = createGateway()
    gateway.createSecret.mockRejectedValueOnce(new Error('K8s API timeout'))
    const app = makeApp(gateway)

    const res = await request(app)
      .post('/admin/mcp-secrets')
      .send({ name: 'fail-secret', data: { K: 'v' } })
      .expect(500)

    expect(res.body.error).toContain('K8s API timeout')
  })
})

describe('DELETE /admin/mcp-secrets/:name', () => {
  it('deletes a secret in the mcp-server namespace (200)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app).delete('/admin/mcp-secrets/my-db-creds').expect(200)

    expect(res.body).toEqual({ deleted: true })
    expect(gateway.deleteSecret).toHaveBeenCalledOnce()
    expect(gateway.deleteSecret).toHaveBeenCalledWith('my-db-creds', 'mcp-server')
  })

  it('always targets config.mcpServersNamespace (ignores any caller intent)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app).delete('/admin/mcp-secrets/orphan-secret').expect(200)

    const [, ns] = gateway.deleteSecret.mock.calls[0]
    expect(ns).toBe('mcp-server')
  })

  it('returns 500 when gateway.deleteSecret throws', async () => {
    const gateway = createGateway()
    gateway.deleteSecret.mockRejectedValueOnce(new Error('K8s API timeout'))
    const app = makeApp(gateway)

    const res = await request(app).delete('/admin/mcp-secrets/any-name').expect(500)

    expect(res.body.error).toContain('K8s API timeout')
  })
})
