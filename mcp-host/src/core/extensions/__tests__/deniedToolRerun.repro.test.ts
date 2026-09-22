/**
 * Acceptance test for the 2026-09-22 Lead Scout approval bypass.
 *
 * Production chat ff2b2573, task acd6c39a, user 0c568723:
 *   11:35 approve evenreach-query search_crm
 *   11:38 deny  evenreach-finder find_company_people  (that call did not run)
 *   11:38 new message "Use Monid MCP to look for more contacts"
 *   11:38 approve evenfire-monid monid_wallet_balance
 *   11:38 find_company_people runs with no new prompt
 *   11:42 create_contact writes 12 contacts with no prompt
 *
 * This drives the real ConversationManager, ApprovalController, and
 * UnifiedApprovalGateController through runToolUseLoop. A plain approval
 * must not allowlist the server or the rest of the turn. A tool she denied,
 * and tools she never approved, must suspend instead of executing.
 */
import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../conversation/conversation'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { SimpleEventEmitter } from '../../orchestration/eventEmitter'
import { buildLoopConfig } from '../../orchestration/loopConfig'
import { runToolUseLoop } from '../../orchestration/toolUseLoop'
import { BasicSafety } from '../../safety/safety'
import type { RespondResult, ToolOutput } from '../../types'
import { ApprovalController } from '../approvalController'
import { UnifiedApprovalGateController } from '../mcpApprovalGateController'

const FINDER = 'evenreach-finder__find_company_people'
const SEARCH = 'evenreach-query__search_crm'
const COMPANY = 'evenreach-query__company_detail'
const CREATE = 'evenreach-query__create_contact'
const WALLET = 'evenfire-monid__monid_wallet_balance'
const DISCOVER = 'evenfire-monid__monid_discover'

function createMockReasoning(results: RespondResult[]): ReasoningPort {
  let callIndex = 0
  return {
    respondWithTools: vi.fn(
      async () => results[callIndex++] ?? { type: 'error', error: new Error('No more results') }
    ),
    continueWithToolResults: vi.fn(
      async () => results[callIndex++] ?? { type: 'error', error: new Error('No more results') }
    ),
  }
}

function createMockTool(toolName: string): Tool {
  return {
    name: () => toolName,
    description: () => toolName,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({
        content: `${toolName} executed`,
        duration_ms: 1,
        is_error: false,
      })
    ),
    requiresSanitization: () => false,
    requiresApproval: () => true,
  }
}

function createMockRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map(tools.map(tool => [tool.name(), tool]))
  return {
    get: name => map.get(name) ?? null,
    listDefinitions: () =>
      tools.map(tool => ({
        name: tool.name(),
        description: tool.description(),
        parameters: tool.parametersSchema(),
      })),
    register: vi.fn(),
  }
}

function argsOf(tool: Tool): unknown[] {
  return (tool.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])
}

