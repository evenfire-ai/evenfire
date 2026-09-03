/**
 * Unit tests for MCP Delegation module (Phase 6).
 *
 * Tests pure builder functions directly and async operations with mocked K8s API.
 */
import { describe, expect, it, vi } from 'vitest'
import { WorkflowRecipeCRD } from '../types'
import {
  DelegationDeps,
  PRE_DEPLOY_ANNOTATION,
  buildMcpServerManifest,
  buildTransportService,
  cleanupDelegation,
  delegateTransportWorkloads,
  deleteTransportDelegation,
  ensureRecipeContext,
  mcpServerName,
  preDeployMcpServers,
  transportWorkloadSecretDenied,
  waitForExternalEgressReady,
  waitForNetworkReady,
} from './mcpDelegation'
import type { SecretAccess } from './resourceBuilder'
import { privateWorkflowContextName } from './workflowContext'

// ─── Test Helpers ─────────────────────────────────────────────────────

function makeRecipe(overrides?: Partial<WorkflowRecipeCRD>): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'test-recipe', namespace: 'sandbox-recipes', uid: 'uid-abc-123' },
    spec: {
      workloads: [
        {
          id: 'redis-mcp',
          type: 'deployment',
          image: 'clerum/redis-mcp:latest',
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
        },
      ],
    },
    ...overrides,
  }
}

function makeRecipeWithBindings(): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'bound-recipe', namespace: 'sandbox-recipes', uid: 'uid-bound-123' },
    spec: {
      contextRef: 'default',
      workloads: [
        { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 },
        {
          id: 'redis-mcp',
          type: 'deployment',
          image: 'clerum/redis-mcp:latest',
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
          dependsOn: ['redis'],
        },
      ],
      bindings: [{ from: 'redis-mcp', to: 'redis', port: 6379 }],
    },
  }
}

// ─── Pure Builder Tests ───────────────────────────────────────────────

describe('mcpServerName', () => {
  it('returns {recipeName}-{workloadId}', () => {
    expect(mcpServerName('my-recipe', 'redis-mcp')).toBe('my-recipe-redis-mcp')
  })

  it('returns the runtime-safe workload resource name for workflow recipes', () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'manual-pr259-layer3a-hybrid-secret-pvc-5step-7f99549a',
        namespace: 'sandbox-recipes',
        uid: 'long-child-uid',
      },
      spec: {
        contextRef: 'default',
        steps: [{ id: 'call-mcp', instruction: 'Call mock tools.' }],
        workloads: [
          {
            id: 'mock-tools',
            type: 'deployment',
            image: 'clerum/mock-mcp-server:test',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
          },
        ],
      },
    })

    const name = mcpServerName(recipe.metadata.name, 'mock-tools', recipe)

    expect(name).toMatch(/-mock-tools-[0-9a-f]{8}$/)
    expect(name).not.toBe(`${recipe.metadata.name}-mock-tools`)
    expect(name.length).toBeLessThanOrEqual(63)
  })
})

describe('buildMcpServerManifest', () => {
  it('6.1a — returns manifest with managed: false', () => {
    const recipe = makeRecipe()
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')

    expect(manifest).not.toBeNull()
    const spec = (manifest as Record<string, unknown>).spec as Record<string, unknown>
    expect(spec.managed).toBe(false)
  })

  it('uses private wf-<recipeName> context when contextRef is omitted', () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'clerum/redis-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
          },
        ],
      },
    })
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as Record<string, unknown>
    const meta = manifest.metadata as { labels: Record<string, string> }

    expect(spec.contextRef).toBe('wf-test-recipe')
    expect(meta.labels['clerum.io/context']).toBe('wf-test-recipe')
  })

  it('keeps generated private context names DNS-label safe for long recipe names', () => {
    const longRecipeName =
      'research-summary-workflow-with-a-very-long-generated-child-run-name-1234567890'
    const recipe = makeRecipe({
      metadata: { name: longRecipeName, namespace: 'sandbox-recipes', uid: 'uid-long' },
    })
    const expectedContext = privateWorkflowContextName(longRecipeName)
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as Record<string, unknown>
    const meta = manifest.metadata as { labels: Record<string, string> }

    expect(expectedContext.length).toBeLessThanOrEqual(63)
    expect(expectedContext).toMatch(/^wf-[a-z0-9-]+-[0-9a-f]{8}$/)
    expect(spec.contextRef).toBe(expectedContext)
    expect(meta.labels['clerum.io/context']).toBe(expectedContext)
  })

  it('6.1b — manifest keeps ownerRef only when child namespace equals recipe namespace', () => {
    const recipe = makeRecipe()
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'sandbox-recipes')!

    const meta = manifest.metadata as {
      ownerReferences: Array<{ kind: string; name: string; uid: string }>
    }
    expect(meta.ownerReferences).toHaveLength(1)
    expect(meta.ownerReferences[0].kind).toBe('WorkflowRecipe')
    expect(meta.ownerReferences[0].name).toBe('test-recipe')
    expect(meta.ownerReferences[0].uid).toBe('uid-abc-123')
  })

  it('6.1b-cross-ns — ownerRef STRIPPED when McpServer ns differs from recipe ns (Phase-8 §4.8)', () => {
    // Canonical recipe lives in sandbox-recipes; McpServer child renders in mcp-server.
    // K8s >=1.24 rejects cross-namespace ownerRefs (OwnerRefInvalidNamespace). The
    // builder must omit `ownerReferences` so the API accepts the create.
    const recipe = makeRecipe({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes', uid: 'uid-abc-123' },
    })
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!

    const meta = manifest.metadata as Record<string, unknown>
    expect(meta.ownerReferences).toBeUndefined()
  })

  it('6.1c — transport.url matches Service DNS pattern', () => {
    const recipe = makeRecipe()
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!

    const spec = manifest.spec as { transport: { url: string; type: string; port: number } }
    expect(spec.transport.url).toBe(
      'http://test-recipe-redis-mcp.mcp-server.svc.cluster.local:3000/mcp'
    )
    expect(spec.transport.type).toBe('streamableHttp')
    expect(spec.transport.port).toBe(3000)
  })

  it('6.1d — manifest has correct labels', () => {
    const recipe = makeRecipe()
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!

    const meta = manifest.metadata as { labels: Record<string, string> }
    expect(meta.labels['clerum.io/managed-by']).toBe('workflow-recipes')
    expect(meta.labels['clerum.io/recipe']).toBe('test-recipe')
    expect(meta.labels['clerum.io/workload']).toBe('redis-mcp')
    expect(meta.labels['clerum.io/context']).toBe('wf-test-recipe')
  })

  it('6.3a — returns null for non-transport workload', () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'nginx', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 80 }],
      },
    })
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')
    expect(manifest).toBeNull()
  })

  it('6.6a — has recipe-bindings annotation when bindings exist', () => {
    const recipe = makeRecipeWithBindings()
    const mcpWorkload = recipe.spec.workloads!.find(w => w.id === 'redis-mcp')!
    const manifest = buildMcpServerManifest(mcpWorkload, recipe, 'mcp-server')!

    const meta = manifest.metadata as { annotations?: Record<string, string> }
    expect(meta.annotations).toBeDefined()
    expect(meta.annotations!['clerum.io/recipe-bindings']).toBeDefined()

    const bindings = JSON.parse(meta.annotations!['clerum.io/recipe-bindings'])
    expect(bindings).toHaveLength(1)
    expect(bindings[0].from).toBe('redis-mcp')
    expect(bindings[0].to).toBe('redis')
  })

  it('has no annotations when no bindings reference the workload', () => {
    const recipe = makeRecipe() // no bindings
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!

    const meta = manifest.metadata as { annotations?: Record<string, string> }
    expect(meta.annotations).toBeUndefined()
  })

  // ─── Per-Workload egressBindings (Least Privilege) ──────────────────

  it('propagates egressBindings only from the workload, not shared across the recipe', () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'multi-egress', namespace: 'sandbox-recipes', uid: 'uid-egress' },
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'openai-mcp',
            type: 'deployment',
            image: 'openai:1',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'api.openai.com', port: 443 }],
          },
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'redis:7',
            port: 3000,
            transport: { type: 'streamableHttp' },
            // No egressBindings — redis has no external egress need
          },
        ],
      },
    }

    const openaiManifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const redisManifest = buildMcpServerManifest(recipe.spec.workloads![1], recipe, 'mcp-server')!

    // openai-mcp gets its declared egress
    expect((openaiManifest.spec as Record<string, unknown>).egressBindings).toEqual([
      { dns: 'api.openai.com', port: 443 },
    ])

    // redis-mcp gets NO egress — least privilege enforced
    expect((redisManifest.spec as Record<string, unknown>).egressBindings).toBeUndefined()
  })

  it('propagates explicit public-web egress without exact destination fields', () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'public-web-egress', namespace: 'sandbox-recipes', uid: 'uid-web' },
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'search-mcp',
            type: 'deployment',
            image: 'search:1',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ egressClass: 'public-web' }],
          },
        ],
      },
    }

    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!

    expect((manifest.spec as Record<string, unknown>).egressBindings).toEqual([
      { egressClass: 'public-web' },
    ])
  })

  it('isolates egressBindings between workloads — no cross-contamination', () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'isolated', namespace: 'sandbox-recipes', uid: 'uid-iso' },
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'openai-mcp',
            type: 'deployment',
            image: 'openai:1',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'api.openai.com', port: 443 }],
          },
          {
            id: 'stripe-mcp',
            type: 'deployment',
            image: 'stripe:1',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'api.stripe.com', port: 443 }],
          },
        ],
      },
    }

    const openai = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const stripe = buildMcpServerManifest(recipe.spec.workloads![1], recipe, 'mcp-server')!

    const openaiEgress = (openai.spec as Record<string, unknown>).egressBindings as Array<
      Record<string, unknown>
    >
    const stripeEgress = (stripe.spec as Record<string, unknown>).egressBindings as Array<
      Record<string, unknown>
    >

    // Each workload only gets its own egress
    expect(openaiEgress).toEqual([{ dns: 'api.openai.com', port: 443 }])
    expect(stripeEgress).toEqual([{ dns: 'api.stripe.com', port: 443 }])

    // Cross-contamination check: openai must NOT have stripe's egress
    expect(openaiEgress).not.toContainEqual({ dns: 'api.stripe.com', port: 443 })
    expect(stripeEgress).not.toContainEqual({ dns: 'api.openai.com', port: 443 })
  })

  it('strips non-schema fields from egressBindings before writing the McpServer manifest', () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'sanitized-egress', namespace: 'sandbox-recipes', uid: 'uid-sanitize' },
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'remote-mcp',
            type: 'deployment',
            image: 'remote:1',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [
              {
                dns: 'api.openai.com',
                port: 443,
                protocol: 'TCP',
                cidr: '0.0.0.0/0',
                extra: 'should-not-leak',
              } as unknown as NonNullable<
                NonNullable<WorkflowRecipeCRD['spec']['workloads']>[number]['egressBindings']
              >[number],
            ],
          },
        ],
      },
    }

    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!

    expect((manifest.spec as Record<string, unknown>).egressBindings).toEqual([
      { dns: 'api.openai.com', port: 443, protocol: 'TCP' },
    ])
  })

  // ─── stdio Transport Tests ──────────────────────────────────────────

  it('stdio workload — manifest has managed: true (HCC manages with sidecar)', () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'calc-mcp',
            type: 'deployment',
            image: 'clerum/mock-stdio-mcp-server:test',
            port: 3000,
            transport: { type: 'stdio' },
          },
        ],
      },
    })
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as Record<string, unknown>
    expect(spec.managed).toBe(true)
  })

  it('stdio workload — transport has no url (stdio-bridge handles HTTP exposure)', () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'calc-mcp',
            type: 'deployment',
            image: 'clerum/mock-stdio-mcp-server:test',
            port: 3000,
            transport: { type: 'stdio' },
          },
        ],
      },
    })
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as { transport: Record<string, unknown> }
    expect(spec.transport.type).toBe('stdio')
    expect(spec.transport.port).toBe(3000)
    expect(spec.transport.url).toBeUndefined()
  })

  it('stdio workload — passes command, args, and env to McpServer spec', () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'pg-mcp',
            type: 'deployment',
            image: 'clerum/pg-stdio:test',
            port: 3000,
            command: ['/usr/local/bin/mcp-server'],
            args: ['--verbose'],
            env: [{ name: 'PG_HOST', value: 'postgres.sandbox-recipes.svc.cluster.local' }],
            transport: { type: 'stdio' },
          },
        ],
      },
    })
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as Record<string, unknown>
    expect(spec.command).toEqual(['/usr/local/bin/mcp-server'])
    expect(spec.args).toEqual(['--verbose'])
    expect(spec.env).toEqual([
      { name: 'PG_HOST', value: 'postgres.sandbox-recipes.svc.cluster.local' },
    ])
  })

  it('HTTP workload — manifest still has managed: false', () => {
    const recipe = makeRecipe() // default streamableHttp
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as Record<string, unknown>
    expect(spec.managed).toBe(false)
  })

  it('HTTP workload — transport includes url', () => {
    const recipe = makeRecipe() // default streamableHttp
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as { transport: Record<string, unknown> }
    expect(spec.transport.url).toBeDefined()
    expect(spec.transport.url).toContain('http://')
  })

  it('defaults transport path to /mcp when not specified', () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'srv',
            type: 'deployment',
            image: 'srv:latest',
            port: 3000,
            transport: { type: 'sse' },
          },
        ],
      },
    })
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as { transport: { url: string } }
    expect(spec.transport.url).toContain('/mcp')
  })

  // ── Codex P2 fix (PR #101) — imagePullSecrets normalization ───────────
  it('G6 — normalizes imagePullSecrets string[] to LocalObjectReference[]', () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'srv',
            type: 'deployment',
            image: 'private/srv:latest',
            port: 3000,
            transport: { type: 'sse' },
            imagePullSecrets: ['registry-secret', 'dockerhub-secret'],
          },
        ],
      },
    })
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as { imagePullSecrets?: Array<{ name: string }> }
    expect(spec.imagePullSecrets).toEqual([
      { name: 'registry-secret' },
      { name: 'dockerhub-secret' },
    ])
  })

  it('G6 — omits imagePullSecrets when not specified', () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'srv',
            type: 'deployment',
            image: 'public/srv:latest',
            port: 3000,
            transport: { type: 'sse' },
          },
        ],
      },
    })
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const spec = manifest.spec as { imagePullSecrets?: Array<{ name: string }> }
    expect(spec.imagePullSecrets).toBeUndefined()
  })
})

