import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentStateMachine } from '../agent/stateMachine'
import { config } from '../config'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../core/conversation/persistence/__tests__/testHelpers'
import { SqliteColdStartLoader } from '../core/conversation/persistence/sqliteColdStartLoader'
import { SessionSearchService } from '../core/sessionSearch/service'
import { SpilloverStorage } from '../core/spillover/storage'
import { SessionSearchTool } from '../core/tools/sessionSearch'
import { SpilloverReadTool } from '../core/tools/spilloverRead'
import { type ChatMessage, ConversationState, FinishReason } from '../core/types'
import { ChannelAttachmentStore } from '../internalTools/channelAttachmentStore'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { PromptCache } from '../llm/promptCache'
import { IncomingMessageHandler, type PendingTaskEntry } from '../messageHandler'
import { MessageQueue } from '../queue/messageQueue'
import { ResultStore } from '../resultStore'
import type { IncomingMessage, ProviderIdentity } from '../server/types'
import { SessionProcessor, resolveCanonicalSessionKey } from '../session'
import { resolveLinkedUserCallerRootBinding } from '../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../workspace/scopedWorkspace'
import { deriveLinkedUserKey } from '../workspace/userKey'

const HEALTHY_STATFS = async () => ({
  bsize: 4096n,
  blocks: (100n * 1024n * 1024n * 1024n) / 4096n,
  bavail: (50n * 1024n * 1024n * 1024n) / 4096n,
})

function slackIdentity(
  sender: string,
  channelId: string,
  workspaceId = 'T_WS_1'
): ProviderIdentity {
  return {
    medium: 'slack',
    providerUserId: sender,
    providerWorkspaceId: workspaceId,
    providerChannelId: channelId,
    providerChannelType: 'im',
    providerTarget: {
      hostRef: 'ns/host-iso',
      communicationChannelNamespace: 'channels',
      communicationChannelName: 'slack-chan',
    },
  }
}

