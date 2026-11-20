import { describe, expect, it } from 'vitest'
import { nativeApprovalCause } from '../../approval/nativeApprovalCause'
import type { NativeToolConfig, Tool, ToolRegistry } from '../../interfaces'
import { NativeToolRegistry } from '../../tools/nativeToolRegistry'
import type { ApprovalConfig } from '../approvalTypes'
import { UnifiedApprovalGateController } from '../mcpApprovalGateController'

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
}

type Outcome = 'none' | 'ordinary' | 'admin_forced'

/** The native rule the gate applied before `approvalAlso` existed. */
function previousGateRule(tool: Tool | null, override: boolean | undefined): Outcome {
  const needsApproval = override ?? tool?.requiresApproval() ?? false
  if (!needsApproval) return 'none'
  return override === true ? 'admin_forced' : 'ordinary'
}

function gateOutcome(
  registry: ToolRegistry,
  toolName: string,
  params: Record<string, unknown>,
  tools: Record<string, boolean> | undefined
): Outcome {
  const approvalConfig = tools ? ({ tools } as unknown as ApprovalConfig) : undefined
  const gate = new UnifiedApprovalGateController(registry, approvalConfig, registry)
  const result = gate.beforeTool(toolName, params)
  if (result === 'proceed') return 'none'
  if (result === 'skip') throw new Error('unexpected skip')
  return (result as unknown as { cause: Outcome }).cause
}

function toolWith(overrides: Partial<Tool> & { requiresApproval(): boolean }): Tool {
  return {
    name: () => 'reader_tool',
    description: () => 'reads',
    parametersSchema: () => ({}),
    execute: async () => ({ content: 'ok', is_error: false, duration_ms: 0 }),
    requiresSanitization: () => true,
    ...overrides,
  }
}

function registryOf(tools: Record<string, Tool>): ToolRegistry {
  return {
    get: name => tools[name] ?? null,
    listDefinitions: () => [],
    register() {},
  }
}

describe('nativeApprovalCause', () => {
  it('equals the old gate rule for every native tool without approvalAlso', () => {
    const registry = new NativeToolRegistry(config, 'test-conv')
    const names = registry.listDefinitions().map(d => d.name)
    expect(names.length).toBeGreaterThan(10)
    let compared = 0
    for (const name of names) {
      const tool = registry.get(name)
      expect(tool?.approvalAlso).toBeUndefined()
      for (const override of [undefined, true, false] as const) {
        const tools = override === undefined ? undefined : { [name]: override }
        const expected = previousGateRule(tool, override)
        expect(nativeApprovalCause(tool, name, {}, tools), `${name} ${override}`).toBe(expected)
        expect(gateOutcome(registry, name, {}, tools), `${name} ${override}`).toBe(expected)
        compared++
      }
    }
    expect(compared).toBe(names.length * 3)
  })

  it('keeps the old rule for an unknown tool name and for an override on another tool', () => {
    expect(nativeApprovalCause(null, 'typo_tool', {}, { typo_tool: true })).toBe('admin_forced')
    expect(nativeApprovalCause(null, 'typo_tool', {}, { typo_tool: false })).toBe('none')
    expect(nativeApprovalCause(null, 'typo_tool', {}, { other: true })).toBe('none')
    expect(nativeApprovalCause(null, 'toString', {}, {})).toBe('none')
  })

  it('a true override on an approvalAlso name forces a card', () => {
    const tool = toolWith({
      requiresApproval: () => false,
      approvalAlso: params => (typeof params.file === 'string' ? ['file_read'] : []),
    })
    const registry = registryOf({ reader_tool: tool })
    const withFile = { file: 'a.json' }

    expect(gateOutcome(registry, 'reader_tool', withFile, { file_read: true })).toBe('admin_forced')
    expect(nativeApprovalCause(tool, 'reader_tool', withFile, { file_read: true })).toBe(
      'admin_forced'
    )
    // The same call without the file read is not forced, and runs.
    expect(gateOutcome(registry, 'reader_tool', { input: '{}' }, { file_read: true })).toBe('none')
    // No override at all: the tool's own default (no approval) applies.
    expect(gateOutcome(registry, 'reader_tool', withFile, undefined)).toBe('none')
  })

  it('a false override on an approvalAlso name never loosens the tool', () => {
    const tool = toolWith({ requiresApproval: () => true, approvalAlso: () => ['shell_exec'] })
    const registry = registryOf({ reader_tool: tool })

    expect(gateOutcome(registry, 'reader_tool', {}, { shell_exec: false })).toBe('ordinary')
    expect(gateOutcome(registry, 'reader_tool', {}, undefined)).toBe('ordinary')
  })

  it("an approvalAlso true override wins over the tool's own false", () => {
    const tool = toolWith({ requiresApproval: () => true, approvalAlso: () => ['file_read'] })
    const registry = registryOf({ reader_tool: tool })

    expect(gateOutcome(registry, 'reader_tool', {}, { reader_tool: false })).toBe('none')
    expect(gateOutcome(registry, 'reader_tool', {}, { reader_tool: false, file_read: true })).toBe(
      'admin_forced'
    )
  })
})
