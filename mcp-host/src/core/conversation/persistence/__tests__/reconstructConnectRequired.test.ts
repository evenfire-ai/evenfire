/**
 * U5 — durable round-trip of a `connect_required` suspension.
 *
 * A reactive OAuth-consent suspension must survive a cold restart WITHOUT
 * degrading into a generic approval. This drives the REAL producer end to end:
 * a PendingApproval (built by the real U5 builder) → store.persistSuspend →
 * the real insert statement → the real select → reconstructPendingApproval,
 * asserting reason/mcpServerName are preserved.
 *
 * T1: the persisted row is NOT hand-written — it is whatever persistSuspend
 * actually maps from the PendingApproval. A typo in that mapping (e.g. writing a
 * non-existent column, so mcp_server_name lands NULL) now turns this test red,
 * where a hand-built PendingApprovalRow would have masked it (R3-M2).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { TaskExecutor, type TaskExecutorDeps } from '../../../../agent/taskExecutor'
import { prepareStatements } from '../../../../db/statements'
import type { PendingApprovalRow } from '../../../../db/worker/protocol'
import { buildConnectRequiredApproval } from '../../../extensions/mcpApprovalGateController'
import { SimpleEventEmitter } from '../../../orchestration/eventEmitter'
import { ConversationState, type PendingApproval } from '../../../types'
import { ConversationManager } from '../../conversation'
import { reconstructPendingApproval } from '../reconstruct'
import { type StoreHandle, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-u5:rpc:agent:default'

let handle: StoreHandle | undefined
afterEach(async () => {
  await handle?.shutdown()
  handle = undefined
})

/** Persist a suspension through the REAL producer and read the reconstructed
 *  PendingApproval back through the REAL select + reconstruct. */
async function roundTrip(approval: PendingApproval): Promise<{
  approval: PendingApproval
  manager: ConversationManager
  conversation: Awaited<ReturnType<ConversationManager['getOrCreate']>>
}> {
  handle = makeSqliteStore()
  const manager = new ConversationManager(handle.store)
  const conv = await manager.getOrCreate(SESSION_KEY)
  // startTurn registers the session (sessionKeyById) and the active task that
  // persistSuspend requires.
  await manager.startTurn(conv, 'do the thing', 'task-1')

  approval.task_budget = {
    elapsedActiveMs: 0,
    iterationsUsed: 1,
    durationMs: 86400000,
    maxIterations: 1000,
  }
  await manager.suspendForApproval(conv, approval)

  const s = prepareStatements(handle.worker.db)
  const row = s.selectPendingApprovalBySession.get(conv.id) as PendingApprovalRow
  return {
    approval: reconstructPendingApproval(row),
    manager,
    conversation: conv,
  }
}

describe('U5 — connect_required durable round-trip', () => {
  it('preserves reason/mcpServerName from persistSuspend through select → reconstruct', async () => {
    // Fixture derived from the REAL U5 producer, not hand-authored.
    const approval = buildConnectRequiredApproval(
      { id: 'call-1', name: 'monday__list_boards', arguments: { limit: 5 } },
      { mcpServerName: 'monday' }
    )

    const { approval: rehydrated } = await roundTrip(approval)

    // Observable: the rehydrated suspension is a connect_required, not a generic
    // approval, and it still names the oauth server.
    expect(rehydrated.reason).toBe('connect_required')
    expect(rehydrated.mcpServerName).toBe('monday')
    expect(rehydrated.tool_name).toBe('monday__list_boards')
  })

  it('a generic HITL approval rehydrates with no reason/mcpServerName', async () => {
    const approval: PendingApproval = {
      request_id: 'req-approval-1',
      tool_name: 'internal__do',
      parameters: {},
      description: 'Approve internal__do',
      tool_call_id: 'call-2',
      context_snapshot: [],
    }

    const { approval: rehydrated } = await roundTrip(approval)

    expect(rehydrated.reason).toBeUndefined()
    expect(rehydrated.mcpServerName).toBeUndefined()
  })

  it('persists exact invocation scope across SQLite cold resume', async () => {
    const approval: PendingApproval = {
      ...baseApproval(),
      authorization_scope: 'exact_invocation',
    }
    const { manager, conversation } = await roundTrip(approval)
    conversation.state = ConversationState.AwaitingApproval

    await manager.approve(conversation, true)
    expect(conversation.auto_approved_tools).toEqual(new Set())
  })

  it('treats a migration NULL authorization scope as exact consent', async () => {
    const { approval, manager, conversation } = await roundTrip(baseApproval())
    conversation.state = ConversationState.AwaitingApproval
    expect(approval.authorization_scope).toBeUndefined()

    await manager.approve(conversation, true)
    expect(conversation.auto_approved_tools).toEqual(new Set())
  })

  it('clears an ambiguous legacy wildcard during real SQLite pending rehydration', async () => {
    const { approval, manager, conversation } = await roundTrip(baseApproval())
    expect(approval.authorization_scope).toBeUndefined()
    conversation.auto_approved_tools.add('*')

    const task = {
      id: 'task-1',
      source: 'channel' as const,
      status: 'pending' as const,
      priority: 'normal' as const,
      createdAt: new Date(),
      conversationHistory: [],
    }
    const deps: TaskExecutorDeps = {
      conversationManager: manager,
      llmProvider: {
        getProviderType: () => 'codex-subscription',
        classifyError: () => {
          throw new Error('not executed')
        },
        completeSingleTurn: async () => {
          throw new Error('not executed')
        },
        completeSingleTurnWithTools: async () => {
          throw new Error('not executed')
        },
      },
      mcpManager: null,
      workspaceService: undefined,
      modelName: 'fixture-model',
      approvalConfig: { defaultPolicy: 'channel_users', channels: {} },
      config: {
        maxTaskDuration: 30_000,
        maxToolCallsPerTask: 10,
        autoStart: true,
        taskDelay: 0,
        approvalTimeout: 30_000,
      },
      coreEvents: new SimpleEventEmitter(),
      cronScheduler: null,
      taskLifecycle: {
        register: () => undefined,
        transition: () => ({ ok: true }),
      } as never,
      onApprovalNeeded: () => undefined,
      onComplete: () => undefined,
      onFail: () => undefined,
    }
    const executor = new TaskExecutor(task, deps)
    await executor.rehydrateWaitingApproval(SESSION_KEY, approval)

    expect(conversation.auto_approved_tools.has('*')).toBe(false)
  })

  it('preserves proven turn-tools consent', async () => {
    const approval: PendingApproval = {
      ...baseApproval(),
      authorization_scope: 'turn_tools',
    }
    const { manager, conversation } = await roundTrip(approval)
    conversation.state = ConversationState.AwaitingApproval

    await manager.approve(conversation, true)
    expect(conversation.auto_approved_tools).toEqual(new Set(['*', 'internal', 'internal__do']))
  })
})

function baseApproval(): PendingApproval {
  return {
    request_id: 'req-approval-scope',
    tool_name: 'internal__do',
    parameters: {},
    description: 'Approve internal__do',
    tool_call_id: 'call-scope',
    context_snapshot: [],
  }
}