describe('buildTransportService', () => {
  it('6.2a — returns Service with name = mcpServerName()', () => {
    const recipe = makeRecipe()
    const svc = buildTransportService(recipe.spec.workloads![0], recipe, 'mcp-server')

    expect(svc).not.toBeNull()
    expect(svc!.metadata!.name).toBe('test-recipe-redis-mcp')
  })

  it('6.2b — Service selector targets workload pod labels', () => {
    const recipe = makeRecipe()
    const svc = buildTransportService(recipe.spec.workloads![0], recipe, 'mcp-server')!

    expect(svc.spec!.selector).toEqual({ app: 'redis-mcp' })
  })

  it('6.3b — returns null for non-transport workload', () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'nginx', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 80 }],
      },
    })
    const svc = buildTransportService(recipe.spec.workloads![0], recipe, 'mcp-server')
    expect(svc).toBeNull()
  })

  it('stdio workload — Service selector uses mcpServerName (matches HCC Deployment labels)', () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'calc-mcp',
            type: 'deployment',
            image: 'clerum/mock-stdio-mcp-server:test',
            port: 3000,
            transport: { type: 'stdio' },
          },
        ],
      },
    })
    const svc = buildTransportService(recipe.spec.workloads![0], recipe, 'mcp-server')!
    // HCC creates Deployment with label app: "test-recipe-calc-mcp" (mcpServerName)
    expect(svc.spec!.selector).toEqual({ app: 'test-recipe-calc-mcp' })
  })

  it('HTTP workload — Service selector uses workload.id (matches WRC Deployment labels)', () => {
    const recipe = makeRecipe() // streamableHttp, id: "redis-mcp"
    const svc = buildTransportService(recipe.spec.workloads![0], recipe, 'mcp-server')!
    // WRC creates Deployment with label app: "redis-mcp" (workload.id)
    expect(svc.spec!.selector).toEqual({ app: 'redis-mcp' })
  })

  it('returns null when workload has no port', () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'srv',
            type: 'deployment',
            image: 'srv:latest',
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    const svc = buildTransportService(recipe.spec.workloads![0], recipe, 'mcp-server')
    expect(svc).toBeNull()
  })

  it('Service keeps ownerRef only when child namespace equals recipe namespace', () => {
    const recipe = makeRecipe()
    const svc = buildTransportService(recipe.spec.workloads![0], recipe, 'sandbox-recipes')!

    expect(svc.metadata!.ownerReferences).toHaveLength(1)
    expect(svc.metadata!.ownerReferences![0].kind).toBe('WorkflowRecipe')
  })

  it('Service ownerRef STRIPPED when Service ns differs from recipe ns (Phase-8 §4.8)', () => {
    const recipe = makeRecipe({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes', uid: 'uid-abc-123' },
    })
    const svc = buildTransportService(recipe.spec.workloads![0], recipe, 'mcp-server')!

    expect(svc.metadata!.ownerReferences).toBeUndefined()
    expect(svc.metadata!.namespace).toBe('mcp-server')
  })
})

// ─── Async Operation Tests (mocked K8s API) ──────────────────────────

