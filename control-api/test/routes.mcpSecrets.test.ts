import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { rootLogger } from '../src/observability/logger.js'
import { createAdminSecretsRouter } from '../src/routes/admin/secrets.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import { CONTROL_UI_ADMIN_SESSION_COOKIE } from '../src/utils/auth/sessionCookies.js'
import { MockGateway } from './mockGateway.js'

const TEST_ADMIN_SESSION_JTI = 'test-admin-session-jti'

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn(async (_key: string, maxPerMinute: number) => ({
    allowed: true,
    remaining: maxPerMinute - 1,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
    backendAvailable: true,
  })),
}))

/** The write shape the admin routes hand to the gateway. */
type SecretWrite = {
  name: string
  namespace?: string
  type?: string
  stringData?: Record<string, string>
  data?: Record<string, string>
}

function writeSummary(body: SecretWrite) {
  return {
    name: body.name,
    namespace: body.namespace || 'mcp-server',
    keys: [
      ...new Set([...Object.keys(body.data ?? {}), ...Object.keys(body.stringData ?? {})]),
    ].sort((a, b) => a.localeCompare(b)),
  }
}

/**
 * Minimal mock gateway with methods used by the POST /admin/mcp-secrets handler.
 */
function createGateway() {
  return {
    listSecrets: vi.fn(async () => []),
    createSecret: vi.fn(async (body: SecretWrite) => ({
      ...writeSummary(body),
      uid: `uid-${body.name}`,
      resourceVersion: '1',
    })),
    updateSecret: vi.fn(async (body: SecretWrite) => writeSummary(body)),
    deleteSecret: vi.fn(async (name: string, namespace?: string) => ({
      name,
      namespace: namespace || 'mcp-server',
      deleted: true as const,
    })),
    getSecret: vi.fn(
      async (
        name: string,
        namespace?: string
      ): Promise<{
        metadata: {
          name: string
          namespace?: string
          labels: Record<string, string>
          annotations?: Record<string, string>
        }
        data: Record<string, string>
      }> => ({
        metadata: {
          name,
          namespace,
          uid: `uid-${name}`,
          resourceVersion: '1',
          labels: {},
        },
        // base64 of 'old-value' — the stored form of an existing key.
        data: { EXISTING_KEY: 'b2xkLXZhbHVl' },
      })
    ),
    // Mirrors the real client: patchNamespacedSecret answers with the WHOLE
    // Secret, values included. A handler that echoed this back would leak
    // every stored credential, so the leak assertions below are meaningful.
    mergeSecret: vi.fn(async (body: SecretWrite) => ({
      name: body.name,
      namespace: body.namespace || 'mcp-server',
      uid: `uid-${body.name}`,
      resourceVersion: '2',
      keys: ['EXISTING_KEY', ...Object.keys(body.stringData ?? {})].sort((a, b) =>
        a.localeCompare(b)
      ),
      data: Object.fromEntries(
        Object.entries(body.stringData ?? {}).map(([key, value]) => [
          key,
          Buffer.from(value, 'utf8').toString('base64'),
        ])
      ),
    })),
    listResource: vi.fn(async (_plural: string, _namespace?: string) => [] as unknown[]),
  }
}

/** A K8s client error carrying an HTTP status, as extractHttpStatus reads it. */
function k8sError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

function makeApp(gateway: ReturnType<typeof createGateway>) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { adminAuth?: { jti: string } }).adminAuth = {
      jti: TEST_ADMIN_SESSION_JTI,
    }
    next()
  })
  app.use(createAdminSecretsRouter(gateway as never))
  // Error handler so gateway errors return 500 instead of crashing
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

const TEST_CONTROL_UI_SESSION = 'test-control-ui-session'

function createAuthenticatedAgent(app: express.Express) {
  const agent = request.agent(app)
  agent.jar.setCookie(
    `${CONTROL_UI_ADMIN_SESSION_COOKIE}=${TEST_CONTROL_UI_SESSION}; Path=/; HttpOnly`,
    '127.0.0.1',
    '/'
  )
  return agent
}

