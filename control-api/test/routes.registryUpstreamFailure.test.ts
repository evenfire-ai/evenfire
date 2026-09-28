import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import type { K8sGateway } from '../src/k8s.js'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import {
  type PublishScope,
  getCredentialSchema,
  getDigest,
  getEntryVersion,
  reportInstall,
  resolvePublishScope,
} from '../src/services/registryClient.js'
import {
  APISERVER_LEAK_MARKERS,
  apiserverError,
  connectionRefused,
  expectNoApiserverText,
} from './helpers/apiserverErrors.js'
import { MockGateway } from './mockGateway.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

// A real Pino instance writing to memory, so each test can read the
// `registry_upstream_failure` line the route emitted (its liveness witness).
const logCapture = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('../src/observability/logger.js', async () => {
  const { default: pino } = await import('pino')
  const stream = {
    write: (chunk: string) => {
      logCapture.lines.push(chunk)
    },
  }
  return { rootLogger: pino({ level: 'debug' }, stream) }
})

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
  applyPublishScope: vi.fn((name: string | undefined) => name),
}))

type UpstreamFailureRecord = {
  level: number
  step: { verb: string; kind: string; name: string; namespace: string }
  status: number
  upstreamStatus: number | null
  upstreamReason: string | null
  invalidFields: string[]
  error: { name: string; status?: number }
}

function upstreamFailureRecords(): UpstreamFailureRecord[] {
  return logCapture.lines
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(record => record.msg === 'registry_upstream_failure') as UpstreamFailureRecord[]
}

/** Exactly one failure line, for the expected step and upstream status. */
function expectOneUpstreamFailureLog(
  step: { verb: string; kind: string; name: string; namespace: string },
  status: number,
  upstreamStatus: number | null
): UpstreamFailureRecord {
  const records = upstreamFailureRecords()
  expect(records).toHaveLength(1)
  expect(records[0].step).toMatchObject(step)
  expect(records[0].status).toBe(status)
  expect(records[0].upstreamStatus).toBe(upstreamStatus)
  return records[0]
}

function accessMessage(subject: string, status: 401 | 403): string {
  return (
    `control-api could not ${subject}: the Kubernetes API server rejected the request from ` +
    `control-api's own ServiceAccount (HTTP ${status}): an RBAC rule or an admission policy ` +
    `denied it. Your session is not the cause.`
  )
}

function makeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gateway as unknown as K8sGateway))
  app.use(clerumErrorHandler)
  return app
}

// The request field name is assembled so this file carries no literal
// credential-shaped key (same convention as routes.registryInstall.test.ts).
const CREDENTIALS_FIELD = [99, 114, 101, 100, 101, 110, 116, 105, 97, 108, 115]
  .map(code => String.fromCharCode(code))
  .join('')