describe('Lead Scout denial stickiness', () => {
  it('suspends a denied tool and unapproved siblings after a later approval', async () => {
    const manager = new ConversationManager()
    const conversation = await manager.getOrCreate('marcela:rpc:lead-scout')
    const search = createMockTool(SEARCH)
    const company = createMockTool(COMPANY)
    const createContact = createMockTool(CREATE)
    const finder = createMockTool(FINDER)
    const wallet = createMockTool(WALLET)
    const discover = createMockTool(DISCOVER)
    const tools = [search, company, createContact, finder, wallet, discover]
    const registry = createMockRegistry(tools)
    const gate = () =>
      new ApprovalController(conversation, new UnifiedApprovalGateController(registry))

    async function turn(userText: string, results: RespondResult[]) {
      return runToolUseLoop(
        buildLoopConfig({
          reasoning: createMockReasoning(results),
          toolRegistry: registry,
          safety: new BasicSafety(),
          events: new SimpleEventEmitter(),
          conversation,
          loopController: gate(),
        }),
        [{ role: 'user', content: userText }]
      )
    }

    // Turn 1 — she approves a read on the EvenReach query server.
    await manager.startTurn(conversation, 'Look for more contacts and add them', 'task-search')
    const searchSuspension = await turn('Look for more contacts and add them', [
      {
        type: 'tool_calls',
        calls: [{ id: 'tc-search', name: SEARCH, arguments: { q: 'Kungfu.ai' } }],
      },
    ])
    expect(searchSuspension.type).toBe('need_approval')
    expect(argsOf(search)).toHaveLength(0)
    if (searchSuspension.type !== 'need_approval') throw new Error('expected search approval')
    await manager.suspendForApproval(conversation, searchSuspension.approval)
    await manager.approve(conversation, false)
    await manager.completeTurn(conversation, 'search approved')

    // Turn 2 — she denies find_company_people. That call does not run.
    // A plain approval must not leave the server allowlisted. startTurn
    // clears only the per-turn wildcard.
    await manager.startTurn(conversation, 'Look for more contacts and add them', 'task-deny')
    expect(conversation.auto_approved_tools.has('evenreach-query')).toBe(false)
    expect(conversation.auto_approved_tools.has('*')).toBe(false)
    const denySuspension = await turn('Look for more contacts and add them', [
      {
        type: 'tool_calls',
        calls: [{ id: 'tc-finder-1', name: FINDER, arguments: { company: 'Kungfu.ai' } }],
      },
    ])
    expect(denySuspension.type).toBe('need_approval')
    if (denySuspension.type === 'need_approval') {
      expect(denySuspension.approval.tool_name).toBe(FINDER)
    }
    expect(argsOf(finder)).toHaveLength(0)
    if (denySuspension.type !== 'need_approval') throw new Error('expected finder approval')
    await manager.suspendForApproval(conversation, denySuspension.approval)
    await manager.deny(conversation)
    expect(conversation.pending_approval).toBeUndefined()
    expect(conversation.auto_approved_tools.has(FINDER)).toBe(false)
    expect(conversation.auto_approved_tools.has('evenreach-finder')).toBe(false)

    // company_detail shares the query server but was not approved. The batch
    // must suspend on it, so the wallet and discover calls do not run.
    await manager.startTurn(
      conversation,
      'Use Monid MCP to look for more contacts in Kungfu.ai',
      'task-monid'
    )
    const walletBatch = await turn('Use Monid MCP to look for more contacts in Kungfu.ai', [
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc-company', name: COMPANY, arguments: { company: 'Kungfu.ai' } },
          { id: 'tc-wallet', name: WALLET, arguments: {} },
          { id: 'tc-discover', name: DISCOVER, arguments: { company: 'Kungfu.ai' } },
        ],
      },
    ])
    expect(walletBatch.type).toBe('need_approval')
    if (walletBatch.type === 'need_approval') {
      expect(walletBatch.approval.tool_name).toBe(COMPANY)
    }
    expect(argsOf(company)).toHaveLength(0)
    expect(argsOf(wallet)).toHaveLength(0)
    expect(argsOf(discover)).toHaveLength(0)
    // She did not deny company_detail. Do not approve or deny it. The loop
    // result is only observed here, so the conversation is still Processing
    // and completeTurn can return it to Idle for the wallet turn.
    await manager.completeTurn(conversation, 'company detail not approved')

    // Separate turn — she approves only the wallet. That must not allowlist
    // the rest of the turn or the Monid server.
    await manager.startTurn(conversation, 'Check the Monid wallet', 'task-wallet')
    const walletOnly = await turn('Check the Monid wallet', [
      {
        type: 'tool_calls',
        calls: [{ id: 'tc-wallet-only', name: WALLET, arguments: {} }],
      },
    ])
    expect(walletOnly.type).toBe('need_approval')
    if (walletOnly.type !== 'need_approval') throw new Error('expected wallet approval')
    expect(walletOnly.approval.tool_name).toBe(WALLET)
    await manager.suspendForApproval(conversation, walletOnly.approval)
    await manager.approve(conversation, false)
    expect(conversation.auto_approved_tools.has('*')).toBe(false)
    expect(conversation.auto_approved_tools.has('evenfire-monid')).toBe(false)

    // Same turn, next model step: the denied finder and a contact write.
    // Neither was approved. The step suspends on the finder and neither runs.
    const bypass = await turn('Check the Monid wallet', [
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc-finder-2', name: FINDER, arguments: { company: 'Kungfu.ai' } },
          { id: 'tc-create', name: CREATE, arguments: { full_name: 'Ada' } },
        ],
      },
      { type: 'text', content: 'Done' },
    ])

    expect(bypass.type).toBe('need_approval')
    if (bypass.type === 'need_approval') {
      expect(bypass.approval.tool_name).toBe(FINDER)
    }
    expect(argsOf(finder)).toHaveLength(0)
    expect(argsOf(createContact)).toHaveLength(0)
  })
})
