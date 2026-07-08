import { describe, expect, it } from 'vitest'
import { CompositeToolRegistry } from '../../adapters/toolRegistryAdapter'
import type { Tool, ToolRegistry } from '../../interfaces'
import { UnifiedApprovalGateController } from '../mcpApprovalGateController'

function makeMockRegistry(tools?: Record<string, { requiresApproval: boolean }>): ToolRegistry {
  return {
    get(name: string) {
      const config = tools?.[name]
      if (!config) return null
      return {
        name: () => name,
        description: () => `Mock tool ${name}`,
        parametersSchema: () => ({}),
        execute: async () => ({ content: 'ok', is_error: false, duration_ms: 0 }),
        requiresSanitization: () => false,
        requiresApproval: () => config.requiresApproval,
      } as Tool
    },
    listDefinitions() {
      return []
    },
    register() {},
  }
}

describe('UnifiedApprovalGateController native double-underscore tools', () => {
  it('treats native Clerum tools with double underscores as native, not MCP', () => {
    const nativeRegistry = makeMockRegistry({
      clerum__generate_markdown: { requiresApproval: false },
    })
    const compositeRegistry = new CompositeToolRegistry(nativeRegistry, makeMockRegistry())
    const controller = new UnifiedApprovalGateController(compositeRegistry)

    expect(controller.beforeTool('clerum__generate_markdown', { filename: 'report.md' })).toBe(
      'proceed'
    )
  })

  it('still suspends external MCP tools when no native tool owns the name', () => {
    const controller = new UnifiedApprovalGateController(
      new CompositeToolRegistry(makeMockRegistry(), makeMockRegistry())
    )
    const result = controller.beforeTool('airtable-server__list_records', {})

    expect(typeof result).toBe('object')
    expect((result as { type?: string }).type).toBe('suspend')
  })
})