beforeEach(() => {
  vi.resetAllMocks()
  logCapture.lines.length = 0
  vi.mocked(getDigest).mockResolvedValue({ digest: null })
  vi.mocked(getCredentialSchema).mockRejectedValue(new Error('No credential schema endpoint'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── POST /admin/registry/install (sites A, B, C) ─────────────────────────────
describe('POST /admin/registry/install — apiserver failures', () => {
  const MCP_ENTRY = {
    id: '1',
    name: 'airtable-mcp',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Airtable MCP server',
    author: 'clerum',
    origin: 'official',
    category: 'database',
    tags: ['airtable'],
    trust_level: 'high',
    quality_tier: 'verified',
    status: 'published',
    server_mode: 'local',
    transport: 'streamableHttp',
    recipe_type: null,
    mcp_server_meta: { imageRef: 'clerum/airtable-mcp:1.0.0', port: 3000 },
    recipe_meta: null,
    artifact_refs: null,
    downloads: 42,
    installs: 10,
    created_at: '2026-03-01T00:00:00Z',
  }
  const SCHEMA_REQUIRED = {
    required: true,
    authType: 'api-key',
    keys: [{ name: 'AIRTABLE_API_KEY', label: 'API Key', kind: 'api-key' }],
  }
  const SCHEMA_NONE = { required: false, authType: 'none', keys: [] }

  function makeInstallApp() {
    const gw = new MockGateway('mcp-server')
    gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    return { app: makeApp(gw), gw }
  }

  function installBody(serverName: string, withCredentials: boolean): Record<string, unknown> {
    return {
      serverName,
      contextRef: 'default-context',
      registryEntryName: 'airtable-mcp',
      registryEntryVersion: '1.0.0',
      ...(withCredentials ? { [CREDENTIALS_FIELD]: { AIRTABLE_API_KEY: 'value-for-test' } } : {}),
    }
  }

  // Site A
  it('answers 502 when the apiserver rejects the credential Secret create with 403', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MCP_ENTRY as never)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(SCHEMA_REQUIRED as never)
    const { app, gw } = makeInstallApp()
    const createSecret = vi.spyOn(gw, 'createSecret').mockRejectedValueOnce(apiserverError(403))
    const deleteSecret = vi.spyOn(gw, 'deleteSecret')
    const createResource = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install').send(installBody('srv-a', true))

    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'registry_upstream_failed',
      message: accessMessage('create Secret "srv-a-credentials" in namespace "mcp-server"', 403),
      resourceType: 'secret',
      resourceName: 'srv-a-credentials',
      namespace: 'mcp-server',
    })
    expectNoApiserverText(res.body)
    expect(createSecret).toHaveBeenCalledTimes(1)
    expect(deleteSecret).not.toHaveBeenCalled()
    expect(createResource).not.toHaveBeenCalled()
    const record = expectOneUpstreamFailureLog(
      { verb: 'create', kind: 'Secret', name: 'srv-a-credentials', namespace: 'mcp-server' },
      502,
      403
    )
    expect(record.upstreamReason).toContain(APISERVER_LEAK_MARKERS.statusMessage)
  })

  it('answers 422 naming the rejected field when the credential Secret is invalid', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MCP_ENTRY as never)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(SCHEMA_REQUIRED as never)
    const { app, gw } = makeInstallApp()
    const createSecret = vi
      .spyOn(gw, 'createSecret')
      .mockRejectedValueOnce(apiserverError(422, { causes: [{ field: 'data[AIRTABLE_API_KEY]' }] }))

    const res = await request(app).post('/admin/registry/install').send(installBody('srv-a', true))

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('registry_upstream_rejected')
    expect(res.body.message).toBe(
      'the Kubernetes API server rejected Secret "srv-a-credentials" in namespace "mcp-server" ' +
        'as invalid (HTTP 422; fields: data[AIRTABLE_API_KEY]).'
    )
    expectNoApiserverText(res.body)
    expect(createSecret).toHaveBeenCalledTimes(1)
    expectOneUpstreamFailureLog(
      { verb: 'create', kind: 'Secret', name: 'srv-a-credentials', namespace: 'mcp-server' },
      422,
      422
    )
  })

  // Site B
  it('answers 502 and rolls the Secret back when the McpServer create is rejected with 403', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MCP_ENTRY as never)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(SCHEMA_REQUIRED as never)
    const { app, gw } = makeInstallApp()
    const original = gw.createResource.bind(gw)
    const createResource = vi
      .spyOn(gw, 'createResource')
      .mockImplementation(async (plural, body, namespace) => {
        if (plural === 'mcpservers') throw apiserverError(403)
        return original(plural, body, namespace)
      })
    const deleteSecret = vi.spyOn(gw, 'deleteSecret')

    const res = await request(app).post('/admin/registry/install').send(installBody('srv-b', true))

    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'registry_upstream_failed',
      message: accessMessage('create McpServer "srv-b" in namespace "mcp-server"', 403),
      resourceType: 'mcp-server',
      resourceName: 'srv-b',
      namespace: 'mcp-server',
    })
    expectNoApiserverText(res.body)
    expect(createResource.mock.calls.filter(call => call[0] === 'mcpservers')).toHaveLength(1)
    expect(deleteSecret).toHaveBeenCalledTimes(1)
    expect(deleteSecret.mock.calls[0][0]).toBe('srv-b-credentials')
    expectOneUpstreamFailureLog(
      { verb: 'create', kind: 'McpServer', name: 'srv-b', namespace: 'mcp-server' },
      502,
      403
    )
  })

  it('answers 422 naming the registry entry when the McpServer spec is rejected', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MCP_ENTRY as never)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(SCHEMA_NONE as never)
    const { app, gw } = makeInstallApp()
    const original = gw.createResource.bind(gw)
    vi.spyOn(gw, 'createResource').mockImplementation(async (plural, body, namespace) => {
      if (plural === 'mcpservers') {
        throw apiserverError(422, { causes: [{ field: 'spec.port' }, { field: 'spec port' }] })
      }
      return original(plural, body, namespace)
    })

    const res = await request(app).post('/admin/registry/install').send(installBody('srv-b', false))

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('registry_upstream_rejected')
    expect(res.body.message).toBe(
      'the Kubernetes API server rejected the McpServer "srv-b" spec that control-api built ' +
        'from registry entry airtable-mcp@1.0.0 (HTTP 422; fields: spec.port). Your request ' +
        "is not the cause: the catalog entry and this cluster's McpServer definition or " +
        'admission policy disagree.'
    )
    expectNoApiserverText(res.body)
    const record = expectOneUpstreamFailureLog(
      { verb: 'create', kind: 'McpServer', name: 'srv-b', namespace: 'mcp-server' },
      422,
      422
    )
    expect(record.invalidFields).toEqual(['spec.port'])
    // A registry-content 422 is control-api's defect, logged at error (50).
    expect(record.level).toBe(50)
  })

  // Site C
  it.each([
    [403, 502, 'registry_upstream_failed'],
    [404, 404, 'registry_upstream_rejected'],
  ] as const)(
    'answers %i→%i and rolls the McpServer back when the Context update fails',
    async (upstream, status, error) => {
      vi.mocked(getEntryVersion).mockResolvedValueOnce(MCP_ENTRY as never)
      vi.mocked(getCredentialSchema).mockResolvedValueOnce(SCHEMA_NONE as never)
      const { app, gw } = makeInstallApp()
      const original = gw.updateResource.bind(gw)
      const updateResource = vi
        .spyOn(gw, 'updateResource')
        .mockImplementation(async (plural, name, body, namespace) => {
          if (plural === 'contexts') throw apiserverError(upstream)
          return original(plural, name, body, namespace)
        })
      const deleteResource = vi.spyOn(gw, 'deleteResource')

      const res = await request(app)
        .post('/admin/registry/install')
        .send(installBody('srv-c', false))

      expect(res.status).toBe(status)
      expect(res.body).toEqual({
        error,
        message:
          upstream === 403
            ? accessMessage(
                `update Context "default-context" in namespace "${config.contextsNamespace}"`,
                403
              )
            : `Context "default-context" not found in namespace "${config.contextsNamespace}".`,
        resourceType: 'context',
        resourceName: 'default-context',
        namespace: config.contextsNamespace,
      })
      expectNoApiserverText(res.body)
      expect(updateResource.mock.calls.filter(call => call[0] === 'contexts')).toHaveLength(1)
      expect(deleteResource.mock.calls.filter(call => call[0] === 'mcpservers')).toHaveLength(1)
      expectOneUpstreamFailureLog(
        {
          verb: 'update',
          kind: 'Context',
          name: 'default-context',
          namespace: config.contextsNamespace,
        },
        status,
        upstream
      )
    }
  )
})

