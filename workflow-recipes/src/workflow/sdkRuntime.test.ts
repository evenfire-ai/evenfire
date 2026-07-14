import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RuntimeDependencies, runWorkflowRuntime } from './sdkRuntime'

function buildRuntimeDeps(overrides: Partial<RuntimeDependencies> = {}): RuntimeDependencies {
  const coordinator = {
    injectSignal: vi.fn(),
    resolveOrder: vi.fn((steps: unknown[]) => steps),
    runWorkflow: vi.fn(),
  }
  const status = {
    getWorkflowStatus: vi.fn().mockResolvedValue({ workflowPhase: 'pending', steps: [] }),
    reportWorkflowStatus: vi.fn().mockResolvedValue(undefined),
    reportStepStatus: vi.fn().mockResolvedValue(undefined),
  }
  const signals = {
    pollSignals: vi.fn().mockReturnValue(vi.fn()),
    hasSignal: vi.fn().mockReturnValue(false),
  }
  const mcpHost = {
    healthCheck: vi.fn().mockResolvedValue({ status: 'unhealthy' }),
  }

  return {
    config: {
      workflowName: 'agentic-recipe',
      wrcUrl: 'http://wrc.example',
      tokenProvider: {},
    },
    spec: {
      agent: { provider: 'openai', model: 'gpt-4.1' },
      steps: [{ id: 'brief', instruction: 'write the brief' }],
    },
    coordinator,
    status,
    signals,
    mcpHost,
    mcpHostReadyAttempts: 1,
    mcpHostReadyDelayMs: 0,
    ...overrides,
  } as unknown as RuntimeDependencies
}

describe('runWorkflowRuntime mcp-host readiness', () => {
  it('reports mcp-host readiness timeout as recovering infrastructure', async () => {
    const deps = buildRuntimeDeps()

    const result = await runWorkflowRuntime(deps)

    expect(result).toMatchObject({
      exitCode: 1,
      workflowPhase: 'recovering',
      failureReason: 'mcp_host not ready',
    })
    expect(deps.status.reportWorkflowStatus).toHaveBeenCalledWith('recovering', {
      failureReason: 'mcp_host not ready',
    })
    expect(deps.status.reportWorkflowStatus).not.toHaveBeenCalledWith('failed', expect.anything())
  })
})

describe('runWorkflowRuntime GFS publishing', () => {
  it('publishes final outputs before reporting the workflow completed', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'wrc-gfs-'))
    const accessFile = join(tmp, 'access')
    await writeFile(accessFile, 'runtime-access')
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 201 }))
    vi.stubGlobal('fetch', fetchFn)
    const previousFile = process.env.GFS_ACCESS_FILE
    const previousRunId = process.env.CLERUM_WORKFLOW_RUN_ID
    process.env.GFS_ACCESS_FILE = accessFile
    process.env.CLERUM_WORKFLOW_RUN_ID = 'run-456'
    try {
      const deps = buildRuntimeDeps({
        spec: {
          namespace: 'sandbox-recipes',
          name: 'publish-recipe',
          steps: [{ id: 'publish' }],
          gfs: { publishTargets: [{ drive: 'main', target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] },
        },
      })
      vi.mocked(deps.coordinator.runWorkflow).mockResolvedValue({ publish: { ok: true } })

      const result = await runWorkflowRuntime(deps)

      expect(result).toMatchObject({ exitCode: 0, workflowPhase: 'completed' })
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('/v1/resources/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/children'),
        expect.objectContaining({ method: 'POST' })
      )
      expect(deps.status.reportWorkflowStatus).toHaveBeenCalledWith('completed', expect.any(Object))
    } finally {
      vi.unstubAllGlobals()
      if (previousFile === undefined) delete process.env.GFS_ACCESS_FILE
      else process.env.GFS_ACCESS_FILE = previousFile
      if (previousRunId === undefined) delete process.env.CLERUM_WORKFLOW_RUN_ID
      else process.env.CLERUM_WORKFLOW_RUN_ID = previousRunId
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('fails the workflow when GFSC denies a configured publish target', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'wrc-gfs-'))
    const accessFile = join(tmp, 'access')
    await writeFile(accessFile, 'runtime-access')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 }))
    )
    const previousFile = process.env.GFS_ACCESS_FILE
    process.env.GFS_ACCESS_FILE = accessFile
    try {
      const deps = buildRuntimeDeps({
        spec: {
          namespace: 'sandbox-recipes',
          name: 'publish-recipe',
          steps: [{ id: 'publish' }],
          gfs: { publishTargets: [{ drive: 'main', target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] },
        },
      })
      vi.mocked(deps.coordinator.runWorkflow).mockResolvedValue({ publish: { ok: true } })

      const result = await runWorkflowRuntime(deps)

      expect(result).toMatchObject({ exitCode: 1, workflowPhase: 'failed' })
      expect(result.failureReason).toMatch(/HTTP 403/)
      expect(deps.status.reportWorkflowStatus).toHaveBeenCalledWith(
        'failed',
        expect.objectContaining({ failureReason: expect.stringMatching(/HTTP 403/) })
      )
      expect(deps.status.reportWorkflowStatus).not.toHaveBeenCalledWith(
        'completed',
        expect.anything()
      )
    } finally {
      vi.unstubAllGlobals()
      if (previousFile === undefined) delete process.env.GFS_ACCESS_FILE
      else process.env.GFS_ACCESS_FILE = previousFile
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
