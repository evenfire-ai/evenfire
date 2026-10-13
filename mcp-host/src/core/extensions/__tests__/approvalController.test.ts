import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DefaultLoopController, buildLoopConfig } from '../../orchestration/loopConfig'
import { ConversationState } from '../../types'
import type { Conversation, PendingApproval } from '../../types'
import { ApprovalController, SESSION_SCOPED_APPROVAL_TOOLS } from '../approvalController'

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

describe('ApprovalController', () => {
  let delegate: DefaultLoopController

  beforeEach(() => {
    delegate = new DefaultLoopController()
  })

  it('should delegate shouldAccept to base controller', () => {
    const conv = makeConversation()
    const controller = new ApprovalController(conv, delegate)

    // DefaultLoopController always returns true
    expect(controller.shouldAccept('some text', 0)).toBe(true)
    expect(controller.shouldAccept('', 5)).toBe(true)
  })

  it('should delegate beforeTool when tool is NOT in auto_approved_tools', () => {
    const conv = makeConversation()
    const controller = new ApprovalController(conv, delegate)

    // DefaultLoopController returns "proceed" for all tools
    const result = controller.beforeTool('shell_exec', { command: 'ls' })
    expect(result).toBe('proceed')
  })

  it('should bypass delegate when tool IS in auto_approved_tools', () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['shell_exec']),
    })

    // Spy on delegate to verify it's NOT called
    const spy = vi.spyOn(delegate, 'beforeTool')
    const controller = new ApprovalController(conv, delegate)

    const result = controller.beforeTool('shell_exec', { command: 'rm -rf' })
    expect(result).toBe('proceed')
    expect(spy).not.toHaveBeenCalled()
  })

  it('requires a fresh delegate decision for live-approval tools despite wildcard approval', () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['*', 'shell_exec']),
    })
    const pendingApproval: PendingApproval = {
      request_id: 'req-live',
      tool_name: 'other_tool',
      parameters: {},
      description: 'Other tool',
      tool_call_id: 'tc_other',
      context_snapshot: [],
    }
    const customDelegate = {
      ...new DefaultLoopController(),
      beforeTool: vi.fn().mockReturnValue({ type: 'suspend', approval: pendingApproval }),
      shouldAccept: delegate.shouldAccept.bind(delegate),
      onTextRejected: delegate.onTextRejected.bind(delegate),
      onExhaustion: delegate.onExhaustion.bind(delegate),
      refreshTools: delegate.refreshTools.bind(delegate),
    }
    const controller = new ApprovalController(conv, customDelegate, new Set(['shell_exec']))

    const result = controller.beforeTool('shell_exec', { command: 'process-file' })
    expect(result).toEqual({
      type: 'suspend',
      approval: { ...pendingApproval, authorization_scope: 'exact_invocation' },
    })
    expect(customDelegate.beforeTool).toHaveBeenCalledWith('shell_exec', {
      command: 'process-file',
    })
  })

  it.each(['process-file', 'process-another-file'])(
    'delegates a live call for %s while preserving the frozen pending approval',
    command => {
      const pendingApproval: PendingApproval = {
        request_id: 'req-live',
        tool_name: 'shell_exec',
        parameters: { command: 'process-file' },
        description: 'Governed shell command',
        tool_call_id: 'tc_shell',
        context_snapshot: [],
      }
      const conv = makeConversation({
        auto_approved_tools: new Set(['*', 'shell_exec']),
        pending_approval: pendingApproval,
      })
      const nextApproval: PendingApproval = {
        ...pendingApproval,
        request_id: 'req-live-2',
        parameters: { command },
        tool_call_id: 'tc_shell_2',
      }
      const customDelegate = {
        ...new DefaultLoopController(),
        beforeTool: vi.fn().mockReturnValue({ type: 'suspend', approval: nextApproval }),
        shouldAccept: delegate.shouldAccept.bind(delegate),
        onTextRejected: delegate.onTextRejected.bind(delegate),
        onExhaustion: delegate.onExhaustion.bind(delegate),
        refreshTools: delegate.refreshTools.bind(delegate),
      }
      const controller = new ApprovalController(conv, customDelegate, new Set(['shell_exec']))

      expect(controller.beforeTool('shell_exec', { command })).toEqual({
        type: 'suspend',
        approval: { ...nextApproval, authorization_scope: 'exact_invocation' },
      })
      expect(customDelegate.beforeTool).toHaveBeenCalledExactlyOnceWith('shell_exec', { command })
      expect(conv.pending_approval).toBe(pendingApproval)
    }
  )

  it('preserves one-shot approval consumption for tools outside the live set', () => {
    const pendingApproval: PendingApproval = {
      request_id: 'req-once',
      tool_name: 'shell_exec',
      parameters: { command: 'printf approved' },
      description: 'Shell command',
      tool_call_id: 'tc_once',
      context_snapshot: [],
    }
    const conv = makeConversation({ pending_approval: pendingApproval })
    const spy = vi.spyOn(delegate, 'beforeTool')
    const controller = new ApprovalController(conv, delegate, new Set(['other_tool']))

    expect(controller.beforeTool('shell_exec', pendingApproval.parameters)).toBe('proceed')
    expect(conv.pending_approval).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it("should propagate 'skip' from delegate", () => {
    const conv = makeConversation()
    const customDelegate = {
      ...new DefaultLoopController(),
      beforeTool: vi.fn().mockReturnValue('skip'),
      shouldAccept: delegate.shouldAccept.bind(delegate),
      onTextRejected: delegate.onTextRejected.bind(delegate),
      onExhaustion: delegate.onExhaustion.bind(delegate),
      refreshTools: delegate.refreshTools.bind(delegate),
    }

    const controller = new ApprovalController(conv, customDelegate)

    const result = controller.beforeTool('dangerous_tool', {})
    expect(result).toBe('skip')
    expect(customDelegate.beforeTool).toHaveBeenCalledWith('dangerous_tool', {})
  })

  it('should propagate suspend from delegate', () => {
    const conv = makeConversation()
    const pendingApproval: PendingApproval = {
      request_id: 'req-1',
      tool_name: 'shell_exec',
      parameters: { command: 'rm -rf /' },
      description: 'Dangerous command',
      tool_call_id: 'tc_1',
      context_snapshot: [],
    }

    const customDelegate = {
      ...new DefaultLoopController(),
      beforeTool: vi.fn().mockReturnValue({ type: 'suspend', approval: pendingApproval }),
      shouldAccept: delegate.shouldAccept.bind(delegate),
      onTextRejected: delegate.onTextRejected.bind(delegate),
      onExhaustion: delegate.onExhaustion.bind(delegate),
      refreshTools: delegate.refreshTools.bind(delegate),
    }

    const controller = new ApprovalController(conv, customDelegate)

    const result = controller.beforeTool('shell_exec', { command: 'rm -rf /' })
    expect(result).toEqual({ type: 'suspend', approval: pendingApproval })
  })

  it('should bypass delegate when MCP server prefix is in auto_approved_tools', () => {
    // Server prefix "airtable-server" is approved → all airtable-server__* tools should proceed
    const conv = makeConversation({
      auto_approved_tools: new Set(['airtable-server']),
    })

    const spy = vi.spyOn(delegate, 'beforeTool')
    const controller = new ApprovalController(conv, delegate)

    expect(controller.beforeTool('airtable-server__list_bases', {})).toBe('proceed')
    expect(controller.beforeTool('airtable-server__list_tables', { baseId: 'abc' })).toBe('proceed')
    expect(controller.beforeTool('airtable-server__create_record', { baseId: 'abc' })).toBe(
      'proceed'
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('should NOT auto-approve tools from a different MCP server', () => {
    // Only airtable-server approved → mongodb-server should still be blocked by delegate
    const conv = makeConversation({
      auto_approved_tools: new Set(['airtable-server']),
    })

    const suspendResult = {
      type: 'suspend' as const,
      approval: {
        request_id: 'req-1',
        tool_name: 'mongodb-server__insert_many',
        parameters: {},
        description: 'MCP tool requires approval',
        tool_call_id: 'tc_1',
        context_snapshot: [],
      },
    }

    const customDelegate = {
      ...new DefaultLoopController(),
      beforeTool: vi.fn().mockReturnValue(suspendResult),
      shouldAccept: delegate.shouldAccept.bind(delegate),
      onTextRejected: delegate.onTextRejected.bind(delegate),
      onExhaustion: delegate.onExhaustion.bind(delegate),
      refreshTools: delegate.refreshTools.bind(delegate),
    }

    const controller = new ApprovalController(conv, customDelegate)

    const result = controller.beforeTool('mongodb-server__insert_many', {})
    expect(result).toEqual(suspendResult)
    expect(customDelegate.beforeTool).toHaveBeenCalledWith('mongodb-server__insert_many', {})
  })

  it('should preserve this context when passed through buildLoopConfig (C1 regression)', () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['shell_exec']),
    })
    const controller = new ApprovalController(conv, delegate)

    // Build loop config with the full ApprovalController instance
    const mockReasoning = {} as any
    const mockToolRegistry = {} as any
    const mockSafety = {
      validateInput: vi.fn(),
      sanitizeOutput: vi.fn(),
      wrapForLlm: vi.fn(),
    } as any
    const mockEvents = { emit: vi.fn(), on: vi.fn() } as any

    const config = buildLoopConfig({
      reasoning: mockReasoning,
      toolRegistry: mockToolRegistry,
      safety: mockSafety,
      events: mockEvents,
      conversation: conv,
      loopController: controller,
    })

    // The loopController in config must preserve `this` context.
    // If it destructured methods into a plain object, this.conversation
    // would be undefined and beforeTool would throw.
    const result = config.loopController.beforeTool('shell_exec', { command: 'ls' })
    expect(result).toBe('proceed') // auto-approved, bypasses delegate

    // Verify non-approved tool delegates to base controller
    const result2 = config.loopController.beforeTool('http_request', { url: 'https://example.com' })
    expect(result2).toBe('proceed') // DefaultLoopController returns "proceed"
  })

  it("should bypass every tool outside the session-scoped set when wildcard '*' is in auto_approved_tools", () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['*']),
    })

    const suspendResult = {
      type: 'suspend' as const,
      approval: {
        request_id: 'req-w1',
        tool_name: 'shell_exec',
        parameters: { command: 'rm -rf /' },
        description: 'Dangerous command',
        tool_call_id: 'tc_w1',
        context_snapshot: [],
      },
    }

    const customDelegate = {
      ...new DefaultLoopController(),
      beforeTool: vi.fn().mockReturnValue(suspendResult),
      shouldAccept: delegate.shouldAccept.bind(delegate),
      onTextRejected: delegate.onTextRejected.bind(delegate),
      onExhaustion: delegate.onExhaustion.bind(delegate),
      refreshTools: delegate.refreshTools.bind(delegate),
    }

    const controller = new ApprovalController(conv, customDelegate)

    // Wildcard bypasses the delegate for MCP tools and other gated natives
    expect(controller.beforeTool('mongodb-server__drop_database', {})).toBe('proceed')
    expect(controller.beforeTool('workflow_trigger', { recipe: 'report' })).toBe('proceed')
    expect(controller.beforeTool('airtable-server__delete_all', {})).toBe('proceed')

    // Delegate should NEVER have been called for those tools
    expect(customDelegate.beforeTool).not.toHaveBeenCalled()
  })

  it("does not let wildcard '*' cover shell_exec, http_request or cron_manage", () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['*']),
    })
    const suspendFor = (toolName: string) => ({
      type: 'suspend' as const,
      approval: {
        request_id: `req-${toolName}`,
        tool_name: toolName,
        parameters: {},
        description: toolName,
        tool_call_id: `tc-${toolName}`,
        context_snapshot: [],
      },
    })
    const customDelegate = {
      ...new DefaultLoopController(),
      beforeTool: vi.fn((toolName: string) => suspendFor(toolName)),
      shouldAccept: delegate.shouldAccept.bind(delegate),
      onTextRejected: delegate.onTextRejected.bind(delegate),
      onExhaustion: delegate.onExhaustion.bind(delegate),
      refreshTools: delegate.refreshTools.bind(delegate),
    }
    const controller = new ApprovalController(conv, customDelegate)

    // Witness: the wildcard is live and covers an MCP tool of the same turn.
    expect(controller.beforeTool('mongodb-server__find', {})).toBe('proceed')
    expect(customDelegate.beforeTool).not.toHaveBeenCalled()

    for (const toolName of SESSION_SCOPED_APPROVAL_TOOLS) {
      expect(controller.beforeTool(toolName, {})).toEqual(suspendFor(toolName))
    }
    expect(customDelegate.beforeTool.mock.calls.map(call => call[0])).toEqual([
      'shell_exec',
      'http_request',
      'cron_manage',
    ])

    // Each session-scoped tool proceeds once its own name is approved, either
    // for later tasks ("always") or for the current task.
    conv.auto_approved_tools.add('shell_exec')
    conv.task_approved_tools = new Set(['cron_manage'])
    expect(controller.beforeTool('shell_exec', {})).toBe('proceed')
    expect(controller.beforeTool('cron_manage', {})).toBe('proceed')
    expect(controller.beforeTool('http_request', {})).toEqual(suspendFor('http_request'))
    expect(customDelegate.beforeTool).toHaveBeenCalledTimes(4)
  })

  it('should NOT bypass tools when wildcard is absent and individual tool is not approved', () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(), // empty — no wildcard, no approvals
    })

    const suspendResult = {
      type: 'suspend' as const,
      approval: {
        request_id: 'req-n1',
        tool_name: 'shell_exec',
        parameters: { command: 'ls' },
        description: 'Shell command',
        tool_call_id: 'tc_n1',
        context_snapshot: [],
      },
    }

    const customDelegate = {
      ...new DefaultLoopController(),
      beforeTool: vi.fn().mockReturnValue(suspendResult),
      shouldAccept: delegate.shouldAccept.bind(delegate),
      onTextRejected: delegate.onTextRejected.bind(delegate),
      onExhaustion: delegate.onExhaustion.bind(delegate),
      refreshTools: delegate.refreshTools.bind(delegate),
    }

    const controller = new ApprovalController(conv, customDelegate)

    // Without wildcard, delegate should be called and its suspend returned
    const result = controller.beforeTool('shell_exec', { command: 'ls' })
    expect(result).toEqual(suspendResult)
    expect(customDelegate.beforeTool).toHaveBeenCalledWith('shell_exec', { command: 'ls' })
  })
})