describe('cleanupDelegation', () => {
  // Minimal stubs for the K8s deleteCollection* methods introduced by the
  // Phase-8 label-selector sweep. All mocks below spread this object so a new
  // test case inherits the stubs without having to repeat them.
  const deleteCollectionStubs = {
    deleteCollectionNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  }
  const deleteCollectionSvcStub = {
    deleteCollectionNamespacedService: vi.fn().mockResolvedValue({}),
  }

  it('6.5a — deletes McpServer CRD and transport Service', async () => {
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      ...deleteCollectionStubs,
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...deleteCollectionSvcStub,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }
    const recipe = makeRecipe()

    await cleanupDelegation(deps, recipe, 'mcp-server')

    expect(mockCustomApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-recipe-redis-mcp', plural: 'mcpservers' })
    )
    expect(mockCoreApi.deleteNamespacedService).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-recipe-redis-mcp' })
    )
  })

  it('H04-cleanup — deletes per-recipe Context CRD (belt-and-suspenders, H-04)', async () => {
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      ...deleteCollectionStubs,
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...deleteCollectionSvcStub,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await cleanupDelegation(deps, makeRecipe(), 'mcp-server')

    // Per-recipe Context CRD must be explicitly deleted
    expect(mockCustomApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'wf-test-recipe', plural: 'contexts' })
    )
  })

  it('H04-cleanup — does NOT call patchNamespacedCustomObject (no shared context mutation)', async () => {
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      ...deleteCollectionStubs,
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...deleteCollectionSvcStub,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await cleanupDelegation(deps, makeRecipe(), 'mcp-server')

    // Must not call unpatchContextAllowlist (shared context mutation)
    expect(mockCustomApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('removes only recipe servers from an explicit shared Context during cleanup', async () => {
    const recipe = makeRecipe({
      spec: {
        ...makeRecipe().spec,
        contextRef: 'context1',
      },
    })
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { resourceVersion: '8', labels: { owner: 'operator' } },
        spec: {
          contextId: 'context1',
          mcpServers: ['other-recipe-server', 'test-recipe-redis-mcp'],
          sharedFileSystems: [{ name: 'shared-workspace', mountPath: '/workspace' }],
        },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      ...deleteCollectionStubs,
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...deleteCollectionSvcStub,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await cleanupDelegation(deps, recipe, 'mcp-server')

    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ plural: 'contexts', name: 'context1' })
    )
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'contexts',
        name: 'context1',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            resourceVersion: '8',
            labels: { owner: 'operator' },
          }),
          spec: {
            contextId: 'context1',
            mcpServers: ['other-recipe-server'],
            sharedFileSystems: [{ name: 'shared-workspace', mountPath: '/workspace' }],
          },
        }),
      })
    )
  })

  it('retries explicit shared Context cleanup on resourceVersion conflict', async () => {
    const recipe = makeRecipe({
      spec: {
        ...makeRecipe().spec,
        contextRef: 'context1',
      },
    })
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '8' },
          spec: { contextId: 'context1', mcpServers: ['other', 'test-recipe-redis-mcp'] },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '9' },
          spec: { contextId: 'context1', mcpServers: ['other', 'test-recipe-redis-mcp'] },
        }),
      replaceNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce({ code: 409 })
        .mockResolvedValueOnce({}),
      ...deleteCollectionStubs,
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...deleteCollectionSvcStub,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await cleanupDelegation(deps, recipe, 'mcp-server')

    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: '9' }),
          spec: { contextId: 'context1', mcpServers: ['other'] },
        }),
      })
    )
  })

  it('fails cleanup when shared Context cleanup exhausts conflict retries', async () => {
    const recipe = makeRecipe({
      spec: {
        ...makeRecipe().spec,
        contextRef: 'context1',
      },
    })
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { resourceVersion: '8' },
        spec: { contextId: 'context1', mcpServers: ['other', 'test-recipe-redis-mcp'] },
      }),
      replaceNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 409 }),
      ...deleteCollectionStubs,
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...deleteCollectionSvcStub,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await expect(cleanupDelegation(deps, recipe, 'mcp-server')).rejects.toThrow(
      'Context "context1": failed to update Context "context1" after conflict retries'
    )
    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledTimes(3)
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(3)
  })

  it("H04-cleanup — Context 404 on delete is silently ignored (already GC'd)", async () => {
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({}) // McpServer delete succeeds
        .mockRejectedValueOnce({ code: 404 }), // Context already gone
      ...deleteCollectionStubs,
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...deleteCollectionSvcStub,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    // Should NOT throw — 404 on Context delete is graceful
    await expect(cleanupDelegation(deps, makeRecipe(), 'mcp-server')).resolves.toBeUndefined()
  })

  it('fails cleanup when per-recipe Context delete fails with a non-404 error', async () => {
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('rbac denied')),
      ...deleteCollectionStubs,
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...deleteCollectionSvcStub,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await expect(cleanupDelegation(deps, makeRecipe(), 'mcp-server')).rejects.toThrow(
      'Context "wf-test-recipe": rbac denied'
    )
  })

  it('M-1 label-sweep — deletes McpServers + Services by label clerum.io/recipe=<name>', async () => {
    // Belt-and-suspenders regression guard: the by-name loop only sweeps
    // workloads still present in recipe.spec.workloads. If a workload is
    // renamed/removed between create and delete, by-name misses it. Post
    // Phase-8 cross-ns placement, native GC cannot reap it (ownerRef
    // stripped), so label sweep is the last line of defense.
    const deleteCollectionCustom = vi.fn().mockResolvedValue({})
    const deleteCollectionSvc = vi.fn().mockResolvedValue({})
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      deleteCollectionNamespacedCustomObject: deleteCollectionCustom,
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      deleteCollectionNamespacedService: deleteCollectionSvc,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await cleanupDelegation(deps, makeRecipe(), 'mcp-server')

    expect(deleteCollectionCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'mcpservers',
        namespace: 'mcp-server',
        labelSelector: 'clerum.io/recipe=test-recipe',
      })
    )
    expect(deleteCollectionSvc).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'mcp-server',
        labelSelector: 'clerum.io/recipe=test-recipe',
      })
    )
  })

  it('fails cleanup when the label sweep cannot verify child deletion', async () => {
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      deleteCollectionNamespacedCustomObject: vi.fn().mockRejectedValue(new Error('api down')),
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...deleteCollectionSvcStub,
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await expect(cleanupDelegation(deps, makeRecipe(), 'mcp-server')).rejects.toThrow(
      'McpServer label sweep failed: api down'
    )
  })
})

