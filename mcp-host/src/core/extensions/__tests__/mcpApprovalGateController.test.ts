import { describe, expect, it } from 'vitest'
import { CompositeToolRegistry } from '../../adapters/toolRegistryAdapter'
import type { Tool, ToolRegistry } from '../../interfaces'
import { ConversationState } from '../../types'
import type { Conversation } from '../../types'
import { ApprovalController } from '../approvalController'
import {
  McpApprovalGateController,
  STATELESS_CRON_APPROVAL_PROMPT,
  UnifiedApprovalGateController,
  isMcpToolName,
} from '../mcpApprovalGateController'

/** Mock ToolRegistry that can be configured with tools that requireApproval */
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

function makeConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv-test',
    user_id: 'user-1',
    state: ConversationState.Processing,
    turns: [],
    auto_approved_tools: new Set<string>(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

describe('isMcpToolName', () => {
  it('returns true for standard MCP tool names', () => {
    expect(isMcpToolName('mongodb-server__find')).toBe(true)
    expect(isMcpToolName('airtable-server__list_records')).toBe(true)
    expect(isMcpToolName('mock-server__echo')).toBe(true)
  })

  it('returns false for native tool names', () => {
    expect(isMcpToolName('shell_exec')).toBe(false)
    expect(isMcpToolName('file_read')).toBe(false)
    expect(isMcpToolName('http_request')).toBe(false)
    expect(isMcpToolName('memory_write')).toBe(false)
  })
})

describe('UnifiedApprovalGateController', () => {
  it('suspends MCP tool calls with PendingApproval', () => {
    const controller = new UnifiedApprovalGateController(makeMockRegistry())
    const params = { database: 'clerum-test', collection: 'users' }

    const result = controller.beforeTool('mongodb-server__find', params)

    expect(typeof result).toBe('object')
    expect((result as any).type).toBe('suspend')
    expect((result as any).approval.tool_name).toBe('mongodb-server__find')
    expect((result as any).approval.parameters).toEqual(params)
    expect((result as any).approval.request_id).toMatch(/^approval-/)
    expect((result as any).approval.description).toContain('mongodb-server__find')
  })

  it("returns 'proceed' for native tools without requiresApproval", () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({
        shell_exec: { requiresApproval: false },
        file_read: { requiresApproval: false },
      })
    )

    expect(controller.beforeTool('shell_exec', { command: 'ls' })).toBe('proceed')
    expect(controller.beforeTool('file_read', { path: '/tmp' })).toBe('proceed')
  })

  it("returns 'proceed' for native Clerum tools that use double underscore names", () => {
    const nativeRegistry = makeMockRegistry({
      clerum__generate_markdown: { requiresApproval: false },
    })
    const compositeRegistry = new CompositeToolRegistry(nativeRegistry, makeMockRegistry())
    const controller = new UnifiedApprovalGateController(compositeRegistry)

    expect(controller.beforeTool('clerum__generate_markdown', { filename: 'report.md' })).toBe(
      'proceed'
    )
  })

  it("returns 'proceed' for unknown native tools (not in registry)", () => {
    const controller = new UnifiedApprovalGateController(makeMockRegistry())
    expect(controller.beforeTool('unknown_tool', {})).toBe('proceed')
  })

  it('suspends native tools with requiresApproval (BUG-11 fix)', () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({
        shell_exec: { requiresApproval: true },
        http_request: { requiresApproval: true },
      })
    )

    const result1 = controller.beforeTool('shell_exec', { command: 'rm -rf /tmp/test' })
    expect(typeof result1).toBe('object')
    expect((result1 as any).type).toBe('suspend')
    expect((result1 as any).approval.tool_name).toBe('shell_exec')

    const result2 = controller.beforeTool('http_request', { url: 'https://api.example.com' })
    expect(typeof result2).toBe('object')
    expect((result2 as any).type).toBe('suspend')
    expect((result2 as any).approval.tool_name).toBe('http_request')
  })

  it('delegates shouldAccept to DefaultLoopController', () => {
    const controller = new UnifiedApprovalGateController(makeMockRegistry())
    expect(controller.shouldAccept('any text', 0)).toBe(true)
  })

  it('delegates onExhaustion to DefaultLoopController', () => {
    const controller = new UnifiedApprovalGateController(makeMockRegistry())
    const msg = controller.onExhaustion(10)
    expect(msg).toContain('maximum number of tool-use iterations')
  })

  it('delegates refreshTools to DefaultLoopController', async () => {
    const controller = new UnifiedApprovalGateController(makeMockRegistry())
    const tools = [{ name: 'test', description: 'test', parameters: {} }] as any
    const result = await controller.refreshTools(tools)
    expect(result).toEqual(tools)
  })

  it("override 'false' skips approval on a tool whose requiresApproval=true", () => {
    const registry = makeMockRegistry({
      http_request: { requiresApproval: true },
    })
    const config = {
      defaultPolicy: 'channel_users' as const,
      channels: {},
      tools: { http_request: false },
    }
    const controller = new UnifiedApprovalGateController(registry, config)

    expect(controller.beforeTool('http_request', { url: 'https://x' })).toBe('proceed')
  })

  it("override 'true' forces approval on a tool whose requiresApproval=false", () => {
    const registry = makeMockRegistry({
      memory_search: { requiresApproval: false },
    })
    const config = {
      defaultPolicy: 'channel_users' as const,
      channels: {},
      tools: { memory_search: true },
    }
    const controller = new UnifiedApprovalGateController(registry, config)

    const result = controller.beforeTool('memory_search', { query: 'foo' })
    expect(typeof result).toBe('object')
    expect((result as any).type).toBe('suspend')
    expect((result as any).approval.tool_name).toBe('memory_search')
  })

  it('absent override falls through to tool.requiresApproval()', () => {
    const registry = makeMockRegistry({
      shell_exec: { requiresApproval: true },
      memory_search: { requiresApproval: false },
    })
    const config = {
      defaultPolicy: 'channel_users' as const,
      channels: {},
      tools: { http_request: false }, // unrelated entry
    }
    const controller = new UnifiedApprovalGateController(registry, config)

    // shell_exec keeps its true default
    const shellResult = controller.beforeTool('shell_exec', { command: 'ls' })
    expect((shellResult as any).type).toBe('suspend')

    // memory_search keeps its false default
    expect(controller.beforeTool('memory_search', { query: 'x' })).toBe('proceed')
  })

  it('override on an unknown tool name is ignored and code default applies', () => {
    const registry = makeMockRegistry({
      shell_exec: { requiresApproval: true },
    })
    const config = {
      defaultPolicy: 'channel_users' as const,
      channels: {},
      tools: { typo_tool_name: false }, // not in registry
    }
    const controller = new UnifiedApprovalGateController(registry, config)

    // Unknown tool name in registry → "proceed" (per existing behavior)
    expect(controller.beforeTool('typo_tool_name', {})).toBe('proceed')
    // Real tool in the registry is unaffected
    const result = controller.beforeTool('shell_exec', { command: 'ls' })
    expect((result as any).type).toBe('suspend')
  })

  it("override 'true' on an unknown tool name still suspends", () => {
    // The override is honored even when the tool doesn't exist in the registry.
    // The LLM will then try to invoke a non-existent tool which fails downstream;
    // the gate's job is solely to honor the configured override.
    const registry = makeMockRegistry({})
    const config = {
      defaultPolicy: 'channel_users' as const,
      channels: {},
      tools: { typo_tool_name: true },
    }
    const controller = new UnifiedApprovalGateController(registry, config)

    const result = controller.beforeTool('typo_tool_name', {})
    expect(typeof result).toBe('object')
    expect((result as any).type).toBe('suspend')
  })

  it('does not treat inherited Object.prototype methods as overrides', () => {
    // Regression: tools[toolName] would resolve to Object.prototype methods
    // (e.g. toString, valueOf, hasOwnProperty) for tool names that collide
    // with prototype keys. With Object.hasOwn the lookup is constrained to
    // explicitly declared overrides only.
    const registry = makeMockRegistry({
      toString: { requiresApproval: false },
    })
    const config = {
      defaultPolicy: 'channel_users' as const,
      channels: {},
      tools: {}, // empty — only inherited prototype keys are reachable
    }
    const controller = new UnifiedApprovalGateController(registry, config)

    // Without the hasOwn guard, this would suspend because tools["toString"]
    // returns Function (truthy). With the guard, it falls through to the
    // tool's requiresApproval()=false default and proceeds.
    expect(controller.beforeTool('toString', {})).toBe('proceed')
    expect(controller.beforeTool('valueOf', {})).toBe('proceed')
    expect(controller.beforeTool('hasOwnProperty', {})).toBe('proceed')
  })
})

