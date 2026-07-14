import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { config } from '../config'
import { createMcpHostRuntimeAuth } from './runtimeAuthFactory'

function runtimeJwt(binding: {
  hostRefs: string[]
  recipeNamespace: string
  recipeName: string
  exp?: number
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(binding)).toString('base64url')
  return `${header}.${payload}.sig`
}

describe('createMcpHostRuntimeAuth reissue binding', () => {
  const originalAccess = config.mcpHostRuntimeAccessToken
  const originalRefresh = config.mcpHostRuntimeRefreshToken
  const originalGateway = config.mcpHostGatewayUrl
  const originalControlCredential = config.mcpHostWorkflowControlToken
  const originalControlCredentialFile = config.mcpHostWorkflowControlTokenFile
  const originalWorkflowRecipe = config.workflowRecipeName
  const originalApprovalRecipe = config.userApprovalRequestRecipeName
  const originalOutputDir = process.env.CLERUM_OUTPUT_DIR
  const originalFetch = global.fetch
  let tempOutputDir = ''
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tempOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-auth-factory-'))
    process.env.CLERUM_OUTPUT_DIR = tempOutputDir
    config.mcpHostGatewayUrl = 'http://control-api.test:8090'
    config.mcpHostWorkflowControlToken = ''
    config.mcpHostWorkflowControlTokenFile = ''
    config.workflowRecipeName = ''
    config.userApprovalRequestRecipeName = ''
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh' }), {
        status: 200,
      })
    )
    ;(global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    config.mcpHostRuntimeAccessToken = originalAccess
    config.mcpHostRuntimeRefreshToken = originalRefresh
    config.mcpHostGatewayUrl = originalGateway
    config.mcpHostWorkflowControlToken = originalControlCredential
    config.mcpHostWorkflowControlTokenFile = originalControlCredentialFile
    config.workflowRecipeName = originalWorkflowRecipe
    config.userApprovalRequestRecipeName = originalApprovalRecipe
    if (originalOutputDir === undefined) {
      delete process.env.CLERUM_OUTPUT_DIR
    } else {
      process.env.CLERUM_OUTPUT_DIR = originalOutputDir
    }
    ;(global as { fetch: typeof fetch }).fetch = originalFetch
    fs.rmSync(tempOutputDir, { recursive: true, force: true })
  })

  it('wires workflow reissue with recipe_name for WRC recipe-bound tokens', async () => {
    config.mcpHostRuntimeAccessToken = runtimeJwt({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'report-recipe',
      hostRefs: ['sandbox-recipes/report-recipe'],
    })
    config.mcpHostRuntimeRefreshToken = 'workflow-refresh'

    const auth = createMcpHostRuntimeAuth()
    expect(auth?.reIssueTokens).toBeTypeOf('function')
    await auth!.reIssueTokens!()

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer workflow-refresh')
    expect(JSON.parse(String(init.body))).toEqual({ recipe_name: 'report-recipe' })
  })

  it('wires standalone HCC reissue with host_ref from hostRefs[0]', async () => {
    config.mcpHostRuntimeAccessToken = runtimeJwt({
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      hostRefs: ['chatllm'],
    })
    config.mcpHostRuntimeRefreshToken = 'standalone-refresh'

    const auth = createMcpHostRuntimeAuth()
    expect(auth).toMatchObject({
      hostRef: 'chatllm',
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
    })
    expect(auth?.reIssueTokens).toBeTypeOf('function')
    await auth!.reIssueTokens!()

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer standalone-refresh')
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({ host_ref: 'chatllm' })
    expect(body).not.toHaveProperty('recipe_name')
  })

  it('loads the workflow-control credential from the mounted file for workflow runtime pods', () => {
    const credentialPath = path.join(tempOutputDir, 'control-credential')
    fs.writeFileSync(credentialPath, 'mounted-control\n')
    config.mcpHostRuntimeAccessToken = runtimeJwt({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'report-recipe',
      hostRefs: ['sandbox-recipes/report-recipe'],
    })
    config.mcpHostRuntimeRefreshToken = 'workflow-refresh'
    config.mcpHostWorkflowControlTokenFile = credentialPath

    const auth = createMcpHostRuntimeAuth()

    expect(auth?.mcpHostControlToken).toBe('mounted-control')
  })
})
