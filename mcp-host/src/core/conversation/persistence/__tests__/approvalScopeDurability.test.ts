/**
 * RP726-01 — a card that authorizes only its own call keeps that cap across a
 * restart. The cards come from the real producers (the cron×stateless forced
 * gate and the denial re-ask), are persisted in a real file-backed SQLite store,
 * rehydrated by the cold-start loader, and decided by the real manager.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ApprovalController } from '../../../extensions/approvalController'
import { UnifiedApprovalGateController } from '../../../extensions/mcpApprovalGateController'
import type { ToolRegistry } from '../../../interfaces'
import { ConversationState, type PendingApproval } from '../../../types'
import { ConversationManager } from '../../conversation'
import { pendingApprovalWireFields } from '../../pendingApprovalView'
import { SqliteColdStartLoader } from '../sqliteColdStartLoader'
import { type StoreHandle, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-a:rpc:agent:scope'
const BUDGET = { elapsedActiveMs: 0, iterationsUsed: 1, durationMs: 86_400_000, maxIterations: 100 }

function registry(): ToolRegistry {
  const gated = { requiresApproval: () => true }
  return {
    get: (name: string) => (name === 'cron_manage' || name === 'shell_exec' ? gated : null),
    register: () => undefined,
    listDefinitions: () => [],
  } as unknown as ToolRegistry
}

function gate(): UnifiedApprovalGateController {
  return new UnifiedApprovalGateController(
    registry(),
    {
      defaultPolicy: 'channel_users',
      channels: {},
      tools: { cron_manage: true, shell_exec: true },
    },
    undefined,
    { statelessLifecycle: true }
  )
}

describe('approval scope across a restart', () => {
  let dbPath: string
  const open: StoreHandle[] = []

  beforeEach(() => {
    process.env.CLERUM_STATELESS_ALLOW_CRON_MANAGE = 'true'
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-scope-')), 'state.db')
  })

  afterEach(async () => {
    delete process.env.CLERUM_STATELESS_ALLOW_CRON_MANAGE
    for (const handle of open.splice(0)) await handle.shutdown().catch(() => {})
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  function pod(): StoreHandle {
    const handle = makeSqliteStore({ dbPath, cacheSize: 4 })
    open.push(handle)
    return handle
  }

  /** Suspend on a card from the real producer, restart, rehydrate, approve "always". */
  async function approveAfterRestart(
    card: (controller: ApprovalController) => PendingApproval,
    setup?: (manager: ConversationManager) => Promise<void>
  ) {
    const podA = pod()
    const managerA = new ConversationManager(podA.store)
    const conv = await managerA.getOrCreate(SESSION_KEY)
    await setup?.(managerA)
    await managerA.startTurn(conv, 'do it', 'task-1')
    const g = gate()
    const approval = card(new ApprovalController(conv, g, { forcedApprovalGate: g }))
    await managerA.suspendForApproval(conv, {
      ...approval,
      tool_call_id: 'tc-1',
      task_budget: BUDGET,
    })
    await podA.shutdown()
    open.splice(open.indexOf(podA), 1)

    const podB = pod()
    const rehydrated = await new SqliteColdStartLoader(podB.store).loadPendingApprovals(Date.now())
    expect(rehydrated.map(r => r.request_id)).toEqual([approval.request_id])
    const reloaded = podB.store.get(SESSION_KEY)!
    expect(reloaded.state).toBe(ConversationState.AwaitingApproval)
    const wire = pendingApprovalWireFields(reloaded.pending_approval!)
    await new ConversationManager(podB.store).approve(reloaded, true, 'user-a')
    return { reloaded, wire }
  }

  function suspendedCard(result: ReturnType<ApprovalController['beforeTool']>): PendingApproval {
    if (typeof result !== 'object') throw new Error('expected a suspension')
    return result.approval
  }

  it('a forced cron create card stores no grant after a restart', async () => {
    const { reloaded, wire } = await approveAfterRestart(c =>
      suspendedCard(c.beforeTool('cron_manage', { action: 'create' }, 'tc-1'))
    )

    expect(reloaded.state).toBe(ConversationState.Processing)
    expect(reloaded.auto_approved_tools.has('cron_manage')).toBe(false)
    expect(reloaded.task_approved_tools?.has('cron_manage') ?? false).toBe(false)
    expect(wire.alwaysApproveAllowed).toBe(false)
  })

  it('a denial re-ask stores no grant after a restart', async () => {
    const { reloaded, wire } = await approveAfterRestart(
      c => suspendedCard(c.beforeTool('shell_exec', { command: 'ls' }, 'tc-1')),
      async manager => {
        const conv = await manager.getOrCreate(SESSION_KEY)
        await manager.startTurn(conv, 'first', 'task-0')
        await manager.suspendForApproval(conv, {
          request_id: 'req-0',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'x',
          tool_call_id: 'tc-0',
          context_snapshot: [],
          authorization_scope: 'turn_tools',
          task_budget: BUDGET,
        })
        await manager.deny(conv, { userId: 'user-a' })
      }
    )

    // The denier lifted the denial for this call, but the re-ask grants nothing.
    expect(reloaded.denials?.has('shell_exec') ?? false).toBe(false)
    expect(reloaded.auto_approved_tools.has('shell_exec')).toBe(false)
    expect(wire.alwaysApproveAllowed).toBe(false)
  })

  it('an ordinary card still stores its exact name after a restart (positive control)', async () => {
    const { reloaded, wire } = await approveAfterRestart(c =>
      suspendedCard(c.beforeTool('cron_manage', { action: 'list' }, 'tc-1'))
    )

    expect(reloaded.auto_approved_tools).toEqual(new Set(['cron_manage']))
    expect(wire.alwaysApproveAllowed).toBeUndefined()
  })
})