function mcpDeleteProofCookieName(value: unknown): string {
  const cookies = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const proofCookie = cookies.find(cookie => cookie.startsWith('mcp_secret_delete_proof_'))
  if (!proofCookie) throw new Error('Expected MCP Secret delete proof cookie')
  return proofCookie.slice(0, proofCookie.indexOf('='))
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

    const res = await request(app)
      .delete('/admin/mcp-secrets/my-db-creds')
      .send({ uid: 'uid-my-db-creds', resourceVersion: '1' })
      .expect(200)

    expect(res.body).toEqual({
      name: 'my-db-creds',
      namespace: 'mcp-server',
      deleted: true,
    })
    expect(gateway.deleteSecret).toHaveBeenCalledOnce()
    expect(gateway.deleteSecret).toHaveBeenCalledWith('my-db-creds', 'mcp-server', {
      uid: 'uid-my-db-creds',
      resourceVersion: '1',
    })
  })

  it('always targets config.mcpServersNamespace (ignores any caller intent)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .delete('/admin/mcp-secrets/orphan-secret')
      .send({ uid: 'uid-orphan-secret', resourceVersion: '1' })
      .expect(200)

    const [, ns] = gateway.deleteSecret.mock.calls[0]
    expect(ns).toBe('mcp-server')
  })

  it('refuses to delete a Secret owned by a WorkflowRecipe', async () => {
    const gateway = createGateway()
    gateway.getSecret.mockResolvedValueOnce({
      metadata: {
        name: 'recipe-creds',
        namespace: 'mcp-server',
        labels: { 'clerum.io/recipe-secret': 'true' },
        uid: 'uid-recipe-creds',
        resourceVersion: '1',
      },
    })
    const app = makeApp(gateway)

    const res = await request(app)
      .delete('/admin/mcp-secrets/recipe-creds')
      .send({ uid: 'uid-recipe-creds', resourceVersion: '1' })
      .expect(409)

    expect(res.body.error).toContain('WorkflowRecipe')
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('binds deletion to the object observed by the ownership check', async () => {
    const gateway = createGateway()
    gateway.getSecret.mockResolvedValueOnce({
      metadata: {
        name: 'versioned-creds',
        namespace: 'mcp-server',
        labels: {},
        uid: 'secret-uid',
        resourceVersion: '17',
      },
    })
    const app = makeApp(gateway)

    await request(app)
      .delete('/admin/mcp-secrets/versioned-creds')
      .send({ uid: 'secret-uid', resourceVersion: '17' })
      .expect(200)

    expect(gateway.deleteSecret).toHaveBeenCalledWith('versioned-creds', 'mcp-server', {
      uid: 'secret-uid',
      resourceVersion: '17',
    })
  })

  it('returns 500 when gateway.deleteSecret throws', async () => {
    const gateway = createGateway()
    gateway.deleteSecret.mockRejectedValueOnce(new Error('K8s API timeout'))
    const app = makeApp(gateway)

    const res = await request(app)
      .delete('/admin/mcp-secrets/any-name')
      .send({ uid: 'uid-any-name', resourceVersion: '1' })
      .expect(500)

    expect(res.body.error).toContain('K8s API timeout')
  })
})

