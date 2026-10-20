import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { ConversationManager } from '../../core/conversation/conversation'
import { toModelStepCheckpointView } from '../../core/conversation/modelStepCheckpointView'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import { buildConnectRequiredApproval } from '../../core/extensions/mcpApprovalGateController'
import { BasicSafety } from '../../core/safety/safety'
import { serializeModelStepCheckpointLoopState } from '../../db/worker/protocol'
import { logger } from '../../logger'
import { handleSessionMessagesRoute } from '../routes'
import { createSessionRouteHandlers, loadSessionModelStepCheckpoint } from '../sessionRouteHandlers'
import { makeHandlers } from './testHelpers'

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

describe('session read model-step recording cost', () => {
  it.each(['entry', 'loop_state', 'task_budget', 'source_message', 'status'])(
    'E3 R1-M1: omits a corrupt %s row with a log witness and keeps claim strict',
    async field => {
      const handle = makeSqliteStore()
      const manager = new ConversationManager(handle.store)
      const now = Date.now()
      const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
        now: () => now,
        blockedTtlMs: 3_600_000,
      })
      const warn = vi.spyOn(logger, 'warn')
      const { handleSessionMessages } = createSessionRouteHandlers({
        getConversationManager: () => manager,
        redactToolError: (_name, text) => text,
        redactTitle: text => text,
        loadModelStepCheckpoint: key => loadSessionModelStepCheckpoint(checkpoints, key, now),
      })
      try {
        const key = 'user-A:rpc:agent-x:corrupt'
        const conv = await manager.getOrCreate(key)
        await manager.startTurn(conv, 'readable question', 'task-origin')
        const fence = await checkpoints.open(
          {
            checkpointId: 'cp-corrupt',
            sessionKey: key,
            originTurnNumber: 1,
            originTaskId: 'task-origin',
            provider: 'openai',
            model: 'model',
            hostId: 'host-a',
            principal: 'user-A',
            loopState: serializeModelStepCheckpointLoopState({
              nextIteration: 0,
              originUserMessageIndex: 0,
            }),
            taskBudget: null,
            sourceMessage: null,
          },
          [
            {
              kind: 'message',
              toolCallId: null,
              payload: JSON.stringify({ role: 'user', content: 'readable question' }),
            },
          ]
        )
        const version = await checkpoints.transition(key, fence, {
          from: ['open'],
          to: 'resumable',
          failedAt: now,
          expiresAt: now + 3_600_000,
        })
        await manager.failTurn(conv)
        const healthy = await handleSessionMessages('user-A', 'agent-x', 'corrupt', {})
        expect(healthy?.modelStepCheckpoint).toMatchObject({
          checkpointId: 'cp-corrupt',
          retryAvailable: true,
        })
        if (field === 'entry') {
          handle.worker.db
            .prepare(
              'UPDATE model_step_checkpoint_entries SET payload = ? WHERE checkpoint_id = ? AND seq = 1'
            )
            .run('{private transcript fragment', 'cp-corrupt')
        } else {
          if (field === 'status') handle.worker.db.pragma('ignore_check_constraints = ON')
          handle.worker.db
            .prepare(`UPDATE model_step_checkpoints SET ${field} = ? WHERE checkpoint_id = ?`)
            .run(field === 'status' ? 'invalid' : '{private transcript fragment', 'cp-corrupt')
        }
        const read = await handleSessionMessages('user-A', 'agent-x', 'corrupt', {})
        expect(read?.turns[0]?.user_input).toBe('readable question')
        expect(read).not.toHaveProperty('modelStepCheckpoint')
        const writeHead = vi.fn()
        const end = vi.fn()
        await handleSessionMessagesRoute(
          {
            runtimeCaller: { caller: 'rpc-proxy', hostRef: 'agent-x', userId: 'user-A' },
            params: { agent: 'agent-x', chatId: 'corrupt' },
            query: {},
          } as unknown as Request,
          { writeHead, end } as unknown as Response,
          makeHandlers({ sessionMessagesHandler: handleSessionMessages })
        )
        expect(writeHead).toHaveBeenCalledWith(200, expect.anything())
        expect(JSON.parse(end.mock.calls[0][0]).turns[0].user_input).toBe('readable question')
        expect(JSON.parse(end.mock.calls[0][0])).not.toHaveProperty('modelStepCheckpoint')
        expect(warn).toHaveBeenCalledWith(
          {
            checkpointId: 'cp-corrupt',
            seq: field === 'entry' ? 1 : null,
            code: 'MODEL_STEP_CHECKPOINT_CORRUPT',
          },
          'Invalid model-step checkpoint row'
        )
        await expect(
          checkpoints.claim({
            sessionKey: key,
            checkpointId: 'cp-corrupt',
            version: version!,
            hostInstanceId: 'host-a',
            newTaskId: 'task-cont',
            leaseMs: 1000,
          })
        ).rejects.toMatchObject({
          code: 'MODEL_STEP_CHECKPOINT_CORRUPT',
          message: 'Invalid model-step checkpoint row',
        })
        expect(
          handle.worker.db
            .prepare('SELECT status FROM model_step_checkpoints WHERE checkpoint_id = ?')
            .get('cp-corrupt')
        ).toEqual({ status: field === 'status' ? 'invalid' : 'resumable' })
      } finally {
        warn.mockRestore()
        await handle.shutdown()
      }
    }
  )

  it('E3 R1-M1: a real checkpoint worker timeout rejects and the next read still offers retry', async () => {
    const handle = makeSqliteStore()
    const manager = new ConversationManager(handle.store)
    const now = Date.now()
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => now,
      blockedTtlMs: 3_600_000,
    })
    const key = 'user-A:rpc:agent-x:timeout'
    const { handleSessionMessages } = createSessionRouteHandlers({
      getConversationManager: () => manager,
      redactToolError: (_name, text) => text,
      redactTitle: text => text,
      loadModelStepCheckpoint: key => loadSessionModelStepCheckpoint(checkpoints, key, now),
    })
    let post: ReturnType<typeof vi.spyOn> | undefined
    let acknowledgeDelayed: (() => void) | undefined
    try {
      const conv = await manager.getOrCreate(key)
      await manager.startTurn(conv, 'timeout question', 'task-origin')
      const fence = await checkpoints.open(
        {
          checkpointId: 'cp-timeout',
          sessionKey: key,
          originTurnNumber: 1,
          originTaskId: 'task-origin',
          provider: 'openai',
          model: 'model',
          hostId: 'host-a',
          principal: 'user-A',
          loopState: serializeModelStepCheckpointLoopState({
            nextIteration: 0,
            originUserMessageIndex: 0,
          }),
          taskBudget: null,
          sourceMessage: null,
        },
        [
          {
            kind: 'message',
            toolCallId: null,
            payload: JSON.stringify({ role: 'user', content: 'timeout question' }),
          },
        ]
      )
      await checkpoints.transition(key, fence, {
        from: ['open'],
        to: 'resumable',
        failedAt: now,
        expiresAt: now + 3_600_000,
      })
      await manager.failTurn(conv)
      const original = handle.worker.worker.postMessage.bind(handle.worker.worker)
      let stalled = false
      post = vi.spyOn(handle.worker.worker, 'postMessage').mockImplementation(message => {
        if (message.op.kind === 'model_step_checkpoint_load_live' && !stalled) {
          stalled = true
          acknowledgeDelayed = () => original(message)
          return
        }
        original(message)
      })
      await expect(handleSessionMessages('user-A', 'agent-x', 'timeout', {})).rejects.toThrow(
        'db worker timeout (2000ms) for op=model_step_checkpoint_load_live'
      )
      expect(stalled).toBe(true)
      // A late worker ACK drains the timed-out operation before shutdown.
      acknowledgeDelayed!()
      acknowledgeDelayed = undefined
      const read = await handleSessionMessages('user-A', 'agent-x', 'timeout', {})
      expect(read?.turns[0]?.user_input).toBe('timeout question')
      expect(read?.modelStepCheckpoint).toMatchObject({
        checkpointId: 'cp-timeout',
        retryAvailable: true,
      })
    } finally {
      acknowledgeDelayed?.()
      post?.mockRestore()
      await handle.shutdown()
    }
  })

  it('D1 M2: serves a resumable checkpoint while a running session has an unreadable open ledger', async () => {
    const handle = makeSqliteStore()
    const manager = new ConversationManager(handle.store)
    const now = Date.now()
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => now,
      blockedTtlMs: 3_600_000,
    })
    const { handleSessionMessages } = createSessionRouteHandlers({
      getConversationManager: () => manager,
      redactToolError: (_name, text) => text,
      redactTitle: text => text,
      loadModelStepCheckpoint: async key => {
        const snapshot = await checkpoints.loadLive(key)
        return snapshot ? toModelStepCheckpointView(snapshot, now) : undefined
      },
    })
    try {
      for (const chat of ['running', 'resumable']) {
        const key = `user-A:rpc:agent-x:${chat}`
        const conv = await manager.getOrCreate(key)
        await manager.startTurn(conv, `question ${chat}`, `task-${chat}`)
        const fence = await checkpoints.open(
          {
            checkpointId: `cp-${chat}`,
            sessionKey: key,
            originTurnNumber: 1,
            originTaskId: `task-${chat}`,
            provider: 'openai',
            model: 'test-model',
            hostId: 'host-a',
            principal: 'user-A',
            loopState: null,
            taskBudget: null,
            sourceMessage: null,
          },
          [
            {
              kind: 'message',
              toolCallId: null,
              payload:
                chat === 'running'
                  ? 'unreadable open ledger'
                  : JSON.stringify({ role: 'user', content: 'question resumable' }),
            },
          ]
        )
        if (chat === 'resumable') {
          await checkpoints.transition(key, fence, {
            from: ['open'],
            to: 'resumable',
            failedAt: now,
            expiresAt: now + 3_600_000,
          })
          await manager.failTurn(conv)
        }
      }
      const live = await handleSessionMessages('user-A', 'agent-x', 'resumable', {})
      expect(live?.modelStepCheckpoint).toMatchObject({
        checkpointId: 'cp-resumable',
        status: 'resumable',
        retryAvailable: true,
      })
      expect(live?.turns[0]?.user_input).toBe('question resumable')
      const running = await handleSessionMessages('user-A', 'agent-x', 'running', {})
      expect(running).toMatchObject({ state: 'processing', activeTaskId: 'task-running' })
      expect(running?.turns[0]?.user_input).toBe('question running')
      expect(running).not.toHaveProperty('modelStepCheckpoint')
    } finally {
      await handle.shutdown()
    }
  })
})

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
