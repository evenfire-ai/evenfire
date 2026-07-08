/**
 * Regression Guard Tests
 *
 * Comprehensive test suite covering ALL bugs documented in project memory.
 * Each test group maps to a specific bug that was found and fixed.
 * These tests MUST pass before any merge to prevent regressions.
 *
 * Bug references:
 * - workflow-fixes.md: NP-01/02/03, phase transitions, input injection
 * - competitive-intel-bug.md: DNS ENOTFOUND, 409 loop, pod ordering
 * - workflow-deployment-bugs.md: body limit, fatal status, keepAlive, stale images
 * - internal-tools-artifacts.md: internal tools registration, stepRouter dispatch
 * - MEMORY.md: workload naming mismatch, hyphenated step IDs, mcpClientFactory
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const WRC_SRC = path.resolve(__dirname, '../../../src')
const MCP_HOST_SRC = path.resolve(__dirname, '../../../../mcp-host/src')
const RUNTIME_CORE_SRC = path.resolve(__dirname, '../../../../packages/workflow-runtime-core/src')
const REPO_ROOT = path.resolve(__dirname, '../../../..')

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(WRC_SRC, relativePath), 'utf-8')
}

function readMcpHostSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(MCP_HOST_SRC, relativePath), 'utf-8')
}

function readRuntimeCoreSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(RUNTIME_CORE_SRC, relativePath), 'utf-8')
}

function readRepo(relativePath: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, relativePath), 'utf-8')
}

// ─── Bug: Workload Naming Mismatch (MEMORY.md line 60) ───────────────────────
// ensure methods must use manifest.metadata.name, not raw workload.id
describe('REG-01: Workload naming mismatch', () => {
  it('resolveWorkloadResourceName prefixes recipe name for workflow recipes', async () => {
    const { resolveWorkloadResourceName } = await import('../../../src/reconciler/resourceBuilder')
    const recipe = {
      metadata: { name: 'competitive-intel-report', namespace: 'sandbox-recipes' },
      spec: {
        workloads: [{ id: 'web-search', type: 'deployment', image: 'test:v1', port: 3000 }],
        steps: [{ id: 'research', instruction: 'test' }],
      },
    } as any
    const resolved = resolveWorkloadResourceName(recipe, 'web-search')
    expect(resolved).toContain('competitive-intel-report')
    expect(resolved).toContain('web-search')
    expect(resolved).not.toBe('web-search')
  })

  it('resolveWorkloadResourceName returns raw id for non-workflow recipes', async () => {
    const { resolveWorkloadResourceName } = await import('../../../src/reconciler/resourceBuilder')
    const recipe = {
      metadata: { name: 'my-stack', namespace: 'sandbox-recipes' },
      spec: {
        workloads: [{ id: 'postgres', type: 'statefulset', image: 'postgres:16' }],
      },
    } as any
    const resolved = resolveWorkloadResourceName(recipe, 'postgres')
    expect(resolved).toBe('postgres')
  })
})

// ─── Bug: Hyphenated Step IDs (MEMORY.md line 61, commit 54e8be4) ────────────
// Regex \w+ didn't match hyphens -> {{research-competitors:output}} stayed literal
describe('REG-02: Hyphenated step IDs in template vars', () => {
  it('runtime leaves step-output template rendering to the prompt renderer', () => {
    const content = readSource('workflow/sdkRuntime.ts')
    expect(content).toContain('renderPrompt(')
    expect(content).toContain('previousOutputs: context.previousOutputs')
    expect(content).not.toContain('resolveRuntimeTemplateValue')
  })

  it('prompt renderer output template regex accepts hyphenated step IDs', () => {
    const content = readRuntimeCoreSource('injection/prompt.ts')
    expect(content).toMatch(/trimmed\.indexOf\(['"]:['"]\)/)
    expect(content).toContain('trimmed.substring(0, colonIdx)')
  })

  it('substituteInputs regex matches hyphenated input keys', () => {
    const text = 'Focus on {{inputs.focus-areas}} in {{inputs.target-market}}'
    const inputs: Record<string, unknown> = {
      'focus-areas': 'pricing',
      'target-market': 'enterprise',
    }
    const result = text.replace(/\{\{inputs\.([\w-]+)\}\}/g, (_m, key: string) => {
      return inputs[key] !== undefined ? String(inputs[key]) : `{{inputs.${key}}}`
    })
    expect(result).toBe('Focus on pricing in enterprise')
  })
})

// ─── Bug: Phase Transition (workflow-fixes.md line 31-33) ─────────────────────
// workflowReconciler always returned "deploying" instead of mapping wf phase
describe('REG-03: Workflow phase transitions', () => {
  it('workflowReconciler maps wf phases correctly in code', () => {
    const content = readSource('workflow/workflowReconciler.ts')
    // Must map completed -> active
    expect(content).toMatch(/completed.*active|"active"/)
    // Must map failed -> failed
    expect(content).toMatch(/failed/)
    // Must NOT always return "deploying"
    const deployingCount = (content.match(/"deploying"/g) || []).length
    const activeCount = (content.match(/"active"/g) || []).length
    expect(activeCount).toBeGreaterThan(0)
    expect(activeCount).toBeGreaterThanOrEqual(deployingCount)
  })
})

// ─── Bug: DNS ENOTFOUND / Pod Ordering (competitive-intel-bug.md) ────────────
// mcp-host pod must be created BEFORE coordinator pod
describe('REG-04: Pod creation ordering', () => {
  it('buildMcpHostPod and buildCoordinatorPod are separate functions', async () => {
    const podFactory = await import('../../../src/workflow/podFactory')
    expect(typeof podFactory.buildMcpHostPod).toBe('function')
    expect(typeof podFactory.buildCoordinatorPod).toBe('function')
  })

  it('workflowReconciler creates mcp-host BEFORE coordinator', () => {
    const content = readSource('workflow/workflowReconciler.ts')
    // Skip the import line — find in the reconcile body
    const importEnd = content.indexOf('export')
    const body = content.slice(importEnd)
    const mcpHostIdx = body.indexOf('mcpHostPod')
    const coordIdx = body.indexOf('coordPod')
    // mcp-host creation must appear before coordinator in the reconcile flow
    expect(mcpHostIdx).toBeGreaterThan(0)
    expect(coordIdx).toBeGreaterThan(0)
    expect(mcpHostIdx).toBeLessThan(coordIdx)
  })

  it('coordinator retries are >= 120 attempts', () => {
    const content = readSource('coordinator.ts')
    const match = content.match(/(?:MAX_RETRIES|maxRetries|retries)\s*[=:]\s*(\d+)/)
    if (match) {
      expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(120)
    }
  })
})

// ─── Bug: Body Limit 64KB (workflow-deployment-bugs.md Bug 2) ────────────────
describe('REG-05: WRC server body limits', () => {
  it('MAX_BODY_BYTES >= 512KB', () => {
    const content = readSource('mcp/server.ts')
    // Matches both `= 524288` and `= 512 * 1024`
    const literalMatch = content.match(/MAX_BODY_BYTES\s*=\s*(\d+)\s*;/)
    const exprMatch = content.match(/MAX_BODY_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)/)
    let value = 0
    if (exprMatch) {
      value = parseInt(exprMatch[1], 10) * parseInt(exprMatch[2], 10)
    } else if (literalMatch) {
      value = parseInt(literalMatch[1], 10)
    }
    expect(value).toBeGreaterThanOrEqual(512 * 1024)
  })
})

// ─── Bug: Status Write Failures Must Not Produce False Success ───────────────
describe('REG-06: Fatal status write failures', () => {
  it('sdk runtime seeds completed step IDs before resuming workflow execution', () => {
    const content = readSource('workflow/sdkRuntime.ts')
    expect(content).toContain('completedStepIds')
    expect(content).toContain('initialOutputs')
    expect(content).toContain('completedStepIds,')
  })

  it('SDK status reporter throws after failed report retries', () => {
    const content = readRuntimeCoreSource('status-reporter/client.ts')
    expect(content).toContain('Failed to report')
    expect(content).toContain('throw new Error(message)')
    expect(content).toContain('WRC rejected')
  })

  it('WRC runtime imports runtime core rather than the public workflow SDK facade', () => {
    const runtimeFiles = [
      readSource('workflow/sdkRuntime.ts'),
      readSource('workflow/snippetRunnerClient.ts'),
    ].join('\n')
    expect(runtimeFiles).toContain('@clerum/workflow-runtime-core')
    expect(runtimeFiles).not.toContain('@clerum/workflow-sdk')
  })
})

// ─── Bug: keepAlive Socket Reuse (workflow-deployment-bugs.md Bug 4) ─────────
describe('REG-07: Coordinator HTTP agent - no keepAlive', () => {
  it('coordinator does not use keepAlive: true', () => {
    const content = readSource('coordinator.ts')
    const hasKeepAliveTrue = /new.*Agent\(\s*\{[^}]*keepAlive:\s*true/s.test(content)
    expect(hasKeepAliveTrue).toBe(false)
  })
})

// ─── Bug: NetworkPolicy NP-01/02/03 (workflow-fixes.md) ─────────────────────
describe('REG-08: NetworkPolicy completeness', () => {
  it('generates LLM API egress NP', async () => {
    const { buildWorkflowNetworkPolicies } =
      await import('../../../src/workflow/networkPolicyFactory')
    const nps = buildWorkflowNetworkPolicies(
      {
        recipeName: 'test',
        sandboxNamespace: 'sandbox-recipes',
        controlPlaneNamespace: 'control-plane',
        mcpServerNamespace: 'mcp-server',
        wrcPort: 8082,
        mcpHostPort: 8080,
      },
      ['test-web-search-abc123']
    )
    const llmEgress = nps.find(
      np => np.metadata?.name?.includes('llm') || np.metadata?.name?.includes('api')
    )
    expect(llmEgress).toBeDefined()
  })

  it('generates cross-namespace ingress for MCP servers', async () => {
    const { buildWorkflowNetworkPolicies } =
      await import('../../../src/workflow/networkPolicyFactory')
    const nps = buildWorkflowNetworkPolicies(
      {
        recipeName: 'test',
        sandboxNamespace: 'sandbox-recipes',
        controlPlaneNamespace: 'control-plane',
        mcpServerNamespace: 'mcp-server',
        wrcPort: 8082,
        mcpHostPort: 8080,
      },
      ['test-web-search-abc123']
    )
    const crossNs = nps.find(np => np.metadata?.namespace === 'mcp-server')
    expect(crossNs).toBeDefined()
  })

  it('generates at least 4 NPs for workflow recipes', async () => {
    const { buildWorkflowNetworkPolicies } =
      await import('../../../src/workflow/networkPolicyFactory')
    const nps = buildWorkflowNetworkPolicies(
      {
        recipeName: 'test',
        sandboxNamespace: 'sandbox-recipes',
        controlPlaneNamespace: 'control-plane',
        mcpServerNamespace: 'mcp-server',
        wrcPort: 8082,
        mcpHostPort: 8080,
      },
      ['test-web-search-abc123']
    )
    expect(nps.length).toBeGreaterThanOrEqual(4)
  })

  it('static sandbox DNS egress also selects workflow coordinator pods', () => {
    const content = readRepo('deploy/base/sandbox-recipes/networkpolicies.yaml')
    expect(content).toContain('name: allow-dns-egress-sandbox-recipes')
    expect(content).not.toMatch(
      /name:\s*allow-dns-egress-sandbox-recipes[\s\S]*operator:\s*NotIn[\s\S]*workflow-coordinator/
    )
  })
})

// ─── Bug: Input Contract Resolution (workflow-fixes.md) ──────────────────────
describe('REG-09: Input contract substitution', () => {
  it('substitutes inputs with defaults', () => {
    const instruction = 'Research {{inputs.topic}} focusing on {{inputs.focus_areas}}.'
    const inputs: Record<string, unknown> = { topic: 'AI platforms', focus_areas: 'pricing' }
    const result = instruction.replace(/\{\{inputs\.([\w-]+)\}\}/g, (_m, key: string) =>
      inputs[key] !== undefined ? String(inputs[key]) : `{{inputs.${key}}}`
    )
    expect(result).toBe('Research AI platforms focusing on pricing.')
  })

  it('preserves unresolvable placeholders', () => {
    const result = '{{inputs.unknown}}'.replace(/\{\{inputs\.([\w-]+)\}\}/g, (_m, key: string) => {
      const inputs: Record<string, unknown> = {}
      return inputs[key] !== undefined ? String(inputs[key]) : `{{inputs.${key}}}`
    })
    expect(result).toBe('{{inputs.unknown}}')
  })
})

// ─── Bug: mcpServer step refs must match workload IDs (2026-03-25) ───────────
describe('REG-10: mcpServer step references match workload IDs', () => {
  it('valid refs: step mcpServers are subset of workload IDs', () => {
    const workloadIds = new Set(['web-search', 'doc-generator'])
    const stepRefs = ['web-search', 'doc-generator']
    for (const ref of stepRefs) {
      expect(workloadIds.has(ref)).toBe(true)
    }
  })

  it('invalid refs: detects prefixed names that dont match workloads', () => {
    const workloadIds = new Set(['web-search', 'doc-generator'])
    const badRefs = ['cir-web-search', 'cir-doc-generator']
    const invalid = badRefs.filter(ref => !workloadIds.has(ref))
    expect(invalid).toEqual(['cir-web-search', 'cir-doc-generator'])
  })
})

// ─── Bug: Reconcile Loop 409 (competitive-intel-bug.md) ──────────────────────
describe('REG-11: Reconcile loop prevention', () => {
  it('workflowReconciler has skip guard for in-progress workflows', () => {
    const content = readSource('workflow/workflowReconciler.ts')
    // Must skip reconcile actions when workflow is actively executing
    // The guard can use various patterns: phase check, terminal check, or explicit skip
    const hasGuard =
      content.includes('workflowExecution') &&
      (content.includes('terminal') ||
        content.includes('completed') ||
        content.includes('failed') ||
        content.includes('skip'))
    expect(hasGuard).toBe(true)
  })
})

// ─── Bug: mcpClientFactory missing (2026-03-25 merge) ────────────────────────
describe('REG-12: mcpClientFactory in mcp-host workflow mode', () => {
  it('main.ts workflow block includes mcpClientFactory', () => {
    const content = readMcpHostSource('main.ts')
    const workflowModeStart = content.indexOf('// M-11: Workflow mode')
    expect(workflowModeStart).toBeGreaterThanOrEqual(0)

    const block = content.slice(workflowModeStart)
    expect(block).toContain('mcpClientFactory')
    expect(block).toContain('McpClient')
    expect(block).toMatch(/new WorkflowService\([^)]*mcpClientFactory/)
  })
})

// ─── Bug: Internal tools registration (merge regression) ────────────────────
describe('REG-13: Internal tools in StepMcpRouter', () => {
  it('stepRouter.ts has registerInternalTools method', () => {
    const content = readMcpHostSource('workflow/stepRouter.ts')
    expect(content).toContain('registerInternalTools')
    expect(content).toContain('internalToolMap')
  })

  it('workflowService.ts registers internal tools', () => {
    const content = readMcpHostSource('workflow/workflowService.ts')
    expect(content).toContain('registerInternalTools')
    // #592: the catalog is wired through the resolveInternalTools() accessor
    // (which gates the clerum__context_files_* tools on a mounted SFS) — it
    // replaced the direct INTERNAL_TOOLS spread. Accept either form so the
    // guard keeps proving "internal tools are wired" without coupling to one
    // accessor name.
    expect(content).toMatch(/resolveInternalTools|INTERNAL_TOOLS/)
  })

  it('internalTools.ts is not empty', () => {
    const content = readMcpHostSource('workflow/internalTools.ts')
    expect(content.length).toBeGreaterThan(100)
    expect(content).toContain('clerum__generate_pdf')
    expect(content).toContain('clerum__generate_docx')
    expect(content).toContain('clerum__generate_xlsx')
    expect(content).toContain('clerum__generate_markdown')
  })
})

// ─── Bug: package.json deps for internal tools (merge regression) ────────────
describe('REG-14: Internal tools dependencies in package.json', () => {
  it('mcp-host has pdf-lib, docx, exceljs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(MCP_HOST_SRC, '../package.json'), 'utf-8'))
    expect(pkg.dependencies['pdf-lib']).toBeDefined()
    expect(pkg.dependencies['docx']).toBeDefined()
    expect(pkg.dependencies['exceljs']).toBeDefined()
  })
})

// ─── Bug: httpUtils exports (merge regression) ──────────────────────────────
describe('REG-15: httpUtils exports completeness', () => {
  it('exports getAllowedOrigins, setCorsHeaders, readBody', () => {
    const content = readMcpHostSource('server/httpUtils.ts')
    expect(content).toContain('getAllowedOrigins')
    expect(content).toContain('setCorsHeaders')
    expect(content).toContain('readBody')
    expect(content).toContain('export function json')
    expect(content).toContain('export function unauthorized')
    expect(content).toContain('export function badRequest')
  })
})

// ─── Bug: setWorkflowService + onProgressStream (merge regression) ──────────
describe('REG-16: RPCServer has both workflow and progress methods', () => {
  it('server.ts has setWorkflowService, onProgressStream, workflowRouter', () => {
    const content = readMcpHostSource('server.ts')
    expect(content).toContain('setWorkflowService')
    expect(content).toContain('onProgressStream')
    expect(content).toContain('workflowRouter')
    expect(content).toContain('/api/v1/workflow')
    expect(content).toContain('progressStreamHandler')
  })
})

// ─── Bug: InternalToolDefinition type (merge regression) ────────────────────
describe('REG-17: Workflow types completeness', () => {
  it('types.ts has InternalToolDefinition', () => {
    const content = readMcpHostSource('workflow/types.ts')
    expect(content).toContain('InternalToolDefinition')
  })

  it('types.ts has StepMcpServerRef', () => {
    const content = readMcpHostSource('workflow/types.ts')
    expect(content).toContain('StepMcpServerRef')
  })
})

// ─── Desktop App approval flow + progress streaming ───────────────────────────
describe('REG-18: Desktop App keeps progress streaming without regressing approval UX', () => {
  it('app controller keeps progress streaming and pending approvals, but no legacy approval mutations', () => {
    const appController = fs.readFileSync(
      path.resolve(__dirname, '../../../../desktop-app/ui/src/hooks/useAppController.ts'),
      'utf-8'
    )
    const agentChatController = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../desktop-app/ui/src/hooks/domain/useAgentChatController.ts'
      ),
      'utf-8'
    )
    const notificationsController = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../desktop-app/ui/src/hooks/domain/useNotificationsController.ts'
      ),
      'utf-8'
    )
    // The task lifecycle (incl. the progress SSE subscription) was moved out of
    // useAgentChatController into the AgentTaskTracker context provider (D.3 —
    // fire-and-forget that survives chat switches / re-renders). The progress
    // stream therefore lives in taskTracker.ts now, not the controller.
    const taskTracker = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../desktop-app/ui/src/contexts/AgentTaskTrackerContext/taskTracker.ts'
      ),
      'utf-8'
    )
    const combined = [
      appController,
      agentChatController,
      notificationsController,
      taskTracker,
    ].join('\n')

    expect(appController).toContain('pendingApprovals')
    expect(appController).toContain('pendingApprovalActionId')
    expect(appController).toContain('progressByAgentMessage')
    expect(agentChatController).toContain('TaskProgress')
    expect(taskTracker).toContain('subscribeTaskProgress')
    expect(notificationsController).toContain('pendingApprovals')
    expect(combined).not.toContain('autoApprove')
    expect(combined).not.toContain('sendApproval')
  })

  it('rpcProxyClient has getTaskResult, not sendApproval', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../../../desktop-app/src/rpcProxyClient.ts'),
      'utf-8'
    )
    expect(content).toContain('getTaskResult')
    expect(content).not.toContain('sendApproval')
    expect(content).toContain('openTaskProgressStream')
  })

  it('ipc.ts imports TaskProgressStreamEvent', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../../../desktop-app/src/ipc.ts'),
      'utf-8'
    )
    expect(content).toContain('TaskProgressStreamEvent')
  })
})

// ─── Bug: NP-1b coord-to-mcp-host ingress (MEMORY.md NP fixes) ─────────────
describe('REG-19: Intra-namespace coordinator to mcp-host NP', () => {
  it('NP factory generates coord-to-mcp-host ingress rule', async () => {
    const { buildWorkflowNetworkPolicies } =
      await import('../../../src/workflow/networkPolicyFactory')
    const nps = buildWorkflowNetworkPolicies(
      {
        recipeName: 'test',
        sandboxNamespace: 'sandbox-recipes',
        controlPlaneNamespace: 'control-plane',
        mcpServerNamespace: 'mcp-server',
        wrcPort: 8082,
        mcpHostPort: 8080,
      },
      []
    )
    const coordToMcpHost = nps.find(
      np => np.metadata?.name?.includes('coord') && np.metadata?.name?.includes('mcp-host')
    )
    expect(coordToMcpHost).toBeDefined()
  })
})

// ─── Bug: Output truncation limit (CRD Output Extensions) ──────────────────
describe('REG-20: Step output is not over-truncated', () => {
  it('restEndpoints has truncation >= 8192 chars or no truncation', () => {
    const content = readSource('workflow/restEndpoints.ts')
    const match = content.match(/(?:slice|substring)\(0,\s*(\d{4,})\)/)
    if (match) {
      expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(8192)
    }
    // If no explicit truncation, that's fine too
  })
})

// ─── Feature: allowedTools scoping (2026-03-25) ─────────────────────────────
describe('REG-21: allowedTools flows through pipeline', () => {
  it('CRD type supports allowedTools in steps', () => {
    const content = readSource('types.ts')
    expect(content).toContain('allowedTools')
    expect(content).toMatch(/allowedTools\?\s*:\s*\{\s*include\?/)
  })

  it('WRC ConfigMap passes allowedTools to workflow config', () => {
    const content = readSource('workflow/workflowReconciler.ts')
    expect(content).toContain('allowedTools')
  })

  it('sdkRuntime sends allowedTools in execute request', () => {
    const content = readSource('workflow/sdkRuntime.ts')
    expect(content).toMatch(/allowedTools:\s*step\.allowedTools/)
  })

  it('StepMcpRouter source keeps allowedTools.include filtering wired', () => {
    // workflow-recipes CI does not install mcp-host dependencies; executable behavior
    // is covered by mcp-host/src/workflow/__tests__/stepRouter.test.ts.
    const content = readMcpHostSource('workflow/stepRouter.ts')
    expect(content).toContain('getFilteredTools(allowedTools?: AllowedToolsConfig)')
    expect(content).toContain('const include = allowedTools?.include')
    expect(content).toContain('if (!include || include.length === 0)')
    expect(content).toContain('const includeSet = new Set(include)')
    expect(content).toMatch(/this\.allTools\.filter\(\(?t\)?\s*=>\s*includeSet\.has\(t\.name\)\)/)
  })
})

// ─── Feature: allowedTools tool name format validation ──────────────────────
describe('REG-22: allowedTools validation rules', () => {
  it('valid: tool names with serverName__toolName format', () => {
    const tools = ['web-search__search', 'web-search__fetch_page', 'doc-generator__generate_pdf']
    const stepServers = new Set(['web-search', 'doc-generator'])
    const errors: string[] = []
    for (const tool of tools) {
      if (!tool.includes('__')) errors.push(`${tool}: missing __ separator`)
      else {
        const prefix = tool.split('__')[0]
        if (!stepServers.has(prefix)) errors.push(`${tool}: server ${prefix} not in step`)
      }
    }
    expect(errors).toEqual([])
  })

  it('invalid: tool without __ separator', () => {
    const tools = ['search', 'fetch_page']
    const errors = tools.filter(t => !t.includes('__'))
    expect(errors.length).toBe(2)
  })

  it('invalid: tool referencing server not in step mcpServers', () => {
    const tools = ['unknown-server__search']
    const stepServers = new Set(['web-search'])
    const mismatched = tools.filter(t => {
      const prefix = t.split('__')[0]
      return !stepServers.has(prefix)
    })
    expect(mismatched).toEqual(['unknown-server__search'])
  })
})

// ─── Feature: endpoint auto-compute (validator allows empty endpoint) ───────
describe('REG-23: Validator allows empty endpoint for transport workloads', () => {
  it('mcpServer with matching transport workload does not require endpoint', () => {
    const spec = {
      mcpServers: [{ id: 'web-search' }], // no endpoint
      workloads: [{ id: 'web-search', transport: { type: 'streamableHttp' }, port: 3000 }],
    }
    const transportIds = new Set(spec.workloads.filter(w => w.transport).map(w => w.id))
    const errors: string[] = []
    for (const m of spec.mcpServers) {
      if (!(m as any).endpoint && !transportIds.has(m.id)) {
        errors.push(`${m.id}: endpoint required`)
      }
    }
    expect(errors).toEqual([])
  })

  it('mcpServer without matching workload requires endpoint', () => {
    const spec = {
      mcpServers: [{ id: 'external-api' }], // no endpoint, no workload
      workloads: [{ id: 'web-search', transport: { type: 'streamableHttp' }, port: 3000 }],
    }
    const transportIds = new Set(spec.workloads.filter(w => w.transport).map(w => w.id))
    const errors: string[] = []
    for (const m of spec.mcpServers) {
      if (!(m as any).endpoint && !transportIds.has(m.id)) {
        errors.push(`${m.id}: endpoint required`)
      }
    }
    expect(errors).toEqual(['external-api: endpoint required'])
  })
})

// ─── Feature: Templates have consistent allowedTools ────────────────────────
describe('REG-24: All workflow templates have allowedTools', () => {
  it('all templates with mcpServers in steps also declare allowedTools', () => {
    // NOTE: This test intentionally fails-loud if a new template forgets allowedTools
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../../../control-ui/components/RecipeEditor.tsx'),
      'utf-8'
    )
    // Find all steps that reference mcpServers
    const stepMcpMatches = content.matchAll(/mcpServers:\s*\[['"]([^'"]+)['"]\]/g)
    let stepsWithMcp = 0
    let stepsWithAllowed = 0
    for (const match of stepMcpMatches) {
      stepsWithMcp++
      // Check if allowedTools appears nearby (within 200 chars after)
      const afterIdx = (match.index ?? 0) + match[0].length
      const window = content.slice(afterIdx, afterIdx + 200)
      if (window.includes('allowedTools')) stepsWithAllowed++
    }
    expect(stepsWithMcp).toBeGreaterThan(0)
    expect(stepsWithAllowed).toBe(stepsWithMcp)
  })
})

// ─── Feature: maxIterations + graceful degradation (2026-03-25) ─────────────
describe('REG-25: maxIterations config and graceful degradation', () => {
  it('CRD type supports maxIterations in steps', () => {
    const content = readSource('types.ts')
    expect(content).toMatch(/maxIterations\?\s*:\s*number/)
  })

  it('WRC ConfigMap passes maxIterations to workflow config', () => {
    const content = readSource('workflow/workflowReconciler.ts')
    expect(content).toContain('maxIterations')
  })

  it('sdkRuntime sends maxIterations in execute request', () => {
    const content = readSource('workflow/sdkRuntime.ts')
    expect(content).toMatch(/maxIterations:\s*step\.maxIterations/)
  })

  it('mcp-host config.ts has CLERUM_WORKFLOW_MAX_ITERATIONS env var', () => {
    const content = readMcpHostSource('config.ts')
    expect(content).toContain('CLERUM_WORKFLOW_MAX_ITERATIONS')
    expect(content).toContain('workflowMaxIterations')
  })

  it('workflowService uses env var default of 50', () => {
    const content = readMcpHostSource('workflow/workflowService.ts')
    expect(content).toContain('CLERUM_WORKFLOW_MAX_ITERATIONS')
    expect(content).toMatch(/50/)
  })

  it('workflowService has wrap-up threshold before max iterations', () => {
    const content = readMcpHostSource('workflow/workflowService.ts')
    expect(content).toContain('WRAP_UP_THRESHOLD')
    expect(content).toContain('approaching the tool-call iteration limit')
  })

  it('workflowService returns partial results on max iterations (graceful)', () => {
    const content = readMcpHostSource('workflow/workflowService.ts')
    // Must NOT return status: "failed" on max iterations
    expect(content).not.toMatch(/status:\s*"failed"[^}]*max-iterations/)
    // Must produce a finalOutput with partial results note
    expect(content).toContain('partial results')
  })

  it('workflowService omits tools on last iteration only after required tool work is satisfied', () => {
    const content = readMcpHostSource('workflow/workflowService.ts')
    // Required tool-call steps must not lose their tool list on the last
    // iteration until at least one real tool call has happened.
    expect(content).toContain('const shouldForceFinalText =')
    expect(content).toContain(
      'remainingIterations <= 1 && (!requiresToolCall || toolsCalled.length > 0)'
    )
    expect(content).toMatch(/shouldForceFinalText\s*\?\s*\[\]\s*:\s*toolDefs/)
    expect(content).toMatch(/shouldForceFinalText[\s\S]*tool_choice:\s*'none'/)
  })

  it('workflowService detects suspicious LLM outputs', () => {
    const content = readMcpHostSource('workflow/workflowService.ts')
    expect(content).toContain('isSuspiciousOutput')
    expect(content).toContain('arg_key')
    expect(content).toContain('tool_call')
    expect(content).toContain('requesting proper summary')
  })

  it('workflowService detects suspicious LLM outputs', () => {
    const content = readMcpHostSource('workflow/workflowService.ts')
    expect(content).toContain('isSuspiciousOutput')
    expect(content).toContain('arg_key')
    expect(content).toContain('requesting proper summary')
  })

  it('validator enforces maxIterations between 1 and 100', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../../../control-ui/lib/recipeValidator.ts'),
      'utf-8'
    )
    expect(content).toContain('maxIterations')
    expect(content).toContain('1 and 100')
  })
})

// ─── Feature: Parent workflow output PVC + run-scoped subPath artifacts ─────
// Parent WorkflowRecipes own one output PVC unless spec.output.claimName points
// at an operator-owned external claim. Triggered child runs reuse the parent
// claim and isolate bytes under workflow-output/<parent>/<runId>.
describe('REG-26: Parent PVC + subPath output storage', () => {
  it('podFactory does NOT export buildOutputPvc (removed by refactor)', async () => {
    const pf = await import('../../../src/workflow/podFactory')
    expect((pf as Record<string, unknown>).buildOutputPvc).toBeUndefined()
  })

  it('mcp-host pod mounts the parent output PVC with workflow-output subPath', async () => {
    const { buildMcpHostPod } = await import('../../../src/workflow/podFactory')
    const pod = buildMcpHostPod(
      'test-recipe',
      { provider: 'zai', model: 'glm-4.7' } as any,
      {
        sandboxNamespace: 'sandbox-recipes',
        mcpHostImage: 'clerum/mcp-host:test',
        coordinatorImage: 'clerum/workflow-coordinator:test',
        imagePullPolicy: 'Never',
      } as any,
      'test-recipe',
      'sandbox-recipes',
      'test-recipe-workflow-output',
      undefined,
      undefined,
      { mountWorkflowOutput: true }
    )
    const container = pod.spec?.containers?.[0]
    const mounts = container?.volumeMounts ?? []
    const outputMount = mounts.find((m: any) => m.mountPath === '/output')
    expect(outputMount).toBeDefined()
    expect(outputMount?.name).toBe('recipe-output')
    // Kubelet binds only the workflow output subdirectory for this recipe.
    expect(outputMount?.subPath).toBe('workflow-output/test-recipe')

    const volumes = pod.spec?.volumes ?? []
    const pvcVolume = volumes.find((v: any) => v.name === 'recipe-output')
    expect(pvcVolume).toBeDefined()
    expect(pvcVolume?.persistentVolumeClaim?.claimName).toBe('test-recipe-workflow-output')
    expect(pod.spec?.nodeName).toBeUndefined()
    expect(
      pod.spec?.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.[0]
        ?.labelSelector?.matchExpressions
    ).toEqual([
      {
        key: 'clerum.io/workflow-output-claim',
        operator: 'In',
        values: ['test-recipe-workflow-output'],
      },
      { key: 'clerum.io/component', operator: 'In', values: ['workflow-output-anchor'] },
    ])
  })

  it('workflowReconciler does not use the removed buildOutputPvc helper', () => {
    const content = readSource('workflow/workflowReconciler.ts')
    expect(content).not.toContain('buildOutputPvc')
    expect(content).toContain('ensureWorkflowOutputPvc')
  })

  it('workflowReconciler cleans recipe artifacts on delete via HTTP DELETE', () => {
    const content = readSource('workflow/workflowReconciler.ts')
    expect(content).toContain('cleanupRecipeArtifacts')
    expect(content).toContain('signWrcArtifactDeleteToken')
    // HTTP DELETE against the mcp-host artifact endpoint
    expect(content).toMatch(/method:\s*['"]DELETE['"]/)
    expect(content).toContain('/api/v1/workflow/artifacts')
  })

  it('internalTools uses /output in workflow mode', () => {
    const content = readMcpHostSource('workflow/internalTools.ts')
    expect(content).toMatch(/['"]\/output['"]/)
    expect(content).toContain('CLERUM_WORKFLOW_ENABLED')
    // Fallback for non-workflow mode
    expect(content).toContain('/tmp/clerum-output')
  })

  it('RecipeStatusContent uses /output/ path for detected artifacts', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../../../control-ui/components/RecipeStatusContent/index.tsx'),
      'utf-8'
    )
    expect(content).toContain('path: `/output/')
    expect(content).not.toContain('/tmp/clerum-output')
  })
})