describe('ensureRecipeContext', () => {
  const ownerRef = {
    apiVersion: 'clerum.io/v1alpha1' as const,
    kind: 'WorkflowRecipe',
    name: 'test-recipe',
    uid: 'uid-abc-123',
    controller: true,
    blockOwnerDeletion: true,
  }

  it('H04a — creates per-recipe Context CRD with correct server names', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    const contextName = await ensureRecipeContext(
      deps,
      'test-recipe',
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef
    )

    expect(contextName).toBe('wf-test-recipe')
    expect(mockCustomApi.createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'contexts',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'wf-test-recipe',
            labels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/managed-by': 'wrc' },
            ownerReferences: [ownerRef],
          }),
          spec: { contextId: 'wf-test-recipe', mcpServers: ['test-recipe-redis-mcp'] },
        }),
      })
    )
  })

  it('H04b — writes on 409 when live Context has no mcpServers (empty→filled is not a skip)', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '5' } }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    const contextName = await ensureRecipeContext(
      deps,
      'test-recipe',
      ['server-a', 'server-b'],
      'mcp-server',
      ownerRef
    )

    expect(contextName).toBe('wf-test-recipe')
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-test-recipe',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: '5' }),
          spec: { contextId: 'wf-test-recipe', mcpServers: ['server-a', 'server-b'] },
        }),
      })
    )
  })

  it('uses explicit contextRef as the effective Context and preserves existing allowlist', async () => {
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '5',
          labels: { 'clerum.io/context-owner': 'admin', 'clerum.io/recipe': 'other-recipe' },
          annotations: { 'operator.io/note': 'keep' },
        },
        spec: {
          contextId: 'context1',
          description: 'shared operator context',
          mcpServers: ['existing-server'],
          sharedFileSystems: [{ name: 'shared-workspace', mountPath: '/workspace' }],
        },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    const contextName = await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(contextName).toBe('context1')
    const replaceCall = mockCustomApi.replaceNamespacedCustomObject.mock.calls[0]?.[0]
    expect(replaceCall).toEqual(
      expect.objectContaining({
        name: 'context1',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            labels: expect.objectContaining({
              'clerum.io/context-owner': 'admin',
              'clerum.io/managed-by': 'wrc',
              'clerum.io/recipe': 'other-recipe',
            }),
            annotations: { 'operator.io/note': 'keep' },
          }),
          spec: {
            contextId: 'context1',
            description: 'shared operator context',
            mcpServers: ['existing-server', 'test-recipe-redis-mcp'],
            sharedFileSystems: [{ name: 'shared-workspace', mountPath: '/workspace' }],
          },
        }),
      })
    )
    expect(
      (replaceCall.body as { metadata?: { labels?: Record<string, string> } }).metadata?.labels?.[
        'clerum.io/recipe'
      ]
    ).not.toBe('test-recipe')
    expect(
      (replaceCall.body as { metadata?: Record<string, unknown> }).metadata
    ).not.toHaveProperty('ownerReferences')
  })

  it('retries explicit contextRef replacement when Kubernetes reports a resourceVersion conflict', async () => {
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '5', labels: { 'clerum.io/context-owner': 'admin' } },
          spec: {
            contextId: 'context1',
            description: 'shared operator context',
            mcpServers: ['existing-server'],
            sharedFileSystems: [{ name: 'shared-workspace', mountPath: '/workspace' }],
          },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '6', labels: { 'clerum.io/context-owner': 'admin' } },
          spec: {
            contextId: 'context1',
            description: 'shared operator context',
            mcpServers: ['existing-server', 'other-server'],
            sharedFileSystems: [{ name: 'shared-workspace', mountPath: '/workspace' }],
          },
        }),
      replaceNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce({ code: 409 })
        .mockResolvedValueOnce({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    const contextName = await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(contextName).toBe('context1')
    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(2)

    const retryReplaceCall = mockCustomApi.replaceNamespacedCustomObject.mock.calls[1]?.[0]
    expect(retryReplaceCall).toEqual(
      expect.objectContaining({
        name: 'context1',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            labels: expect.objectContaining({ 'clerum.io/context-owner': 'admin' }),
            resourceVersion: '6',
          }),
          spec: {
            contextId: 'context1',
            description: 'shared operator context',
            mcpServers: ['existing-server', 'other-server', 'test-recipe-redis-mcp'],
            sharedFileSystems: [{ name: 'shared-workspace', mountPath: '/workspace' }],
          },
        }),
      })
    )
  })

  it('fails clearly after exhausting explicit contextRef replacement conflicts', async () => {
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { resourceVersion: '5' },
        spec: { contextId: 'context1', mcpServers: ['existing-server'] },
      }),
      replaceNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 409 }),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await expect(
      ensureRecipeContext(
        deps,
        recipe,
        ['test-recipe-redis-mcp'],
        'mcp-server',
        ownerRef,
        'sandbox-recipes'
      )
    ).rejects.toThrow('failed to update Context "context1" after conflict retries')

    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledTimes(3)
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(3)
  })

  it('skips shared Context replace when the union and WRC-authored labels already match', async () => {
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '9',
          labels: {
            'clerum.io/recipe': 'other-recipe',
            'clerum.io/managed-by': 'wrc',
            'clerum.io/context-owner': 'admin',
          },
        },
        spec: {
          contextId: 'context1',
          mcpServers: ['existing-server', 'test-recipe-redis-mcp'],
        },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    const contextName = await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(contextName).toBe('context1')
    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(mockCustomApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('writes a shared Context when managed-by is missing even if the server union already matches', async () => {
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '9',
          labels: { 'clerum.io/recipe': 'other-recipe' },
        },
        spec: {
          contextId: 'context1',
          mcpServers: ['existing-server', 'test-recipe-redis-mcp'],
        },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    const replaceCall = mockCustomApi.replaceNamespacedCustomObject.mock.calls[0]?.[0]
    expect(replaceCall).toEqual(
      expect.objectContaining({
        name: 'context1',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            labels: expect.objectContaining({
              'clerum.io/managed-by': 'wrc',
              'clerum.io/recipe': 'other-recipe',
            }),
          }),
        }),
      })
    )
    expect(
      (replaceCall.body as { metadata?: { labels?: Record<string, string> } }).metadata?.labels?.[
        'clerum.io/recipe'
      ]
    ).not.toBe('test-recipe')
  })

  it('skips shared Context replace even when a leftover spec-hash annotation is present', async () => {
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '9',
          labels: { 'clerum.io/managed-by': 'wrc', 'clerum.io/recipe': 'other-recipe' },
          annotations: { 'clerum.io/spec-hash': 'deadbeefdeadbeefdeadbeefdeadbeef' },
        },
        spec: {
          contextId: 'context1',
          mcpServers: ['existing-server', 'test-recipe-redis-mcp'],
        },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(mockCustomApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('skips private Context replace when mcpServers and WRC labels already match', async () => {
    // Helper-compatibility path: omitted recipeNamespace means same-ns ownership.
    // A valid private no-op must already carry this recipe's ownerRef.
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '3',
          labels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/managed-by': 'wrc' },
          ownerReferences: [ownerRef],
        },
        spec: { contextId: 'wf-test-recipe', mcpServers: ['server-a', 'server-b'] },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    const contextName = await ensureRecipeContext(
      deps,
      'test-recipe',
      ['server-a', 'server-b'],
      'mcp-server',
      ownerRef
    )

    expect(contextName).toBe('wf-test-recipe')
    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(mockCustomApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('rewrites a same-namespace private ownerRef when controller flags drifted', async () => {
    const driftedOwnerRef = { ...ownerRef, controller: false, blockOwnerDeletion: false }
    const { mockCustomApi, deps, liveOf } = contextApiWithLiveState({
      metadata: {
        resourceVersion: '3',
        labels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/managed-by': 'wrc' },
        ownerReferences: [driftedOwnerRef],
      },
      spec: { contextId: 'wf-test-recipe', mcpServers: ['server-a', 'server-b'] },
    })

    await ensureRecipeContext(deps, 'test-recipe', ['server-a', 'server-b'], 'mcp-server', ownerRef)
    await ensureRecipeContext(deps, 'test-recipe', ['server-a', 'server-b'], 'mcp-server', ownerRef)

    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(
      (liveOf().metadata as { ownerReferences?: unknown } | undefined)?.ownerReferences
    ).toEqual([ownerRef])
  })

  it('skips canonical private Context replace when servers and labels match without a recipe ownerRef', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '3',
          labels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/managed-by': 'wrc' },
        },
        spec: { contextId: 'wf-test-recipe', mcpServers: ['server-a', 'server-b'] },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await ensureRecipeContext(
      deps,
      'test-recipe',
      ['server-a', 'server-b'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(mockCustomApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('writes a private Context when the recipe label does not match', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '3',
          labels: { 'clerum.io/recipe': 'other-recipe', 'clerum.io/managed-by': 'wrc' },
        },
        spec: { contextId: 'wf-test-recipe', mcpServers: ['server-a', 'server-b'] },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await ensureRecipeContext(deps, 'test-recipe', ['server-a', 'server-b'], 'mcp-server', ownerRef)

    const replaceCall = mockCustomApi.replaceNamespacedCustomObject.mock.calls[0]?.[0]
    expect(replaceCall).toEqual(
      expect.objectContaining({
        name: 'wf-test-recipe',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            labels: expect.objectContaining({
              'clerum.io/recipe': 'test-recipe',
              'clerum.io/managed-by': 'wrc',
            }),
          }),
        }),
      })
    )
  })

  function contextApiWithLiveState(initial: {
    metadata?: Record<string, unknown>
    spec?: Record<string, unknown>
  }) {
    let live = structuredClone(initial)
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 409 }),
      getNamespacedCustomObject: vi
        .fn()
        .mockImplementation(() => Promise.resolve(structuredClone(live))),
      replaceNamespacedCustomObject: vi.fn().mockImplementation((args: { body: typeof live }) => {
        const currentRv = Number(
          (live.metadata as { resourceVersion?: string } | undefined)?.resourceVersion ?? '0'
        )
        live = {
          ...args.body,
          metadata: {
            ...((args.body.metadata as object | undefined) ?? {}),
            resourceVersion: String(currentRv + 1),
          },
        }
        return Promise.resolve({})
      }),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }
    return { mockCustomApi, deps, liveOf: () => live }
  }

  it('repairs a shared empty contextId once, then skips the next reconcile', async () => {
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const { mockCustomApi, deps, liveOf } = contextApiWithLiveState({
      metadata: {
        resourceVersion: '9',
        labels: {
          'clerum.io/recipe': 'other-recipe',
          'clerum.io/managed-by': 'wrc',
          'clerum.io/context-owner': 'admin',
        },
      },
      spec: {
        contextId: '',
        mcpServers: ['existing-server', 'test-recipe-redis-mcp'],
      },
    })

    await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )
    await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(liveOf().spec?.contextId).toBe('context1')
  })

  it('repairs a private empty contextId once, then skips the next reconcile', async () => {
    const { mockCustomApi, deps, liveOf } = contextApiWithLiveState({
      metadata: {
        resourceVersion: '3',
        labels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/managed-by': 'wrc' },
        ownerReferences: [ownerRef],
      },
      spec: { contextId: '', mcpServers: ['server-a', 'server-b'] },
    })

    await ensureRecipeContext(deps, 'test-recipe', ['server-a', 'server-b'], 'mcp-server', ownerRef)
    await ensureRecipeContext(deps, 'test-recipe', ['server-a', 'server-b'], 'mcp-server', ownerRef)

    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(liveOf().spec?.contextId).toBe('wf-test-recipe')
  })

  it('keeps a non-empty contextId that differs from metadata.name and does not write', async () => {
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '9',
          labels: { 'clerum.io/managed-by': 'wrc', 'clerum.io/recipe': 'other-recipe' },
        },
        spec: {
          contextId: 'legacy-shared-id',
          mcpServers: ['existing-server', 'test-recipe-redis-mcp'],
        },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(mockCustomApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('strips a stale cross-namespace recipe ownerRef from a canonical private Context once', async () => {
    const { mockCustomApi, deps, liveOf } = contextApiWithLiveState({
      metadata: {
        resourceVersion: '3',
        labels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/managed-by': 'wrc' },
        ownerReferences: [ownerRef],
      },
      spec: { contextId: 'wf-test-recipe', mcpServers: ['server-a', 'server-b'] },
    })

    await ensureRecipeContext(
      deps,
      'test-recipe',
      ['server-a', 'server-b'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )
    await ensureRecipeContext(
      deps,
      'test-recipe',
      ['server-a', 'server-b'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(liveOf().metadata).not.toHaveProperty('ownerReferences')
  })

  it('repairs empty contextId and a stale cross-namespace ownerRef in one write', async () => {
    const { mockCustomApi, deps, liveOf } = contextApiWithLiveState({
      metadata: {
        resourceVersion: '3',
        labels: { 'clerum.io/recipe': 'test-recipe', 'clerum.io/managed-by': 'wrc' },
        ownerReferences: [ownerRef],
      },
      spec: { contextId: '', mcpServers: ['server-a', 'server-b'] },
    })

    await ensureRecipeContext(
      deps,
      'test-recipe',
      ['server-a', 'server-b'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )
    await ensureRecipeContext(
      deps,
      'test-recipe',
      ['server-a', 'server-b'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(liveOf().spec?.contextId).toBe('wf-test-recipe')
    expect(liveOf().metadata).not.toHaveProperty('ownerReferences')
  })

  it('preserves foreign ownerReferences and finalizers on a necessary Context write', async () => {
    const foreignOwner = {
      apiVersion: 'example.com/v1',
      kind: 'BackupOwner',
      name: 'backup',
      uid: 'uid-foreign',
    }
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '9',
          labels: { 'clerum.io/recipe': 'other-recipe' },
          ownerReferences: [foreignOwner],
          finalizers: ['example.com/protect'],
        },
        spec: {
          contextId: 'context1',
          mcpServers: ['existing-server', 'test-recipe-redis-mcp'],
        },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    const replaceCall = mockCustomApi.replaceNamespacedCustomObject.mock.calls[0]?.[0] as {
      body?: { metadata?: { ownerReferences?: unknown; finalizers?: string[] } }
    }
    expect(replaceCall.body?.metadata?.ownerReferences).toEqual([foreignOwner])
    expect(replaceCall.body?.metadata?.finalizers).toEqual(['example.com/protect'])
  })

  it('does not write a shared Context when only foreign metadata is present', async () => {
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 409 }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          resourceVersion: '9',
          labels: {
            'clerum.io/recipe': 'other-recipe',
            'clerum.io/managed-by': 'wrc',
          },
          annotations: { 'operator.io/note': 'keep' },
          ownerReferences: [
            {
              apiVersion: 'example.com/v1',
              kind: 'BackupOwner',
              name: 'backup',
              uid: 'uid-foreign',
            },
          ],
          finalizers: ['example.com/protect'],
        },
        spec: {
          contextId: 'context1',
          mcpServers: ['existing-server', 'test-recipe-redis-mcp'],
        },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await ensureRecipeContext(
      deps,
      recipe,
      ['test-recipe-redis-mcp'],
      'mcp-server',
      ownerRef,
      'sandbox-recipes'
    )

    expect(mockCustomApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('H04c — re-throws non-409 errors', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockRejectedValue(new Error('API error')),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await expect(
      ensureRecipeContext(deps, 'test-recipe', ['server-a'], 'mcp-server', ownerRef)
    ).rejects.toThrow('API error')
  })

  it('H04-cross-ns — Context ownerRef STRIPPED when Context ns differs from recipe ns', async () => {
    // Post Phase-8 refactor: recipe CRD lives in sandbox-recipes, Context lives in
    // mcp-server (co-located with McpServer CRDs HCC watches). Cross-namespace
    // ownerRefs are invalid per K8s API, so the builder must omit them when the
    // `recipeNamespace` param differs from the target `namespace`.
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: {} as DelegationDeps['coreApi'],
    }

    await ensureRecipeContext(
      deps,
      'test-recipe',
      ['test-recipe-redis-mcp'],
      'mcp-server', // Context target ns
      ownerRef,
      'sandbox-recipes' // recipe's actual ns
    )

    const callArg = mockCustomApi.createNamespacedCustomObject.mock.calls[0][0]
    expect(callArg.body.metadata.ownerReferences).toBeUndefined()
    expect(callArg.body.metadata.namespace).toBe('mcp-server')
  })
})

describe('delegateTransportWorkloads', () => {
  it('returns delegated server names and creates per-recipe Context (H-04)', async () => {
    const mockCustomApi = {
      // Call 1: McpServer pre-check GET → 404 (new server)
      // Call 2: ensureRecipeContext createNamespacedCustomObject → succeeds
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi
        .fn()
        // Pre-check GET: 404 → server does not exist yet, safe to create
        .mockRejectedValueOnce({ code: 404 }),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }
    const recipe = makeRecipe()

    const delegated = await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())

    expect(delegated).toEqual(['test-recipe-redis-mcp'])
    expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(1)
    // createNamespacedCustomObject called twice: McpServer + per-recipe Context
    expect(mockCustomApi.createNamespacedCustomObject).toHaveBeenCalledTimes(2)
    // Verify the Context CRD was created (second call), NOT the shared allowlist patched
    expect(mockCustomApi.createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'contexts',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'wf-test-recipe' }),
          spec: { contextId: 'wf-test-recipe', mcpServers: ['test-recipe-redis-mcp'] },
        }),
      })
    )
  })

  it('does NOT replace an unchanged McpServer even when the apiserver defaulted extra spec fields', async () => {
    const MCPSERVER_PLURAL = 'mcpservers'
    const recipe = makeRecipe()
    let storedMcpServer: { metadata?: unknown; spec?: Record<string, unknown> } | undefined

    const mockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockImplementation((args: { plural: string }) => {
        if (args.plural === MCPSERVER_PLURAL && storedMcpServer) {
          return Promise.resolve(storedMcpServer)
        }
        return Promise.reject({ code: 404 })
      }),
      createNamespacedCustomObject: vi
        .fn()
        .mockImplementation(
          (args: { plural: string; body: { spec?: Record<string, unknown> } }) => {
            if (args.plural === MCPSERVER_PLURAL) {
              // Simulate the apiserver injecting CRD-defaulted spec fields that
              // buildMcpServerManifest omits (port/enabled/logging/protocol/…). A naive
              // existing.spec-vs-manifest.spec compare would never match → gate never fires.
              // The spec-hash annotation gate must still recognize this as unchanged.
              storedMcpServer = {
                ...args.body,
                spec: { ...args.body.spec, enabled: true, logging: 'stderr', protocol: 'TCP' },
              }
            }
            return Promise.resolve({})
          }
        ),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = { createNamespacedService: vi.fn().mockResolvedValue({}) }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    // First reconcile: McpServer does not exist → created (captured + server-defaulted).
    await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())
    expect(storedMcpServer).toBeDefined()

    // Second reconcile: spec-hash annotation matches (despite defaulted spec) → skip the PUT.
    mockCustomApi.replaceNamespacedCustomObject.mockClear()
    await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())

    const mcpServerReplaceCalls = mockCustomApi.replaceNamespacedCustomObject.mock.calls.filter(
      (call: unknown[]) => (call[0] as { plural?: string } | undefined)?.plural === MCPSERVER_PLURAL
    )
    expect(mcpServerReplaceCalls).toHaveLength(0)
  })

  it('does NOT replace an explicit Context on the second reconcile when the union is already live', async () => {
    const CONTEXT_PLURAL = 'contexts'
    const MCPSERVER_PLURAL = 'mcpservers'
    const recipe = makeRecipe({ spec: { ...makeRecipe().spec, contextRef: 'context1' } })
    let storedMcpServer: { metadata?: unknown; spec?: Record<string, unknown> } | undefined
    let storedContext:
      | {
          metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
          spec?: { mcpServers?: string[] }
        }
      | undefined

    const mockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockImplementation((args: { plural: string }) => {
        if (args.plural === MCPSERVER_PLURAL && storedMcpServer) {
          return Promise.resolve(storedMcpServer)
        }
        if (args.plural === CONTEXT_PLURAL && storedContext) {
          return Promise.resolve(storedContext)
        }
        return Promise.reject({ code: 404 })
      }),
      createNamespacedCustomObject: vi.fn().mockImplementation(
        (args: {
          plural: string
          body: {
            metadata?: { labels?: Record<string, string> }
            spec?: { mcpServers?: string[] }
          }
        }) => {
          if (args.plural === MCPSERVER_PLURAL) {
            storedMcpServer = args.body as typeof storedMcpServer
            return Promise.resolve({})
          }
          if (args.plural === CONTEXT_PLURAL) {
            if (storedContext) {
              return Promise.reject({ code: 409 })
            }
            storedContext = {
              ...args.body,
              metadata: {
                ...args.body.metadata,
                labels: {
                  ...(args.body.metadata?.labels ?? {}),
                  'clerum.io/managed-by': 'wrc',
                },
              },
            }
            return Promise.resolve({})
          }
          return Promise.resolve({})
        }
      ),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = { createNamespacedService: vi.fn().mockResolvedValue({}) }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())
    expect(storedContext).toBeDefined()

    mockCustomApi.replaceNamespacedCustomObject.mockClear()
    await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())

    const contextReplaceCalls = mockCustomApi.replaceNamespacedCustomObject.mock.calls.filter(
      (call: unknown[]) => (call[0] as { plural?: string } | undefined)?.plural === CONTEXT_PLURAL
    )
    expect(contextReplaceCalls).toHaveLength(0)
    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ plural: CONTEXT_PLURAL, name: 'context1' })
    )
  })

  it('DOES replace an McpServer when the desired spec-hash differs (changed recipe / pre-upgrade object)', async () => {
    const MCPSERVER_PLURAL = 'mcpservers'
    const SPEC_HASH = 'clerum.io/spec-hash'
    const recipe = makeRecipe()
    let storedMcpServer:
      | { metadata?: { annotations?: Record<string, string> }; spec?: Record<string, unknown> }
      | undefined

    const mockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockImplementation((args: { plural: string }) => {
        if (args.plural === MCPSERVER_PLURAL && storedMcpServer) {
          return Promise.resolve(storedMcpServer)
        }
        return Promise.reject({ code: 404 })
      }),
      createNamespacedCustomObject: vi
        .fn()
        .mockImplementation((args: { plural: string; body: unknown }) => {
          if (args.plural === MCPSERVER_PLURAL) {
            storedMcpServer = args.body as typeof storedMcpServer
          }
          return Promise.resolve({})
        }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = { createNamespacedService: vi.fn().mockResolvedValue({}) }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())
    expect(storedMcpServer).toBeDefined()

    // Stamp a stale hash → as if the desired manifest changed (or a pre-upgrade object).
    storedMcpServer!.metadata = {
      ...(storedMcpServer!.metadata ?? {}),
      annotations: { ...(storedMcpServer!.metadata?.annotations ?? {}), [SPEC_HASH]: 'stale-hash' },
    }
    mockCustomApi.replaceNamespacedCustomObject.mockClear()
    await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())

    const mcpServerReplaceCalls = mockCustomApi.replaceNamespacedCustomObject.mock.calls.filter(
      (call: unknown[]) => (call[0] as { plural?: string } | undefined)?.plural === MCPSERVER_PLURAL
    )
    expect(mcpServerReplaceCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('Issue #408: drops the carried-over network-ready ack pair from the replace on a spec change', async () => {
    const MCPSERVER_PLURAL = 'mcpservers'
    const SPEC_HASH = 'clerum.io/spec-hash'
    const NETWORK_READY = 'clerum.io/network-ready'
    const NETWORK_READY_GEN = 'clerum.io/network-ready-observed-generation'
    const recipe = makeRecipe()
    let storedMcpServer:
      | { metadata?: { annotations?: Record<string, string> }; spec?: Record<string, unknown> }
      | undefined

    const mockCustomApi = {
      getNamespacedCustomObject: vi.fn().mockImplementation((args: { plural: string }) => {
        if (args.plural === MCPSERVER_PLURAL && storedMcpServer) {
          return Promise.resolve(storedMcpServer)
        }
        return Promise.reject({ code: 404 })
      }),
      createNamespacedCustomObject: vi
        .fn()
        .mockImplementation((args: { plural: string; body: unknown }) => {
          if (args.plural === MCPSERVER_PLURAL) {
            storedMcpServer = args.body as typeof storedMcpServer
          }
          return Promise.resolve({})
        }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = { createNamespacedService: vi.fn().mockResolvedValue({}) }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())
    expect(storedMcpServer).toBeDefined()

    // Simulate a prior-generation HCC ack carried on the live object, plus a stale
    // spec-hash so the desired manifest differs and the replace path is taken.
    storedMcpServer!.metadata = {
      ...(storedMcpServer!.metadata ?? {}),
      annotations: {
        ...(storedMcpServer!.metadata?.annotations ?? {}),
        [SPEC_HASH]: 'stale-hash',
        [NETWORK_READY]: 'true',
        [NETWORK_READY_GEN]: '1',
      },
    }
    mockCustomApi.replaceNamespacedCustomObject.mockClear()
    await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())

    const replaceCall = mockCustomApi.replaceNamespacedCustomObject.mock.calls.find(
      (call: unknown[]) => (call[0] as { plural?: string } | undefined)?.plural === MCPSERVER_PLURAL
    ) as [{ body: { metadata: { annotations: Record<string, string> } } }] | undefined
    expect(replaceCall).toBeDefined()

    const replacedAnnotations = replaceCall![0].body.metadata.annotations
    // The stale network ack pair must NOT be carried forward into the new generation.
    expect(replacedAnnotations[NETWORK_READY]).toBeUndefined()
    expect(replacedAnnotations[NETWORK_READY_GEN]).toBeUndefined()
    // Non-network annotations (the freshly stamped spec-hash from the manifest) survive.
    expect(replacedAnnotations[SPEC_HASH]).toBeDefined()
    expect(replacedAnnotations[SPEC_HASH]).not.toBe('stale-hash')
  })

  it('does NOT patch shared Context (H-04 isolation — no patchNamespacedCustomObject)', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi.fn().mockRejectedValueOnce({ code: 404 }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await delegateTransportWorkloads(deps, makeRecipe(), 'mcp-server', new Map())

    // patchNamespacedCustomObject must NOT be called — no shared context mutation
    expect(mockCustomApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('recipe with no transport workloads does NOT create per-recipe Context (H-04)', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'no-mcp', namespace: 'sandbox-recipes', uid: 'uid-no-mcp' },
      spec: {
        workloads: [
          { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 }, // no transport
        ],
      },
    }

    const delegated = await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())

    expect(delegated).toEqual([])
    // No Context or McpServer created
    expect(mockCustomApi.createNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('skips non-transport workloads', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi
        .fn()
        // Pre-check GET: 404 → server does not exist yet, safe to create
        .mockRejectedValueOnce({ code: 404 }),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }
    const recipe = makeRecipeWithBindings() // has redis (no transport) + redis-mcp (transport)

    const delegated = await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())

    // Only redis-mcp delegated, not redis
    expect(delegated).toEqual(['bound-recipe-redis-mcp'])
    // McpServer + Context = 2 creates
    expect(mockCustomApi.createNamespacedCustomObject).toHaveBeenCalledTimes(2)
  })

  it('M3 — handles existing recipe-owned McpServer with replace (resourceVersion)', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi
        .fn()
        // Pre-check GET: server exists AND has clerum.io/recipe label → recipe-owned, replace path
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '42', labels: { 'clerum.io/recipe': 'test-recipe' } },
        }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }
    const recipe = makeRecipe()

    const delegated = await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())

    expect(delegated).toEqual(['test-recipe-redis-mcp'])
    // Verify McpServer replace was called with resourceVersion from existing object
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-recipe-redis-mcp',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: '42' }),
        }),
      })
    )
    // Per-recipe Context was created (via createNamespacedCustomObject)
    expect(mockCustomApi.createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ plural: 'contexts' })
    )
  })

  it('rejects an existing McpServer owned by a different recipe label', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi.fn().mockResolvedValueOnce({
        metadata: { resourceVersion: '42', labels: { 'clerum.io/recipe': 'other-recipe' } },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    try {
      await expect(
        delegateTransportWorkloads(deps, makeRecipe(), 'mcp-server', new Map())
      ).rejects.toThrow(/Delegation failed for workload\(s\): redis-mcp/)
      expect(mockCustomApi.replaceNamespacedCustomObject).not.toHaveBeenCalled()
      expect(mockCustomApi.createNamespacedCustomObject).not.toHaveBeenCalledWith(
        expect.objectContaining({ plural: 'contexts' })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('retries McpServer replace conflicts with the latest object', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '42', labels: { 'clerum.io/recipe': 'test-recipe' } },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '43', labels: { 'clerum.io/recipe': 'test-recipe' } },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '44', labels: { 'clerum.io/recipe': 'test-recipe' } },
        }),
      replaceNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce({ code: 409 })
        .mockRejectedValueOnce({ code: 409 })
        .mockResolvedValueOnce({}),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    const delegated = await delegateTransportWorkloads(deps, makeRecipe(), 'mcp-server', new Map())

    expect(delegated).toEqual(['test-recipe-redis-mcp'])
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(3)
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        name: 'test-recipe-redis-mcp',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: '44' }),
        }),
      })
    )
  })

  it('keeps delegation non-fatal when a recipe-owned McpServer remains after conflict retries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const recipe = makeRecipe()
    const desiredManifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '42', labels: { 'clerum.io/recipe': 'test-recipe' } },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '43', labels: { 'clerum.io/recipe': 'test-recipe' } },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '44', labels: { 'clerum.io/recipe': 'test-recipe' } },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '45', labels: { 'clerum.io/recipe': 'test-recipe' } },
          spec: desiredManifest.spec,
        }),
      replaceNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce({ code: 409 })
        .mockRejectedValueOnce({ code: 409 })
        .mockRejectedValueOnce({ code: 409 }),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    try {
      const delegated = await delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())

      expect(delegated).toEqual(['test-recipe-redis-mcp'])
      expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(3)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('existing spec already matches'))
      expect(mockCustomApi.createNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ plural: 'contexts' })
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not hide exhausted McpServer conflicts when the remaining recipe-owned object is stale', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recipe = makeRecipe()
    const desiredManifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const staleSpec = { ...(desiredManifest.spec as Record<string, unknown>), image: 'old:image' }
    const mockCustomApi = {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '42', labels: { 'clerum.io/recipe': 'test-recipe' } },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '43', labels: { 'clerum.io/recipe': 'test-recipe' } },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '44', labels: { 'clerum.io/recipe': 'test-recipe' } },
        })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '45', labels: { 'clerum.io/recipe': 'test-recipe' } },
          spec: staleSpec,
        }),
      replaceNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce({ code: 409 })
        .mockRejectedValueOnce({ code: 409 })
        .mockRejectedValueOnce({ code: 409 }),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    try {
      await expect(
        delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())
      ).rejects.toThrow(/Delegation failed for workload\(s\): redis-mcp/)
      expect(mockCustomApi.createNamespacedCustomObject).not.toHaveBeenCalledWith(
        expect.objectContaining({ plural: 'contexts' })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('updates an existing McpServer when create races with another reconciler', async () => {
    const mockCustomApi = {
      createNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce({ code: 409 })
        .mockResolvedValueOnce({}),
      getNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce({ code: 404 })
        .mockResolvedValueOnce({
          metadata: { resourceVersion: '44', labels: { 'clerum.io/recipe': 'test-recipe' } },
        }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    const delegated = await delegateTransportWorkloads(deps, makeRecipe(), 'mcp-server', new Map())

    expect(delegated).toEqual(['test-recipe-redis-mcp'])
    expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-recipe-redis-mcp',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: '44' }),
        }),
      })
    )
    expect(mockCustomApi.createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ plural: 'contexts' })
    )
  })

  it('H1 — continues loop on per-workload error, throws aggregated error', async () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'multi', namespace: 'sandbox-recipes', uid: 'uid-multi' },
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'w1',
            type: 'deployment',
            image: 'img:1',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
          {
            id: 'w2',
            type: 'deployment',
            image: 'img:2',
            port: 3001,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    }
    const mockCustomApi = {
      createNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce(new Error('API down')) // w1 McpServer create fails
        .mockResolvedValueOnce({}) // w2 McpServer create succeeds
        .mockResolvedValueOnce({}), // per-recipe Context create succeeds
      getNamespacedCustomObject: vi
        .fn()
        // w1 pre-check GET: 404 → new server, proceed to create (which then throws "API down")
        .mockRejectedValueOnce({ code: 404 })
        // w2 pre-check GET: 404 → new server, proceed to create (succeeds)
        .mockRejectedValueOnce({ code: 404 }),
    }
    const mockCoreApi = {
      createNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await expect(delegateTransportWorkloads(deps, recipe, 'mcp-server', new Map())).rejects.toThrow(
      'Delegation failed for workload(s): w1'
    )

    // w2 Service was still created (loop continued past w1 error)
    expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(2)
  })
})

