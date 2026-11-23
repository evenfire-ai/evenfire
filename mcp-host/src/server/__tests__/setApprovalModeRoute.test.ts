import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySessionApprovalMode } from '../../agent/sessionApprovalMode'
import type { ApprovalConfigSnapshot } from '../../core/approval/approvalMode'
import { classifierAvailable } from '../../core/approval/shellClassifier'
import { ConversationManager } from '../../core/conversation/conversation'
import { InMemoryConversationStore } from '../../core/conversation/conversationStore'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import { ConversationState } from '../../core/types'
import { runMigrations } from '../../db/migrate'
import { applyPragmas } from '../../db/pragmas'
import { createDispatcher, dispatch } from '../../db/worker/dispatcher'
import type { SessionRow } from '../../db/worker/protocol'
import { serializeSessionKey } from '../../session'
import { handleSetApprovalModeRoute } from '../routes'
import { createSessionRouteHandlers } from '../sessionRouteHandlers'
import type { SetApprovalModeHandler } from '../types'
import { makeHandlers } from './testHelpers'

const USER = 'u-1'
const AGENT = 'agent-x'
const CHAT = 'chat-1'
const RPC_CALLER = { caller: 'rpc-proxy', userId: USER, hostRef: AGENT }

function rpcKey(user = USER, agent = AGENT, chat = CHAT): string {
  return serializeSessionKey({
    userId: user,
    channelType: 'rpc',
    channelId: agent,
    threadId: chat,
  })
}

function makeRes() {
  const captured: { statusCode?: number; jsonBody?: unknown } = {}
  const res = {
    writeHead: vi.fn().mockImplementation((status: number) => {
      captured.statusCode = status
      return res
    }),
    end: vi.fn().mockImplementation((body?: string) => {
      if (typeof body === 'string') {
        try {
          captured.jsonBody = JSON.parse(body)
        } catch {
          captured.jsonBody = body
        }
      }
      return res
    }),
  } as unknown as Response
  return {
    get statusCode() {
      return captured.statusCode
    },
    get jsonBody() {
      return captured.jsonBody
    },
    res,
  }
}

function makeReq(opts: {
  caller?: { caller: string; userId?: string; hostRef?: string }
  agent?: string
  chatId?: string
  body?: unknown
}): Request {
  return {
    runtimeCaller: opts.caller,
    params: { agent: opts.agent ?? AGENT, chatId: opts.chatId ?? CHAT },
    body: opts.body,
    query: {},
  } as unknown as Request
}

function hostSpec(ceiling: 'manual' | 'auto' | 'allow_all'): ApprovalConfig {
  return { defaultPolicy: 'cli_only', channels: {}, modeCeiling: ceiling }
}

function snapshot(spec: ApprovalConfig | undefined): ApprovalConfigSnapshot {
  return {
    effective: {
      defaultPolicy: 'channel_users',
      channels: {},
      modeCeiling: 'allow_all',
    },
    hostSpec: spec,
  }
}

function realHandler(
  manager: ConversationManager,
  live: ApprovalConfigSnapshot = snapshot(hostSpec('allow_all'))
): SetApprovalModeHandler {
  return (userSub, agent, chatId, mode) =>
    applySessionApprovalMode(
      { convManager: manager, approvalSnapshot: () => live },
      userSub,
      agent,
      chatId,
      mode
    )
}

async function seedRpc(manager: ConversationManager, user = USER): Promise<void> {
  await manager.getOrCreate(rpcKey(user), {
    userId: user,
    channelType: 'rpc',
    channelId: AGENT,
    threadId: CHAT,
    source: 'rpc',
  })
}