describe('McpApprovalGateController deprecated alias', () => {
  it('is the same class as UnifiedApprovalGateController', () => {
    expect(McpApprovalGateController).toBe(UnifiedApprovalGateController)
  })
})

describe('ApprovalController + UnifiedApprovalGateController chain', () => {
  it('suspends MCP tool when NOT in auto_approved_tools', () => {
    const conv = makeConversation()
    const gate = new UnifiedApprovalGateController(makeMockRegistry())
    const controller = new ApprovalController(conv, gate)

    const result = controller.beforeTool('mongodb-server__insert-many', {
      database: 'clerum-test',
      collection: 'e2e_test',
      documents: [{ name: 'test' }],
    })

    expect(typeof result).toBe('object')
    expect((result as any).type).toBe('suspend')
    expect((result as any).approval.tool_name).toBe('mongodb-server__insert-many')
  })

  it('bypasses gate when MCP tool IS in auto_approved_tools', () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['mongodb-server__find']),
    })
    const gate = new UnifiedApprovalGateController(makeMockRegistry())
    const controller = new ApprovalController(conv, gate)

    const result = controller.beforeTool('mongodb-server__find', { collection: 'users' })
    expect(result).toBe('proceed')
  })

  it('suspends native tools with requiresApproval (BUG-11 fix)', () => {
    const conv = makeConversation()
    const gate = new UnifiedApprovalGateController(
      makeMockRegistry({
        shell_exec: { requiresApproval: true },
      })
    )
    const controller = new ApprovalController(conv, gate)

    const result = controller.beforeTool('shell_exec', { command: 'ls' })
    expect(typeof result).toBe('object')
    expect((result as any).type).toBe('suspend')
    expect((result as any).approval.tool_name).toBe('shell_exec')
  })

  it('auto-approves native tool when in auto_approved_tools (BUG-11 fix)', () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['shell_exec']),
    })
    const gate = new UnifiedApprovalGateController(
      makeMockRegistry({
        shell_exec: { requiresApproval: true },
      })
    )
    const controller = new ApprovalController(conv, gate)

    expect(controller.beforeTool('shell_exec', { command: 'ls' })).toBe('proceed')
  })

  it('proceeds for native tools without requiresApproval', () => {
    const conv = makeConversation()
    const gate = new UnifiedApprovalGateController(
      makeMockRegistry({
        file_read: { requiresApproval: false },
      })
    )
    const controller = new ApprovalController(conv, gate)

    expect(controller.beforeTool('file_read', { path: '/tmp' })).toBe('proceed')
  })

  it('one-shot approval: proceeds when pending_approval matches tool, then blocks on next call', () => {
    const conv = makeConversation({
      pending_approval: {
        request_id: 'approval-123',
        tool_name: 'mongodb-server__insert-many',
        parameters: { collection: 'test' },
        description: 'test',
        tool_call_id: 'call-1',
        context_snapshot: [],
      },
    })
    const gate = new UnifiedApprovalGateController(makeMockRegistry())
    const controller = new ApprovalController(conv, gate)

    // First call: matches pending_approval → proceed (one-shot)
    const result1 = controller.beforeTool('mongodb-server__insert-many', { collection: 'test' })
    expect(result1).toBe('proceed')
    expect(conv.pending_approval).toBeUndefined()

    // Second call: pending_approval consumed → should suspend again
    const result2 = controller.beforeTool('mongodb-server__insert-many', { collection: 'test' })
    expect(typeof result2).toBe('object')
    expect((result2 as any).type).toBe('suspend')
  })

  it('one-shot approval: does NOT match different tool name', () => {
    const conv = makeConversation({
      pending_approval: {
        request_id: 'approval-456',
        tool_name: 'mongodb-server__find',
        parameters: {},
        description: 'test',
        tool_call_id: 'call-2',
        context_snapshot: [],
      },
    })
    const gate = new UnifiedApprovalGateController(makeMockRegistry())
    const controller = new ApprovalController(conv, gate)

    // Different tool → should suspend, NOT consume the pending_approval
    const result = controller.beforeTool('mongodb-server__insert-many', { collection: 'test' })
    expect(typeof result).toBe('object')
    expect((result as any).type).toBe('suspend')
    expect(conv.pending_approval).toBeDefined() // NOT consumed
  })

  it('bypasses gate when server prefix is in auto_approved_tools', () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['mongodb-server']),
    })
    const gate = new UnifiedApprovalGateController(makeMockRegistry())
    const controller = new ApprovalController(conv, gate)

    expect(controller.beforeTool('mongodb-server__find', {})).toBe('proceed')
    expect(controller.beforeTool('mongodb-server__insert-many', {})).toBe('proceed')
    // Different server should still suspend
    const result = controller.beforeTool('airtable-server__list_records', {})
    expect(typeof result).toBe('object')
    expect((result as any).type).toBe('suspend')
  })
})

