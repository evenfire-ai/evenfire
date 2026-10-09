import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoopController } from '../../interfaces'
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
    denials: overrides?.denials,
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
    const controller = new ApprovalController(conv, customDelegate, {
      liveApprovalTools: new Set(['shell_exec']),
    })

    const result = controller.beforeTool('shell_exec', { command: 'process-file' })
    expect(result).toEqual({
      type: 'suspend',
      approval: { ...pendingApproval, authorization_scope: 'exact_invocation' },
    })
    expect(customDelegate.beforeTool).toHaveBeenCalledWith(
      'shell_exec',
      { command: 'process-file' },
      undefined
    )
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
      const controller = new ApprovalController(conv, customDelegate, {
        liveApprovalTools: new Set(['shell_exec']),
      })

      expect(controller.beforeTool('shell_exec', { command })).toEqual({
        type: 'suspend',
        approval: { ...nextApproval, authorization_scope: 'exact_invocation' },
      })
      expect(customDelegate.beforeTool).toHaveBeenCalledExactlyOnceWith(
        'shell_exec',
        { command },
        undefined
      )
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
    const controller = new ApprovalController(conv, delegate, {
      liveApprovalTools: new Set(['other_tool']),
    })

    // The one-shot matches only the approved call: same tool call id and arguments.
    expect(controller.beforeTool('shell_exec', pendingApproval.parameters, 'tc_once')).toBe(
      'proceed'
    )
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
      denials: new Map([['shell_exec', null]]),
    })
    const controller = new ApprovalController(conv, customDelegateThatSuspends)
    const result = controller.beforeTool('shell_exec', { command: 'ls' })
    expect(result).toEqual(
      expect.objectContaining({
        type: 'suspend',
        approval: expect.objectContaining({
          request_id: 'req-denied',
          tool_call_id: 'tc-denied',
          description: 'suspended',
          reask: 'denied',
        }),
      })
    )
  })

  it('replaces a proceed with a re-approval card that names the tool', () => {
    const conv = makeConversation({
      denials: new Map([['file_read', null]]),
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

  describe('one-shot grant matches each dimension on its own', () => {
    const approved = {
      request_id: 'req-oneshot',
      tool_name: 'evenfire-monid__monid_run',
      parameters: { amount: 1, currency: 'usd' },
      description: 'wallet',
      tool_call_id: 'call-approved',
      context_snapshot: [],
    }

    it.each([
      ['same call id, different arguments', { amount: 2, currency: 'usd' }, 'call-approved'],
      ['different call id, same arguments', { amount: 1, currency: 'usd' }, 'call-other'],
      ['no call id on the new call', { amount: 1, currency: 'usd' }, undefined],
    ])('suspends for %s', (_label, params, toolCallId) => {
      const conv = makeConversation({ pending_approval: { ...approved } })
      const controller = new ApprovalController(conv, customDelegateThatSuspends)

      expect(controller.beforeTool('evenfire-monid__monid_run', params, toolCallId)).toEqual(
        expect.objectContaining({ type: 'suspend' })
      )
      expect(conv.pending_approval?.tool_call_id).toBe('call-approved')
    })

    it('suspends when the approved call has no call id', () => {
      const conv = makeConversation({ pending_approval: { ...approved, tool_call_id: '' } })
      const controller = new ApprovalController(conv, customDelegateThatSuspends)

      expect(
        controller.beforeTool('evenfire-monid__monid_run', { amount: 1, currency: 'usd' }, '')
      ).toEqual(expect.objectContaining({ type: 'suspend' }))
    })

    it('matches the approved arguments regardless of key order, once', () => {
      const conv = makeConversation({ pending_approval: { ...approved } })
      const controller = new ApprovalController(conv, customDelegateThatSuspends)

      expect(
        controller.beforeTool(
          'evenfire-monid__monid_run',
          { currency: 'usd', amount: 1 },
          'call-approved'
        )
      ).toBe('proceed')
      expect(
        controller.beforeTool(
          'evenfire-monid__monid_run',
          { currency: 'usd', amount: 1 },
          'call-approved'
        )
      ).toEqual(expect.objectContaining({ type: 'suspend' }))
    })
  })

  describe('workflow_trigger while a denial is active', () => {
    const proceeds = new DefaultLoopController()

    it('asks again even though the gate would proceed, and says why', () => {
      const conv = makeConversation({ denials: new Map([['shell_exec', null]]) })
      const controller = new ApprovalController(conv, proceeds)

      const result = controller.beforeTool('workflow_trigger', { name: 'wf' }, 'tc-1')

      expect(result).toEqual(expect.objectContaining({ type: 'suspend' }))
      const approval = (result as { approval: PendingApproval }).approval
      expect(approval.reask).toBe('denials_active')
      expect(approval.alwaysApproveAllowed).toBe(false)
      expect(approval.description).toContain('another tool was denied in this chat')
      expect(approval.description).not.toContain('"workflow_trigger" was denied')
    })

    it('asks again even when workflow_trigger is on the allowlist', () => {
      const conv = makeConversation({
        denials: new Map([['shell_exec', null]]),
        auto_approved_tools: new Set(['workflow_trigger']),
      })
      const controller = new ApprovalController(conv, proceeds)

      expect(controller.beforeTool('workflow_trigger', { name: 'wf' }, 'tc-1')).toEqual(
        expect.objectContaining({ type: 'suspend' })
      )
    })

    it('follows the gate when no tool is denied', () => {
      const conv = makeConversation()
      const controller = new ApprovalController(conv, proceeds)

      expect(controller.beforeTool('workflow_trigger', { name: 'wf' }, 'tc-1')).toBe('proceed')
    })

    it('does not ask again on a cron lane that ignores denials', () => {
      const conv = makeConversation({ denials: new Map([['shell_exec', null]]) })
      const controller = new ApprovalController(conv, proceeds, { honorDenials: false })

      expect(controller.beforeTool('workflow_trigger', { name: 'wf' }, 'tc-1')).toBe('proceed')
    })
  })

  describe('cron_manage while a denial is active', () => {
    const proceeds = new DefaultLoopController()

    it.each(['create', 'enable', 'trigger'])(
      'asks again for %s, even when cron_manage is allowlisted',
      action => {
        const conv = makeConversation({
          denials: new Map([['monid__run', null]]),
          auto_approved_tools: new Set(['cron_manage']),
        })
        const controller = new ApprovalController(conv, proceeds)

        const result = controller.beforeTool('cron_manage', { action }, 'tc-1')

        expect(result).toEqual(expect.objectContaining({ type: 'suspend' }))
        expect((result as { approval: PendingApproval }).approval.reask).toBe('denials_active')
      }
    )

    it.each(['list', 'get', 'delete', 'disable'])('follows the allowlist for %s', action => {
      const conv = makeConversation({
        denials: new Map([['monid__run', null]]),
        auto_approved_tools: new Set(['cron_manage']),
      })
      const controller = new ApprovalController(conv, proceeds)

      expect(controller.beforeTool('cron_manage', { action }, 'tc-1')).toBe('proceed')
    })

    it('follows the allowlist when no tool is denied', () => {
      const conv = makeConversation({ auto_approved_tools: new Set(['cron_manage']) })
      const controller = new ApprovalController(conv, proceeds)

      expect(controller.beforeTool('cron_manage', { action: 'create' }, 'tc-1')).toBe('proceed')
    })

    it('does not ask again on a cron lane that ignores denials', () => {
      const conv = makeConversation({ denials: new Map([['monid__run', null]]) })
      const controller = new ApprovalController(conv, proceeds, { honorDenials: false })

      expect(controller.beforeTool('cron_manage', { action: 'trigger' }, 'tc-1')).toBe('proceed')
    })

    it("keeps the gate's own card and only marks it as a re-ask", () => {
      const conv = makeConversation({ denials: new Map([['monid__run', null]]) })
      const controller = new ApprovalController(conv, customDelegateThatSuspends)

      const result = controller.beforeTool('cron_manage', { action: 'create' }, 'tc-1')

      const approval = (result as { approval: PendingApproval }).approval
      expect(approval.request_id).toBe('req-denied')
      expect(approval.description).toBe('suspended')
      expect(approval.reask).toBe('denials_active')
      expect(approval.alwaysApproveAllowed).toBe(false)
    })
  })

  describe('a denied tool asks again', () => {
    it("keeps the gate's description and marks the card as a denial re-ask", () => {
      const conv = makeConversation({ denials: new Map([['shell_exec', null]]) })
      const controller = new ApprovalController(conv, customDelegateThatSuspends)

      const result = controller.beforeTool('shell_exec', { command: 'ls' }, 'tc-1')

      const approval = (result as { approval: PendingApproval }).approval
      expect(approval.description).toBe('suspended')
      expect(approval.reask).toBe('denied')
      expect(approval.alwaysApproveAllowed).toBe(false)
    })

    it('builds its own re-ask card when the gate would proceed', () => {
      const conv = makeConversation({ denials: new Map([['shell_exec', null]]) })
      const controller = new ApprovalController(conv, new DefaultLoopController())

      const result = controller.beforeTool('shell_exec', { command: 'ls' }, 'tc-1')

      const approval = (result as { approval: PendingApproval }).approval
      expect(approval.description).toBe('Tool "shell_exec" was denied and must be approved again')
      expect(approval.reask).toBe('denied')
      expect(approval.alwaysApproveAllowed).toBe(false)
    })
  })

  it('a cron gate does not let a denial suspend an autonomous proceed', () => {
    const conv = makeConversation({
      denials: new Map([['cron_manage', null]]),
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

  it("does not let a '*' entry cover any tool, including the session-scoped ones", () => {
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

    // A '*' entry is not a grant: it covers no tool, not even an MCP tool.
    expect(controller.beforeTool('mongodb-server__find', {})).toEqual(
      suspendFor('mongodb-server__find')
    )
    customDelegate.beforeTool.mockClear()

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
    expect(customDelegate.beforeTool).toHaveBeenCalledWith(
      'shell_exec',
      { command: 'ls' },
      undefined
    )
  })
})