describe('handleSetApprovalModeRoute', () => {
  const open: StoreHandle[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const handle of open.splice(0)) await handle.shutdown().catch(() => {})
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('returns 401 when the caller is not the rpc edge user', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpc(manager)
    const captured = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({
        caller: { caller: 'channel-reader', userId: USER },
        body: { mode: 'auto' },
      }),
      captured.res,
      makeHandlers({ setApprovalModeHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(401)
    expect(captured.jsonBody).toEqual({ error: 'Missing rpc edge caller context' })
    expect(manager.getSessionByKey(rpcKey())?.approval_mode).toBe('manual')
  })

  function okHandler() {
    return vi.fn<SetApprovalModeHandler>(async () => ({
      ok: true,
      approvalMode: 'auto',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'auto',
    }))
  }

  it('returns 400 for an unsafe agent segment and does not call the handler', async () => {
    const handler = okHandler()
    for (const agent of ['agent:x', '..', 'a/b', 'a\\b', 'a\u0000b', 'a'.repeat(201)]) {
      const captured = makeRes()
      await handleSetApprovalModeRoute(
        makeReq({ caller: RPC_CALLER, agent, body: { mode: 'auto' } }),
        captured.res,
        makeHandlers({ setApprovalModeHandler: handler })
      )
      expect(captured.statusCode).toBe(400)
      expect(captured.jsonBody).toEqual({ error: 'Invalid agent or chatId' })
    }
    expect(handler).not.toHaveBeenCalled()

    const safe = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({ caller: RPC_CALLER, body: { mode: 'auto' } }),
      safe.res,
      makeHandlers({ setApprovalModeHandler: handler })
    )
    expect(safe.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(USER, AGENT, CHAT, 'auto')
  })

  it('returns 400 for an unsafe chatId segment and does not call the handler', async () => {
    const handler = okHandler()
    for (const chatId of ['.', '..', 'x/y', 'x\\y', 'x\u001fy', 'x'.repeat(501)]) {
      const captured = makeRes()
      await handleSetApprovalModeRoute(
        makeReq({ caller: RPC_CALLER, chatId, body: { mode: 'auto' } }),
        captured.res,
        makeHandlers({ setApprovalModeHandler: handler })
      )
      expect(captured.statusCode).toBe(400)
      expect(captured.jsonBody).toEqual({ error: 'Invalid agent or chatId' })
    }
    expect(handler).not.toHaveBeenCalled()

    const safe = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({ caller: RPC_CALLER, chatId: 'chat:with:colons', body: { mode: 'auto' } }),
      safe.res,
      makeHandlers({ setApprovalModeHandler: handler })
    )
    expect(safe.statusCode).toBe(200)
    expect(handler).toHaveBeenCalledWith(USER, AGENT, 'chat:with:colons', 'auto')
  })

  it('returns 501 when no set-approval-mode handler is configured', async () => {
    const captured = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({ caller: RPC_CALLER, body: { mode: 'auto' } }),
      captured.res,
      makeHandlers()
    )
    expect(captured.statusCode).toBe(501)
    expect(captured.jsonBody).toEqual({ error: 'Set approval mode handler not configured' })
  })

  it('returns 400 for a mode outside the enum and does not create a row', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    const captured = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({ caller: RPC_CALLER, body: { mode: 'yolo' } }),
      captured.res,
      makeHandlers({ setApprovalModeHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(400)
    expect(captured.jsonBody).toEqual({ error: 'invalid mode' })
    expect(manager.getStore().listByPrefix('')).toHaveLength(0)
  })

  it('returns 400 for an invalid mode and leaves the stored mode unchanged', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpc(manager)
    const captured = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({ caller: RPC_CALLER, body: { mode: 'allow-all' } }),
      captured.res,
      makeHandlers({ setApprovalModeHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(400)
    expect(manager.getSessionByKey(rpcKey())?.approval_mode).toBe('manual')
  })

  it('returns 404 for a missing session and does not create a row', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    const captured = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({ caller: RPC_CALLER, chatId: 'ghost', body: { mode: 'auto' } }),
      captured.res,
      makeHandlers({ setApprovalModeHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(404)
    expect(captured.jsonBody).toEqual({ error: 'session not found' })
    expect(manager.getStore().listByPrefix('')).toHaveLength(0)
  })

  it('returns 404 for another user and does not reveal or retarget the row', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpc(manager, USER)
    const captured = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({
        caller: { caller: 'rpc-proxy', userId: 'u-2', hostRef: AGENT },
        body: { mode: 'allow_all' },
      }),
      captured.res,
      makeHandlers({ setApprovalModeHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(404)
    expect(captured.jsonBody).toEqual({ error: 'session not found' })
    expect(manager.getSessionByKey(rpcKey(USER))?.approval_mode).toBe('manual')
    expect(manager.getStore().listByPrefix('')).toHaveLength(1)
  })

  it('stores a choice above the ceiling and returns the clamped effective mode', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpc(manager)
    const captured = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({ caller: RPC_CALLER, body: { mode: 'allow_all' } }),
      captured.res,
      makeHandlers({ setApprovalModeHandler: realHandler(manager, snapshot(hostSpec('manual'))) })
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({
      approvalMode: 'allow_all',
      modeCeiling: 'manual',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'manual',
    })
    expect(manager.getSessionByKey(rpcKey())?.approval_mode).toBe('allow_all')
  })

  it('leaves a waiting card waiting', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    const conv = await manager.getOrCreate(rpcKey(), {
      userId: USER,
      channelType: 'rpc',
      channelId: AGENT,
      threadId: CHAT,
      source: 'rpc',
    })
    await manager.startTurn(conv, 'run it', 'task-wait')
    await manager.suspendForApproval(conv, {
      request_id: 'req-wait',
      tool_name: 'shell_exec',
      parameters: { command: 'ls' },
      description: 'Shell command',
      tool_call_id: 'tc-1',
      context_snapshot: [],
    })
    const captured = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({ caller: RPC_CALLER, body: { mode: 'auto' } }),
      captured.res,
      makeHandlers({ setApprovalModeHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(200)
    expect(conv.state).toBe(ConversationState.AwaitingApproval)
    expect(conv.pending_approval?.request_id).toBe('req-wait')
    expect(conv.approval_mode).toBe('auto')
  })

  it('reloads the stored mode after a cold restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-mode-route-'))
    dirs.push(dir)
    const dbPath = join(dir, 'state.db')
    const first = makeSqliteStore({ dbPath })
    open.push(first)
    const manager = new ConversationManager(first.store)
    await seedRpc(manager)
    const captured = makeRes()
    await handleSetApprovalModeRoute(
      makeReq({ caller: RPC_CALLER, body: { mode: 'auto' } }),
      captured.res,
      makeHandlers({
        setApprovalModeHandler: realHandler(manager, snapshot(hostSpec('allow_all'))),
      })
    )
    expect(captured.statusCode).toBe(200)
    await first.shutdown()
    open.pop()

    const second = makeSqliteStore({ dbPath })
    open.push(second)
    const reloaded = new ConversationManager(second.store)
    expect(second.store.get(rpcKey())).toBeUndefined()
    const conv = await reloaded.getSessionByKeyForUserAsync(rpcKey(), USER)
    expect(conv?.approval_mode).toBe('auto')
  })
})

