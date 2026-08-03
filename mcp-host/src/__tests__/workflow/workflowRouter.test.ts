/**
 * Tests for workflow/workflowRouter.ts JWT auth middleware
 * Step 4.4 (G-03)
 *
 * Uses real listening server + fetch (same pattern as authMiddleware.test.ts).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import crypto from 'crypto'
import * as fs from 'fs'
import type http from 'http'
import { SignJWT, importPKCS8 } from 'jose'
import type { AddressInfo } from 'net'
import * as os from 'os'
import * as path from 'path'

// ─── RSA keypair for test tokens ─────────────────────────────────────────────

let publicKeyPem: string
let privateKeyPem: string

beforeAll(() => {
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  publicKeyPem = pair.publicKey
  privateKeyPem = pair.privateKey
})

// ─── Token helpers ────────────────────────────────────────────────────────────

async function signWorkflowToken(
  claims: Record<string, unknown>,
  opts?: {
    privateKey?: string
    issuer?: string
    audience?: string
    expiresIn?: string | false
  }
): Promise<string> {
  const key = await importPKCS8(opts?.privateKey ?? privateKeyPem, 'RS256')
  const builder = new SignJWT({
    sub: 'coordinator',
    recipeName: 'test-wf',
    recipeNamespace: 'sandbox-recipes',
    scopes: ['execute', 'configure', 'mode_read'],
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(opts?.issuer ?? 'clerum-wrc')
    .setAudience(opts?.audience ?? 'mcp-host')

  if (opts?.expiresIn !== false) {
    builder.setExpirationTime(opts?.expiresIn ?? '5m')
  }
  return builder.sign(key)
}

// ─── App factory ──────────────────────────────────────────────────────────────

async function createTestApp(
  pubKey: string,
  enableAuth = true,
  serviceOverride?: {
    executeStep?: ReturnType<typeof vi.fn>
    configure?: ReturnType<typeof vi.fn>
    configurePluginWorkloadSdkBootstrap?: ReturnType<typeof vi.fn>
    getStatus?: ReturnType<typeof vi.fn>
  }
): Promise<{ baseUrl: string; server: http.Server }> {
  vi.resetModules()

  vi.doMock('../../config', () => ({
    config: {
      enableAuth,
      wrcPublicKey: pubKey,
    },
  }))

  const { createWorkflowRouter } = await import('../../workflow/workflowRouter')

  const service = {
    executeStep: vi.fn().mockResolvedValue({ stepId: 's1', status: 'completed' }),
    configure: vi.fn().mockReturnValue({ configured: true }),
    configurePluginWorkloadSdkBootstrap: vi.fn().mockResolvedValue({
      configured: true,
      ready: true,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      contractVersion: 2,
      policyRevision: 1,
      policyHash: 'a'.repeat(64),
      defaultTargetRef: 'primary-openai',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.4-mini',
    }),
    getStatus: vi.fn().mockReturnValue({ ready: true, configured: true }),
    ...serviceOverride,
  }

  const app = express()
  app.use(express.json())
  app.use('/api/v1/workflow', createWorkflowRouter(service as never))

  return new Promise(resolve => {
    // Bind to 127.0.0.1 explicitly, not the wildcard listen(0). macOS's
    // ephemeral allocator can hand a wildcard bind a port a daemon (Docker,
    // VS Code) already holds on 127.0.0.1, and the kernel routes loopback to
    // the more-specific bind — so this test's fetch would reach that foreign
    // process and see its response instead of ours. A specific bind cannot be
    // handed an occupied port, which removes the flake at its source.
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server })
    })
  })
}

// ─── Artifact test sandbox ────────────────────────────────────────────────────
//
// The GET and DELETE /artifacts handlers read from getOutputDir() (which is
// driven by CLERUM_OUTPUT_DIR) and from workflow env bindings. We allocate a
// temp dir per test and restore the original env afterwards.

const ORIGINAL_OUTPUT_DIR = process.env.CLERUM_OUTPUT_DIR
const ORIGINAL_RECIPE = process.env.CLERUM_WORKFLOW_RECIPE
const ORIGINAL_NAMESPACE = process.env.CLERUM_WORKFLOW_NAMESPACE

function setupArtifactSandbox(recipeName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-test-'))
  process.env.CLERUM_OUTPUT_DIR = dir
  process.env.CLERUM_WORKFLOW_RECIPE = recipeName
  process.env.CLERUM_WORKFLOW_NAMESPACE = 'sandbox-recipes'
  return dir
}

function teardownArtifactSandbox(dir: string): void {
  if (ORIGINAL_OUTPUT_DIR === undefined) delete process.env.CLERUM_OUTPUT_DIR
  else process.env.CLERUM_OUTPUT_DIR = ORIGINAL_OUTPUT_DIR
  if (ORIGINAL_RECIPE === undefined) delete process.env.CLERUM_WORKFLOW_RECIPE
  else process.env.CLERUM_WORKFLOW_RECIPE = ORIGINAL_RECIPE
  if (ORIGINAL_NAMESPACE === undefined) delete process.env.CLERUM_WORKFLOW_NAMESPACE
  else process.env.CLERUM_WORKFLOW_NAMESPACE = ORIGINAL_NAMESPACE
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

function setupWorkflowEnv(recipeName = 'test-wf'): void {
  process.env.CLERUM_WORKFLOW_RECIPE = recipeName
  process.env.CLERUM_WORKFLOW_NAMESPACE = 'sandbox-recipes'
}

function restoreWorkflowEnv(): void {
  if (ORIGINAL_RECIPE === undefined) delete process.env.CLERUM_WORKFLOW_RECIPE
  else process.env.CLERUM_WORKFLOW_RECIPE = ORIGINAL_RECIPE
  if (ORIGINAL_NAMESPACE === undefined) delete process.env.CLERUM_WORKFLOW_NAMESPACE
  else process.env.CLERUM_WORKFLOW_NAMESPACE = ORIGINAL_NAMESPACE
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('workflowRouter — JWT auth middleware', () => {
  beforeEach(() => {
    setupWorkflowEnv()
  })

  afterEach(() => {
    restoreWorkflowEnv()
  })

  it('POST /execute without Authorization header returns 401', async () => {
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect(res.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('POST /execute with expired token returns 401', async () => {
    const token = await signWorkflowToken({}, { expiresIn: '-10s' })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect(res.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('POST /execute with wrong issuer returns 401', async () => {
    const token = await signWorkflowToken({}, { issuer: 'bad-issuer' })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect(res.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('POST /execute with wrong audience returns 401', async () => {
    const token = await signWorkflowToken({}, { audience: 'wrong-aud' })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect(res.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('POST /execute with token missing execute scope returns 403', async () => {
    const token = await signWorkflowToken({ scopes: ['configure'] })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Missing scope/)
    } finally {
      server.close()
    }
  })

  it('POST /execute with valid token + execute scope passes to handler (200 or 400)', async () => {
    const token = await signWorkflowToken({ scopes: ['execute'] })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect([200, 400]).toContain(res.status)
    } finally {
      server.close()
    }
  })

  it('POST /execute rejects a WRC-subject token even when it has execute scope', async () => {
    const token = await signWorkflowToken({ sub: 'wrc', scopes: ['execute'] })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Endpoint requires sub: coordinator/)
    } finally {
      server.close()
    }
  })

  it('POST /execute rejects tokens bound to a different recipe', async () => {
    const token = await signWorkflowToken({ recipeName: 'other-recipe', scopes: ['execute'] })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/recipeName mismatch/)
    } finally {
      server.close()
    }
  })

  it('POST /execute streams progress and final result over SSE', async () => {
    const token = await signWorkflowToken({ scopes: ['execute'] })
    const executeStep = vi.fn().mockImplementation(async (_body, onProgress) => {
      onProgress?.({ iteration: 1, toolCall: 'web-search__search' })
      return { stepId: 's1', status: 'completed', output: 'ok', durationMs: 10 }
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem, true, { executeStep })
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const body = await res.text()
      expect(body).toContain('event: progress')
      expect(body).toContain('web-search__search')
      expect(body).toContain('event: result')
      expect(body).toContain('"status":"completed"')
      expect(executeStep.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal)
    } finally {
      server.close()
    }
  })

  it('POST /configure with missing configure scope returns 403', async () => {
    const token = await signWorkflowToken({ scopes: ['execute'] })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    } finally {
      server.close()
    }
  })

  it('POST /configure with valid configure scope returns 200', async () => {
    const token = await signWorkflowToken({ sub: 'wrc', scopes: ['configure'] })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      })
      expect([200, 400]).toContain(res.status)
    } finally {
      server.close()
    }
  })

  it('POST /configure rejects a coordinator-subject token even when it has configure scope', async () => {
    const token = await signWorkflowToken({ sub: 'coordinator', scopes: ['configure'] })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Endpoint requires sub: wrc/)
    } finally {
      server.close()
    }
  })

  it('POST /plugin-workload-sdk/bootstrap accepts only public identity and forwards no credential', async () => {
    const token = await signWorkflowToken({ sub: 'wrc', scopes: ['configure'] })
    const bootstrap = vi.fn().mockResolvedValue({
      configured: true,
      ready: true,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      contractVersion: 2,
      policyRevision: 1,
      policyHash: 'a'.repeat(64),
      defaultTargetRef: 'primary-openai',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.4-mini',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem, true, {
      configurePluginWorkloadSdkBootstrap: bootstrap,
    })
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/plugin-workload-sdk/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.4-mini',
          apiKey: 'must-not-pass',
        }),
      })
      expect(res.status).toBe(200)
      expect(bootstrap).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.4-mini' })
    } finally {
      server.close()
    }
  })

  it('rate-limits repeated SDK bootstrap calls per verified recipe', async () => {
    const recipeName = 'rate-limit-wf'
    const previousRecipe = process.env.CLERUM_WORKFLOW_RECIPE
    process.env.CLERUM_WORKFLOW_RECIPE = recipeName
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName,
      scopes: ['configure'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem, true)
    try {
      const request = () =>
        fetch(`${baseUrl}/api/v1/workflow/plugin-workload-sdk/bootstrap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }),
        })
      for (let index = 0; index < 60; index += 1) {
        expect((await request()).status).toBe(200)
      }
      const limited = await request()
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBeTruthy()
    } finally {
      server.close()
      if (previousRecipe === undefined) delete process.env.CLERUM_WORKFLOW_RECIPE
      else process.env.CLERUM_WORKFLOW_RECIPE = previousRecipe
    }
  })

  it('GET /mode with missing mode_read scope returns 403', async () => {
    const token = await signWorkflowToken({ scopes: ['execute'] })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/mode`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
    } finally {
      server.close()
    }
  })

  it('GET /mode with valid token + mode_read scope returns 200', async () => {
    const token = await signWorkflowToken({ scopes: ['mode_read'] })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/mode`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
    } finally {
      server.close()
    }
  })

  it('GET /mode rejects tokens bound to a different namespace', async () => {
    const token = await signWorkflowToken({
      recipeNamespace: 'mcp-server',
      scopes: ['mode_read'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/mode`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/recipeNamespace mismatch/)
    } finally {
      server.close()
    }
  })

  it('GET /mode fails closed when the workflow recipe env is missing', async () => {
    delete process.env.CLERUM_WORKFLOW_RECIPE
    const token = await signWorkflowToken({ scopes: ['mode_read'], recipeName: '' })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/mode`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Workflow recipe not configured/)
    } finally {
      server.close()
    }
  })

  it('empty WRC public key causes 401 on all authenticated endpoints', async () => {
    const token = await signWorkflowToken({ scopes: ['execute'] })
    const { baseUrl, server } = await createTestApp('')
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stepId: 's1', instruction: 'do it' }),
      })
      expect(res.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('auth disabled — requests pass through without token', async () => {
    const { baseUrl, server } = await createTestApp(publicKeyPem, false)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/mode`)
      expect(res.status).not.toBe(401)
    } finally {
      server.close()
    }
  })
})

describe('workflowRouter — GET /artifacts/:filename', () => {
  let sandboxDir = ''

  afterEach(() => {
    if (sandboxDir) {
      teardownArtifactSandbox(sandboxDir)
      sandboxDir = ''
    }
  })

  it('returns 401 without Authorization header', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`)
      expect(res.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('returns 403 when token lacks artifact_read scope', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      recipeName: 'recipe-a',
      scopes: ['execute'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Missing scope: artifact_read/)
    } finally {
      server.close()
    }
  })

  it("returns 403 when recipeName claim does not match pod's env", async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), '# hello')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-b', // different from pod's CLERUM_WORKFLOW_RECIPE
      scopes: ['artifact_read'],
      artifactName: 'report.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/recipeName mismatch/)
    } finally {
      server.close()
    }
  })

  it("returns 403 when recipeNamespace claim does not match pod's env", async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), '# hello')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      recipeNamespace: 'other-namespace',
      scopes: ['artifact_read'],
      artifactName: 'report.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/recipeNamespace mismatch/)
    } finally {
      server.close()
    }
  })

  it('returns 403 when artifact_read token is not WRC-issued for the hop', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), '# hello')
    const token = await signWorkflowToken({
      sub: 'coordinator',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
      artifactName: 'report.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Endpoint requires sub: wrc/)
    } finally {
      server.close()
    }
  })

  it('returns 403 when token artifactName binding does not match requested file', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), '# hello')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
      artifactName: 'other.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/artifactName mismatch/)
    } finally {
      server.close()
    }
  })

  it('returns 403 when artifact_read token has no artifactName binding', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), '# hello')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Missing artifactName binding/)
    } finally {
      server.close()
    }
  })

  it('returns 404 when recipeName matches but file does not exist', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
      artifactName: 'missing.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/missing.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(404)
    } finally {
      server.close()
    }
  })

  it('returns 403 when the artifact path is a symlink', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const outsideFile = path.join(os.tmpdir(), `clerum-outside-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(outsideFile, 'secret outside output')
    fs.symlinkSync(outsideFile, path.join(sandboxDir, 'leak.md'))
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
      artifactName: 'leak.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/leak.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/symlink/i)
    } finally {
      fs.rmSync(outsideFile, { force: true })
      server.close()
    }
  })

  it('returns 404 when the artifact path is a directory', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.mkdirSync(path.join(sandboxDir, 'nested.md'))
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
      artifactName: 'nested.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/nested.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(404)
    } finally {
      server.close()
    }
  })

  it('returns 400 on path traversal attempts', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
      artifactName: '..evil',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(
        `${baseUrl}/api/v1/workflow/artifacts/${encodeURIComponent('..evil')}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      )
      expect(res.status).toBe(400)
    } finally {
      server.close()
    }
  })

  it('streams the file and emits a structured audit log on success', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const filePath = path.join(sandboxDir, 'report.md')
    const content = '# hello audit\n'
    fs.writeFileSync(filePath, content)

    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
      artifactName: 'report.md',
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-correlation-id': 'corr-123',
        },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/markdown/)
      expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="report.md"/)
      const body = await res.text()
      expect(body).toBe(content)

      const auditLine = logSpy.mock.calls
        .map(c => String(c[0]))
        .find(line => line.includes('"event":"artifact_download"'))
      expect(auditLine).toBeDefined()
      const parsed = JSON.parse(auditLine!)
      expect(parsed).toMatchObject({
        event: 'artifact_download',
        correlationId: 'corr-123',
        sub: 'wrc',
        recipeName: 'recipe-a',
        filename: 'report.md',
        contentType: 'text/markdown',
      })
      expect(parsed.sizeBytes).toBe(content.length)
    } finally {
      logSpy.mockRestore()
      server.close()
    }
  })
})

describe('workflowRouter — DELETE /artifacts', () => {
  let sandboxDir = ''

  afterEach(() => {
    if (sandboxDir) {
      teardownArtifactSandbox(sandboxDir)
      sandboxDir = ''
    }
  })

  it('returns 401 without Authorization header', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, { method: 'DELETE' })
      expect(res.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('returns 403 when token carries only artifact_read scope (no artifact_delete)', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Missing scope: artifact_delete/)
    } finally {
      server.close()
    }
  })

  it('returns 403 when sub is coordinator (only WRC may delete)', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'coordinator',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Endpoint requires sub: wrc/)
    } finally {
      server.close()
    }
  })

  it("returns 403 when recipeName claim does not match pod's env", async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-b', // wrong recipe
      scopes: ['artifact_delete'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/recipeName mismatch/)
    } finally {
      server.close()
    }
  })

  it("returns 403 when recipeNamespace claim does not match pod's env", async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      recipeNamespace: 'other-namespace',
      scopes: ['artifact_delete'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/recipeNamespace mismatch/)
    } finally {
      server.close()
    }
  })

  it('clears the output directory and emits audit log on success (204)', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    // Pre-seed two files and a nested dir
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), 'x'.repeat(50))
    fs.writeFileSync(path.join(sandboxDir, 'data.xlsx'), Buffer.alloc(200))
    fs.mkdirSync(path.join(sandboxDir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(sandboxDir, 'sub', 'nested.txt'), 'nested')

    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-correlation-id': 'corr-delete-1',
        },
      })
      expect(res.status).toBe(204)

      // Directory was re-created but empty
      expect(fs.existsSync(sandboxDir)).toBe(true)
      expect(fs.readdirSync(sandboxDir)).toHaveLength(0)

      const auditLine = logSpy.mock.calls
        .map(c => String(c[0]))
        .find(line => line.includes('"event":"artifact_cleanup"'))
      expect(auditLine).toBeDefined()
      const parsed = JSON.parse(auditLine!)
      expect(parsed).toMatchObject({
        event: 'artifact_cleanup',
        correlationId: 'corr-delete-1',
        sub: 'wrc',
        recipeName: 'recipe-a',
      })
    } finally {
      logSpy.mockRestore()
      server.close()
    }
  })

  it('removes symlink artifacts without deleting their external target during bulk cleanup', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const outsideFile = path.join(os.tmpdir(), `clerum-outside-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), 'ok')
    fs.writeFileSync(outsideFile, 'secret outside output')
    fs.symlinkSync(outsideFile, path.join(sandboxDir, 'leak.md'))
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(204)
      expect(fs.existsSync(outsideFile)).toBe(true)
      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('secret outside output')
      expect(fs.readdirSync(sandboxDir)).toHaveLength(0)
    } finally {
      fs.rmSync(outsideFile, { force: true })
      server.close()
    }
  })

  it('returns 403 when sub is admin:xxx (only WRC may delete, admin scoped via control-api delegation)', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'admin:admin-alice',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Endpoint requires sub: wrc/)
    } finally {
      server.close()
    }
  })

  it('emits artifact_cleanup_failed log and returns 500 when mkdirSync fails', async () => {
    // Point CLERUM_OUTPUT_DIR at a path whose parent segment is a regular
    // FILE, not a directory. fs.rmSync(..., {force: true}) is a no-op on a
    // non-existent descendant, but the follow-up fs.mkdirSync() will throw
    // ENOTDIR because the parent is a file. This exercises the error
    // branch of the DELETE handler without mocking fs (which is hostile
    // in ESM mode — vitest can't spy on native module namespaces).
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-bad-parent-'))
    const fileBlocker = path.join(parentDir, 'not-a-dir')
    fs.writeFileSync(fileBlocker, '')
    const badOutputDir = path.join(fileBlocker, 'output')
    sandboxDir = parentDir // teardown cleans the whole parent
    process.env.CLERUM_OUTPUT_DIR = badOutputDir
    process.env.CLERUM_WORKFLOW_RECIPE = 'recipe-a'
    process.env.CLERUM_WORKFLOW_NAMESPACE = 'sandbox-recipes'

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
    })

    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Cleanup failed/)

      const auditLine = errSpy.mock.calls
        .map(c => String(c[0]))
        .find(line => line.includes('"event":"artifact_cleanup_failed"'))
      expect(auditLine).toBeDefined()
      const parsed = JSON.parse(auditLine!)
      expect(parsed).toMatchObject({
        event: 'artifact_cleanup_failed',
        recipeName: 'recipe-a',
      })
      // ENOTDIR or similar — just assert there is a non-empty error string
      expect(typeof parsed.error).toBe('string')
      expect(parsed.error.length).toBeGreaterThan(0)
    } finally {
      errSpy.mockRestore()
      server.close()
    }
  })
})

describe('workflowRouter — DELETE /artifacts/:filename', () => {
  let sandboxDir = ''

  afterEach(() => {
    if (sandboxDir) {
      teardownArtifactSandbox(sandboxDir)
      sandboxDir = ''
    }
  })

  it('returns 401 without Authorization header', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        method: 'DELETE',
      })
      expect(res.status).toBe(401)
    } finally {
      server.close()
    }
  })

  it('returns 403 without artifact_delete scope', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_read'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Missing scope: artifact_delete/)
    } finally {
      server.close()
    }
  })

  it('returns 403 when sub is not wrc (e.g., sub=coordinator)', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'coordinator',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
      artifactName: 'report.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Endpoint requires sub: wrc/)
    } finally {
      server.close()
    }
  })

  it('returns 403 on recipeName mismatch', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), '# hello')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-b',
      scopes: ['artifact_delete'],
      artifactName: 'report.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/recipeName mismatch/)
    } finally {
      server.close()
    }
  })

  it('returns 403 on recipeNamespace mismatch', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), '# hello')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      recipeNamespace: 'other-namespace',
      scopes: ['artifact_delete'],
      artifactName: 'report.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/recipeNamespace mismatch/)
    } finally {
      server.close()
    }
  })

  it('returns 400 on path traversal (../, null bytes)', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
      artifactName: '..evil',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(
        `${baseUrl}/api/v1/workflow/artifacts/${encodeURIComponent('..evil')}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      )
      expect(res.status).toBe(400)
    } finally {
      server.close()
    }
  })

  it('returns 403 when deleting an artifact path that is a symlink', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const outsideFile = path.join(os.tmpdir(), `clerum-outside-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(outsideFile, 'secret outside output')
    fs.symlinkSync(outsideFile, path.join(sandboxDir, 'leak.md'))
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
      artifactName: 'leak.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/leak.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      expect(fs.existsSync(outsideFile)).toBe(true)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/symlink/i)
    } finally {
      fs.rmSync(outsideFile, { force: true })
      server.close()
    }
  })

  it('returns 404 when deleting an artifact path that is a directory', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const dirPath = path.join(sandboxDir, 'nested.md')
    fs.mkdirSync(dirPath)
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
      artifactName: 'nested.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/nested.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(404)
      expect(fs.existsSync(dirPath)).toBe(true)
    } finally {
      server.close()
    }
  })

  it('returns 403 when artifact_delete token has no artifactName binding', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), '# hello')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Missing artifactName binding/)
    } finally {
      server.close()
    }
  })

  it('returns 403 when artifact_delete token is bound to a different file', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'report.md'), '# hello')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
      artifactName: 'other.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/artifactName mismatch/)
    } finally {
      server.close()
    }
  })

  it('returns 404 when file does not exist', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
      artifactName: 'nonexistent.md',
    })
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/nonexistent.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(404)
    } finally {
      server.close()
    }
  })

  it('returns 204 on successful delete and verifies file is removed', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    const filePath = path.join(sandboxDir, 'report.md')
    fs.writeFileSync(filePath, '# hello delete')

    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
      artifactName: 'report.md',
    })

    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/report.md`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(204)

      // Verify file was actually removed
      expect(fs.existsSync(filePath)).toBe(false)
    } finally {
      server.close()
    }
  })

  it('emits artifact_file_deleted audit log on successful delete', async () => {
    sandboxDir = setupArtifactSandbox('recipe-a')
    fs.writeFileSync(path.join(sandboxDir, 'audit-test.md'), '# audit')

    const token = await signWorkflowToken({
      sub: 'wrc',
      recipeName: 'recipe-a',
      scopes: ['artifact_delete'],
      artifactName: 'audit-test.md',
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { baseUrl, server } = await createTestApp(publicKeyPem)
    try {
      const res = await fetch(`${baseUrl}/api/v1/workflow/artifacts/audit-test.md`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-correlation-id': 'corr-del-file-1',
        },
      })
      expect(res.status).toBe(204)

      const auditLine = logSpy.mock.calls
        .map(c => String(c[0]))
        .find(line => line.includes('"event":"artifact_file_deleted"'))
      expect(auditLine).toBeDefined()
      const parsed = JSON.parse(auditLine!)
      expect(parsed).toMatchObject({
        event: 'artifact_file_deleted',
        correlationId: 'corr-del-file-1',
        sub: 'wrc',
        recipeName: 'recipe-a',
        filename: 'audit-test.md',
      })
    } finally {
      logSpy.mockRestore()
      server.close()
    }
  })
})