describe('PUT /admin/mcp-secrets/:name (credential rotation, issue #223)', () => {
  // ── Happy path + merge semantics ─────────────────────────────────────────

  it('merges the sent keys and preserves the ones it did not send', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ data: { LINEAR_API_KEY: 'rotated-value' } })
      .expect(200)

    // Only the rotated key travels to the API server; EXISTING_KEY is never
    // resent, and merge-patch leaves it in place server-side.
    expect(gateway.mergeSecret).toHaveBeenCalledOnce()
    const arg = gateway.mergeSecret.mock.calls[0][0] as {
      name: string
      namespace: string
      stringData: Record<string, string>
      type?: string
    }
    expect(arg.name).toBe('linear-credentials')
    expect(arg.namespace).toBe('mcp-server')
    expect(arg.stringData).toEqual({ LINEAR_API_KEY: 'rotated-value' })
    // Secret type is immutable and the Secret already exists: sending it would
    // only add a way to fail.
    expect(arg.type).toBeUndefined()

    // The response reports the resulting key names — the union of stored and
    // rotated — so the operator sees the Secret did not shrink.
    expect(res.body.keys).toEqual(['EXISTING_KEY', 'LINEAR_API_KEY'])
    expect(res.body.name).toBe('linear-credentials')
    expect(res.body.namespace).toBe('mcp-server')
    expect(res.body.uid).toBe('uid-linear-credentials')
    expect(res.body.resourceVersion).toBe('2')
  })

  it('does not grant public rotation a registry annotation capability', async () => {
    const gateway = createGateway()
    gateway.getSecret.mockResolvedValueOnce({
      metadata: {
        name: 'linear-credentials',
        namespace: 'mcp-server',
        uid: 'uid-linear-credentials',
        resourceVersion: '1',
        labels: { 'clerum.io/managed-by': 'control-api' },
        annotations: {
          'clerum.io/catalog-id': 'linear',
          'clerum.io/catalog-version': '1.0.0',
        },
      },
      data: { EXISTING_KEY: 'b2xkLXZhbHVl' },
    })
    const app = makeApp(gateway)

    await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ data: { LINEAR_API_KEY: 'rotated-value' } })
      .expect(200)

    expect(gateway.mergeSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'linear-credentials',
        namespace: 'mcp-server',
        stringData: { LINEAR_API_KEY: 'rotated-value' },
      }),
      undefined,
      {
        uid: 'uid-linear-credentials',
      }
    )
  })

  it('always targets config.mcpServersNamespace and ignores a namespace in the body', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ namespace: 'kube-system', data: { LINEAR_API_KEY: 'rotated-value' } })
      .expect(200)

    expect(res.body.namespace).toBe('mcp-server')
    const [, readNs] = gateway.getSecret.mock.calls[0]
    expect(readNs).toBe('mcp-server')
    const arg = gateway.mergeSecret.mock.calls[0][0] as { namespace: string }
    expect(arg.namespace).toBe('mcp-server')
  })

  // ── No secret value ever leaves the process ──────────────────────────────

  it('never returns secret values, in plaintext or base64', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ data: { LINEAR_API_KEY: 'rotated-value' } })
      .expect(200)

    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('rotated-value')
    expect(serialized).not.toContain(Buffer.from('rotated-value', 'utf8').toString('base64'))
    // The stored key the caller never sent must not leak either.
    expect(serialized).not.toContain('b2xkLXZhbHVl')
    expect(serialized).not.toContain('old-value')
    // Key NAMES are the contract; values are not.
    expect(res.body.keys).toContain('LINEAR_API_KEY')
  })

  // ── affectedConnectors ───────────────────────────────────────────────────

  it('names every connector that references the secret', async () => {
    const gateway = createGateway()
    gateway.listResource.mockResolvedValueOnce([
      { metadata: { name: 'linear' }, spec: { envSecret: { name: 'linear-credentials' } } },
      {
        metadata: { name: 'linear-readonly' },
        spec: { envSecret: { name: 'linear-credentials' } },
      },
      { metadata: { name: 'github' }, spec: { envSecret: { name: 'github-credentials' } } },
      { metadata: { name: 'filesystem' }, spec: {} },
    ])
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ data: { LINEAR_API_KEY: 'rotated-value' } })
      .expect(200)

    expect(res.body.affectedConnectors).toEqual(['linear', 'linear-readonly'])
    expect(gateway.listResource).toHaveBeenCalledWith('mcpservers', 'mcp-server')
  })

  it('reports an empty affectedConnectors when no connector references the secret', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/orphan-credentials')
      .send({ data: { SOME_KEY: 'rotated-value' } })
      .expect(200)

    // Legitimate answer, and the UI must say "nothing will restart" rather
    // than promise a rollout that will not happen.
    expect(res.body.affectedConnectors).toEqual([])
  })

  // ── Existence: rotation is not an upsert ─────────────────────────────────

  it('returns 404 when the secret does not exist', async () => {
    const gateway = createGateway()
    gateway.getSecret.mockRejectedValueOnce(k8sError(404, 'secrets "nope" not found'))
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/nope')
      .send({ data: { SOME_KEY: 'rotated-value' } })
      .expect(404)

    expect(res.body.error).toContain('not found')
    expect(gateway.mergeSecret).not.toHaveBeenCalled()
  })

  it('propagates a non-404 read failure instead of disguising it as 404', async () => {
    const gateway = createGateway()
    gateway.getSecret.mockRejectedValueOnce(k8sError(403, 'secrets is forbidden'))
    const app = makeApp(gateway)

    // A missing RBAC verb must not read as "no such credential".
    const res = await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ data: { LINEAR_API_KEY: 'rotated-value' } })
      .expect(500)

    expect(res.body.error).toContain('forbidden')
    expect(gateway.mergeSecret).not.toHaveBeenCalled()
  })

  // ── Ownership guard: mcp-server is a shared namespace ────────────────────

  it('refuses to rotate a WorkflowRecipe-owned secret (409)', async () => {
    const gateway = createGateway()
    gateway.getSecret.mockResolvedValueOnce({
      metadata: {
        name: 'recipe-creds',
        namespace: 'mcp-server',
        labels: { 'clerum.io/recipe-secret': 'true' },
      },
      data: {},
    })
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/recipe-creds')
      .send({ data: { SOME_KEY: 'rotated-value' } })
      .expect(409)

    expect(res.body.error).toContain('WorkflowRecipe')
    expect(gateway.mergeSecret).not.toHaveBeenCalled()
  })

  // ── Payload validation ───────────────────────────────────────────────────

  it('rejects an invalid K8s secret name', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/Invalid_Name')
      .send({ data: { SOME_KEY: 'rotated-value' } })
      .expect(400)

    expect(res.body.error).toContain('Invalid secret name')
    expect(gateway.getSecret).not.toHaveBeenCalled()
  })

  it('rejects a missing data field', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app).put('/admin/mcp-secrets/linear-credentials').send({}).expect(400)

    expect(res.body.error).toContain('data is required')
  })

  it('rejects an empty data object', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app).put('/admin/mcp-secrets/linear-credentials').send({ data: {} }).expect(400)

    expect(gateway.mergeSecret).not.toHaveBeenCalled()
  })

  it('rejects a non-string value', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ data: { LINEAR_API_KEY: 42 } })
      .expect(400)

    expect(res.body.error).toContain('must be a string')
  })

  it('rejects a blank value instead of silently skipping the key', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    // Blanking is an operator slip, not a delete instruction. Skipping it
    // would report a rotation that never happened.
    const res = await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ data: { LINEAR_API_KEY: '   ' } })
      .expect(400)

    expect(res.body.error).toContain('must not be empty')
    expect(gateway.mergeSecret).not.toHaveBeenCalled()
  })

  it('rejects an invalid Secret key name with a 400, not an opaque apiserver 500', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    // A key with a space (or any char outside [-._a-zA-Z0-9]) can never be a
    // valid Secret data key. Catching it here returns an actionable 400 rather
    // than letting the apiserver reject the merge as a 500 the operator can't act on.
    const res = await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ data: { 'bad key': 'value' } })
      .expect(400)

    expect(res.body.error).toContain('not a valid Secret key')
    expect(gateway.mergeSecret).not.toHaveBeenCalled()
  })

  it('rejects the reserved keys "." and ".." with a 400 (charset-valid but apiserver-rejected)', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    // "." and ".." pass the [-._a-zA-Z0-9]+ charset but Kubernetes rejects them
    // as Secret data keys — without the explicit exclusion they'd reach the
    // apiserver and come back as the opaque 500 this guard exists to prevent.
    for (const badKey of ['.', '..']) {
      const res = await request(app)
        .put('/admin/mcp-secrets/linear-credentials')
        .send({ data: { [badKey]: 'value' } })
        .expect(400)
      expect(res.body.error).toContain('not a valid Secret key')
    }
    expect(gateway.mergeSecret).not.toHaveBeenCalled()
  })

  // ── Gateway failure ──────────────────────────────────────────────────────

  it('still returns 200 when listing connectors fails AFTER a successful merge (M1)', async () => {
    const gateway = createGateway()
    // The rotation itself succeeds; only the secondary affectedConnectors
    // lookup fails. The operator must see the rotation as the success it is,
    // not a 500 that suggests the credential is unchanged.
    const sentinel = 'RP231_NESTED_ERROR_SENTINEL'
    gateway.listResource.mockRejectedValueOnce(
      Object.assign(new Error('mcpservers list forbidden'), {
        response: { body: { value: sentinel } },
      })
    )
    const warnSpy = vi.spyOn(rootLogger, 'warn').mockImplementation(() => {})
    const app = makeApp(gateway)

    try {
      const res = await request(app)
        .put('/admin/mcp-secrets/linear-credentials')
        .send({ data: { LINEAR_API_KEY: 'rotated-value' } })
        .expect(200)

      expect(gateway.mergeSecret).toHaveBeenCalledOnce()
      expect(res.body.name).toBe('linear-credentials')
      expect(res.body.affectedConnectors).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'mcp-secret-rotated-affected-connectors-unavailable',
          name: 'linear-credentials',
          namespace: 'mcp-server',
        }),
        'Affected connectors unavailable after MCP Secret rotation'
      )
      const [fields] = warnSpy.mock.calls[0]
      expect(fields).toEqual(
        expect.objectContaining({
          err: { name: 'Error', message: 'mcpservers list forbidden' },
        })
      )
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(sentinel)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('returns 500 when gateway.mergeSecret throws', async () => {
    const gateway = createGateway()
    gateway.mergeSecret.mockRejectedValueOnce(new Error('K8s API timeout'))
    const app = makeApp(gateway)

    const res = await request(app)
      .put('/admin/mcp-secrets/linear-credentials')
      .send({ data: { LINEAR_API_KEY: 'rotated-value' } })
      .expect(500)

    expect(res.body.error).toContain('K8s API timeout')
  })
})

