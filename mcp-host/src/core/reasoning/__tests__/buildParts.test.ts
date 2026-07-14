import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { ToolDefinition } from '../../types'
import {
  DefaultPromptBuilder,
  MCP_SERVER_SELECTION_TEXT,
  TOOL_DISCOVERY_TEXT,
  WORKFLOW_RECIPES_TEXT,
} from '../promptBuilder'
import type { BuilderInput } from '../systemPrompt'

function makeInput(overrides: Partial<BuilderInput> = {}): BuilderInput {
  return {
    identityFiles: {
      identity: 'IDENTITY body',
      soul: 'SOUL body',
      agents: 'AGENTS body',
      user: 'USER body',
    },
    dailyLogSnapshot: '## Today\n\nentry',
    model: 'claude-sonnet-4-6',
    provider: 'claude',
    platformHints: ['DESKTOP ENVIRONMENT: hint'],
    capabilities: 'CAPABILITIES contract',
    workflowGuidance: '',
    mcpServerGuidance: '',
    toolDiscoveryGuidance: '',
    memoryGuidance: 'MEMORY guidance',
    ...overrides,
  }
}

function tool(name: string): ToolDefinition {
  return { name, description: `${name} desc`, parameters: { type: 'object', properties: {} } }
}

describe('DefaultPromptBuilder.buildParts (T2.2)', () => {
  it('assembles stable with identity → daily → runtime; context with capabilities → memory', () => {
    const parts = new DefaultPromptBuilder().buildParts(makeInput())
    const sIdent = parts.stable.indexOf('## Identity')
    const sSoul = parts.stable.indexOf('## Core Values')
    const sAgents = parts.stable.indexOf('## Agent Instructions')
    const sUser = parts.stable.indexOf('## User Context')
    const sDaily = parts.stable.indexOf('## Daily Log (frozen at session start)')
    const sRuntime = parts.stable.indexOf('## Runtime')

    expect(sIdent).toBeGreaterThanOrEqual(0)
    expect(sSoul).toBeGreaterThan(sIdent)
    expect(sAgents).toBeGreaterThan(sSoul)
    expect(sUser).toBeGreaterThan(sAgents)
    expect(sDaily).toBeGreaterThan(sUser)
    expect(sRuntime).toBeGreaterThan(sDaily)
    expect(parts.stable).toContain('model: claude-sonnet-4-6')
    expect(parts.stable).toContain('provider: claude')
    expect(parts.stable).toContain('DESKTOP ENVIRONMENT: hint')

    const cCap = parts.context.indexOf('CAPABILITIES contract')
    const cMem = parts.context.indexOf('MEMORY guidance')
    expect(cCap).toBeGreaterThanOrEqual(0)
    expect(cMem).toBeGreaterThan(cCap)
  })

  it('omits empty identity sections without producing double separators', () => {
    const parts = new DefaultPromptBuilder().buildParts(
      makeInput({
        identityFiles: { identity: '', soul: '', agents: 'AGENTS', user: '' },
        dailyLogSnapshot: '',
        platformHints: [],
      })
    )
    expect(parts.stable).not.toContain('---\n\n---')
    expect(parts.stable).toContain('## Agent Instructions')
    expect(parts.stable).not.toContain('## Identity')
    expect(parts.stable).not.toContain('## Core Values')
    expect(parts.stable).not.toContain('## User Context')
    expect(parts.stable).not.toContain('## Daily Log')
  })

  it('omits empty context sections', () => {
    const parts = new DefaultPromptBuilder().buildParts(
      makeInput({ memoryGuidance: '', capabilities: 'only this' })
    )
    expect(parts.context).toBe('only this')
  })

  it('produces deterministic hashes (same input → same hash)', () => {
    const a = new DefaultPromptBuilder().buildParts(makeInput())
    const b = new DefaultPromptBuilder().buildParts(makeInput())
    expect(a.stableHash).toBe(b.stableHash)
    expect(a.contextHash).toBe(b.contextHash)
    // Hashes match a fresh sha256(content)
    expect(a.stableHash).toBe(createHash('sha256').update(a.stable, 'utf8').digest('hex'))
    expect(a.contextHash).toBe(createHash('sha256').update(a.context, 'utf8').digest('hex'))
  })

  it('hash diverges when stable input mutates (e.g. model change)', () => {
    const baseline = new DefaultPromptBuilder().buildParts(makeInput())
    const mutated = new DefaultPromptBuilder().buildParts(makeInput({ model: 'claude-haiku-4-5' }))
    expect(mutated.stableHash).not.toBe(baseline.stableHash)
    expect(mutated.contextHash).toBe(baseline.contextHash)
  })

  it('hash stays constant when context input mutates only (capabilities change)', () => {
    const baseline = new DefaultPromptBuilder().buildParts(makeInput())
    const mutated = new DefaultPromptBuilder().buildParts(
      makeInput({ capabilities: 'different contract' })
    )
    expect(mutated.stableHash).toBe(baseline.stableHash)
    expect(mutated.contextHash).not.toBe(baseline.contextHash)
  })

  // Regression: dev's d85360d2 added WORKFLOW RECIPES + MCP SERVER SELECTION
  // guidance to the legacy `buildSystemPrompt` only. The tiered cache path
  // (`buildParts`) had no slot for them, so enabling the prompt cache silently
  // dropped both blocks. These guard the cross-path parity.
  it('places workflow + MCP guidance in the context tier, ordered after capabilities and before memory', () => {
    const parts = new DefaultPromptBuilder().buildParts(
      makeInput({
        workflowGuidance: WORKFLOW_RECIPES_TEXT,
        mcpServerGuidance: MCP_SERVER_SELECTION_TEXT,
      })
    )
    const cCap = parts.context.indexOf('CAPABILITIES contract')
    const cWf = parts.context.indexOf('WORKFLOW RECIPES:')
    const cMcp = parts.context.indexOf('MCP SERVER SELECTION:')
    const cMem = parts.context.indexOf('MEMORY guidance')
    expect(cCap).toBeGreaterThanOrEqual(0)
    expect(cWf).toBeGreaterThan(cCap)
    expect(cMcp).toBeGreaterThan(cWf)
    expect(cMem).toBeGreaterThan(cMcp)
    // Full text, not just the header.
    expect(parts.context).toContain(WORKFLOW_RECIPES_TEXT)
    expect(parts.context).toContain(MCP_SERVER_SELECTION_TEXT)
  })

  it('cache-path context carries the exact guidance the legacy buildSystemPrompt emits', () => {
    const tools = [tool('workflow_list'), tool('github__create_issue')]
    const builder = new DefaultPromptBuilder()
    const legacy = builder.buildSystemPrompt(tools).content as string
    const parts = builder.buildParts(
      makeInput({
        workflowGuidance: WORKFLOW_RECIPES_TEXT,
        mcpServerGuidance: MCP_SERVER_SELECTION_TEXT,
      })
    )
    // Both paths reference the same exported constants → byte-identical blocks.
    expect(legacy).toContain(WORKFLOW_RECIPES_TEXT)
    expect(legacy).toContain(MCP_SERVER_SELECTION_TEXT)
    expect(parts.context).toContain(WORKFLOW_RECIPES_TEXT)
    expect(parts.context).toContain(MCP_SERVER_SELECTION_TEXT)
  })

  it('omits workflow + MCP guidance when not provided (empty string → no block)', () => {
    const parts = new DefaultPromptBuilder().buildParts(makeInput())
    expect(parts.context).not.toContain('WORKFLOW RECIPES:')
    expect(parts.context).not.toContain('MCP SERVER SELECTION:')
  })

  // F4.1 — TOOL_DISCOVERY_TEXT (dynamic-tool-loading).
  it('tiered path: emits TOOL_DISCOVERY_TEXT only when provided, and it is a constant (cache-safe)', () => {
    const without = new DefaultPromptBuilder().buildParts(makeInput())
    expect(without.context).not.toContain(TOOL_DISCOVERY_TEXT)

    const withGuidance = new DefaultPromptBuilder().buildParts(
      makeInput({ toolDiscoveryGuidance: TOOL_DISCOVERY_TEXT })
    )
    expect(withGuidance.context).toContain(TOOL_DISCOVERY_TEXT)
    // Stable tier never carries it → stableHash unchanged.
    expect(withGuidance.stableHash).toBe(without.stableHash)
    // It is a CONSTANT: building twice with it on yields the same context hash.
    const again = new DefaultPromptBuilder().buildParts(
      makeInput({ toolDiscoveryGuidance: TOOL_DISCOVERY_TEXT })
    )
    expect(again.contextHash).toBe(withGuidance.contextHash)
  })

  it('legacy path: buildSystemPrompt emits TOOL_DISCOVERY_TEXT only when clerum__tool_search is present', () => {
    const builder = new DefaultPromptBuilder()
    const withSearch = builder.buildSystemPrompt([tool('clerum__tool_search')]).content as string
    expect(withSearch).toContain(TOOL_DISCOVERY_TEXT)

    const withoutSearch = builder.buildSystemPrompt([tool('shell_exec')]).content as string
    expect(withoutSearch).not.toContain(TOOL_DISCOVERY_TEXT)
  })
})