// ─── Cron×stateless forced-approval gate ─────────────────────────────────────

describe('UnifiedApprovalGateController — cron×stateless forced gate', () => {
  const waivingConfig = {
    defaultPolicy: 'channel_users' as const,
    channels: {},
    tools: { cron_manage: false },
  }

  it('suspends cron_manage create/enable with the exact stateless prompt even when the CRD override disables approval', () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({ cron_manage: { requiresApproval: true } }),
      waivingConfig,
      undefined,
      { statelessLifecycle: true }
    )

    for (const action of ['create', 'enable']) {
      const result = controller.beforeTool('cron_manage', { action })
      expect((result as any).type).toBe('suspend')
      expect((result as any).approval.tool_name).toBe('cron_manage')
      expect((result as any).approval.parameters).toEqual({ action })
      expect((result as any).approval.description).toBe(STATELESS_CRON_APPROVAL_PROMPT)
    }
  })

  it('pins the exact user-facing consequence prompt', () => {
    expect(STATELESS_CRON_APPROVAL_PROMPT).toBe(
      'Approve scheduled task on a stateless agent? While any schedule is active, this agent ' +
        'stays running continuously and will NOT suspend when idle (higher cost). Remove or ' +
        'disable the schedule to restore suspension.'
    )
  })

  it('does NOT force-gate reads and blocker-removing actions: list/get/delete/disable/trigger fall through to the override', () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({ cron_manage: { requiresApproval: true } }),
      waivingConfig,
      undefined,
      { statelessLifecycle: true }
    )

    for (const action of ['list', 'get', 'delete', 'disable', 'trigger']) {
      expect(controller.beforeTool('cron_manage', { action })).toBe('proceed')
    }
  })

  it('does not fire on a non-stateless host: create/enable follow the normal decision (override wins)', () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({ cron_manage: { requiresApproval: true } }),
      waivingConfig,
      undefined,
      { statelessLifecycle: false }
    )

    expect(controller.beforeTool('cron_manage', { action: 'create' })).toBe('proceed')
    expect(controller.beforeTool('cron_manage', { action: 'enable' })).toBe('proceed')
  })

  it('without the stateless option, cron_manage keeps its code default (generic suspension, not the stateless prompt)', () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({ cron_manage: { requiresApproval: true } })
    )
    const result = controller.beforeTool('cron_manage', { action: 'create' })
    expect((result as any).type).toBe('suspend')
    expect((result as any).approval.description).not.toBe(STATELESS_CRON_APPROVAL_PROMPT)
  })

  it('a missing or non-string action is not force-gated (falls through to the normal decision; execute() errors on it anyway)', () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({ cron_manage: { requiresApproval: true } }),
      waivingConfig,
      undefined,
      { statelessLifecycle: true }
    )
    expect(controller.beforeTool('cron_manage', {})).toBe('proceed')
    expect(controller.beforeTool('cron_manage', { action: 42 })).toBe('proceed')
  })
})

