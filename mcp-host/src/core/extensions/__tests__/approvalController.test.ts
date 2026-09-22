import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoopController } from '../../interfaces'
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
    denied_tools: overrides?.denied_tools,
  }
}

const customDelegateThatSuspends: LoopController = {
  shouldAccept: () => true,
  onTextRejected: () => null,
  beforeTool: () => ({
    type: 'suspend',
    approval: {
      request_id: 'req-denied',
      tool_name: 'shell_exec',
      parameters: { command: 'ls' },
      description: 'suspended',
      tool_call_id: 'tc-denied',
      context_snapshot: [],
    },
  }),
  onExhaustion: () => 'exhausted',
  refreshTools: async currentTools => currentTools,
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
    expect(customDelegate.beforeTool).toHaveBeenCalledWith('dangerous_tool', {}, undefined)
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

  it('suspends MCP tools when only the server prefix is in auto_approved_tools', () => {
    const suspendFor = (toolName: string) => ({
      type: 'suspend' as const,
      approval: {
        request_id: 'req-prefix',
        tool_name: toolName,
        parameters: {},
        description: 'MCP tool requires approval',
        tool_call_id: 'tc_prefix',
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

    const prefixed = makeConversation({
      auto_approved_tools: new Set(['mongodb-server', 'airtable-server']),
    })
    const prefixedController = new ApprovalController(prefixed, customDelegate)

    expect(prefixedController.beforeTool('mongodb-server__find', {})).toEqual(
      expect.objectContaining({ type: 'suspend' })
    )
    expect(prefixedController.beforeTool('airtable-server__delete_records', {})).toEqual(
      expect.objectContaining({ type: 'suspend' })
    )
    expect(customDelegate.beforeTool).toHaveBeenCalledWith('mongodb-server__find', {}, undefined)
    expect(customDelegate.beforeTool).toHaveBeenCalledWith(
      'airtable-server__delete_records',
      {},
      undefined
    )

    const exact = makeConversation({
      auto_approved_tools: new Set(['shell_exec']),
    })
    const exactSpy = vi.spyOn(delegate, 'beforeTool')
    const exactController = new ApprovalController(exact, delegate)
    expect(exactController.beforeTool('shell_exec', { command: 'ls' })).toBe('proceed')
    expect(exactSpy).not.toHaveBeenCalled()
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
    expect(customDelegate.beforeTool).toHaveBeenCalledWith(
      'mongodb-server__insert_many',
      {},
      undefined
    )
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

  it("returns the delegate suspend for shell_exec when wildcard '*' is in auto_approved_tools", () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['*']),
    })

    const suspendResult = {
      type: 'suspend' as const,
      approval: {
        request_id: 'req-w1',
        tool_name: 'shell_exec',
        parameters: { command: 'ls' },
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

    expect(controller.beforeTool('shell_exec', { command: 'ls' })).toEqual(suspendResult)
    expect(customDelegate.beforeTool).toHaveBeenCalledWith(
      'shell_exec',
      { command: 'ls' },
      undefined
    )
  })

  it('suspends a denied tool even when the exact name is allowlisted', () => {
    const conv = makeConversation({
      auto_approved_tools: new Set(['shell_exec', '*', 'mongodb-server']),
      denied_tools: new Set(['shell_exec']),
    })
    const controller = new ApprovalController(conv, customDelegateThatSuspends)
    const result = controller.beforeTool('shell_exec', { command: 'ls' })
    expect(result).toEqual(expect.objectContaining({ type: 'suspend' }))
  })

  it('replaces a proceed with a re-approval card that names the tool', () => {
    const conv = makeConversation({
      denied_tools: new Set(['file_read']),
    })
    const registry = {
      get: (name: string) =>
        name === 'file_read'
          ? {
              traceDescriptor: () => ({ kind: 'internal_tool' as const, sourceRef: 'mcp-host' }),
            }
          : null,
      listDefinitions: () => [],
      register: () => undefined,
    }
    const proceed = {
      ...new DefaultLoopController(),
      beforeTool: vi.fn().mockReturnValue('proceed'),
      shouldAccept: delegate.shouldAccept.bind(delegate),
      onTextRejected: delegate.onTextRejected.bind(delegate),
      onExhaustion: delegate.onExhaustion.bind(delegate),
      refreshTools: delegate.refreshTools.bind(delegate),
    }
    const controller = new ApprovalController(conv, proceed, {
      toolRegistry: registry as never,
    })
    const result = controller.beforeTool('file_read', { path: '/tmp' }, 'call-read')
    expect(result).toEqual(
      expect.objectContaining({
        type: 'suspend',
        approval: expect.objectContaining({
          tool_name: 'file_read',
          tool_kind: 'internal_tool',
          tool_source_ref: 'mcp-host',
          description: 'Tool "file_read" was denied and must be approved again',
        }),
      })
    )
  })

  it('does not treat a different argument set as the approved call', () => {
    const conv = makeConversation({
      pending_approval: {
        request_id: 'req-oneshot',
        tool_name: 'evenfire-monid__monid_run',
        parameters: { amount: 1 },
        description: 'wallet',
        tool_call_id: 'call-approved',
        context_snapshot: [],
      },
    })
    const controller = new ApprovalController(conv, customDelegateThatSuspends)
    const mismatched = controller.beforeTool(
      'evenfire-monid__monid_run',
      { amount: 999999 },
      'call-other'
    )
    expect(mismatched).toEqual(expect.objectContaining({ type: 'suspend' }))
    expect(conv.pending_approval?.tool_call_id).toBe('call-approved')

    const matched = controller.beforeTool(
      'evenfire-monid__monid_run',
      { amount: 1 },
      'call-approved'
    )
    expect(matched).toBe('proceed')
    expect(conv.pending_approval).toBeUndefined()
  })

  it('a cron gate does not let a denial suspend an autonomous proceed', () => {
    const conv = makeConversation({
      denied_tools: new Set(['cron_manage']),
    })
    const proceed = {
      ...new DefaultLoopController(),
      beforeTool: vi.fn().mockReturnValue('proceed'),
      shouldAccept: delegate.shouldAccept.bind(delegate),
      onTextRejected: delegate.onTextRejected.bind(delegate),
      onExhaustion: delegate.onExhaustion.bind(delegate),
      refreshTools: delegate.refreshTools.bind(delegate),
    }
    const controller = new ApprovalController(conv, proceed, { honorDenials: false })
    expect(controller.beforeTool('cron_manage', { action: 'list' }, 'call-list')).toBe('proceed')
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
    expect(customDelegate.beforeTool).toHaveBeenCalledWith(
      'shell_exec',
      { command: 'ls' },
      undefined
    )
  })
})