describe('cleanupDelegation — error accumulation', () => {
  it('H2 — continues cleanup for all workloads, throws aggregated error', async () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'multi', namespace: 'sandbox-recipes', uid: 'uid-multi' },
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'w1',
            type: 'deployment',
            image: 'img:1',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
          {
            id: 'w2',
            type: 'deployment',
            image: 'img:2',
            port: 3001,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    }
    const mockCustomApi = {
      deleteNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce(new Error('API down')) // w1 McpServer delete fails
        .mockResolvedValueOnce({}) // w2 McpServer delete succeeds
        .mockResolvedValueOnce({}), // per-recipe Context delete succeeds
      deleteCollectionNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    }
    const mockCoreApi = {
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      deleteCollectionNamespacedService: vi.fn().mockResolvedValue({}),
    }
    const deps: DelegationDeps = {
      customApi: mockCustomApi as unknown as DelegationDeps['customApi'],
      coreApi: mockCoreApi as unknown as DelegationDeps['coreApi'],
    }

    await expect(cleanupDelegation(deps, recipe, 'mcp-server')).rejects.toThrow(
      'Cleanup failed for workload(s): w1'
    )

    // w2 was still cleaned up (loop continued past w1 error)
    expect(mockCoreApi.deleteNamespacedService).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'multi-w2' })
    )
  })
})

