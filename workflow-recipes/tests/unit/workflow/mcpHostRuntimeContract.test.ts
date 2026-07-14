import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '../../../../')

function readRepo(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function listFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir)
  if (!fs.existsSync(abs)) return []
  const entries = fs.readdirSync(abs, { withFileTypes: true })
  return entries.flatMap(entry => {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'build'].includes(entry.name)) return []
      return listFiles(rel)
    }
    return [rel]
  })
}

describe('mcpHost runtime token contract', () => {
  it('keeps retired approval token names out of active runtime surfaces', () => {
    const oldApprovalEnvPrefix = 'APPROVAL'
    const oldApprovalSecretPrefix = 'approval'
    const oldApprovalPascal = `${oldApprovalSecretPrefix[0]!.toUpperCase()}${oldApprovalSecretPrefix.slice(1)}`
    const forbidden = [
      `${oldApprovalEnvPrefix}_ACCESS_TOKEN`,
      `${oldApprovalEnvPrefix}_REFRESH_TOKEN`,
      `${oldApprovalSecretPrefix}-access-token`,
      `${oldApprovalSecretPrefix}-refresh-token`,
      `${oldApprovalSecretPrefix}-tokens`,
      `${oldApprovalSecretPrefix}TokenIssuerClient`,
      `issue${oldApprovalPascal}Tokens`,
    ]
    const activeSurfaces = [
      'workflow-recipes/src',
      'host-context-controller/src',
      'mcp-host/src',
      'scripts/e2e',
      'scripts/load',
      'deploy/base',
      'desktop-app/test/e2e-playwright',
    ]

    const files = activeSurfaces
      .flatMap(listFiles)
      .filter(file => /\.(ts|tsx|js|sh|ya?ml)$/.test(file))
    const hits = files.flatMap(file => {
      const content = readRepo(file)
      return forbidden
        .filter(pattern => content.includes(pattern))
        .map(pattern => `${file}: ${pattern}`)
    })

    expect(hits).toEqual([])
  })

  it('keeps workflow native tools split into focused modules', () => {
    const expectedModules = [
      'mcp-host/src/core/tools/workflowBrokerClient.ts',
      'mcp-host/src/core/tools/workflowShared.ts',
      'mcp-host/src/core/tools/workflowTriggerTool.ts',
      'mcp-host/src/core/tools/workflowReadTools.ts',
    ]
    for (const modulePath of expectedModules) {
      expect(fs.existsSync(path.join(REPO_ROOT, modulePath))).toBe(true)
    }

    const barrel = readRepo('mcp-host/src/core/tools/workflow.ts')
    expect(barrel).toContain("from './workflowReadTools'")
    expect(barrel).toContain("from './workflowTriggerTool'")
    expect(barrel).toContain('createWorkflowTools')
    expect(barrel).not.toContain('class WorkflowTriggerTool')
    expect(barrel).not.toContain('class WorkflowBrokerClient')
    expect(barrel).not.toContain('fetch(')
    expect(barrel).not.toContain('gateStep(')
  })

  it('keeps control-api workflow lanes explicit after removing the route factory', () => {
    const removedFactoryPath = 'control-api/src/routes/workflows/handlers.ts'
    expect(fs.existsSync(path.join(REPO_ROOT, removedFactoryPath))).toBe(false)

    const expectedRouteModules = [
      'control-api/src/routes/admin/workflows/index.ts',
      'control-api/src/routes/admin/workflows/read.routes.ts',
      'control-api/src/routes/admin/workflows/runs.routes.ts',
      'control-api/src/routes/admin/workflows/grants.routes.ts',
      'control-api/src/routes/admin/workflows/trigger.routes.ts',
      'control-api/src/routes/external/workflows/index.ts',
      'control-api/src/routes/external/workflows/read.routes.ts',
      'control-api/src/routes/external/workflows/runs.routes.ts',
      'control-api/src/routes/external/workflows/trigger.routes.ts',
      'control-api/src/routes/mcp-host/workflows/index.ts',
      'control-api/src/routes/mcp-host/workflows/read.routes.ts',
      'control-api/src/routes/mcp-host/workflows/trigger.routes.ts',
      'control-api/src/routes/workflows/shared/auth.ts',
      'control-api/src/services/workflows/workflowRecipeAccessService.ts',
      'control-api/src/services/workflows/workflowRunReadService.ts',
      'control-api/src/services/workflows/workflowTriggerService.ts',
      'control-api/src/services/workflows/workflowGrantManagementService.ts',
    ]
    for (const modulePath of expectedRouteModules) {
      expect(fs.existsSync(path.join(REPO_ROOT, modulePath))).toBe(true)
    }

    const routeIndexes = [
      'control-api/src/routes/admin/workflows/index.ts',
      'control-api/src/routes/external/workflows/index.ts',
      'control-api/src/routes/mcp-host/workflows/index.ts',
    ]
    for (const modulePath of routeIndexes) {
      const content = readRepo(modulePath)
      expect(content).not.toContain('createWorkflowsRouter')
      expect(content).not.toContain('exposeAuthIssue')
      expect(content).not.toContain('exposeLeader')
      expect(content).not.toContain('exposeRuns')
      expect(content).not.toContain('exposeGrants')
    }
  })
})