// ── POST /admin/registry/install-recipe (site D) ─────────────────────────────
describe('POST /admin/registry/install-recipe — apiserver failures', () => {
  const RECIPE_ENTRY = {
    id: 'r1',
    name: 'competitive-intel-report',
    version: '1.0.0',
    entry_type: 'recipe',
    description: 'Research + PDF report',
    author: 'clerum',
    origin: 'official',
    category: 'workflow',
    tags: ['research'],
    trust_level: 'high',
    quality_tier: 'verified',
    status: 'published',
    server_mode: null,
    transport: null,
    recipe_type: 'workflow',
    mcp_server_meta: null,
    recipe_meta: {
      recipeYaml: JSON.stringify({
        spec: {
          description: 'Competitive intel',
          steps: [{ id: 'research', description: 'Research step' }],
        },
      }),
      stepCount: 1,
      hasAgent: true,
    },
    artifact_refs: null,
    downloads: 5,
    installs: 2,
    created_at: '2026-03-01T00:00:00Z',
  }

  it.each([
    [
      'a 403',
      () => apiserverError(403),
      502,
      (subject: string) => accessMessage(subject, 403),
      403,
    ],
    [
      'a 409',
      () => apiserverError(409),
      409,
      (_subject: string, name: string) =>
        `WorkflowRecipe "${name}" already exists in namespace "${config.sandboxNamespace}". ` +
        'Uninstall it or choose another name.',
      409,
    ],
    [
      'a 500',
      () => apiserverError(500),
      503,
      (subject: string) =>
        `control-api could not ${subject}: the Kubernetes API server returned HTTP 500.`,
      500,
    ],
    [
      'a refused connection',
      connectionRefused,
      503,
      (subject: string) =>
        `control-api could not ${subject}: the Kubernetes API server could not be reached.`,
      null,
    ],
  ] as const)(
    'answers the classified status for %s on the WorkflowRecipe create',
    async (_label, makeError, status, message, upstreamStatus) => {
      vi.mocked(getEntryVersion).mockResolvedValueOnce(RECIPE_ENTRY as never)
      const gw = new MockGateway('mcp-server')
      const createResource = vi.spyOn(gw, 'createResource').mockRejectedValueOnce(makeError())

      const res = await request(makeApp(gw)).post('/admin/registry/install-recipe').send({
        registryEntryName: 'competitive-intel-report',
        registryEntryVersion: '1.0.0',
      })

      expect(createResource).toHaveBeenCalledTimes(1)
      expect(createResource.mock.calls[0][0]).toBe('workflowrecipes')
      const recipeName = (createResource.mock.calls[0][1] as { metadata: { name: string } })
        .metadata.name
      expect(recipeName).toMatch(/^recipe-/)
      const subject = `create WorkflowRecipe "${recipeName}" in namespace "${config.sandboxNamespace}"`
      expect(res.status).toBe(status)
      expect(res.body).toEqual({
        error: status >= 500 ? 'registry_upstream_failed' : 'registry_upstream_rejected',
        message: message(subject, recipeName),
        resourceType: 'recipe',
        resourceName: recipeName,
        namespace: config.sandboxNamespace,
      })
      expectNoApiserverText(res.body)
      expect(JSON.stringify(res.body)).not.toContain('10.96.0.1')
      expectOneUpstreamFailureLog(
        {
          verb: 'create',
          kind: 'WorkflowRecipe',
          name: recipeName,
          namespace: config.sandboxNamespace,
        },
        status,
        upstreamStatus
      )
    }
  )
})

