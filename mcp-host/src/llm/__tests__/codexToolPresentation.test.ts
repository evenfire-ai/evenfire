/**
 * #627 — presentation rules for a codex-subscription request.
 *
 * The cases below are the ones the issue measured against `origin/dev`, where
 * the old selector produced: only natives survive a mixed catalog, zero
 * definitions survive an MCP-only catalog, and a 36-native/90-MCP catalog
 * collapses to the first 32 natives.
 */
import { describe, expect, it } from 'vitest'
import { ToolDefinition } from '../../core/types'
import {
  CODEX_BRIDGE_TOOL_NAMES,
  CodexToolCapacityError,
  isCodexNativeToolName,
  presentCodexTools,
} from '../codexToolPresentation'

const tool = (name: string): ToolDefinition => ({ name, description: name, parameters: {} })
const bridge = (): ToolDefinition[] => CODEX_BRIDGE_TOOL_NAMES.map(tool)
const names = (tools: ToolDefinition[]) => tools.map(t => t.name)

describe('isCodexNativeToolName', () => {
  it('separates MCP tools from natives by their server prefix', () => {
    expect(isCodexNativeToolName('file_read')).toBe(true)
    expect(isCodexNativeToolName('workflow_trigger')).toBe(true)
    expect(isCodexNativeToolName('clerum__gfs_read')).toBe(true)
    expect(isCodexNativeToolName('clerum__tool_search')).toBe(true)
    expect(isCodexNativeToolName('mongodb-mcp-stack-mongodb-mcp-server__find')).toBe(false)
  })
})

describe('presentCodexTools', () => {
  it('advertises a mixed catalog whole when it fits', () => {
    const result = presentCodexTools([tool('file_read'), tool('connector__find')], { capacity: 64 })
    expect(names(result.presented)).toEqual(['file_read', 'connector__find'])
    expect(result.outcome).toBe('complete')
    expect(result.deferredCount).toBe(0)
    expect(result.unreachableCount).toBe(0)
  })

  it('advertises an MCP-only catalog', () => {
    const result = presentCodexTools([tool('connector__find')], { capacity: 64 })
    expect(names(result.presented)).toEqual(['connector__find'])
    expect(result.outcome).toBe('complete')
  })

  it('keeps every native and defers MCP when the catalog exceeds capacity', () => {
    const natives = Array.from({ length: 36 }, (_, i) => tool(`native_${i}`))
    const mcp = Array.from({ length: 90 }, (_, i) => tool(`connector__tool_${i}`))
    const result = presentCodexTools([...natives, ...mcp, ...bridge()], { capacity: 64 })

    expect(result.outcome).toBe('deferred')
    expect(result.deferredCount).toBe(90)
    // The invariant: nothing is lost, it only moves to the bridge.
    expect(result.unreachableCount).toBe(0)
    expect(names(result.presented)).toEqual([...CODEX_BRIDGE_TOOL_NAMES, ...names(natives)])
  })

  it('reserves the bridge ahead of natives that would otherwise crowd it out', () => {
    // The bridge tools register LAST, so any leading-slice policy drops exactly
    // the tools that make the deferred catalog reachable.
    const natives = Array.from({ length: 40 }, (_, i) => tool(`native_${i}`))
    const result = presentCodexTools([...natives, ...bridge()], { capacity: 10 })

    expect(names(result.presented).slice(0, 3)).toEqual([...CODEX_BRIDGE_TOOL_NAMES])
    expect(result.presented).toHaveLength(10)
  })

  it('reports natives it cannot place rather than shortening the list silently', () => {
    const natives = Array.from({ length: 40 }, (_, i) => tool(`native_${i}`))
    const result = presentCodexTools([...natives, ...bridge()], { capacity: 10 })

    // 10 slots - 3 bridge = 7 natives placed, 33 with nowhere to go: the bridge
    // catalog holds MCP tools, so a deferred native would simply be gone.
    expect(result.outcome).toBe('capacity_exceeded')
    expect(result.unreachableCount).toBe(33)
  })

  it('advertises MCP tools directly when the bridge is absent', () => {
    const result = presentCodexTools([tool('native_0'), tool('connector__find')], { capacity: 64 })
    expect(names(result.presented)).toContain('connector__find')
    expect(result.deferredCount).toBe(0)
  })

  it('treats a partial bridge as no bridge', () => {
    // Without clerum__tool_call a searchable tool still cannot be invoked, so
    // deferring would strand it.
    const mcp = Array.from({ length: 4 }, (_, i) => tool(`connector__tool_${i}`))
    const result = presentCodexTools([tool('clerum__tool_search'), ...mcp], { capacity: 64 })

    expect(result.deferredCount).toBe(0)
    expect(names(result.presented)).toEqual(['clerum__tool_search', ...names(mcp)])
  })

  it('orders the bridge identically however the registry emits it', () => {
    const shuffled = [tool('clerum__tool_call'), tool('clerum__tool_search')]
    const result = presentCodexTools([...shuffled, tool('native_0')], { capacity: 64 })
    expect(names(result.presented)).toEqual([
      'clerum__tool_search',
      'clerum__tool_call',
      'native_0',
    ])
  })

  it('is stable across repeated calls on the same catalog', () => {
    const catalog = [
      ...bridge(),
      ...Array.from({ length: 12 }, (_, i) => tool(`native_${i}`)),
      ...Array.from({ length: 70 }, (_, i) => tool(`connector__tool_${i}`)),
    ]
    const first = presentCodexTools(catalog, { capacity: 64 })
    const second = presentCodexTools(catalog, { capacity: 64 })
    expect(names(first.presented)).toEqual(names(second.presented))
  })

  it('does not invent capacity for a catalog that already fits', () => {
    const result = presentCodexTools([...bridge(), tool('native_0')], { capacity: 64 })
    expect(result.presented).toHaveLength(4)
    expect(result.outcome).toBe('complete')
  })

  it('rejects a capacity too small to hold the bridge itself', () => {
    expect(() => presentCodexTools(bridge(), { capacity: 2 })).toThrow(CodexToolCapacityError)
  })

  it('accepts an empty catalog', () => {
    const result = presentCodexTools([], { capacity: 64 })
    expect(result.presented).toEqual([])
    expect(result.outcome).toBe('complete')
  })
})