// ─── Issue #15 — McpServer CRD label consistency ──────────────────────────

describe('mcpServerName label alignment (Issue #15)', () => {
  it('McpServer CRD manifest name matches mcpServerName()', () => {
    const recipe = makeRecipe()
    const manifest = buildMcpServerManifest(recipe.spec.workloads![0], recipe, 'mcp-server')!
    const meta = manifest.metadata as { name: string }
    expect(meta.name).toBe(mcpServerName('test-recipe', 'redis-mcp'))
    expect(meta.name).toBe('test-recipe-redis-mcp')
  })

  it('Transport Service name matches mcpServerName()', () => {
    const recipe = makeRecipe()
    const svc = buildTransportService(recipe.spec.workloads![0], recipe, 'mcp-server')!
    expect(svc.metadata?.name).toBe('test-recipe-redis-mcp')
  })

  it('mcpServerName format is {recipeName}-{workloadId} for NetworkPolicy alignment', () => {
    expect(mcpServerName('mcp-redis-cache', 'redis-mcp')).toBe('mcp-redis-cache-redis-mcp')
    expect(mcpServerName('mcp-postgres', 'pg-mcp')).toBe('mcp-postgres-pg-mcp')
    expect(mcpServerName('mongodb-mcp-stack', 'mongodb-mcp-server')).toBe(
      'mongodb-mcp-stack-mongodb-mcp-server'
    )
  })
})