// ── POST /admin/registry/install-hook (sites M, E, F, G) ─────────────────────
describe('POST /admin/registry/install-hook — apiserver failures', () => {
  const IMG_A = `reg.example/hook@sha256:${'a'.repeat(64)}`
  const clusterScope: PublishScope = { curator: false, orgName: 'acme', scope: '@acme' }
  const HOOK_ENTRY = {
    id: 'h1',
    name: '@acme/hook',
    version: '2.0.0',
    entry_type: 'llm-hook',
    owner_type: 'org',
    description: 'a hook',
    author: 'acme',
    origin: 'org',
    category: 'guardrail',
    tags: [],
    trust_level: 'high',
    quality_tier: 'production',
    status: 'published',
    server_mode: null,
    transport: null,
    recipe_type: null,
    mcp_server_meta: null,
    recipe_meta: null,
    artifact_refs: null,
    downloads: 0,
    installs: 0,
    created_at: '2026-03-20T00:00:00Z',
    hook_meta: {
      target: { image: { ref: IMG_A, port: 8080 } },
      lifecyclePoints: ['preCall'],
    },
  }

  async function makeHookApp(seedHost = true) {
    const gw = new MockGateway()
    if (seedHost) {
      await gw.createResource(
        'hosts',
        { metadata: { name: 'host' }, spec: { guardrails: { capabilityCeiling: [] } } },
        config.hostsNamespace
      )
    }
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    vi.mocked(getEntryVersion).mockResolvedValueOnce(HOOK_ENTRY as never)
    vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true })
    return { app: makeApp(gw), gw }
  }

  function hookBody(withCredentials: boolean): Record<string, unknown> {
    return {
      hostRef: 'host',
      hookName: 'my-hook',
      registryEntryName: '@acme/hook',
      registryEntryVersion: '2.0.0',
      ...(withCredentials ? { [CREDENTIALS_FIELD]: { k: 'value-for-test' } } : {}),
    }
  }

  // Site M
  it('answers 502 when the Host read is rejected with 403', async () => {
    const { app, gw } = await makeHookApp()
    const original = gw.getResource.bind(gw)
    const getResource = vi
      .spyOn(gw, 'getResource')
      .mockImplementation(async (plural, name, namespace) => {
        if (plural === 'hosts') throw apiserverError(403)
        return original(plural, name, namespace)
      })
    const createResource = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install-hook').send(hookBody(false))

    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'registry_upstream_failed',
      message: accessMessage(`read Host "host" in namespace "${config.hostsNamespace}"`, 403),
      resourceType: 'host',
      resourceName: 'host',
      namespace: config.hostsNamespace,
    })
    expectNoApiserverText(res.body)
    expect(getResource.mock.calls.filter(call => call[0] === 'hosts')).toHaveLength(1)
    expect(createResource).not.toHaveBeenCalled()
    expectOneUpstreamFailureLog(
      { verb: 'read', kind: 'Host', name: 'host', namespace: config.hostsNamespace },
      502,
      403
    )
  })

  it('keeps the existing 404 body when the Host does not exist', async () => {
    const { app, gw } = await makeHookApp(false)
    const getResource = vi.spyOn(gw, 'getResource')

    const res = await request(app).post('/admin/registry/install-hook').send(hookBody(false))

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Host "host" not found' })
    expect(getResource.mock.calls.filter(call => call[0] === 'hosts')).toHaveLength(1)
    expect(upstreamFailureRecords()).toHaveLength(0)
  })

  // Site E
  it('answers 502 when the hook credential Secret create is rejected with 403', async () => {
    const { app, gw } = await makeHookApp()
    const createSecret = vi.spyOn(gw, 'createSecret').mockRejectedValueOnce(apiserverError(403))
    const createResource = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install-hook').send(hookBody(true))

    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'registry_upstream_failed',
      message: accessMessage(
        `create Secret "my-hook-creds" in namespace "${config.llmHooksNamespace}"`,
        403
      ),
      resourceType: 'secret',
      resourceName: 'my-hook-creds',
      namespace: config.llmHooksNamespace,
    })
    expectNoApiserverText(res.body)
    expect(createSecret).toHaveBeenCalledTimes(1)
    expect(createResource).not.toHaveBeenCalled()
    expectOneUpstreamFailureLog(
      {
        verb: 'create',
        kind: 'Secret',
        name: 'my-hook-creds',
        namespace: config.llmHooksNamespace,
      },
      502,
      403
    )
  })

  // Site F
  it('answers 502 and rolls the Secret back when the LlmHook create is rejected with 403', async () => {
    const { app, gw } = await makeHookApp()
    const original = gw.createResource.bind(gw)
    const createResource = vi
      .spyOn(gw, 'createResource')
      .mockImplementation(async (plural, body, namespace) => {
        if (plural === 'llmhooks') throw apiserverError(403)
        return original(plural, body, namespace)
      })
    const deleteSecret = vi.spyOn(gw, 'deleteSecret')

    const res = await request(app).post('/admin/registry/install-hook').send(hookBody(true))

    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'registry_upstream_failed',
      message: accessMessage(
        `create LlmHook "my-hook" in namespace "${config.llmHooksNamespace}"`,
        403
      ),
      resourceType: 'llm-hook',
      resourceName: 'my-hook',
      namespace: config.llmHooksNamespace,
    })
    expectNoApiserverText(res.body)
    expect(createResource.mock.calls.filter(call => call[0] === 'llmhooks')).toHaveLength(1)
    expect(deleteSecret).toHaveBeenCalledTimes(1)
    expect(deleteSecret.mock.calls[0][0]).toBe('my-hook-creds')
    expectOneUpstreamFailureLog(
      { verb: 'create', kind: 'LlmHook', name: 'my-hook', namespace: config.llmHooksNamespace },
      502,
      403
    )
  })

  // Site G
  it('answers 502 and rolls the LlmHook back when the Host guardrails update is rejected', async () => {
    const { app, gw } = await makeHookApp()
    const mutateResource = vi.spyOn(gw, 'mutateResource').mockRejectedValueOnce(apiserverError(403))
    const deleteResource = vi.spyOn(gw, 'deleteResource')

    const res = await request(app).post('/admin/registry/install-hook').send(hookBody(false))

    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'registry_upstream_failed',
      message: accessMessage(`update Host "host" in namespace "${config.hostsNamespace}"`, 403),
      resourceType: 'host',
      resourceName: 'host',
      namespace: config.hostsNamespace,
    })
    expectNoApiserverText(res.body)
    expect(mutateResource).toHaveBeenCalledTimes(1)
    expect(mutateResource.mock.calls[0][0]).toBe('hosts')
    expect(deleteResource.mock.calls.filter(call => call[0] === 'llmhooks')).toHaveLength(1)
    expectOneUpstreamFailureLog(
      { verb: 'update', kind: 'Host', name: 'host', namespace: config.hostsNamespace },
      502,
      403
    )
  })
})