describe('session reads project the live approval config', () => {
  const open: StoreHandle[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const handle of open.splice(0)) await handle.shutdown().catch(() => {})
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function handlersFor(
    manager: ConversationManager,
    live: ApprovalConfigSnapshot,
    sessionModel: (selections: Record<string, string> | undefined) => {
      providerType: string
      modelName: string
    }
  ) {
    return createSessionRouteHandlers({
      getConversationManager: () => manager,
      redactToolError: (_tool, raw) => raw,
      redactTitle: raw => raw,
      approvalSnapshot: () => live,
      sessionModel,
    })
  }

  async function coldManager(seed: (manager: ConversationManager) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'approval-mode-reads-'))
    dirs.push(dir)
    const dbPath = join(dir, 'state.db')
    const first = makeSqliteStore({ dbPath })
    open.push(first)
    await seed(new ConversationManager(first.store))
    await first.shutdown()
    open.pop()
    const second = makeSqliteStore({ dbPath })
    open.push(second)
    return new ConversationManager(second.store)
  }

  it('fills all five fields on a cold list and transcript, ignoring an env ceiling', async () => {
    const manager = await coldManager(async created => {
      const conv = await created.getOrCreate(rpcKey(), {
        userId: USER,
        channelType: 'rpc',
        channelId: AGENT,
        threadId: CHAT,
        source: 'rpc',
        approvalMode: 'auto',
      })
      await created.setModelSelection(conv, 'openai', 'gpt-5')
      await created.startTurn(conv, 'hello', 'task-1')
      await created.completeTurn(conv, 'hi')
    })
    expect(manager.getSessionByKey(rpcKey())).toBeUndefined()
    const sessionModel = (selections: Record<string, string> | undefined) =>
      selections?.openai
        ? { providerType: 'openai', modelName: selections.openai }
        : { providerType: 'claude', modelName: 'claude-sonnet-4-5' }
    const { handleSessionsList, handleSessionMessages } = handlersFor(
      manager,
      snapshot(undefined),
      sessionModel
    )
    const expected = {
      approvalMode: 'auto',
      modeCeiling: 'manual',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'manual',
      shellClassifierAvailable: false,
    }
    expect(classifierAvailable('openai', 'gpt-5', {})).toBe(false)
    const list = await handleSessionsList(USER, {})
    expect(list.items[0]).toMatchObject(expected)
    const page = await handleSessionMessages(USER, AGENT, CHAT, {})
    expect(page).toMatchObject(expected)
  })

  it('treats a Host with no spec.approval as manual and honors a dev-mode host spec', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await manager.getOrCreate(rpcKey(), {
      userId: USER,
      channelType: 'rpc',
      channelId: AGENT,
      threadId: CHAT,
      source: 'rpc',
      approvalMode: 'allow_all',
    })
    const model = () => ({ providerType: 'claude', modelName: 'claude-sonnet-4-5' })
    const absent = handlersFor(manager, { effective: undefined, hostSpec: undefined }, model)
    const absentPage = await absent.handleSessionMessages(USER, AGENT, CHAT, {})
    expect(absentPage).toMatchObject({
      approvalMode: 'allow_all',
      modeCeiling: 'manual',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'manual',
      shellClassifierAvailable: true,
    })
    const dev = handlersFor(manager, snapshot(hostSpec('allow_all')), model)
    const devPage = await dev.handleSessionMessages(USER, AGENT, CHAT, {})
    expect(devPage).toMatchObject({
      modeCeiling: 'allow_all',
      effectiveApprovalMode: 'allow_all',
      shellClassifierAvailable: true,
    })
  })

  it('reads the channel cap from the stored channel type, not the session key', async () => {
    const manager = await coldManager(async created => {
      const key = rpcKey()
      await created.getOrCreate(key, {
        userId: USER,
        channelType: 'email',
        channelId: AGENT,
        threadId: CHAT,
        source: 'email',
        approvalMode: 'allow_all',
      })
      await created.getOrCreate(rpcKey(USER, AGENT, 'unset'), {
        userId: USER,
        source: 'rpc',
      })
    })
    const live: ApprovalConfigSnapshot = {
      effective: snapshot(undefined).effective,
      hostSpec: {
        defaultPolicy: 'cli_only',
        // Explicit false: the email cap must read manual whatever the default,
        // so a reader that parses the rpc-shaped key (allow_all) still fails.
        channels: { email: { enabled: true, allowModeChange: false } },
        modeCeiling: 'allow_all',
      },
    }
    const { handleSessionsList } = handlersFor(manager, live, () => ({
      providerType: 'unknown',
      modelName: 'unknown',
    }))
    const list = await handleSessionsList(USER, {})
    const emailColumn = list.items.find(item => item.chatId === CHAT)
    const unset = list.items.find(item => item.chatId === 'unset')
    expect(emailColumn?.channelCap).toBe('manual')
    expect(emailColumn?.approvalMode).toBe('allow_all')
    expect(unset?.channelCap).toBe('manual')
    expect(unset?.approvalMode).toBe('manual')
  })
})

