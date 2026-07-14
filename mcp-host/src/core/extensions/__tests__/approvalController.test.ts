import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DefaultLoopController, buildLoopConfig } from '../../orchestration/loopConfig'
import { ConversationState } from '../../types'
import type { Conversation, PendingApproval } from '../../types'
import { ApprovalController } from '../approvalController'

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

  it("should bypass ALL tools when wildcard '*' is in auto_approved_tools", () => {
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

    // Wildcard should bypass delegate for any tool
    expect(controller.beforeTool('shell_exec', { command: 'rm -rf /' })).toBe('proceed')
    expect(controller.beforeTool('mongodb-server__drop_database', {})).toBe('proceed')
    expect(controller.beforeTool('http_request', { url: 'https://evil.com' })).toBe('proceed')
    expect(controller.beforeTool('airtable-server__delete_all', {})).toBe('proceed')

    // Delegate should NEVER have been called — wildcard bypasses everything
    expect(customDelegate.beforeTool).not.toHaveBeenCalled()
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
