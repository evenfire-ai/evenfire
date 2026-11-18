import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import {
  UnifiedApprovalGateController,
  buildConnectRequiredApproval,
} from '../../core/extensions/mcpApprovalGateController'
import type { ToolRegistry } from '../../core/interfaces'
import { BasicSafety } from '../../core/safety/safety'
import { createSessionRouteHandlers } from '../sessionRouteHandlers'

function makeHandlersUnderTest() {
  const convManager = new ConversationManager()
  const { handleSessionsList, handleSessionMessages } = createSessionRouteHandlers({
    getConversationManager: () => convManager,
    redactToolError: (_toolName, rawError) => rawError,
    redactTitle: rawTitle => rawTitle,
  })
  return { convManager, handleSessionsList, handleSessionMessages }
}

async function seed(convManager: ConversationManager, key: string): Promise<void> {
  const conv = await convManager.getOrCreate(key)
  await convManager.startTurn(conv, 'q', 'task')
  await convManager.completeTurn(conv, 'a')
}

/**
 * Suspend a seeded conversation with a connect_required PendingApproval built by
 * the REAL producer (`buildConnectRequiredApproval`), driven through the REAL
 * `ConversationManager.suspendForApproval`. No hand-built wire shape (T1).
 */
async function suspendConnectRequired(
  convManager: ConversationManager,
  key: string
): Promise<void> {
  const conv = await convManager.getOrCreate(key)
  await convManager.startTurn(conv, 'list boards', 'task-connect')
  const approval = buildConnectRequiredApproval(
    { id: 'tc_1', name: 'monday__list_boards', arguments: { limit: 5 } },
    { mcpServerName: 'monday' }
  )
  await convManager.suspendForApproval(conv, approval)
}

async function suspendGenericApproval(
  convManager: ConversationManager,
  key: string
): Promise<void> {
  const conv = await convManager.getOrCreate(key)
  await convManager.startTurn(conv, 'run it', 'task-approve')
  await convManager.suspendForApproval(conv, {
    request_id: 'req-approve',
    tool_name: 'shell_exec',
    parameters: {},
    description: 'Shell command',
    tool_call_id: 'tc_1',
    context_snapshot: [],
  })
}

describe('createSessionRouteHandlers — U5 connect_required projection on the rejoin snapshot', () => {
  it('handleSessionMessages surfaces reason/mcpServerName for a connect_required suspension', async () => {
    const { convManager, handleSessionMessages } = makeHandlersUnderTest()
    await suspendConnectRequired(convManager, 'user-A:rpc:agent-x:chat-1')

    const page = await handleSessionMessages('user-A', 'agent-x', 'chat-1', {})

    expect(page?.state).toBe('awaiting_approval')
    expect(page?.pendingApproval).toMatchObject({
      reason: 'connect_required',
      mcpServerName: 'monday',
    })
    expect(page?.pendingApproval).not.toHaveProperty('provider')
  })

  it('handleSessionsList surfaces the connect_required discriminator on the summary', async () => {
    const { convManager, handleSessionsList } = makeHandlersUnderTest()
    await suspendConnectRequired(convManager, 'user-A:rpc:agent-x:chat-1')

    const list = await handleSessionsList('user-A', {})
    const item = list.items.find(i => i.chatId === 'chat-1')
    expect(item?.pendingApproval).toMatchObject({
      reason: 'connect_required',
      mcpServerName: 'monday',
    })
    expect(item?.pendingApproval).not.toHaveProperty('provider')
  })

  it('a generic approval projects WITHOUT the connect fields (back-compat)', async () => {
    const { convManager, handleSessionMessages } = makeHandlersUnderTest()
    await suspendGenericApproval(convManager, 'user-A:rpc:agent-x:chat-2')

    const page = await handleSessionMessages('user-A', 'agent-x', 'chat-2', {})
    expect(page?.pendingApproval).toBeDefined()
    expect(page?.pendingApproval).not.toHaveProperty('reason')
    expect(page?.pendingApproval).not.toHaveProperty('mcpServerName')
    expect(page?.pendingApproval).not.toHaveProperty('provider')
  })
})