describe('SQLite worker session listing', () => {
  it('returns the stored mode and channel type and does not compute the ceiling', async () => {
    const db = new Database(':memory:')
    applyPragmas(db)
    runMigrations(db)
    try {
      const deps = createDispatcher(db)
      const row: SessionRow = {
        id: 'conv-mode',
        session_key: 'u-1:rpc:agent-x:chat-1',
        source: 'rpc',
        user_id: 'u-1',
        team_id: null,
        channel_type: 'slack',
        channel_id: 'agent-x',
        thread_id: 'chat-1',
        model: null,
        model_selections: null,
        system_prompt_stable_hash: null,
        parent_session_id: null,
        started_at: 1_700_000_000,
        ended_at: null,
        end_reason: null,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cache_tokens_reported: 0,
        title: null,
        state: 'idle',
        active_task_id: null,
        active_trace_context: null,
        approval_mode: 'auto',
      }
      await dispatch({ kind: 'insert_session', payload: row }, deps)
      const summaries = (await dispatch(
        {
          kind: 'list_session_summaries_by_prefix',
          sessionKeyPrefix: 'u-1:rpc:',
          userId: 'u-1',
        },
        deps
      )) as Array<{ session: SessionRow }>
      expect(summaries).toHaveLength(1)
      expect(summaries[0]?.session.approval_mode).toBe('auto')
      expect(summaries[0]?.session.channel_type).toBe('slack')
      const encoded = JSON.stringify(summaries)
      expect(encoded).not.toContain('modeCeiling')
      expect(encoded).not.toContain('channelCap')
      expect(encoded).not.toContain('effectiveApprovalMode')
      expect(encoded).not.toContain('shellClassifierAvailable')
    } finally {
      db.close()
    }
  })
})