describe('DELETE /admin/mcp-secrets/:name (identity and dependency guard)', () => {
  it('rate-limits delete attempts before reading or mutating a Secret', async () => {
    vi.mocked(checkAndIncrement).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 60_000,
      windowStartMs: Date.now(),
      count: 31,
      backendAvailable: true,
    })
    const gateway = createGateway()

    await request(makeApp(gateway))
      .delete('/admin/mcp-secrets/linear-credentials')
      .send({ uid: 'uid-linear-credentials', resourceVersion: '1' })
      .expect(429)

    expect(gateway.getSecret).not.toHaveBeenCalled()
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('requires both server-issued identity values when a client supplies either one', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    for (const body of [{ uid: 'uid-linear-credentials' }, { resourceVersion: '1' }]) {
      await request(app).delete('/admin/mcp-secrets/linear-credentials').send(body).expect(428)
    }

    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('supports an old UI POST plus bodyless DELETE with a signed create proof', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)
    const agent = createAuthenticatedAgent(app)

    const created = await agent
      .post('/admin/mcp-secrets')
      .send({ name: 'linear-credentials', data: { LINEAR_API_KEY: 'create-value' } })
      .expect(201)
    const proofCookieName = mcpDeleteProofCookieName(created.headers['set-cookie'])
    const warnSpy = vi.spyOn(rootLogger, 'warn').mockImplementation(() => {})

    try {
      const res = await agent.delete('/admin/mcp-secrets/linear-credentials').expect(200)

      expect(res.body).toEqual({
        name: 'linear-credentials',
        namespace: 'mcp-server',
        deleted: true,
      })
      expect(res.status).toBe(200)
      expect(gateway.getSecret).toHaveBeenCalledWith('linear-credentials', 'mcp-server')
      expect(gateway.deleteSecret).toHaveBeenCalledWith('linear-credentials', 'mcp-server', {
        uid: 'uid-linear-credentials',
        resourceVersion: '1',
      })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          module: 'admin-secrets',
          event: 'mcp-secret-delete-legacy-signed-create-proof',
          name: 'linear-credentials',
          namespace: 'mcp-server',
          preconditionSource: 'signed-create-proof',
        }),
        'MCP Secret delete used signed create proof'
      )
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(TEST_CONTROL_UI_SESSION)
      expect(res.headers['set-cookie']).toEqual(
        expect.arrayContaining([expect.stringMatching(new RegExp(`^${proofCookieName}=`))])
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('rejects a bodyless old UI DELETE with no signed create proof', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)
    const agent = createAuthenticatedAgent(app)

    await agent.delete('/admin/mcp-secrets/linear-credentials').expect(428)

    expect(gateway.getSecret).not.toHaveBeenCalled()
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('rejects a stale supplied identity before delete', async () => {
    const gateway = createGateway()
    gateway.getSecret.mockResolvedValueOnce({
      metadata: {
        name: 'linear-credentials',
        namespace: 'mcp-server',
        uid: 'uid-current',
        resourceVersion: '2',
        labels: {},
      },
      data: {},
    })
    const app = makeApp(gateway)

    const res = await request(app)
      .delete('/admin/mcp-secrets/linear-credentials')
      .send({ uid: 'uid-linear-credentials', resourceVersion: '1' })
      .expect(409)

    expect(res.body).toMatchObject({ error: 'secret_identity_changed', outcome: 'repair_required' })
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('legacy signed proof refuses to delete a Secret referenced by a live connector', async () => {
    const gateway = createGateway()
    gateway.listResource.mockResolvedValueOnce([
      {
        metadata: { name: 'linear', namespace: 'mcp-server' },
        spec: { envSecret: { name: 'linear-credentials' } },
      },
    ])
    const app = makeApp(gateway)
    const agent = createAuthenticatedAgent(app)

    await agent
      .post('/admin/mcp-secrets')
      .send({ name: 'linear-credentials', data: { LINEAR_API_KEY: 'create-value' } })
      .expect(201)
    const res = await agent.delete('/admin/mcp-secrets/linear-credentials').expect(409)

    expect(res.body).toMatchObject({ error: 'mcp_secret_in_use', outcome: 'repair_required' })
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('legacy signed proof refuses to delete a WorkflowRecipe-owned Secret', async () => {
    const gateway = createGateway()
    gateway.getSecret.mockResolvedValueOnce({
      metadata: {
        name: 'recipe-creds',
        namespace: 'mcp-server',
        uid: 'uid-recipe-creds',
        resourceVersion: '1',
        labels: { 'clerum.io/recipe-secret': 'true' },
      },
      data: {},
    })
    const app = makeApp(gateway)
    const agent = createAuthenticatedAgent(app)

    await agent
      .post('/admin/mcp-secrets')
      .send({ name: 'recipe-creds', data: { RECIPE_KEY: 'create-value' } })
      .expect(201)
    const res = await agent.delete('/admin/mcp-secrets/recipe-creds').expect(409)

    expect(res.body.error).toContain('WorkflowRecipe')
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('refuses to delete a Secret used as a live connector image pull Secret', async () => {
    const gateway = createGateway()
    gateway.listResource.mockResolvedValueOnce([
      {
        metadata: { name: 'linear', namespace: 'mcp-server' },
        spec: { imagePullSecrets: [{ name: 'linear-credentials' }] },
      },
    ])
    const app = makeApp(gateway)

    const res = await request(app)
      .delete('/admin/mcp-secrets/linear-credentials')
      .send({ uid: 'uid-linear-credentials', resourceVersion: '1' })
      .expect(409)

    expect(res.body).toMatchObject({ error: 'mcp_secret_in_use', outcome: 'repair_required' })
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('fails closed when the dependency graph cannot be read', async () => {
    const gateway = createGateway()
    gateway.listResource.mockRejectedValueOnce(new Error('connector list unavailable'))
    const app = makeApp(gateway)

    const res = await request(app)
      .delete('/admin/mcp-secrets/linear-credentials')
      .send({ uid: 'uid-linear-credentials', resourceVersion: '1' })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'mcp_secret_reference_check_unavailable',
      outcome: 'repair_required',
    })
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('deletes an unreferenced Secret with its identity precondition', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)

    await request(app)
      .delete('/admin/mcp-secrets/linear-credentials')
      .send({ uid: 'uid-linear-credentials', resourceVersion: '1' })
      .expect(200)

    expect(gateway.deleteSecret).toHaveBeenCalledWith('linear-credentials', 'mcp-server', {
      uid: 'uid-linear-credentials',
      resourceVersion: '1',
    })
  })

  it('rejects a malformed fallback body even when a signed proof exists', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)
    const agent = createAuthenticatedAgent(app)

    await agent
      .post('/admin/mcp-secrets')
      .send({ name: 'linear-credentials', data: { LINEAR_API_KEY: 'create-value' } })
      .expect(201)
    await agent
      .delete('/admin/mcp-secrets/linear-credentials')
      .send({ unexpected: true })
      .expect(428)

    expect(gateway.getSecret).not.toHaveBeenCalled()
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('rejects a tampered signed create proof', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)
    const agent = createAuthenticatedAgent(app)

    const created = await agent
      .post('/admin/mcp-secrets')
      .send({ name: 'linear-credentials', data: { LINEAR_API_KEY: 'create-value' } })
      .expect(201)
    const proofCookieName = mcpDeleteProofCookieName(created.headers['set-cookie'])
    agent.jar.setCookie(`${proofCookieName}=tampered; Path=/; HttpOnly`, '127.0.0.1', '/')

    await agent.delete('/admin/mcp-secrets/linear-credentials').expect(428)

    expect(gateway.getSecret).toHaveBeenCalledOnce()
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('rejects an expired signed create proof', async () => {
    const gateway = createGateway()
    const app = makeApp(gateway)
    const agent = createAuthenticatedAgent(app)

    await agent
      .post('/admin/mcp-secrets')
      .send({ name: 'linear-credentials', data: { LINEAR_API_KEY: 'create-value' } })
      .expect(201)
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000)
    try {
      await agent.delete('/admin/mcp-secrets/linear-credentials').expect(428)
    } finally {
      dateNowSpy.mockRestore()
    }

    expect(gateway.getSecret).not.toHaveBeenCalled()
    expect(gateway.deleteSecret).not.toHaveBeenCalled()
  })

  it('does not delete a replacement that wins before the legacy proof read', async () => {
    const gateway = new MockGateway('mcp-server')
    const name = 'linear-credentials'
    const app = makeApp(gateway as never)
    const agent = createAuthenticatedAgent(app)

    const created = await agent
      .post('/admin/mcp-secrets')
      .send({ name, data: { LINEAR_API_KEY: 'create-value' } })
      .expect(201)
    const originalIdentity = {
      uid: created.body.uid as string,
      resourceVersion: created.body.resourceVersion as string,
    }
    await gateway.deleteSecret(name, 'mcp-server', originalIdentity)
    gateway.seedSecret(name, 'mcp-server', {
      uid: 'uid-linear-replacement',
      resourceVersion: '1',
    })

    const res = await agent.delete(`/admin/mcp-secrets/${name}`).expect(409)

    expect(res.body).toMatchObject({ error: 'secret_identity_changed', outcome: 'repair_required' })
    await expect(gateway.getSecret(name, 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: 'uid-linear-replacement', resourceVersion: '1' },
    })
  })

  it('does not delete a replacement that wins after the legacy proof read', async () => {
    const gateway = new MockGateway('mcp-server')
    const name = 'linear-credentials'
    const app = makeApp(gateway as never)
    const agent = createAuthenticatedAgent(app)

    const created = await agent
      .post('/admin/mcp-secrets')
      .send({ name, data: { LINEAR_API_KEY: 'create-value' } })
      .expect(201)
    const originalIdentity = {
      uid: created.body.uid as string,
      resourceVersion: created.body.resourceVersion as string,
    }

    const deleteSpy = vi.spyOn(gateway, 'deleteSecret')
    const listResources = gateway.listResource.bind(gateway)
    let replacementCreated = false
    vi.spyOn(gateway, 'listResource').mockImplementation(async (...args) => {
      if (!replacementCreated && args[0] === 'mcpservers' && args[1] === 'mcp-server') {
        replacementCreated = true
        await gateway.deleteSecret(name, 'mcp-server', originalIdentity)
        gateway.seedSecret(name, 'mcp-server', {
          uid: 'uid-linear-replacement',
          resourceVersion: '1',
        })
      }
      return listResources(...args)
    })

    const res = await agent.delete(`/admin/mcp-secrets/${name}`).expect(409)

    expect(res.body).toMatchObject({ error: 'secret_identity_changed', outcome: 'repair_required' })
    expect(replacementCreated).toBe(true)
    expect(deleteSpy).toHaveBeenLastCalledWith(name, 'mcp-server', originalIdentity)
    await expect(gateway.getSecret(name, 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: 'uid-linear-replacement', resourceVersion: '1' },
    })
  })
})
