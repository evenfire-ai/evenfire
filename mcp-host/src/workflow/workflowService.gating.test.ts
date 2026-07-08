import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { config } from '../config'
import type { SingleTurnProvider } from '../llm'
import { getMcpHostJwtStateFilePath } from './mcpHostJwtState'
import { gateStep } from './userApprovalRequester'
import { WorkflowService } from './workflowService'

vi.mock('./userApprovalRequester', () => ({
  gateStep: vi.fn(),
}))

function makeJwt(exp: number, label: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      exp,
      label,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'recipe-1',
      hostRefs: ['sandbox-recipes/recipe-1'],
    })
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

function makeProvider(): SingleTurnProvider {
  return {
    completeSingleTurn: vi.fn().mockResolvedValue({
      content: 'final answer',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    completeSingleTurnWithTools: vi.fn().mockResolvedValue({
      content: 'final answer',
      tool_calls: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    getProviderType: () => 'openai',
    classifyError: () => ({
      code: 'unknown_error',
      retryable: false,
      message: 'unknown',
    }),
  } as unknown as SingleTurnProvider
}

describe('WorkflowService approval gating', () => {
  const originalMcpHostRuntimeAccessToken = config.mcpHostRuntimeAccessToken
  const originalMcpHostRuntimeRefreshToken = config.mcpHostRuntimeRefreshToken
  const originalMcpHostGatewayUrl = config.mcpHostGatewayUrl
  const originalOutputDir = process.env.CLERUM_OUTPUT_DIR
  const originalRuntimeAuthStateDir = process.env.MCP_HOST_RUNTIME_AUTH_STATE_DIR
  const originalWorkflowNamespace = process.env.CLERUM_WORKFLOW_NAMESPACE
  const originalWorkflowRecipe = process.env.CLERUM_WORKFLOW_RECIPE
  let tempOutputDir = ''

  beforeEach(() => {
    vi.clearAllMocks()
    const nowSecs = Math.floor(Date.now() / 1000)
    config.mcpHostRuntimeAccessToken = makeJwt(nowSecs + 600, 'initial-access')
    config.mcpHostRuntimeRefreshToken = makeJwt(nowSecs + 900, 'initial-refresh')
    config.mcpHostGatewayUrl = 'http://gateway:8092'
    tempOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-approval-auth-'))
    process.env.CLERUM_OUTPUT_DIR = tempOutputDir
    process.env.MCP_HOST_RUNTIME_AUTH_STATE_DIR = tempOutputDir
    process.env.CLERUM_WORKFLOW_NAMESPACE = 'sandbox-recipes'
    process.env.CLERUM_WORKFLOW_RECIPE = 'recipe-1-run-12345678'
  })

  afterEach(() => {
    config.mcpHostRuntimeAccessToken = originalMcpHostRuntimeAccessToken
    config.mcpHostRuntimeRefreshToken = originalMcpHostRuntimeRefreshToken
    config.mcpHostGatewayUrl = originalMcpHostGatewayUrl
    if (originalOutputDir === undefined) {
      delete process.env.CLERUM_OUTPUT_DIR
    } else {
      process.env.CLERUM_OUTPUT_DIR = originalOutputDir
    }
    if (originalRuntimeAuthStateDir === undefined) {
      delete process.env.MCP_HOST_RUNTIME_AUTH_STATE_DIR
    } else {
      process.env.MCP_HOST_RUNTIME_AUTH_STATE_DIR = originalRuntimeAuthStateDir
    }
    if (originalWorkflowNamespace === undefined) {
      delete process.env.CLERUM_WORKFLOW_NAMESPACE
    } else {
      process.env.CLERUM_WORKFLOW_NAMESPACE = originalWorkflowNamespace
    }
    if (originalWorkflowRecipe === undefined) {
      delete process.env.CLERUM_WORKFLOW_RECIPE
    } else {
      process.env.CLERUM_WORKFLOW_RECIPE = originalWorkflowRecipe
    }
    fs.rmSync(tempOutputDir, { recursive: true, force: true })
  })

  it('reuses one mcpHost runtime auth holder across step executions and preserves rotated tokens', async () => {
    const provider = makeProvider()
    vi.mocked(gateStep).mockImplementationOnce(async (_params, auth) => {
      auth.accessToken = 'rotated-access'
      auth.refreshToken = 'rotated-refresh'
      return { status: 'approved' }
    })
    vi.mocked(gateStep).mockResolvedValueOnce({ status: 'approved' })

    const service = new WorkflowService('recipe-1', {
      llmFactory: () => provider,
      mcpClientFactory: () => {
        throw new Error('mcp client should not be created in this test')
      },
    })

    expect(
      service.configure({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o' })
    ).toMatchObject({ configured: true })

    const first = await service.executeStep({
      stepId: 'step-1',
      instruction: 'Explain the result',
      requiresApproval: {
        target: { userId: 'user-1' },
        message: 'approve step 1',
      },
      contextVars: { workflowExecutionId: 'exec-123' },
    })
    const second = await service.executeStep({
      stepId: 'step-2',
      instruction: 'Explain the next result',
      requiresApproval: {
        target: { userId: 'user-1' },
        message: 'approve step 2',
      },
      contextVars: { workflowExecutionId: 'exec-123' },
    })

    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    expect(gateStep).toHaveBeenCalledTimes(2)

    const firstParams = vi.mocked(gateStep).mock.calls[0]?.[0]
    const secondParams = vi.mocked(gateStep).mock.calls[1]?.[0]
    const firstAuth = vi.mocked(gateStep).mock.calls[0]?.[1]
    const secondAuth = vi.mocked(gateStep).mock.calls[1]?.[1]

    expect(firstParams).toMatchObject({
      stepId: 'step-1',
      executionId: 'exec-123',
      runtimeMcpHostRef: 'sandbox-recipes/recipe-1-run-12345678',
    })
    expect(secondParams).toMatchObject({
      stepId: 'step-2',
      executionId: 'exec-123',
      runtimeMcpHostRef: 'sandbox-recipes/recipe-1-run-12345678',
    })
    expect(firstAuth).toBe(secondAuth)
    expect(secondAuth).toMatchObject({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      baseUrl: 'http://gateway:8092',
    })
  })

  it('starts a new workflow service from the fresher persisted mcpHost runtime tokens after rotation', async () => {
    const provider = makeProvider()
    // Use future Unix timestamps so loadPersistedRuntimeAuth's freshness guard
    // (persistedRefreshExpiry <= now => treat as stale) does not discard the
    // rotated refresh token as already-expired.
    const nowSecs = Math.floor(Date.now() / 1000)
    const mountedAccess = makeJwt(nowSecs + 100, 'mounted-access')
    const mountedRefresh = makeJwt(nowSecs + 200, 'mounted-refresh')
    const rotatedAccess = makeJwt(nowSecs + 300, 'rotated-access')
    const rotatedRefresh = makeJwt(nowSecs + 400, 'rotated-refresh')
    config.mcpHostRuntimeAccessToken = mountedAccess
    config.mcpHostRuntimeRefreshToken = mountedRefresh

    vi.mocked(gateStep)
      .mockImplementationOnce(async (_params, auth) => {
        auth.accessToken = rotatedAccess
        auth.refreshToken = rotatedRefresh
        await auth.persistRotatedTokens?.({
          accessToken: rotatedAccess,
          refreshToken: rotatedRefresh,
        })
        return { status: 'approved' }
      })
      .mockResolvedValueOnce({ status: 'approved' })

    const firstService = new WorkflowService('recipe-1', {
      llmFactory: () => provider,
      mcpClientFactory: () => {
        throw new Error('mcp client should not be created in this test')
      },
    })
    firstService.configure({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o' })

    await firstService.executeStep({
      stepId: 'step-rotated-once',
      instruction: 'Explain the result',
      requiresApproval: {
        target: { userId: 'user-1' },
        message: 'approve step 1',
      },
    })

    const secondService = new WorkflowService('recipe-1', {
      llmFactory: () => provider,
      mcpClientFactory: () => {
        throw new Error('mcp client should not be created in this test')
      },
    })
    secondService.configure({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o' })

    const result = await secondService.executeStep({
      stepId: 'step-after-restart',
      instruction: 'Explain the next result',
      requiresApproval: {
        target: { userId: 'user-1' },
        message: 'approve step 2',
      },
    })

    expect(result.status).toBe('completed')
    expect(gateStep).toHaveBeenCalledTimes(2)
    expect(vi.mocked(gateStep).mock.calls[1]?.[1]).toMatchObject({
      accessToken: rotatedAccess,
      refreshToken: rotatedRefresh,
      baseUrl: 'http://gateway:8092',
    })
  })

  it('does not use correlationId as an approval execution id fallback', async () => {
    const provider = makeProvider()
    vi.mocked(gateStep).mockResolvedValueOnce({ status: 'approved' })

    const service = new WorkflowService('recipe-1', {
      llmFactory: () => provider,
      mcpClientFactory: () => {
        throw new Error('mcp client should not be created in this test')
      },
    })

    service.configure({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o' })

    const result = await service.executeStep({
      stepId: 'step-correlation',
      instruction: 'Explain the result',
      requiresApproval: {
        target: { teamId: 'team-1' },
        message: 'approve step',
      },
      contextVars: { correlationId: 'corr-456' },
    })

    expect(result.status).toBe('completed')
    expect(gateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: undefined,
      }),
      expect.any(Object)
    )
  })

  it('prefers mounted mcpHost runtime tokens over stale persisted approval state on startup', async () => {
    const provider = makeProvider()
    const mountedAccess = makeJwt(500, 'mounted-access')
    const mountedRefresh = makeJwt(600, 'mounted-refresh')
    const persistedAccess = makeJwt(300, 'persisted-access')
    const persistedRefresh = makeJwt(400, 'persisted-refresh')
    config.mcpHostRuntimeAccessToken = mountedAccess
    config.mcpHostRuntimeRefreshToken = mountedRefresh
    vi.mocked(gateStep).mockResolvedValueOnce({ status: 'approved' })

    const stateFile = getMcpHostJwtStateFilePath(tempOutputDir)
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        accessToken: persistedAccess,
        refreshToken: persistedRefresh,
      }),
      'utf-8'
    )

    const service = new WorkflowService('recipe-1', {
      llmFactory: () => provider,
      mcpClientFactory: () => {
        throw new Error('mcp client should not be created in this test')
      },
    })

    expect(
      service.configure({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o' })
    ).toMatchObject({ configured: true })

    const result = await service.executeStep({
      stepId: 'step-persisted',
      instruction: 'Explain the result',
      requiresApproval: {
        target: { userId: 'user-1' },
        message: 'approve persisted state',
      },
    })

    expect(result.status).toBe('completed')
    expect(gateStep).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        accessToken: mountedAccess,
        refreshToken: mountedRefresh,
        baseUrl: 'http://gateway:8092',
      })
    )
  })
})

// #592: the recipe runtime registers internal tools through resolveInternalTools()
// (workflowService.ts), which drops the clerum__context_files_* tools when no
// SharedFileSystem is mounted. internalTools.test.ts covers the accessor in
// isolation; this suite covers the WIRING — it drives the real
// WorkflowService.executeStep() path and inspects the tool list actually handed
// to the LLM provider, so a regression that reverts the gated accessor to a raw
// [...INTERNAL_TOOLS] spread is caught behaviorally (not by a source-token guard).
describe('WorkflowService internal-tools capability gate (#592)', () => {
  const originalOutputDir = process.env.CLERUM_OUTPUT_DIR
  const originalMounts = process.env.CLERUM_CONTEXT_FILES_MOUNTS
  let tempDir = ''

  beforeEach(() => {
    vi.clearAllMocks()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-capgate-'))
    process.env.CLERUM_OUTPUT_DIR = tempDir
  })

  afterEach(() => {
    if (originalOutputDir === undefined) delete process.env.CLERUM_OUTPUT_DIR
    else process.env.CLERUM_OUTPUT_DIR = originalOutputDir
    if (originalMounts === undefined) delete process.env.CLERUM_CONTEXT_FILES_MOUNTS
    else process.env.CLERUM_CONTEXT_FILES_MOUNTS = originalMounts
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // Run a single text step that allow-lists a generate tool plus the two
  // context-files tools, then return the tool names that reached the provider.
  // getFilteredTools() returns the intersection of the REGISTERED catalog with
  // the include list, so a context-files tool appears here only if
  // workflowService actually registered it (i.e. the SFS gate let it through).
  async function toolNamesExposedToProvider(): Promise<string[]> {
    const provider = makeProvider()
    const service = new WorkflowService('recipe-1', {
      llmFactory: () => provider,
      mcpClientFactory: () => {
        throw new Error('mcp client must not be created in this gate test')
      },
    })
    expect(
      service.configure({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o' })
    ).toMatchObject({ configured: true })

    const result = await service.executeStep({
      stepId: 'gate-step',
      instruction: 'Do the thing.',
      allowedTools: {
        include: [
          'clerum__generate_markdown',
          'clerum__context_files_list',
          'clerum__context_files_read',
        ],
      },
    })
    expect(result.status).toBe('completed')

    const call = vi.mocked(provider.completeSingleTurnWithTools).mock.calls[0]
    expect(
      call,
      'provider.completeSingleTurnWithTools was not called with a tool list'
    ).toBeDefined()
    const toolDefs = call[1] as Array<{ name: string }>
    return toolDefs.map(t => t.name)
  }

  it('does NOT expose clerum__context_files_* to recipe steps when no SFS is mounted (the recipe case)', async () => {
    delete process.env.CLERUM_CONTEXT_FILES_MOUNTS
    const names = await toolNamesExposedToProvider()
    // The allow-listed generate tool proves tools ARE being surfaced...
    expect(names).toContain('clerum__generate_markdown')
    // ...while the gated context-files tools are absent because no SFS is mounted.
    expect(names).not.toContain('clerum__context_files_list')
    expect(names).not.toContain('clerum__context_files_read')
  })

  it('exposes clerum__context_files_* only when CLERUM_CONTEXT_FILES_MOUNTS is present (gate is env-driven, not hardcoded off)', async () => {
    process.env.CLERUM_CONTEXT_FILES_MOUNTS = JSON.stringify([
      { name: 'team-mission', namespace: 'mcp-host', mountPath: '/cf/tm', pvcName: 'sfs-x-files' },
    ])
    const names = await toolNamesExposedToProvider()
    expect(names).toContain('clerum__generate_markdown')
    expect(names).toContain('clerum__context_files_list')
    expect(names).toContain('clerum__context_files_read')
  })
})