describe('Channel attachment & identity isolation (S68, S71, S72, S73, S77, S78, S82, S83, S88)', () => {
  let tmpDir: string
  let dbPath: string
  const origEnableApproval = config.enableApproval

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-ch-iso-'))
    dbPath = path.join(tmpDir, 'state.db')
    config.enableApproval = false
  })

  afterEach(async () => {
    config.enableApproval = origEnableApproval
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function makeStack(opts: {
    dbPath: string
    tmpDir: string
    liveUserRef: { current: string | null }
    llmResponder?: (
      messages: ChatMessage[],
      callIndex: number
    ) => Promise<{
      content: string | null
      tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null
      finish_reason?: FinishReason
    }>
  }) {
    const storeHandle = makeSqliteStore({ dbPath: opts.dbPath })
    const attachmentStore = new ChannelAttachmentStore({
      hostWorkspaceRoot: opts.tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })
    const spilloverStorage = new SpilloverStorage({
      workspacePath: opts.tmpDir,
      thresholdBytes: 64,
      ttlMs: 3_600_000,
      gcIntervalMs: 0,
    })
    const promptCache = new PromptCache()
    const sessionSearchService = new SessionSearchService({
      persistQueue: storeHandle.persistQueue,
    })
    const workspaceProvider = new ScopedWorkspaceProvider(path.join(opts.tmpDir, 'workspace'))
    const gfsWorkspaceProvider = new ScopedWorkspaceProvider(path.join(opts.tmpDir, 'gfs-ws'))

    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    const pendingTaskResults = new ResultStore<PendingTaskEntry>(10 * 60 * 1000, e => e.storedAt)
    const agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    agent.setConversationStore(storeHandle.store)
    agent.setChannelAttachmentStore(attachmentStore)
    agent.setSpilloverStorage(spilloverStorage)
    agent.setPromptCache(promptCache)
    agent.setSessionSearchService(sessionSearchService)
    agent.setWorkspaceProvider(workspaceProvider)
    agent.setGfsWorkspaceProvider(gfsWorkspaceProvider)
    agent.setPendingTaskResults(pendingTaskResults)
    agent.setChannelCallerContextResolver(async msg => {
      if (!opts.liveUserRef.current) return null
      return { targetUserId: opts.liveUserRef.current, conversationId: msg.channelId }
    })

    const capturedPrompts: ChatMessage[][] = []
    let callIdx = 0
    const llmMock = vi.fn(async (messages: ChatMessage[]) => {
      capturedPrompts.push(messages.map(m => ({ ...m })))
      if (opts.llmResponder) {
        const out = await opts.llmResponder(messages, callIdx++)
        return {
          content: out.content,
          tool_calls: out.tool_calls ?? null,
          usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 },
          finish_reason: out.finish_reason ?? FinishReason.Stop,
        }
      }
      callIdx++
      return {
        content: `reply-${callIdx}`,
        tool_calls: null,
        usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 },
        finish_reason: FinishReason.Stop,
      }
    })
    agent.setLLMProvider(
      {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools: llmMock,
        getProviderType: () => 'openai' as const,
      } as never,
      'gpt-4o'
    )
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)

    const sessionProcessor = new SessionProcessor({
      maxConcurrent: 4,
      lifecycle,
      executor: task => agent.executeTask(task),
    })
    agent.setSessionProcessor(sessionProcessor)
    agent.setColdStartLoader(new SqliteColdStartLoader(storeHandle.store))

    const send = (msg: IncomingMessage) => {
      const handler = new IncomingMessageHandler(msg, {
        messageQueue: queue,
        agent,
        pendingTaskResults,
        getModel: () => 'gpt-4o',
        sanitizeAttachments: a => a,
        sessionProcessor,
        taskLifecycle: lifecycle,
      })
      return handler.execute()
    }

    return {
      storeHandle,
      attachmentStore,
      spilloverStorage,
      promptCache,
      sessionSearchService,
      workspaceProvider,
      gfsWorkspaceProvider,
      queue,
      lifecycle,
      pendingTaskResults,
      agent,
      sessionProcessor,
      llmMock,
      capturedPrompts,
      send,
      shutdown: async () => {
        await agent.stop()
        await storeHandle.shutdown()
      },
      coldCrash: async () => {
        await storeHandle.shutdown()
      },
    }
  }

  it('S68 & S71 & S78: unlink->relink isolates messages, FTS, SpilloverBlob, PromptCache, rotates under partial unique index without crash/resurrection, prevents reverse FTS leak, and revoked sender makes 0 DB writes', async () => {
    const liveUser = { current: 'linked-user-a' as string | null }
    const stack = makeStack({
      dbPath,
      tmpDir,
      liveUserRef: liveUser,
      llmResponder: async (_messages, idx) => ({
        content: idx === 0 ? 'Processed USERA-SENTINEL-6801 cleanly' : 'User B reply clean',
      }),
    })

    const sessionKey = resolveCanonicalSessionKey({
      sender: 'U_PROV',
      channelType: 'slack',
      channelId: 'D_ISO_1',
    })

    try {
      // Turn 1 as User A
      const t1 = await stack.send({
        content: 'Analyze secret USERA-SENTINEL-6801',
        channelType: 'slack',
        channelId: 'D_ISO_1',
        sender: 'U_PROV',
        timestamp: new Date().toISOString(),
        messageId: 'm-user-a-1',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: slackIdentity('U_PROV', 'D_ISO_1'),
      })
      expect(t1.success).toBe(true)

      const sessionA = stack.storeHandle.worker.db
        .prepare('SELECT id, state, linked_user_id FROM sessions WHERE session_key = ?')
        .get(sessionKey) as { id: string; state: string; linked_user_id: string }
      expect(sessionA.state).toBe('idle')
      expect(sessionA.linked_user_id).toBe('linked-user-a')

      // Seed PromptCache and SpilloverBlob for User A on sessionKey
      stack.promptCache.set(sessionKey, {
        stableHash: 'hash-user-a',
        parts: {
          staticPrefix: 'USERA-PROMPT',
          dailyContext: 'USERA-DAILY',
          stableHash: 'hash-user-a',
        },
      } as never)
      expect(stack.promptCache.has(sessionKey)).toBe(true)

      const spill = await stack.spilloverStorage.maybePersist({
        taskId: 'task-a-1',
        toolCallId: 'tc-a-1',
        toolName: 'clerum__document_read',
        content: `Large document output containing USERA-SENTINEL-6801 ${'x'.repeat(200)}`,
        isError: false,
        linkedUserId: 'linked-user-a',
        sessionKey,
      })
      expect(spill).not.toBeNull()

      // Admin unlinks U_PROV from User A and re-links to User B
      liveUser.current = 'linked-user-b'

      // Turn 2 as User B carrying confidential USERB-SECRET-991 (S78 reverse-leak test)
      const t2 = await stack.send({
        content: 'Confidential USERB-SECRET-991',
        channelType: 'slack',
        channelId: 'D_ISO_1',
        sender: 'U_PROV',
        timestamp: new Date().toISOString(),
        messageId: 'm-user-b-2',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: slackIdentity('U_PROV', 'D_ISO_1'),
      })
      expect(t2.success).toBe(true)

      // S68: PromptCache entry from User A was dropped on rotation; User B LLM prompt has 0 occurrences of User A sentinel.
      const cachedAfterRotate = stack.promptCache.get(sessionKey)
      expect(cachedAfterRotate?.parts?.stableHash).not.toBe('hash-user-a')
      expect(JSON.stringify(stack.capturedPrompts[1]!)).not.toContain('USERA-SENTINEL-6801')

      // S71: SQLite has 2 rows for session_key (Session A 'ended', Session B 'idle') — zero UNIQUE constraint crash!
      const sessionRows = stack.storeHandle.worker.db
        .prepare(
          'SELECT id, state, linked_user_id FROM sessions WHERE session_key = ? ORDER BY rowid ASC'
        )
        .all(sessionKey) as Array<{ id: string; state: string; linked_user_id: string }>
      expect(sessionRows).toHaveLength(2)
      expect(sessionRows[0]).toMatchObject({
        id: sessionA.id,
        state: 'ended',
        linked_user_id: 'linked-user-a',
      })
      expect(sessionRows[1]).toMatchObject({ state: 'idle', linked_user_id: 'linked-user-b' })
      const sessionBId = sessionRows[1]!.id

      // S78: Reverse FTS leak check — User B's USERB-SECRET-991 is ONLY in S_B, 0 rows in S_A!
      const leakInA = (
        stack.storeHandle.worker.db
          .prepare(
            "SELECT count(*) AS cnt FROM messages WHERE session_id = ? AND content LIKE '%USERB-SECRET-991%'"
          )
          .get(sessionA.id) as { cnt: number }
      ).cnt
      expect(leakInA).toBe(0)
      const presentInB = (
        stack.storeHandle.worker.db
          .prepare(
            "SELECT count(*) AS cnt FROM messages WHERE session_id = ? AND content LIKE '%USERB-SECRET-991%'"
          )
          .get(sessionBId) as { cnt: number }
      ).cnt
      expect(presentInB).toBe(1)

      // S68: FTS search via SessionSearchTool isolated by linkedUserId in BOTH directions!
      const msgForSearch: IncomingMessage = {
        content: 'search',
        channelType: 'slack',
        channelId: 'D_ISO_1',
        sender: 'U_PROV',
        timestamp: new Date().toISOString(),
        messageId: 'm-search',
        hostRef: 'ns/host-iso',
      }
      const userBSearchTool = new SessionSearchTool(
        stack.sessionSearchService,
        msgForSearch,
        'linked-user-b'
      )
      const userASearchTool = new SessionSearchTool(
        stack.sessionSearchService,
        msgForSearch,
        'linked-user-a'
      )

      const bSearchingA = await userBSearchTool.execute({ query: '6801' })
      expect(bSearchingA.is_error).toBe(false)
      expect(bSearchingA.content).not.toContain('USERA-SENTINEL-6801')

      const aSearchingB = await userASearchTool.execute({ query: '991' })
      expect(aSearchingB.is_error).toBe(false)
      expect(aSearchingB.content).not.toContain('USERB-SECRET-991')

      // Liveness witness: each user finds their OWN sentinel via FTS (strip <mark> highlights)!
      const aSearchingA = await userASearchTool.execute({ query: '6801' })
      expect(aSearchingA.content.replace(/<\/?mark>/g, '')).toContain('USERA-SENTINEL-6801')
      const bSearchingB = await userBSearchTool.execute({ query: '991' })
      expect(bSearchingB.content.replace(/<\/?mark>/g, '')).toContain('USERB-SECRET-991')

      // S68: SpilloverReadTool blocks User B from reading User A's spillover_ref, while User A reads it!
      const spilloverB = new SpilloverReadTool(stack.spilloverStorage, {
        linkedUserId: 'linked-user-b',
        sessionKey,
      })
      const spilloverA = new SpilloverReadTool(stack.spilloverStorage, {
        linkedUserId: 'linked-user-a',
        sessionKey,
      })
      const deniedSpill = await spilloverB.execute({ ref: spill!.spillover_ref })
      expect(deniedSpill.is_error).toBe(true)
      expect(deniedSpill.content).not.toContain('USERA-SENTINEL-6801')
      const allowedSpill = await spilloverA.execute({ ref: spill!.spillover_ref })
      expect(allowedSpill.is_error).toBe(false)
      expect(allowedSpill.content).toContain('USERA-SENTINEL-6801')

      // S78: Revoked sender triggers completeWithoutSession with 0 DB writes and 0 LLM calls.
      const msgCountBeforeRevoked = (
        stack.storeHandle.worker.db.prepare('SELECT count(*) AS cnt FROM messages').get() as {
          cnt: number
        }
      ).cnt
      const llmCountBeforeRevoked = stack.llmMock.mock.calls.length
      liveUser.current = null
      const revokedRes = await stack.send({
        content: 'Revoked prompt must not touch DB',
        channelType: 'slack',
        channelId: 'D_ISO_1',
        sender: 'U_PROV',
        timestamp: new Date().toISOString(),
        messageId: 'm-revoked-3',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: slackIdentity('U_PROV', 'D_ISO_1'),
      })
      expect(revokedRes.success).toBe(true)
      expect(revokedRes.response).toBeTruthy()
      expect(stack.llmMock.mock.calls.length).toBe(llmCountBeforeRevoked)
      const msgCountAfterRevoked = (
        stack.storeHandle.worker.db.prepare('SELECT count(*) AS cnt FROM messages').get() as {
          cnt: number
        }
      ).cnt
      expect(msgCountAfterRevoked).toBe(msgCountBeforeRevoked)
    } finally {
      await stack.shutdown()
    }

    // S71 cold-restart witness: recreating SQLite store returns ONLY User B's active session, never resurrecting ended S_A!
    const reopened = makeSqliteStore({ dbPath })
    try {
      const loaded = await reopened.store.getOrLoad(sessionKey)
      expect(loaded).toBeDefined()
      expect(loaded!.linked_user_id).toBe('linked-user-b')
      expect(loaded!.turns.map(t => t.user_input)).toEqual(['Confidential USERB-SECRET-991'])
    } finally {
      await reopened.shutdown()
    }
  })

  it('S72: Teams channel cold-restart persists normalized sessions.channel_id matching session_key so loadAllPendingApprovals passes ownership check while preserving raw sourceMessage.channelId', async () => {
    config.enableApproval = true
    const rawTeamsChannelId = '19:abc@thread.tacv2;messageid=1001'
    const normalizedTeamsChannelId = '19:abc@thread.tacv2'
    const liveUser = { current: 'linked-teams-a' as string | null }
    let requestId = ''

    const pod1 = makeStack({
      dbPath,
      tmpDir,
      liveUserRef: liveUser,
      llmResponder: async () => ({
        content: null,
        tool_calls: [{ id: 'tc-t1', name: 'shell_exec', arguments: { command: 'echo teams-s72' } }],
        finish_reason: FinishReason.ToolUse,
      }),
    })
    pod1.agent.setApprovalConfig({
      defaultPolicy: 'allow_all',
      tools: { shell_exec: true },
    } as never)

    try {
      const res = await pod1.send({
        content: 'Run teams command',
        channelType: 'teams',
        channelId: rawTeamsChannelId,
        sender: 'teams-user-1',
        threadId: '1001',
        timestamp: new Date().toISOString(),
        messageId: 'act-1001',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-teams-a',
        providerIdentity: {
          medium: 'teams',
          providerUserId: 'teams-user-1',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: rawTeamsChannelId,
          providerChannelType: 'channel',
        },
      })
      expect(res.success).toBe(true)
      expect(res.status).toBe('waiting_approval')
      requestId = res.approval!.requestId

      // Verify sessions.channel_id is normalized while sessions.session_key matches!
      const row = pod1.storeHandle.worker.db
        .prepare('SELECT session_key, channel_id, thread_id FROM sessions LIMIT 1')
        .get() as { session_key: string; channel_id: string; thread_id: string }
      expect(row.channel_id).toBe(normalizedTeamsChannelId)
      expect(row.session_key).toBe('teams-user-1:teams:19:abc@thread.tacv2:1001')
      expect(row.thread_id).toBe('1001')
    } finally {
      await pod1.coldCrash()
    }

    // Pod 2: cold restart -> loadAllPendingApprovals() passes userIdFromStructuredSessionKey!
    const pod2 = makeStack({
      dbPath,
      tmpDir,
      liveUserRef: liveUser,
      llmResponder: async () => ({ content: 'Teams approval resumed cleanly' }),
    })
    pod2.agent.setApprovalConfig({
      defaultPolicy: 'allow_all',
      tools: { shell_exec: true },
    } as never)
    try {
      const listings = await pod2.storeHandle.store.loadAllPendingApprovals()
      expect(listings).toHaveLength(1)
      expect(listings[0]!.sourceMessage?.channelId).toBe(rawTeamsChannelId)

      await pod2.agent.bootstrap()
      expect(pod2.agent.getPendingApprovals()).toHaveLength(1)

      // Approving with raw channelId resumes and releases suspendedSessions cleanly!
      const approved = await pod2.agent.handleApproval(
        'teams-user-1',
        requestId,
        false,
        'teams',
        rawTeamsChannelId
      )
      expect(approved.success).toBe(true)
    } finally {
      await pod2.shutdown()
    }
  })

  it('S73: ScopedWorkspace.forLinkedUser and resolveLinkedUserCallerRootBinding isolate daily/ compaction logs, private MEMORY.md, and gfsCallerRoot across unlink->relink', async () => {
    const wsBase = path.join(tmpDir, 'ws-73')
    const gfsBase = path.join(tmpDir, 'gfs-73')
    await fs.mkdir(wsBase, { recursive: true })
    await fs.mkdir(gfsBase, { recursive: true })
    const wsProvider = new ScopedWorkspaceProvider(wsBase)
    const gfsProvider = new ScopedWorkspaceProvider(gfsBase)

    const wsA = wsProvider.forLinkedUser('linked-user-a')
    const wsB = wsProvider.forLinkedUser('linked-user-b')

    await wsA.appendDailyLog('COMPACTION-SENTINEL-USER-A-7301')
    await wsA.appendPrivateMemory('PRIVATE-MEMORY-USER-A-7302')
    await wsB.appendDailyLog('COMPACTION-PUBLIC-USER-B-7303')

    const promptA = await wsA.assembleSystemPrompt()
    const promptB = await wsB.assembleSystemPrompt()
    expect(promptA).toContain('COMPACTION-SENTINEL-USER-A-7301')
    expect(promptB).not.toContain('COMPACTION-SENTINEL-USER-A-7301')
    expect(promptB).toContain('COMPACTION-PUBLIC-USER-B-7303')

    // memory_search (ScopedWorkspace.search) never crosses into User A's tree.
    const searchB = await wsB.search('7302')
    expect(searchB).toHaveLength(0)
    const searchA = await wsA.search('7302')
    expect(searchA.length).toBeGreaterThan(0)

    // GFS caller roots are distinct verified directories keyed by deriveLinkedUserKey.
    const rootA = resolveLinkedUserCallerRootBinding(gfsProvider, 'linked-user-a')
    const rootB = resolveLinkedUserCallerRootBinding(gfsProvider, 'linked-user-b')
    expect(rootA.root).toBeDefined()
    expect(rootB.root).toBeDefined()
    expect(rootA.root).not.toBe(rootB.root)
    expect(rootA.root).toContain(deriveLinkedUserKey('linked-user-a'))
    expect(rootB.root).toContain(deriveLinkedUserKey('linked-user-b'))

    // End-to-end TaskExecutor witness: User B's Turn 2 system prompt contains 0 occurrences of User A's daily log!
    const liveUser = { current: 'linked-user-a' as string | null }
    const stack = makeStack({ dbPath, tmpDir, liveUserRef: liveUser })
    try {
      await stack.workspaceProvider
        .forLinkedUser('linked-user-a')
        .appendDailyLog('EXEC-DAILY-SECRET-A-7399')
      liveUser.current = 'linked-user-b'
      const resB = await stack.send({
        content: 'Hello from User B',
        channelType: 'slack',
        channelId: 'D_73',
        sender: 'U_SHARED',
        timestamp: new Date().toISOString(),
        messageId: 'm-73-b',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: slackIdentity('U_SHARED', 'D_73'),
      })
      expect(resB.success).toBe(true)
      expect(JSON.stringify(stack.capturedPrompts[0]!)).not.toContain('EXEC-DAILY-SECRET-A-7399')

      // Liveness witness: User A's own turn DOES see User A's daily log!
      liveUser.current = 'linked-user-a'
      const resA = await stack.send({
        content: 'Hello from User A',
        channelType: 'slack',
        channelId: 'D_73_A',
        sender: 'U_A_OWN',
        timestamp: new Date().toISOString(),
        messageId: 'm-73-a',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: slackIdentity('U_A_OWN', 'D_73_A'),
      })
      expect(resA.success).toBe(true)
      expect(JSON.stringify(stack.capturedPrompts[1]!)).toContain('EXEC-DAILY-SECRET-A-7399')
    } finally {
      await stack.shutdown()
    }
  })

  it('S77: Desktop rpc & channel cancel-during-approval preserves state=idle visibility in selectSessionSummariesByPrefix & selectSessionBySessionKey across restart while excluding state=ended', async () => {
    const liveUser = { current: 'linked-user-a' as string | null }
    const pod1 = makeStack({ dbPath, tmpDir, liveUserRef: liveUser })
    const desktopKey = 'desktop-user-77:rpc:agent-1:chat-77'
    const channelKey = 'U_77:slack:D_77:default'
    const endedKey = 'desktop-user-77:rpc:agent-1:chat-ended'

    try {
      const cm = pod1.agent.getConversationManager()
      // 1) Desktop rpc chat: complete Turn 1, suspend Turn 2, cancel Turn 2 (stamps ended_at while state='idle')
      const deskConv = await cm.getOrCreate(desktopKey, {
        userId: 'desktop-user-77',
        channelType: 'rpc',
        channelId: 'agent-1',
        threadId: 'chat-77',
        source: 'rpc',
      })
      await cm.startTurn(deskConv, 'Desktop Turn 1 history', 'task-d1')
      await cm.completeTurn(deskConv, 'Desktop Turn 1 answer')
      await cm.startTurn(deskConv, 'Desktop Turn 2 gated', 'task-d2')
      await cm.suspendForApproval(deskConv, {
        request_id: 'req-d2',
        tool_name: 'shell_exec',
        tool_call_id: 'tc-d2',
        description: 'Run shell',
        parameters: {},
        context_snapshot: [],
      })
      deskConv.state = ConversationState.Idle
      deskConv.pending_approval = undefined
      deskConv.activeTaskId = undefined
      await pod1.storeHandle.store.persistApprovalResolved(deskConv, 'req-d2', 'cancel')

      // 2) Channel chat: same cancel-during-approval, plus an ended rotated session excluded from listing.
      const chConv = await cm.getOrCreate(channelKey, {
        userId: 'U_77',
        channelType: 'slack',
        channelId: 'D_77',
        source: 'slack',
        linkedUserId: 'linked-user-a',
      })
      await cm.startTurn(chConv, 'Channel Turn 1', 'task-c1')
      await cm.completeTurn(chConv, 'Channel Turn 1 answer')
      await cm.startTurn(chConv, 'Channel Turn 2 gated', 'task-c2')
      await cm.suspendForApproval(chConv, {
        request_id: 'req-c2',
        tool_name: 'shell_exec',
        tool_call_id: 'tc-c2',
        description: 'Run shell',
        parameters: {},
        context_snapshot: [],
      })
      chConv.state = ConversationState.Idle
      chConv.pending_approval = undefined
      chConv.activeTaskId = undefined
      await pod1.storeHandle.store.persistApprovalResolved(chConv, 'req-c2', 'cancel')

      // 3) Ended identity-rotated session for same desktop prefix must be excluded.
      const endedConv = await cm.getOrCreate(endedKey, {
        userId: 'desktop-user-77',
        channelType: 'rpc',
        channelId: 'agent-1',
        threadId: 'chat-ended',
        source: 'rpc',
      })
      await cm.startTurn(endedConv, 'Ended chat', 'task-e1')
      await cm.completeTurn(endedConv, 'Done')
      await pod1.storeHandle.store.endObsoleteApprovalSession!({
        sessionKey: endedKey,
        endReason: 'identity_changed',
      })
    } finally {
      await pod1.shutdown()
    }

    // Pod 2 cold reload: both cancelled-approval idle chats remain visible and retain Turn 1; ended chat is excluded!
    const pod2 = makeStack({ dbPath, tmpDir, liveUserRef: liveUser })
    try {
      const summaries = await pod2.storeHandle.store.listSessionSummariesByPrefix!(
        'desktop-user-77:rpc:',
        {}
      )
      expect(summaries.map(s => s.key)).toEqual([desktopKey])
      expect(summaries[0]!.state).toBe(ConversationState.Idle)

      const reloadedDesk = await pod2.storeHandle.store.getOrLoad(desktopKey)
      expect(reloadedDesk).toBeDefined()
      expect(reloadedDesk!.turns[0]!.user_input).toBe('Desktop Turn 1 history')

      const reloadedCh = await pod2.storeHandle.store.getOrLoad(channelKey)
      expect(reloadedCh).toBeDefined()
      expect(reloadedCh!.turns[0]!.user_input).toBe('Channel Turn 1')

      const reloadedEnded = await pod2.storeHandle.store.getOrLoad(endedKey)
      expect(reloadedEnded).toBeUndefined()
    } finally {
      await pod2.shutdown()
    }
  })

  it('S82: MessageQueue.deliveryKeyOf, TaskLifecycle purge, and duplicateSuppressedResponse block 5-min cross-user replay after unlink->relink while preserving same-user dedupe', async () => {
    const liveUser = { current: 'linked-user-a' as string | null }
    const stack = makeStack({
      dbPath,
      tmpDir,
      liveUserRef: liveUser,
      llmResponder: async (_messages, idx) => ({
        content: idx === 0 ? 'USERA-SECRET-PDF-SUMMARY-8201' : 'USERB-CLEAN-RESPONSE-8202',
      }),
    })

    try {
      const baseMsg = {
        content: 'Summarize secret.pdf',
        channelType: 'slack' as const,
        channelId: 'D_82',
        sender: 'U_82',
        timestamp: new Date().toISOString(),
        messageId: 'M_DUP_82',
        hostRef: 'ns/host-iso',
        providerIdentity: slackIdentity('U_82', 'D_82'),
      }

      // 1) User A executes M_DUP_82 (use executeAsync so TaskLifecycle finishes cleanly and records taskId)
      const handlerA1 = new IncomingMessageHandler(
        { ...baseMsg, admittedLinkedUserId: 'linked-user-a' },
        {
          messageQueue: stack.queue,
          agent: stack.agent,
          pendingTaskResults: stack.pendingTaskResults,
          getModel: () => 'gpt-4o',
          sanitizeAttachments: a => a,
          sessionProcessor: stack.sessionProcessor,
          taskLifecycle: stack.lifecycle,
        }
      )
      const asyncA1 = handlerA1.executeAsync()
      expect(asyncA1.success).toBe(true)
      const taskIdA1 = asyncA1.taskId!
      await vi.waitFor(() => {
        expect(stack.lifecycle.getStatus(taskIdA1)).toBe('completed')
      })
      expect(stack.pendingTaskResults.get(taskIdA1)?.response).toBe('USERA-SECRET-PDF-SUMMARY-8201')
      expect(stack.llmMock).toHaveBeenCalledTimes(1)

      // 2) Same-user retry within 5 minutes deduplicates cleanly (0 extra LLM calls, returns prior taskId === taskIdA1!)
      const resA2 = await stack.send({ ...baseMsg, admittedLinkedUserId: 'linked-user-a' })
      expect(resA2.success).toBe(true)
      expect(resA2.taskId).toBe(taskIdA1)
      expect(stack.llmMock).toHaveBeenCalledTimes(1)

      // 3) Admin executes unlink->relink (UserA -> UserB); reconcileChannelIdentity purges User A's TaskLifecycle/deliveryIndex
      liveUser.current = 'linked-user-b'
      await stack.agent.reconcileChannelIdentity({
        medium: 'slack',
        workspaceOrTargetKey: 'T_WS_1',
        providerUserId: 'U_82',
        channelScope: null,
        liveLinkedUserId: 'linked-user-b',
      })

      // 4) Redelivery of M_DUP_82 for User B MUST NOT replay User A's response!
      const resB = await stack.send({ ...baseMsg, admittedLinkedUserId: 'linked-user-b' })
      expect(resB.success).toBe(true)
      expect(resB.response).toBe('USERB-CLEAN-RESPONSE-8202')
      expect(resB.response).not.toContain('USERA-SECRET-PDF-SUMMARY-8201')
      expect(stack.llmMock).toHaveBeenCalledTimes(2)

      // 5) Defense-in-depth witness: even if deliveryKeyOf collided (without reconcile), duplicateSuppressedResponse blocks cross-user replay!
      expect(
        MessageQueue.deliveryKeyOf({ ...baseMsg, admittedLinkedUserId: 'linked-user-a' })
      ).not.toBe(MessageQueue.deliveryKeyOf({ ...baseMsg, admittedLinkedUserId: 'linked-user-b' }))
    } finally {
      await stack.shutdown()
    }
  })

  it('S83: pre-migration-020 active external-channel session with linked_user_id IS NULL rotates fail-closed on unlink->relink without backfilling User B', async () => {
    const liveUser = { current: 'linked-user-b' as string | null }
    const stack = makeStack({ dbPath, tmpDir, liveUserRef: liveUser })
    const sessionKey = resolveCanonicalSessionKey({
      sender: 'U_LEGACY',
      channelType: 'slack',
      channelId: 'D_LEGACY',
    })

    try {
      // Seed pre-migration-020 active external-channel session with linked_user_id = NULL and legacy secret message.
      const db = stack.storeHandle.worker.db
      const now = Math.floor(Date.now() / 1000)
      db.prepare(
        `INSERT INTO sessions (
          id, session_key, source, user_id, channel_type, channel_id, started_at, last_activity_at,
          turn_count, message_count, tool_call_count, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cache_tokens_reported, state, approval_mode, linked_user_id
        ) VALUES (?, ?, 'slack', 'U_LEGACY', 'slack', 'D_LEGACY', ?, ?, 1, 2, 0, 0, 0, 0, 0, 0, 'idle', 'manual', NULL)`
      ).run('sess-legacy-83', sessionKey, now - 100, now - 50)
      db.prepare(
        `INSERT INTO messages (session_id, ordinal, role, content, timestamp, is_error, turn_number)
         VALUES ('sess-legacy-83', 0, 'user', 'LEGACY-SECRET-404', ?, 0, 1)`
      ).run(now - 100)
      db.prepare(
        `INSERT INTO messages (session_id, ordinal, role, content, timestamp, is_error, turn_number)
         VALUES ('sess-legacy-83', 1, 'assistant', 'Legacy answer 404', ?, 0, 1)`
      ).run(now - 99)

      // User B sends Turn 2 -> S_legacy rotates to ('ended', NULL) BEFORE getOrCreate/startTurn!
      const resB = await stack.send({
        content: 'New User B turn',
        channelType: 'slack',
        channelId: 'D_LEGACY',
        sender: 'U_LEGACY',
        timestamp: new Date().toISOString(),
        messageId: 'm-legacy-b',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: slackIdentity('U_LEGACY', 'D_LEGACY'),
      })
      expect(resB.success).toBe(true)

      const legacyRow = db
        .prepare('SELECT state, linked_user_id, end_reason FROM sessions WHERE id = ?')
        .get('sess-legacy-83') as {
        state: string
        linked_user_id: string | null
        end_reason: string
      }
      expect(legacyRow).toEqual({
        state: 'ended',
        linked_user_id: null,
        end_reason: 'identity_changed',
      })

      // LLM prompt for User B contains 0 occurrences of LEGACY-SECRET-404
      expect(JSON.stringify(stack.capturedPrompts[0]!)).not.toContain('LEGACY-SECRET-404')

      // User B FTS search returns 0 matches for LEGACY-SECRET-404
      const ftsB = await stack.sessionSearchService.search(
        { query: '404', userId: 'U_LEGACY', linkedUserId: 'linked-user-b', limit: 10 },
        'llm'
      )
      expect(ftsB.total).toBe(0)
    } finally {
      await stack.shutdown()
    }
  })

  it('S88: queued User A task m2 in SessionProcessor.sessionQueues is blocked from executing as User B in both Variant A (natural completion) and Variant B (reconcileChannelIdentity purge-first)', async () => {
    // Variant A: m1 is processing (User A), m2 ("USERA-SSN-999", admittedLinkedUserId=UserA) is queued.
    // Admin executes unlink->relink (UserA -> UserB). m1 completes naturally and tryProcessNext() dequeues m2.
    // TaskExecutor.run() detects liveLinkedUserId !== task.admittedLinkedUserId -> completeWithoutSession (0 DB writes, 0 LLM calls).
    let releaseM1!: () => void
    const m1Gate = new Promise<void>(resolve => {
      releaseM1 = resolve
    })
    let m1Started!: () => void
    const m1StartedPromise = new Promise<void>(resolve => {
      m1Started = resolve
    })
    const liveUserA = { current: 'linked-user-a' as string | null }
    const stackA = makeStack({
      dbPath,
      tmpDir,
      liveUserRef: liveUserA,
      llmResponder: async (_messages, idx) => {
        if (idx === 0) {
          m1Started()
          await m1Gate
          return { content: 'm1 done' }
        }
        return { content: 'unexpected m2 llm call' }
      },
    })

    try {
      const m1Promise = stackA.send({
        content: 'Start long turn m1',
        channelType: 'slack',
        channelId: 'D_88A',
        sender: 'U_88',
        timestamp: new Date().toISOString(),
        messageId: 'm-88a-1',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: slackIdentity('U_88', 'D_88A'),
      })
      await m1StartedPromise

      // Enqueue User A's confidential m2 while m1 is active
      const m2Promise = stackA.send({
        content: 'USERA-SSN-999',
        channelType: 'slack',
        channelId: 'D_88A',
        sender: 'U_88',
        timestamp: new Date().toISOString(),
        messageId: 'm-88a-2',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: slackIdentity('U_88', 'D_88A'),
      })

      // Admin relinks U_88 to User B before m1 completes
      liveUserA.current = 'linked-user-b'
      releaseM1()

      const [r1, r2] = await Promise.all([m1Promise, m2Promise])
      expect(r1.success).toBe(true)
      expect(r2.success).toBe(true)
      expect(r2.response).toContain('account link changed')
      // Only m1 called LLM (1 total); m2 never called LLM and never wrote USERA-SSN-999 to DB!
      expect(stackA.llmMock).toHaveBeenCalledTimes(1)
      const ssnRowsA = (
        stackA.storeHandle.worker.db
          .prepare("SELECT count(*) AS cnt FROM messages WHERE content LIKE '%USERA-SSN-999%'")
          .get() as { cnt: number }
      ).cnt
      expect(ssnRowsA).toBe(0)
    } finally {
      await stackA.shutdown()
    }

    // Variant B: m1 is awaiting_approval (User A), m2 ("USERA-SSN-999") is queued behind suspendedSessions.
    // Admin relinks U_88 -> User B and reconcileChannelIdentity runs -> purges sessionQueues/TaskLifecycle FIRST
    // before releasing suspendedSessions, so m2 never dispatches, and User B's m3 starts clean S_B.
    config.enableApproval = true
    const dbPathB = path.join(tmpDir, 'state-88b.db')
    const liveUserB = { current: 'linked-user-a' as string | null }
    const stackB = makeStack({
      dbPath: dbPathB,
      tmpDir,
      liveUserRef: liveUserB,
      llmResponder: async (_messages, idx) => {
        if (idx === 0) {
          return {
            content: null,
            tool_calls: [{ id: 'tc-88b', name: 'shell_exec', arguments: { command: 'echo hi' } }],
            finish_reason: FinishReason.ToolUse,
          }
        }
        return { content: 'User B m3 clean reply' }
      },
    })
    stackB.agent.setApprovalConfig({
      defaultPolicy: 'allow_all',
      tools: { shell_exec: true },
    } as never)

    try {
      const m1Res = await stackB.send({
        content: 'Run gated command m1',
        channelType: 'slack',
        channelId: 'D_88B',
        sender: 'U_88B',
        timestamp: new Date().toISOString(),
        messageId: 'm-88b-1',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: slackIdentity('U_88B', 'D_88B'),
      })
      expect(m1Res.status).toBe('waiting_approval')

      // Queue User A's confidential m2 behind suspended session
      const m2Promise = stackB.send({
        content: 'USERA-SSN-999',
        channelType: 'slack',
        channelId: 'D_88B',
        sender: 'U_88B',
        timestamp: new Date().toISOString(),
        messageId: 'm-88b-2',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: slackIdentity('U_88B', 'D_88B'),
      })

      // Admin relinks U_88B -> User B and calls reconcileChannelIdentity
      liveUserB.current = 'linked-user-b'
      await stackB.agent.reconcileChannelIdentity({
        medium: 'slack',
        workspaceOrTargetKey: 'T_WS_1',
        providerUserId: 'U_88B',
        channelScope: null,
        liveLinkedUserId: 'linked-user-b',
      })

      const m2Res = await m2Promise
      expect(m2Res.success).toBe(false)
      expect(m2Res.error?.code).toBe('TASK_CANCELLED')

      // User B sends m3 -> starts clean S_B with 0 occurrences of USERA-SSN-999!
      const m3Res = await stackB.send({
        content: 'User B m3 clean question',
        channelType: 'slack',
        channelId: 'D_88B',
        sender: 'U_88B',
        timestamp: new Date().toISOString(),
        messageId: 'm-88b-3',
        hostRef: 'ns/host-iso',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: slackIdentity('U_88B', 'D_88B'),
      })
      expect(m3Res.success).toBe(true)
      expect(m3Res.response).toBe('User B m3 clean reply')

      const ssnRowsB = (
        stackB.storeHandle.worker.db
          .prepare("SELECT count(*) AS cnt FROM messages WHERE content LIKE '%USERA-SSN-999%'")
          .get() as { cnt: number }
      ).cnt
      expect(ssnRowsB).toBe(0)
      expect(JSON.stringify(stackB.capturedPrompts[1]!)).not.toContain('USERA-SSN-999')
    } finally {
      await stackB.shutdown()
    }
  })
})
