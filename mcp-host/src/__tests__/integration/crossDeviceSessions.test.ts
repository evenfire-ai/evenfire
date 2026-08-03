/**
 * Cross-device desktop sessions — integration regression guard.
 *
 * Wires the REAL handleSessionsListRoute and handleSessionMessagesRoute into
 * an Express app, backed by a real ConversationManager. The only thing faked
 * is the JWT middleware — an `x-test-sub` header populates `req.auth` directly
 * (we're not testing the JWT plumbing; requireScope has its own tests).
 *
 * Proves three invariants:
 *   1. After a message+turn is seeded under <sub>:rpc:<agent>:<chatId>,
 *      a request with the same `sub` can list and read that session
 *      (mirrors "laptop A starts a chat, laptop B sees it").
 *   2. A request with a DIFFERENT `sub` sees an empty catalog
 *      (cross-user isolation).
 *   3. A request with a different `sub` asking for user-A's transcript by
 *      its exact path returns 404 with the same body as "never existed"
 *      (enumeration-defense).
 *
 * The 2026-03-28 userId-mismatch bug class is covered transitively: if
 * submit and read used different userId conventions, the catalog lookup
 * here would return 0 items and tests (1) and (2) would fail.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { ConversationManager } from '../../core/conversation/conversation'
import { makeHandlers } from '../../server/__tests__/testHelpers'
import { handleSessionMessagesRoute, handleSessionsListRoute } from '../../server/routes'
import { createSessionRouteHandlers } from '../../server/sessionRouteHandlers'
import { decodeSessionsCursor, sessionsCursorScope } from '../../server/wireProjections'

function makeApp(convManager: ConversationManager) {
  const app = express()
  app.use(express.json())

  // Test-only auth injection: bypasses JWT validation. The dev server refactor
  // moved the /sessions routes behind `runtimeEdgeGuard(['rpc-proxy'])`, which
  // reads `req.runtimeCaller` (not `req.auth`). Mirror that contract here so the
  // route handlers resolve the user from `caller.userId`. No x-test-sub → no
  // caller context → 401 (the unauth tests still hold).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const sub = req.header('x-test-sub')
    if (sub) {
      ;(req as Request & { auth: { sub: string } }).auth = { sub }
      ;(
        req as Request & {
          runtimeCaller: { caller: 'rpc-proxy'; hostRef: string; userId: string }
        }
      ).runtimeCaller = { caller: 'rpc-proxy', hostRef: 'chatllm', userId: sub }
    }
    next()
  })

  // Wire the REAL production handlers (createSessionRouteHandlers) over a real
  // ConversationManager — no reimplemented pagination/mapping. `redactToolError`
  // is a passthrough here (tool-error redaction has its own coverage and is not
  // exercised by these transcripts).
  const { handleSessionsList, handleSessionMessages } = createSessionRouteHandlers({
    getConversationManager: () => convManager,
    redactToolError: (_toolName, rawError) => rawError,
  })
  const handlers = makeHandlers({
    sessionsListHandler: handleSessionsList,
    sessionMessagesHandler: handleSessionMessages,
  })

  app.get('/v1/runtime/sessions', async (req, res) => {
    await handleSessionsListRoute(req, res, handlers)
  })
  app.get('/v1/runtime/sessions/:agent/:chatId/messages', async (req, res) => {
    await handleSessionMessagesRoute(req, res, handlers)
  })

  return app
}

async function seedConversation(
  convManager: ConversationManager,
  userSub: string,
  agent: string,
  chatId: string,
  userInput: string,
  response: string
) {
  const key = `${userSub}:rpc:${agent}:${chatId}`
  const conv = await convManager.getOrCreate(key)
  await convManager.startTurn(conv, userInput, 'test-task')
  await convManager.completeTurn(conv, response)
  return conv
}

describe('Cross-device desktop sessions — integration regression guard', () => {
  let convManager: ConversationManager
  let app: ReturnType<typeof makeApp>

  beforeEach(() => {
    convManager = new ConversationManager()
    app = makeApp(convManager)
  })

  it("Laptop B (same sub) sees Laptop A's session in the catalog and can fetch the transcript", async () => {
    await seedConversation(
      convManager,
      'user-A',
      'agent-x',
      'chat-1',
      'hello from A',
      'hi from assistant'
    )

    const listRes = await request(app)
      .get('/v1/runtime/sessions')
      .set('x-test-sub', 'user-A')
      .expect(200)

    expect(listRes.body.items).toHaveLength(1)
    expect(listRes.body.items[0]).toMatchObject({
      agent: 'agent-x',
      chatId: 'chat-1',
      turnCount: 1,
      // 1 completed turn = 1 user + 1 assistant response = 2 visible messages.
      // The real handler emits messageCount; the previous fake omitted it.
      messageCount: 2,
    })
    expect(typeof listRes.body.items[0].lastActivityAt).toBe('string')

    const msgRes = await request(app)
      .get('/v1/runtime/sessions/agent-x/chat-1/messages')
      .set('x-test-sub', 'user-A')
      .expect(200)

    expect(msgRes.body.agent).toBe('agent-x')
    expect(msgRes.body.chatId).toBe('chat-1')
    expect(msgRes.body.turns).toHaveLength(1)
    expect(msgRes.body.turns[0]).toMatchObject({
      number: 1,
      user_input: 'hello from A',
      response: 'hi from assistant',
    })
  })

  it('A different sub sees an empty catalog (cross-user isolation)', async () => {
    await seedConversation(convManager, 'user-A', 'agent-x', 'chat-1', 'hello from A', 'hi')

    const res = await request(app)
      .get('/v1/runtime/sessions')
      .set('x-test-sub', 'user-B')
      .expect(200)

    expect(res.body.items).toEqual([])
  })

  it("A different sub asking for user-A's transcript gets 404 with the enumeration-defense body", async () => {
    await seedConversation(convManager, 'user-A', 'agent-x', 'chat-1', 'hello', 'hi')

    // First, confirm "never existed" returns the canonical body for user-B.
    const missingRes = await request(app)
      .get('/v1/runtime/sessions/agent-x/nonexistent/messages')
      .set('x-test-sub', 'user-B')
      .expect(404)

    // Second, the SAME user-B asking for user-A's real chatId gets the SAME body.
    const stolenRes = await request(app)
      .get('/v1/runtime/sessions/agent-x/chat-1/messages')
      .set('x-test-sub', 'user-B')
      .expect(404)

    expect(stolenRes.body).toEqual(missingRes.body)
    expect(stolenRes.body).toEqual({ error: 'session not found' })
  })

  it('Approval cycle preserves session identity — submit → suspendForApproval → approve → completeTurn → catalog shows exactly 1 session', async () => {
    // Mirrors the full CM lifecycle a real submit-approve flow would take.
    const key = 'user-A:rpc:agent-x:chat-1'
    const conv = await convManager.getOrCreate(key)
    await convManager.startTurn(conv, 'please do X', 'test-task')

    // Enter AwaitingApproval — the state the 2026-03-28 hot-fix was protecting.
    const pendingApproval = {
      request_id: 'req-1',
      tool_name: 'fs__write',
      parameters: { path: '/tmp/x' },
      description: 'Write file',
      tool_call_id: 'tc-1',
      context_snapshot: [],
    }
    await convManager.suspendForApproval(conv, pendingApproval)

    // Resume via approve — this is where a pre-fix regression would have
    // created a NEW empty conversation under a different userId, causing
    // the catalog read below to return 0 items.
    await convManager.approve(conv, false)
    await convManager.completeTurn(conv, 'done')

    // Catalog for user-A must show exactly one session, not two.
    const listRes = await request(app)
      .get('/v1/runtime/sessions')
      .set('x-test-sub', 'user-A')
      .expect(200)

    expect(listRes.body.items).toHaveLength(1)
    expect(listRes.body.items[0]).toMatchObject({
      agent: 'agent-x',
      chatId: 'chat-1',
      turnCount: 1,
    })

    // Transcript still contains the completed turn.
    const msgRes = await request(app)
      .get('/v1/runtime/sessions/agent-x/chat-1/messages')
      .set('x-test-sub', 'user-A')
      .expect(200)
    expect(msgRes.body.turns).toHaveLength(1)
    expect(msgRes.body.turns[0].response).toBe('done')
  })

  it('Requests without an auth.sub return 401', async () => {
    await seedConversation(convManager, 'user-A', 'agent-x', 'chat-1', 'hello', 'hi')

    await request(app).get('/v1/runtime/sessions').expect(401)

    await request(app).get('/v1/runtime/sessions/agent-x/chat-1/messages').expect(401)
  })

  // D.1 — session liveness exposed to the desktop.
  it('idle session exposes state=idle with no activeTaskId/pendingApproval', async () => {
    await seedConversation(convManager, 'user-A', 'agent-x', 'chat-1', 'hi', 'done')

    const listRes = await request(app)
      .get('/v1/runtime/sessions')
      .set('x-test-sub', 'user-A')
      .expect(200)
    expect(listRes.body.items[0].state).toBe('idle')
    expect(listRes.body.items[0].activeTaskId).toBeUndefined()
    expect(listRes.body.items[0].pendingApproval).toBeUndefined()

    const msgRes = await request(app)
      .get('/v1/runtime/sessions/agent-x/chat-1/messages')
      .set('x-test-sub', 'user-A')
      .expect(200)
    expect(msgRes.body.state).toBe('idle')
  })

  it('processing session exposes state=processing + activeTaskId', async () => {
    const conv = await convManager.getOrCreate('user-A:rpc:agent-x:chat-1')
    await convManager.startTurn(conv, 'long task', 'task-running') // no completeTurn → in flight

    const listRes = await request(app)
      .get('/v1/runtime/sessions')
      .set('x-test-sub', 'user-A')
      .expect(200)
    expect(listRes.body.items[0]).toMatchObject({
      state: 'processing',
      activeTaskId: 'task-running',
    })
    expect(listRes.body.items[0].pendingApproval).toBeUndefined()

    const msgRes = await request(app)
      .get('/v1/runtime/sessions/agent-x/chat-1/messages')
      .set('x-test-sub', 'user-A')
      .expect(200)
    expect(msgRes.body).toMatchObject({ state: 'processing', activeTaskId: 'task-running' })
  })

  it('awaiting_approval session exposes pendingApproval (displayName only, no tool_name leak)', async () => {
    const conv = await convManager.getOrCreate('user-A:rpc:agent-x:chat-1')
    await convManager.startTurn(conv, 'do X', 'task-suspended')
    await convManager.suspendForApproval(conv, {
      request_id: 'req-9',
      tool_name: 'shell_exec',
      tool_call_id: 'tc-9',
      parameters: { cmd: 'rm -rf /' },
      description: 'dangerous',
      context_snapshot: [],
    })

    const listRes = await request(app)
      .get('/v1/runtime/sessions')
      .set('x-test-sub', 'user-A')
      .expect(200)
    const item = listRes.body.items[0]
    expect(item.state).toBe('awaiting_approval')
    expect(item.activeTaskId).toBe('task-suspended')
    expect(item.pendingApproval.requestId).toBe('req-9')
    expect(typeof item.pendingApproval.displayName).toBe('string')
    // Security P1-1: the raw tool_name must NOT be exposed over the wire.
    expect(item.pendingApproval.toolName).toBeUndefined()
    // Nor leak the tool arguments.
    expect(JSON.stringify(item.pendingApproval)).not.toContain('rm -rf')
  })

  it('Same user across multiple agents — catalog returns all agents, transcript is scoped per-agent', async () => {
    await seedConversation(convManager, 'user-A', 'agent-x', 'chat-1', 'x1', 'X1')
    await seedConversation(convManager, 'user-A', 'agent-y', 'chat-2', 'y1', 'Y1')
    // A different user's session for the same agent should NOT appear.
    await seedConversation(convManager, 'user-B', 'agent-x', 'chat-99', 'intruder', 'nope')

    const listRes = await request(app)
      .get('/v1/runtime/sessions')
      .set('x-test-sub', 'user-A')
      .expect(200)

    expect(listRes.body.items).toHaveLength(2)
    const agents = listRes.body.items.map((i: { agent: string }) => i.agent).sort()
    expect(agents).toEqual(['agent-x', 'agent-y'])

    // Transcript per-agent is correctly scoped.
    const xRes = await request(app)
      .get('/v1/runtime/sessions/agent-x/chat-1/messages')
      .set('x-test-sub', 'user-A')
      .expect(200)
    expect(xRes.body.turns[0].user_input).toBe('x1')

    const yRes = await request(app)
      .get('/v1/runtime/sessions/agent-y/chat-2/messages')
      .set('x-test-sub', 'user-A')
      .expect(200)
    expect(yRes.body.turns[0].user_input).toBe('y1')
  })

  it('paginates with a real decodable nextCursor that advances to the next page exactly once', async () => {
    await seedConversation(convManager, 'user-A', 'agent-x', 'chat-1', 'q1', 'a1')
    await seedConversation(convManager, 'user-A', 'agent-x', 'chat-2', 'q2', 'a2')

    const firstPage = await request(app)
      .get('/v1/runtime/sessions?limit=1')
      .set('x-test-sub', 'user-A')
      .expect(200)
    expect(firstPage.body.items).toHaveLength(1)
    expect(typeof firstPage.body.nextCursor).toBe('string')

    // The token is a REAL, scope-bound cursor — decodable only with the same
    // (user, no-agent) scope the handler encoded it under, and its stripped key
    // is `${agent}:${chatId}` of the last item on the page.
    const decoded = decodeSessionsCursor(
      firstPage.body.nextCursor,
      sessionsCursorScope('user-A', undefined)
    )
    expect(decoded).not.toBeNull()
    expect(decoded!.key).toBe(`${firstPage.body.items[0].agent}:${firstPage.body.items[0].chatId}`)

    const secondPage = await request(app)
      .get(`/v1/runtime/sessions?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set('x-test-sub', 'user-A')
      .expect(200)
    expect(secondPage.body.items).toHaveLength(1)
    // Catalog exhausted → no further cursor.
    expect(secondPage.body.nextCursor).toBeUndefined()

    // Exactly-once coverage across the two pages.
    const seen = [firstPage.body.items[0].chatId, secondPage.body.items[0].chatId]
    expect(new Set(seen)).toEqual(new Set(['chat-1', 'chat-2']))
  })
})