// ─── preDeployMcpServers ─────────────────────────────────────────────────────

describe('preDeployMcpServers', () => {
  function makePreDeployDeps(overrides?: Partial<DelegationDeps>): DelegationDeps {
    return {
      customApi: {
        createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
        patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      } as any,
      coreApi: {
        createNamespacedService: vi.fn().mockResolvedValue({}),
        readNamespacedService: vi.fn().mockRejectedValue({ code: 404 }),
        replaceNamespacedService: vi.fn().mockResolvedValue({}),
        deleteNamespacedService: vi.fn().mockResolvedValue({}),
      } as any,
      ...overrides,
    }
  }

  it('returns server names for successfully pre-deployed workloads', async () => {
    const deps = makePreDeployDeps()
    const recipe = makeRecipe()

    const result = await preDeployMcpServers(deps, recipe, 'mcp-server', new Map())

    expect(result).toEqual(['test-recipe-redis-mcp'])
  })

  it('adds PRE_DEPLOY_ANNOTATION to the McpServer CRD manifest', async () => {
    // Capture all create calls — preDeployMcpServers now also creates the per-recipe
    // Context CRD (ensureRecipeContext), so we filter by kind to find the McpServer.
    const capturedManifests: Record<string, unknown>[] = []
    const deps = makePreDeployDeps({
      customApi: {
        createNamespacedCustomObject: vi
          .fn()
          .mockImplementation((opts: { body: Record<string, unknown> }) => {
            capturedManifests.push(opts.body)
            return Promise.resolve({})
          }),
        getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
        patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      } as any,
    })
    const recipe = makeRecipe()

    await preDeployMcpServers(deps, recipe, 'mcp-server', new Map())

    const mcpServerManifest = capturedManifests.find(m => (m as any).kind === 'McpServer')
    expect(mcpServerManifest).not.toBeUndefined()
    const meta = (mcpServerManifest as any).metadata as Record<string, unknown>
    expect((meta.annotations as Record<string, string>)[PRE_DEPLOY_ANNOTATION]).toBe('true')
  })

  it('throws when any workload pre-deploy fails (not silent)', async () => {
    const deps = makePreDeployDeps({
      customApi: {
        createNamespacedCustomObject: vi.fn().mockRejectedValue(new Error('quota exceeded')),
        getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
        patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      } as any,
    })
    const recipe = makeRecipe()

    await expect(preDeployMcpServers(deps, recipe, 'mcp-server', new Map())).rejects.toThrow(
      'Pre-deploy failed for workload(s): redis-mcp'
    )
  })

  it('throws when the pre-deploy Context allowlist cannot be persisted', async () => {
    const deps = makePreDeployDeps({
      customApi: {
        createNamespacedCustomObject: vi
          .fn()
          .mockImplementation((opts: { body: { kind?: string } }) => {
            if (opts.body.kind === 'Context') {
              return Promise.reject(new Error('context denied'))
            }
            return Promise.resolve({})
          }),
        getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
        patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      } as any,
    })
    const recipe = makeRecipe()

    await expect(preDeployMcpServers(deps, recipe, 'mcp-server', new Map())).rejects.toThrow(
      'Pre-deploy Context allowlist failed'
    )
  })

  it('returns empty array when recipe has no transport workloads', async () => {
    const deps = makePreDeployDeps()
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [{ id: 'plain-job', type: 'deployment' as const, image: 'alpine' }],
      },
    })

    const result = await preDeployMcpServers(deps, recipe, 'mcp-server', new Map())

    expect(result).toEqual([])
  })
})

describe('waitForExternalEgressReady', () => {
  it('accepts ExternalEgressReady=True only for the current McpServer generation', async () => {
    const deps: DelegationDeps = {
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { generation: 3 },
          status: {
            conditions: [
              {
                type: 'ExternalEgressReady',
                status: 'True',
                reason: 'Reconciled',
                observedGeneration: 3,
              },
            ],
          },
        }),
      } as any,
      coreApi: {} as any,
    }

    await expect(
      waitForExternalEgressReady(deps, ['web-search'], 'mcp-server', 1000)
    ).resolves.toEqual({ ready: true, pending: [], failed: [] })
  })

  it('does not accept stale ExternalEgressReady=True from an older generation', async () => {
    const deps: DelegationDeps = {
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { generation: 3 },
          status: {
            conditions: [
              {
                type: 'ExternalEgressReady',
                status: 'True',
                reason: 'Reconciled',
                observedGeneration: 2,
              },
            ],
          },
        }),
      } as any,
      coreApi: {} as any,
    }

    const result = await waitForExternalEgressReady(deps, ['web-search'], 'mcp-server', 1)

    expect(result.ready).toBe(false)
    expect(result.pending).toEqual(['web-search'])
    expect(result.failed).toEqual([])
  })

  it('treats stale ExternalEgressReady=False as pending rather than a current failure', async () => {
    const deps: DelegationDeps = {
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { generation: 3 },
          status: {
            conditions: [
              {
                type: 'ExternalEgressReady',
                status: 'False',
                reason: 'DnsResolutionFailed',
                message: 'old failure',
                observedGeneration: 2,
              },
            ],
          },
        }),
      } as any,
      coreApi: {} as any,
    }

    const result = await waitForExternalEgressReady(deps, ['web-search'], 'mcp-server', 1)

    expect(result.ready).toBe(false)
    expect(result.pending).toEqual(['web-search'])
    expect(result.failed).toEqual([])
  })
})

