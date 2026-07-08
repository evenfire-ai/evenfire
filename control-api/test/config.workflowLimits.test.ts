import { afterEach, describe, expect, it, vi } from 'vitest'

const LIMIT_KEYS = [
  'CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE',
  'CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS',
  'CLERUM_WORKFLOW_MAX_STEPS',
  'CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS',
  'CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS',
  'CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS',
] as const

async function loadConfigWith(overrides: Partial<Record<(typeof LIMIT_KEYS)[number], string>>) {
  const originalValues = new Map<string, string | undefined>()
  for (const key of LIMIT_KEYS) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    for (const key of LIMIT_KEYS) {
      const value = originalValues.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('control-api workflow limit config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('loads approved defaults', async () => {
    const config = await loadConfigWith({})

    expect(config.workflowMaxWorkloadsPerRecipe).toBe(25)
    expect(config.workflowUiEgressInternalMaxItems).toBe(25)
    expect(config.workflowMaxSteps).toBe(100)
    expect(config.workflowStepDependsOnMaxItems).toBe(100)
    expect(config.workflowStepAllowedToolsMaxItems).toBe(50)
    expect(config.workflowStepMcpServersMaxItems).toBe(20)
  })

  it('accepts overrides within CRD ceilings', async () => {
    const config = await loadConfigWith({
      CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE: '12',
      CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS: '15',
      CLERUM_WORKFLOW_MAX_STEPS: '80',
      CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS: '90',
      CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS: '75',
      CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS: '12',
    })

    expect(config.workflowMaxWorkloadsPerRecipe).toBe(12)
    expect(config.workflowUiEgressInternalMaxItems).toBe(15)
    expect(config.workflowMaxSteps).toBe(80)
    expect(config.workflowStepDependsOnMaxItems).toBe(90)
    expect(config.workflowStepAllowedToolsMaxItems).toBe(75)
    expect(config.workflowStepMcpServersMaxItems).toBe(12)
  })

  it.each([
    ['CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE', '0'],
    ['CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE', '26'],
    ['CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS', '0'],
    ['CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS', '26'],
    ['CLERUM_WORKFLOW_MAX_STEPS', '0'],
    ['CLERUM_WORKFLOW_MAX_STEPS', '101'],
    ['CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS', '-1'],
    ['CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS', '101'],
    ['CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS', '1.5'],
    ['CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS', '101'],
    ['CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS', 'abc'],
    ['CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS', '21'],
  ])('rejects invalid %s=%s', async (key, value) => {
    await expect(loadConfigWith({ [key]: value })).rejects.toThrow(new RegExp(key))
  })
})