describe('createSessionRouteHandlers — handleSessionsList (R1-L2)', () => {
  it('treats an empty agent identically to an absent agent (unscoped catalog, not fail-closed)', async () => {
    const { convManager, handleSessionsList } = makeHandlersUnderTest()
    await seed(convManager, 'user-A:rpc:agent-x:chat-1')
    await seed(convManager, 'user-A:rpc:agent-y:chat-2')

    const absent = await handleSessionsList('user-A', {})
    const empty = await handleSessionsList('user-A', { agent: '' })

    // Absent agent → unscoped catalog spanning both agents.
    expect(absent.items.map(item => item.chatId).sort()).toEqual(['chat-1', 'chat-2'])
    // Empty agent must resolve to the SAME unscoped result. Before the fix the
    // prefix treated '' as falsy (unscoped) while the store query received ''
    // (agent scope), which fail-closed to an empty catalog — so the two diverged.
    expect(empty).toEqual(absent)
  })
})

describe('createSessionRouteHandlers — handleSessionsList cursor validation', () => {
  it('serves the next page for a valid cursor with exactly one store read (control)', async () => {
    const { convManager, handleSessionsList } = makeHandlersUnderTest()
    await seed(convManager, 'user-A:rpc:agent-x:chat-1')
    await seed(convManager, 'user-A:rpc:agent-x:chat-2')
    const first = await handleSessionsList('user-A', { agent: 'agent-x', limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toEqual(expect.any(String))

    const listSpy = vi.spyOn(convManager, 'listSessionSummariesForUserAsync')
    const second = await handleSessionsList('user-A', {
      agent: 'agent-x',
      limit: 1,
      cursor: first.nextCursor,
    })

    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.chatId).not.toBe(first.items[0]?.chatId)
  })

  it.each([
    ['a malformed cursor', () => 'not-a-cursor'],
    ['a cursor minted for another agent scope', (otherScopeCursor: string) => otherScopeCursor],
  ])(
    'rejects %s instead of silently serving page 1, without reading the store',
    async (_label, pick) => {
      const { convManager, handleSessionsList } = makeHandlersUnderTest()
      await seed(convManager, 'user-A:rpc:agent-x:chat-1')
      await seed(convManager, 'user-A:rpc:agent-x:chat-2')
      await seed(convManager, 'user-A:rpc:agent-y:chat-3')
      await seed(convManager, 'user-A:rpc:agent-y:chat-4')
      const otherScope = await handleSessionsList('user-A', { agent: 'agent-y', limit: 1 })
      expect(otherScope.nextCursor).toEqual(expect.any(String))

      const listSpy = vi.spyOn(convManager, 'listSessionSummariesForUserAsync')
      await expect(
        handleSessionsList('user-A', {
          agent: 'agent-x',
          limit: 1,
          cursor: pick(otherScope.nextCursor as string),
        })
      ).rejects.toThrow('Invalid sessions cursor')
      expect(listSpy).toHaveBeenCalledTimes(0)
    }
  )
})

describe('createSessionRouteHandlers — handleSessionsList title projection (spec 15 A12)', () => {
  async function seedWithTitle(
    convManager: ConversationManager,
    key: string,
    title: string
  ): Promise<void> {
    const conv = await convManager.getOrCreate(key)
    await convManager.startTurn(conv, 'first message', 'task', null, title)
    await convManager.completeTurn(conv, 'a')
  }

  it('includes the session title in the list payload', async () => {
    const { convManager, handleSessionsList } = makeHandlersUnderTest()
    await seedWithTitle(convManager, 'user-A:rpc:agent-x:chat-1', 'Plan a trip to Japan')

    const res = await handleSessionsList('user-A', {})
    expect(res.items[0]).toMatchObject({ chatId: 'chat-1', title: 'Plan a trip to Japan' })
  })

  it('omits the title field entirely when the session has none', async () => {
    const { convManager, handleSessionsList } = makeHandlersUnderTest()
    const conv = await convManager.getOrCreate('user-A:rpc:agent-x:chat-1')
    await convManager.startTurn(conv, 'q', 'task') // no autoTitle
    await convManager.completeTurn(conv, 'a')

    const res = await handleSessionsList('user-A', {})
    expect(res.items[0]).not.toHaveProperty('title')
  })

  it('re-redacts a secret in the title at projection time (defense in depth §5)', async () => {
    // Build handlers with the REAL BasicSafety redaction primitive (T1), matching
    // the main.ts wiring. Simulates a title that was materialized before the
    // operator marked the value secret (rotation) — the read path must still scrub it.
    const secret = 'syntheticS3cretRotatedInLater1234567890'
    const convManager = new ConversationManager()
    const safety = new BasicSafety(() => [{ name: 'API_KEY', value: secret }])
    const { handleSessionsList } = createSessionRouteHandlers({
      getConversationManager: () => convManager,
      redactToolError: (_t, e) => e,
      redactTitle: raw =>
        safety.sanitizeFreeformContent(raw, { secretWarning: 'secret in title' }).content,
    })

    const conv = await convManager.getOrCreate('user-A:rpc:agent-x:chat-1')
    // Title stored raw (redaction at materialization ran with an empty secret list).
    await convManager.startTurn(conv, 'msg', 'task', null, `key ${secret}`)
    await convManager.completeTurn(conv, 'a')

    const res = await handleSessionsList('user-A', {})
    expect(res.items[0]?.title).toBe('key [REDACTED:API_KEY]')
    expect(res.items[0]?.title).not.toContain(secret)
  })
})

describe('createSessionRouteHandlers — Always approve eligibility on every view (RP726-03)', () => {
  const BUDGET = { elapsedActiveMs: 0, iterationsUsed: 1, durationMs: 86_400_000, maxIterations: 9 }
  let dbPath: string
  const open: StoreHandle[] = []

  beforeEach(() => {
    process.env.CLERUM_STATELESS_ALLOW_CRON_MANAGE = 'true'
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-views-')), 'state.db')
  })

  afterEach(async () => {
    delete process.env.CLERUM_STATELESS_ALLOW_CRON_MANAGE
    for (const handle of open.splice(0)) await handle.shutdown().catch(() => {})
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  function handlersOver(handle: StoreHandle) {
    const manager = new ConversationManager(handle.store)
    return {
      manager,
      ...createSessionRouteHandlers({
        getConversationManager: () => manager,
        redactToolError: (_toolName, rawError) => rawError,
        redactTitle: rawTitle => rawTitle,
      }),
    }
  }

  /** A forced stateless cron card from the real gate, or an ordinary one. */
  function card(action: 'create' | 'list') {
    const gated = { requiresApproval: () => true }
    const gate = new UnifiedApprovalGateController(
      {
        get: () => gated,
        register: () => undefined,
        listDefinitions: () => [],
      } as unknown as ToolRegistry,
      { defaultPolicy: 'channel_users', channels: {}, tools: { cron_manage: true } },
      undefined,
      { statelessLifecycle: true }
    )
    const decision = gate.beforeTool('cron_manage', { action })
    if (typeof decision !== 'object') throw new Error('expected a suspension')
    return { ...decision.approval, tool_call_id: 'tc-1', task_budget: BUDGET }
  }

  async function views(handle: StoreHandle, chatId: string) {
    const { handleSessionsList, handleSessionMessages } = handlersOver(handle)
    const list = await handleSessionsList('user-A', {})
    const page = await handleSessionMessages('user-A', 'agent-x', chatId, {})
    return [list.items.find(i => i.chatId === chatId)?.pendingApproval, page?.pendingApproval]
  }

  it('hides Always approve for a forced card on hot and cold list/messages views', async () => {
    const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
    open.push(podA)
    const { manager } = handlersOver(podA)
    const conv = await manager.getOrCreate('user-A:rpc:agent-x:chat-forced')
    await manager.startTurn(conv, 'schedule it', 'task-1')
    await manager.suspendForApproval(conv, card('create'))

    for (const view of await views(podA, 'chat-forced')) {
      expect(view).toMatchObject({ alwaysApproveAllowed: false })
    }

    await podA.shutdown()
    open.splice(open.indexOf(podA), 1)
    const podB = makeSqliteStore({ dbPath, cacheSize: 4 })
    open.push(podB)
    for (const view of await views(podB, 'chat-forced')) {
      expect(view).toMatchObject({ alwaysApproveAllowed: false })
    }
  })

  it('offers Always approve for an ordinary card on the same views', async () => {
    const podA = makeSqliteStore({ dbPath, cacheSize: 4 })
    open.push(podA)
    const { manager } = handlersOver(podA)
    const conv = await manager.getOrCreate('user-A:rpc:agent-x:chat-ordinary')
    await manager.startTurn(conv, 'list them', 'task-1')
    await manager.suspendForApproval(conv, card('list'))

    for (const view of await views(podA, 'chat-ordinary')) {
      expect(view).toBeDefined()
      expect(view).not.toHaveProperty('alwaysApproveAllowed')
    }

    await podA.shutdown()
    open.splice(open.indexOf(podA), 1)
    const podB = makeSqliteStore({ dbPath, cacheSize: 4 })
    open.push(podB)
    for (const view of await views(podB, 'chat-ordinary')) {
      expect(view).not.toHaveProperty('alwaysApproveAllowed')
    }
  })
})