// ─── Issue #408 — waitForNetworkReady must be generation-aware ─────────────────
// The flat `clerum.io/network-ready: "true"` ack carries no generation. A stale
// ack carried over from a previous generation must NOT satisfy the gate for the
// current generation. Mirrors waitForExternalEgressReady's observedGeneration
// freshness check, but for the annotation pair.
describe('waitForNetworkReady (Issue #408 generation-aware gate)', () => {
  it('rejects a network-ready ack stamped for an older generation', async () => {
    const deps: DelegationDeps = {
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: {
            generation: 2,
            annotations: {
              'clerum.io/network-ready': 'true',
              'clerum.io/network-ready-observed-generation': '1',
            },
          },
        }),
      } as any,
      coreApi: {} as any,
    }

    const result = await waitForNetworkReady(deps, ['srv-a'], 'mcp-server', 25)

    expect(result.ready).toBe(false)
    expect(result.pending).toEqual(['srv-a'])
  })

  it('rejects a network-ready ack that lacks the generation stamp', async () => {
    const deps: DelegationDeps = {
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: {
            generation: 2,
            annotations: { 'clerum.io/network-ready': 'true' },
          },
        }),
      } as any,
      coreApi: {} as any,
    }

    const result = await waitForNetworkReady(deps, ['srv-a'], 'mcp-server', 25)

    expect(result.ready).toBe(false)
    expect(result.pending).toEqual(['srv-a'])
  })

  it('accepts a network-ready ack stamped for the current generation', async () => {
    const deps: DelegationDeps = {
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: {
            generation: 2,
            annotations: {
              'clerum.io/network-ready': 'true',
              'clerum.io/network-ready-observed-generation': '2',
            },
          },
        }),
      } as any,
      coreApi: {} as any,
    }

    await expect(waitForNetworkReady(deps, ['srv-a'], 'mcp-server', 25)).resolves.toEqual({
      ready: true,
      pending: [],
    })
  })

  it('tolerates a missing (non-numeric) generation and accepts the flat ack', async () => {
    const deps: DelegationDeps = {
      customApi: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { annotations: { 'clerum.io/network-ready': 'true' } },
        }),
      } as any,
      coreApi: {} as any,
    }

    await expect(waitForNetworkReady(deps, ['srv-a'], 'mcp-server', 25)).resolves.toEqual({
      ready: true,
      pending: [],
    })
  })

  it('treats a 404 (McpServer deleted) as resolved', async () => {
    const deps: DelegationDeps = {
      customApi: {
        getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      } as any,
      coreApi: {} as any,
    }

    await expect(waitForNetworkReady(deps, ['srv-a'], 'mcp-server', 25)).resolves.toEqual({
      ready: true,
      pending: [],
    })
  })
})

// ─── Issue #637 — transport Secret ownership gate ──────────────────────────────
// Proves the transport delegation path (McpServer CRD copy) is fail-closed for
// cross-recipe Secret ownership, mirroring the non-transport render gate. HCC
// materializes the McpServer CRD WITHOUT re-checking ownership, so the WRC must
// strip/skip a denied envSecret or imagePullSecret before it ever reaches HCC.
describe('Issue #637 — transport Secret ownership gate', () => {
  function transportRecipeWithEnvSecret(secretName: string): WorkflowRecipeCRD {
    return makeRecipe({
      metadata: { name: 'attacker', namespace: 'sandbox-recipes', uid: 'uid-attacker' },
      spec: {
        workloads: [
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'clerum/redis-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
            envSecret: { name: secretName, keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
      },
    })
  }

  const deniedMap = (name: string): ReadonlyMap<string, SecretAccess> =>
    new Map([[name, { state: 'denied' }]])
  const accessibleMap = (name: string): ReadonlyMap<string, SecretAccess> =>
    new Map([[name, { state: 'accessible', keys: new Set(['token']) }]])

  const transportDeps = (overrides?: {
    customApi?: Record<string, unknown>
    coreApi?: Record<string, unknown>
  }): DelegationDeps => ({
    customApi: {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      ...overrides?.customApi,
    } as unknown as DelegationDeps['customApi'],
    coreApi: {
      createNamespacedService: vi.fn().mockResolvedValue({}),
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
      ...overrides?.coreApi,
    } as unknown as DelegationDeps['coreApi'],
  })

  describe('transportWorkloadSecretDenied', () => {
    it('is true when the envSecret is denied or its ownership is unverifiable (error)', () => {
      const w = transportRecipeWithEnvSecret('foreign').spec.workloads![0]
      expect(transportWorkloadSecretDenied(w, new Map([['foreign', { state: 'denied' }]]))).toBe(
        true
      )
      expect(transportWorkloadSecretDenied(w, new Map([['foreign', { state: 'error' }]]))).toBe(
        true
      )
    })

    it('is false when accessible, missing, absent from the map, or no map provided', () => {
      const w = transportRecipeWithEnvSecret('owned').spec.workloads![0]
      expect(transportWorkloadSecretDenied(w, accessibleMap('owned'))).toBe(false)
      expect(transportWorkloadSecretDenied(w, new Map([['owned', { state: 'missing' }]]))).toBe(
        false
      )
      expect(transportWorkloadSecretDenied(w, new Map())).toBe(false)
      expect(transportWorkloadSecretDenied(w, undefined)).toBe(false)
    })

    it('is true when ANY imagePullSecret is denied', () => {
      const w = {
        ...transportRecipeWithEnvSecret('owned').spec.workloads![0],
        imagePullSecrets: ['foreign-pull'],
      }
      expect(transportWorkloadSecretDenied(w, deniedMap('foreign-pull'))).toBe(true)
    })
  })

  describe('buildMcpServerManifest secret gating', () => {
    it('strips a denied envSecret from the McpServer spec (defense in depth)', () => {
      const recipe = transportRecipeWithEnvSecret('foreign')
      const manifest = buildMcpServerManifest(
        recipe.spec.workloads![0],
        recipe,
        'mcp-server',
        deniedMap('foreign')
      )!
      expect((manifest.spec as Record<string, unknown>).envSecret).toBeUndefined()
    })

    it('keeps an accessible envSecret', () => {
      const recipe = transportRecipeWithEnvSecret('owned')
      const manifest = buildMcpServerManifest(
        recipe.spec.workloads![0],
        recipe,
        'mcp-server',
        accessibleMap('owned')
      )!
      expect((manifest.spec as Record<string, unknown>).envSecret).toEqual({
        name: 'owned',
        keys: [{ secretKey: 'token', envVar: 'TOKEN' }],
      })
    })

    it('forwards only ownership-allowed imagePullSecrets', () => {
      const recipe = transportRecipeWithEnvSecret('owned')
      recipe.spec.workloads![0].imagePullSecrets = ['foreign-pull', 'owned-pull']
      const access = new Map<string, SecretAccess>([
        ['owned', { state: 'accessible', keys: new Set(['token']) }],
        ['foreign-pull', { state: 'denied' }],
        ['owned-pull', { state: 'accessible', keys: new Set() }],
      ])
      const manifest = buildMcpServerManifest(
        recipe.spec.workloads![0],
        recipe,
        'mcp-server',
        access
      )!
      expect((manifest.spec as Record<string, unknown>).imagePullSecrets).toEqual([
        { name: 'owned-pull' },
      ])
    })
  })

  describe('preDeployMcpServers skips denied transport workloads', () => {
    it('creates NO McpServer CRD and NO Service for a denied envSecret workload', async () => {
      const deps = transportDeps()
      const recipe = transportRecipeWithEnvSecret('foreign')

      const result = await preDeployMcpServers(deps, recipe, 'mcp-server', deniedMap('foreign'))

      expect(result).toEqual([])
      expect(deps.customApi.createNamespacedCustomObject).not.toHaveBeenCalled()
      expect(deps.coreApi.createNamespacedService).not.toHaveBeenCalled()
    })
  })

  describe('delegateTransportWorkloads skips denied transport workloads', () => {
    it('does NOT (re)create the McpServer CRD for a denied envSecret workload', async () => {
      const deps = transportDeps()
      const recipe = transportRecipeWithEnvSecret('foreign')

      const delegated = await delegateTransportWorkloads(
        deps,
        recipe,
        'mcp-server',
        deniedMap('foreign')
      )

      expect(delegated).toEqual([])
      expect(deps.customApi.createNamespacedCustomObject).not.toHaveBeenCalled()
    })
  })

  describe('deleteTransportDelegation (revocation teardown)', () => {
    it('deletes the McpServer CRD and the transport Service', async () => {
      const deps = transportDeps()
      const recipe = transportRecipeWithEnvSecret('foreign')

      await deleteTransportDelegation(deps, recipe, recipe.spec.workloads![0], 'mcp-server')

      expect(deps.customApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          plural: 'mcpservers',
          name: 'attacker-redis-mcp',
          namespace: 'mcp-server',
        })
      )
      expect(deps.coreApi.deleteNamespacedService).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'attacker-redis-mcp', namespace: 'mcp-server' })
      )
    })

    it('tolerates 404 (already gone) on both the CRD and the Service', async () => {
      const deps = transportDeps({
        customApi: { deleteNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }) },
        coreApi: { deleteNamespacedService: vi.fn().mockRejectedValue({ code: 404 }) },
      })
      const recipe = transportRecipeWithEnvSecret('foreign')

      await expect(
        deleteTransportDelegation(deps, recipe, recipe.spec.workloads![0], 'mcp-server')
      ).resolves.toBeUndefined()
    })
  })
})
