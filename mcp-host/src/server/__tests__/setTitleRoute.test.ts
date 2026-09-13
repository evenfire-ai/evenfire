import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { applySessionTitle } from '../../agent/sessionTitle'
import { ConversationManager } from '../../core/conversation/conversation'
import { InMemoryConversationStore } from '../../core/conversation/conversationStore'
import { serializeSessionKey } from '../../session'
import { handleSetTitleRoute } from '../routes'
import type { SetTitleHandler } from '../types'
import { makeHandlers } from './testHelpers'

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
    params: { agent: opts.agent ?? 'agent-x', chatId: opts.chatId ?? 'chat-1' },
    body: opts.body,
    query: {},
  } as unknown as Request
}

const RPC_CALLER = { caller: 'rpc-proxy', userId: 'u-1', hostRef: 'agent-x' }

async function managerWithSession(user = 'u-1'): Promise<ConversationManager> {
  const manager = new ConversationManager(new InMemoryConversationStore())
  await manager.getOrCreate(
    serializeSessionKey({
      userId: user,
      channelType: 'rpc',
      channelId: 'agent-x',
      threadId: 'chat-1',
    }),
    { userId: user, channelType: 'rpc', channelId: 'agent-x', threadId: 'chat-1', source: 'rpc' }
  )
  return manager
}

/** Wire the REAL core (T1) behind the route so 404-uniform / validation are genuine. */
function realHandler(manager: ConversationManager): SetTitleHandler {
  return (userSub, agent, chatId, title) =>
    applySessionTitle({ convManager: manager }, userSub, agent, chatId, title)
}

describe('handleSetTitleRoute (spec 15 Fase B)', () => {
  it('401 when the caller is not rpc-proxy', async () => {
    const manager = await managerWithSession()
    const captured = makeRes()
    await handleSetTitleRoute(
      makeReq({ caller: { caller: 'channel-reader', userId: 'u-1' }, body: { title: 'x' } }),
      captured.res,
      makeHandlers({ setTitleHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(401)
  })

  it('400 invalid title for an empty/whitespace body', async () => {
    const manager = await managerWithSession()
    const captured = makeRes()
    await handleSetTitleRoute(
      makeReq({ caller: RPC_CALLER, body: { title: '   ' } }),
      captured.res,
      makeHandlers({ setTitleHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(400)
    expect(captured.jsonBody).toEqual({ error: 'invalid title' })
  })

  it('404 (uniform) for a non-existent session', async () => {
    const manager = await managerWithSession()
    const captured = makeRes()
    await handleSetTitleRoute(
      makeReq({ caller: RPC_CALLER, chatId: 'ghost', body: { title: 'New' } }),
      captured.res,
      makeHandlers({ setTitleHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(404)
    expect(captured.jsonBody).toEqual({ error: 'session not found' })
  })

  it('404 (SAME shape) for a session owned by another user — no oracle', async () => {
    const manager = await managerWithSession('u-1')
    const captured = makeRes()
    await handleSetTitleRoute(
      // caller is u-2, session belongs to u-1
      makeReq({
        caller: { caller: 'rpc-proxy', userId: 'u-2', hostRef: 'agent-x' },
        body: { title: 'New' },
      }),
      captured.res,
      makeHandlers({ setTitleHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(404)
    expect(captured.jsonBody).toEqual({ error: 'session not found' })
  })

  it('200 with the sanitized canonical title on success', async () => {
    const manager = await managerWithSession()
    const captured = makeRes()
    await handleSetTitleRoute(
      makeReq({ caller: RPC_CALLER, body: { title: '  Quarterly   plan ' } }),
      captured.res,
      makeHandlers({ setTitleHandler: realHandler(manager) })
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({ ok: true, title: 'Quarterly plan' })
  })

  it('never logs the raw title — only titleLength (T4)', async () => {
    const manager = await managerWithSession()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const captured = makeRes()
      const secretish = 'MyPrivateBoardName'
      await handleSetTitleRoute(
        makeReq({ caller: RPC_CALLER, body: { title: secretish } }),
        captured.res,
        makeHandlers({ setTitleHandler: realHandler(manager) })
      )
      expect(captured.statusCode).toBe(200)
      const allLogs = infoSpy.mock.calls.map(args => args.join(' ')).join('\n')
      expect(allLogs).not.toContain(secretish)
      expect(allLogs).toContain('titleLength')
    } finally {
      infoSpy.mockRestore()
    }
  })
})