describe('UnifiedApprovalGateController — cronManageGateOnly (cron-sourced narrow gate)', () => {
  // cron-sourced tasks on a stateless host run in this mode: ONLY cron_manage
  // create/enable can suspend (self-propagation containment); every other tool
  // call keeps issue #529 autonomy and proceeds without a gate.
  it('suspends cron_manage create/enable with the stateless prompt', () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({ cron_manage: { requiresApproval: true } }),
      undefined,
      undefined,
      { statelessLifecycle: true, cronManageGateOnly: true }
    )

    for (const action of ['create', 'enable']) {
      const result = controller.beforeTool('cron_manage', { action })
      expect((result as any).type).toBe('suspend')
      expect((result as any).approval.tool_name).toBe('cron_manage')
      expect((result as any).approval.description).toBe(STATELESS_CRON_APPROVAL_PROMPT)
    }
  })

  it('does NOT gate cron_manage list/get/delete/disable/trigger (autonomy for blocker-removing + read actions)', () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({ cron_manage: { requiresApproval: true } }),
      undefined,
      undefined,
      { statelessLifecycle: true, cronManageGateOnly: true }
    )

    for (const action of ['list', 'get', 'delete', 'disable', 'trigger']) {
      expect(controller.beforeTool('cron_manage', { action })).toBe('proceed')
    }
  })

  it('does NOT gate a non-cron_manage native tool that requiresApproval (preserves #529 autonomy)', () => {
    // Reverting FIX 1 (dropping cronManageGateOnly, falling back to
    // DefaultLoopController for cron tasks means this controller would never be
    // constructed; but if it WERE the normal gate, shell_exec would suspend).
    // In gate-only mode it must proceed.
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({ shell_exec: { requiresApproval: true } }),
      undefined,
      undefined,
      { statelessLifecycle: true, cronManageGateOnly: true }
    )

    expect(controller.beforeTool('shell_exec', { command: 'rm -rf /tmp/x' })).toBe('proceed')
  })

  it('does NOT gate an MCP tool (preserves #529 autonomy)', () => {
    // An MCP tool (serverName__toolName) would ALWAYS suspend under the normal
    // gate; in cronManageGateOnly mode it proceeds.
    const controller = new UnifiedApprovalGateController(makeMockRegistry(), undefined, undefined, {
      statelessLifecycle: true,
      cronManageGateOnly: true,
    })

    expect(controller.beforeTool('mongodb-server__find', { collection: 'users' })).toBe('proceed')
  })

  it('with cronManageGateOnly but statelessLifecycle false, even create/enable proceed (gate not armed)', () => {
    const controller = new UnifiedApprovalGateController(
      makeMockRegistry({ cron_manage: { requiresApproval: true } }),
      undefined,
      undefined,
      { statelessLifecycle: false, cronManageGateOnly: true }
    )

    expect(controller.beforeTool('cron_manage', { action: 'create' })).toBe('proceed')
    expect(controller.beforeTool('cron_manage', { action: 'enable' })).toBe('proceed')
  })
})
