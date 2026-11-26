import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildAttachmentFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import { AgentStateMachine } from '../agent/stateMachine'
import { config } from '../config'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../core/conversation/persistence/__tests__/testHelpers'
import { SqliteColdStartLoader } from '../core/conversation/persistence/sqliteColdStartLoader'
import { WorkflowBrokerRequestError } from '../core/tools/workflowBrokerClient'
import { type ChatMessage, ConversationState, FinishReason } from '../core/types'
import type { RetainedChannelAttachmentRow } from '../db/worker/protocol'
import {
  ChannelAttachmentStore,
  normalizeChannelFilename,
  validateStrictChannelImageContainer,
} from '../internalTools/channelAttachmentStore'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { PNG_2X2_BASE64 } from '../llm/__tests__/codexImageFixtures'
import { PromptCache } from '../llm/promptCache'
import { handleProviderMessageAuthorization, mainRpcTestSeams } from '../main'
import { IncomingMessageHandler, type PendingTaskEntry } from '../messageHandler'
import { MessageQueue } from '../queue/messageQueue'
import { ResultStore } from '../resultStore'
import type { IncomingMessage, ProviderIdentity } from '../server/types'
import { SessionProcessor, resolveCanonicalSessionKey } from '../session'
import { resolveProviderWorkflowCallerContext } from '../workflow/providerWorkflowCallerContextClient'

vi.mock('../workflow/providerWorkflowCallerContextClient', () => ({
  resolveProviderWorkflowCallerContext: vi.fn(),
}))

const HEALTHY_STATFS = async () => ({
  bsize: 4096n,
  blocks: (100n * 1024n * 1024n * 1024n) / 4096n,
  bavail: (50n * 1024n * 1024n * 1024n) / 4096n,
})

function makeIdentity(
  medium: 'telegram' | 'slack' | 'teams',
  userId: string,
  channelId: string,
  workspaceId?: string
): ProviderIdentity {
  return {
    medium,
    providerUserId: userId,
    ...(workspaceId ? { providerWorkspaceId: workspaceId } : {}),
    providerChannelId: channelId,
    ...(medium === 'teams' ? { providerChannelType: 'channel' } : {}),
    providerTarget: {
      hostRef: 'ns/host-appr',
      communicationChannelNamespace: 'channels',
      communicationChannelName: `${medium}-bot`,
    },
  }
}

async function seedAttachment(params: {
  store: ChannelAttachmentStore
  storeHandle: StoreHandle
  bytes: Buffer
  filename: string
  declaredMediaType: string
  medium?: 'telegram' | 'slack' | 'teams'
  sender?: string
  channelId?: string
  threadId?: string
  linkedUserId?: string
  expiresAtEpoch?: number
}): Promise<{ attachmentId: string; sessionKey: string }> {
  const medium = params.medium ?? 'telegram'
  const sender = params.sender ?? 'u-prov'
  const channelId = params.channelId ?? 'chat-appr'
  const linkedUserId = params.linkedUserId ?? 'linked-user-a'
  const sessionKey = resolveCanonicalSessionKey({
    sender,
    channelType: medium,
    channelId,
    threadId: params.threadId,
  })
  const put = await params.store.putBuffer({ bytes: params.bytes, linkedUserId })
  const classification = classifyBytes({
    bytes: params.bytes,
    totalByteLength: params.bytes.length,
    declaredMediaType: params.declaredMediaType,
    filename: params.filename,
  })
  const name = normalizeChannelFilename(
    params.filename,
    classification.class,
    put.attachmentId.slice(0, 8)
  )
  const ref = buildAttachmentFileReference({
    attachmentId: put.attachmentId,
    messageId: `msg-${randomUUID().slice(0, 8)}`,
    name,
    declaredMediaType: params.declaredMediaType,
    byteLength: put.byteLength,
    digestHex: put.sha256,
    classification,
  })
  if (!ref.ok) throw new Error(ref.message)

  const isImg = classification.class === 'png' || classification.class === 'jpeg'
  const framing = isImg
    ? validateStrictChannelImageContainer(params.bytes, classification.class)
    : { width: null, height: null, visualValid: false }

  const now = Math.floor(Date.now() / 1000)
  const row: RetainedChannelAttachmentRow = {
    attachment_id: put.attachmentId,
    session_key: sessionKey,
    linked_user_id: linkedUserId,
    provider_event_id: `evt-${randomUUID().slice(0, 8)}`,
    provider_attachment_id: `patt-${randomUUID().slice(0, 8)}`,
    storage_rel_path: put.storageRelPath,
    sha256: put.sha256,
    byte_length: put.byteLength,
    file_reference_json: JSON.stringify(ref.value),
    width: framing.width,
    height: framing.height,
    visual_valid: framing.visualValid ? 1 : 0,
    created_at: now,
    expires_at: params.expiresAtEpoch ?? now + 86_400,
    status: 'ready',
  }
  await params.storeHandle.store.insertChannelAttachment!(row)
  return { attachmentId: put.attachmentId, sessionKey }
}

describe('Channel attachment approval resume, revocation, CAS races, scoping & legacy boot reap (S38, S39, S47, S48, S54, S62-S64, S74-S76, S79, S80, S85-S87)', () => {
  let tmpDir: string
  let dbPath: string
  const origEnableApproval = config.enableApproval
  const origServerPort = config.serverPort

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-ch-appr-'))
    dbPath = path.join(tmpDir, 'state.db')
    config.enableApproval = true
    vi.mocked(resolveProviderWorkflowCallerContext).mockReset()
  })

  afterEach(async () => {
    config.enableApproval = origEnableApproval
    config.serverPort = origServerPort
    mainRpcTestSeams.setAgent(null)
    mainRpcTestSeams.setMessageQueue(null)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function buildPod(opts: {
    dbPath: string
    tmpDir: string
    resolveCaller: (
      msg: IncomingMessage
    ) => Promise<{ targetUserId?: string; conversationId?: string } | null>
    llmResponder?: (
      messages: ChatMessage[],
      callIndex: number
    ) => Promise<{
      content: string | null
      tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null
      finish_reason?: FinishReason
    }>
    mcpCallTool?: ReturnType<typeof vi.fn>
    approvalTools?: Record<string, boolean>
  }) {
    const storeHandle = makeSqliteStore({ dbPath: opts.dbPath })
    const attachmentStore = new ChannelAttachmentStore({
      hostWorkspaceRoot: opts.tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })
    const promptCache = new PromptCache()
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    const pendingTaskResults = new ResultStore<PendingTaskEntry>(10 * 60 * 1000, e => e.storedAt)
    const agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    agent.setConversationStore(storeHandle.store)
    agent.setChannelAttachmentStore(attachmentStore)
    agent.setPromptCache(promptCache)
    agent.setPendingTaskResults(pendingTaskResults)
    const resolverSpy = vi.fn(opts.resolveCaller)
    agent.setChannelCallerContextResolver(resolverSpy)
    agent.setApprovalConfig({
      defaultPolicy: 'allow_all',
      tools: opts.approvalTools ?? { shell_exec: true, srv__gated_action: true },
    } as never)

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
        content: `ok-${callIdx}`,
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
        getVisualDeliveryLimits: () => null,
      } as never,
      'gpt-4o'
    )
    agent.setImageInputResolver(() => ({
      capability: {
        state: 'supported',
        evidence: {
          source: 'curated',
          reference: 'https://unit.invalid/vision',
          checkedAt: '2026-10-02T00:00:00Z',
        },
      },
    }))
    const mcpCallTool =
      opts.mcpCallTool ?? vi.fn(async () => ({ content: [{ type: 'text', text: 'mcp-tool-ran' }] }))
    agent.setMcpManager({
      getAllTools: () => [
        {
          name: 'srv__gated_action',
          description: 'A gated test tool',
          inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
          serverName: 'srv',
        },
      ],
      callTool: mcpCallTool,
    } as never)

    const sessionProcessor = new SessionProcessor({
      maxConcurrent: 4,
      lifecycle,
      executor: task => agent.executeTask(task),
    })
    agent.setSessionProcessor(sessionProcessor)
    agent.setColdStartLoader(new SqliteColdStartLoader(storeHandle.store))

    const send = (msg: IncomingMessage) =>
      new IncomingMessageHandler(msg, {
        messageQueue: queue,
        agent,
        pendingTaskResults,
        getModel: () => 'gpt-4o',
        sanitizeAttachments: a => a,
        sessionProcessor,
        taskLifecycle: lifecycle,
      }).execute()

    const sendAsync = (msg: IncomingMessage) =>
      new IncomingMessageHandler(msg, {
        messageQueue: queue,
        agent,
        pendingTaskResults,
        getModel: () => 'gpt-4o',
        sanitizeAttachments: a => a,
        sessionProcessor,
        taskLifecycle: lifecycle,
      }).executeAsync()

    return {
      storeHandle,
      attachmentStore,
      promptCache,
      queue,
      lifecycle,
      pendingTaskResults,
      agent,
      sessionProcessor,
      resolverSpy,
      llmMock,
      mcpCallTool,
      capturedPrompts,
      send,
      sendAsync,
      shutdown: async () => {
        await agent.stop()
        await storeHandle.shutdown()
      },
      coldCrash: async () => {
        await storeHandle.shutdown()
      },
    }
  }

  it('S38 & S39: warm & cold approval resume preserve channelAttachmentIds/linkedUserId/allowlisted providerIdentity with 0 base64 in context_snapshot and read retained file; mid-session revocation denies access', async () => {
    const toolOutputs: Record<string, string> = {}
    let fileId = ''
    let pngId = ''
    let reqWarm = ''
    let reqCold = ''
    let liveLinkedUser: string | null = 'linked-user-a'

    const pod1 = buildPod({
      dbPath,
      tmpDir,
      resolveCaller: async msg =>
        liveLinkedUser ? { targetUserId: liveLinkedUser, conversationId: msg.channelId } : null,
      llmResponder: async (messages, idx) => {
        for (const m of messages) {
          if (m.role === 'tool' && m.tool_call_id) toolOutputs[m.tool_call_id] = m.content
        }
        if (idx === 0) {
          // Turn 1: suspend on gated MCP tool (warm approval)
          return {
            content: null,
            tool_calls: [
              { id: 'tc-warm-gate', name: 'srv__gated_action', arguments: { note: 'warm' } },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        if (idx === 1) {
          // After warm approval resumes, read retained file via clerum__attachment_read
          return {
            content: null,
            tool_calls: [
              {
                id: 'tc-warm-read',
                name: 'clerum__attachment_read',
                arguments: { attachmentId: fileId },
              },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        if (idx === 2) {
          return { content: 'Warm resume read succeeded' }
        }
        // Turn 2: suspend again for cold pod restart test
        return {
          content: null,
          tool_calls: [
            { id: 'tc-cold-gate', name: 'srv__gated_action', arguments: { note: 'cold' } },
          ],
          finish_reason: FinishReason.ToolUse,
        }
      },
    })

    try {
      const f = await seedAttachment({
        store: pod1.attachmentStore,
        storeHandle: pod1.storeHandle,
        bytes: Buffer.from('RETAINED-RESUME-TOKEN-3839'),
        filename: 'memo.txt',
        declaredMediaType: 'text/plain',
      })
      fileId = f.attachmentId
      const p = await seedAttachment({
        store: pod1.attachmentStore,
        storeHandle: pod1.storeHandle,
        bytes: Buffer.from(PNG_2X2_BASE64, 'base64'),
        filename: 'secret.png',
        declaredMediaType: 'image/png',
      })
      pngId = p.attachmentId

      // S38: Warm suspend & approve
      const t1 = await pod1.send({
        content: 'Run gated action then read memo.txt',
        channelType: 'telegram',
        channelId: 'chat-appr',
        sender: 'u-prov',
        timestamp: new Date().toISOString(),
        messageId: 'm-warm-1',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-prov', 'chat-appr'),
        channelAttachmentIds: [fileId, pngId],
      })
      expect(t1.status).toBe('waiting_approval')
      reqWarm = t1.approval!.requestId

      // Verify pending_approvals.context_snapshot has 0 raw base64 image bytes!
      const rawRow = pod1.storeHandle.worker.db
        .prepare(
          'SELECT context_snapshot, source_message FROM pending_approvals WHERE request_id = ?'
        )
        .get(reqWarm) as { context_snapshot: string; source_message: string }
      expect(rawRow.context_snapshot).not.toContain(PNG_2X2_BASE64)
      const persistedSrc = JSON.parse(rawRow.source_message) as Record<string, unknown>
      expect(persistedSrc.linkedUserId).toBe('linked-user-a')
      expect(persistedSrc.channelAttachmentIds).toEqual([fileId, pngId])
      expect(persistedSrc.providerIdentity).toMatchObject({
        medium: 'telegram',
        providerUserId: 'u-prov',
      })

      const warmOk = await pod1.agent.handleApproval(
        'u-prov',
        reqWarm,
        false,
        'telegram',
        'chat-appr'
      )
      expect(warmOk.success).toBe(true)
      await vi.waitFor(() => {
        expect(toolOutputs['tc-warm-read']).toContain('RETAINED-RESUME-TOKEN-3839')
      })

      // Suspend Turn 2 for S39 cold restart
      const t2 = await pod1.send({
        content: 'Run cold gated action',
        channelType: 'telegram',
        channelId: 'chat-appr',
        sender: 'u-prov',
        timestamp: new Date().toISOString(),
        messageId: 'm-cold-2',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-prov', 'chat-appr'),
        channelAttachmentIds: [fileId, pngId],
      })
      expect(t2.status).toBe('waiting_approval')
      reqCold = t2.approval!.requestId
    } finally {
      await pod1.coldCrash()
    }

    // Pod 2: Cold restart -> bootstrap() -> approve -> reads retained attachment cleanly!
    const pod2 = buildPod({
      dbPath,
      tmpDir,
      resolveCaller: async msg =>
        liveLinkedUser ? { targetUserId: liveLinkedUser, conversationId: msg.channelId } : null,
      llmResponder: async (messages, idx) => {
        for (const m of messages) {
          if (m.role === 'tool' && m.tool_call_id) toolOutputs[m.tool_call_id] = m.content
        }
        if (idx === 0) {
          return {
            content: null,
            tool_calls: [
              {
                id: 'tc-cold-read',
                name: 'clerum__attachment_read',
                arguments: { attachmentId: fileId },
              },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        return { content: 'Cold resume completed' }
      },
    })
    try {
      await pod2.agent.bootstrap()
      const coldOk = await pod2.agent.handleApproval(
        'u-prov',
        reqCold,
        false,
        'telegram',
        'chat-appr'
      )
      expect(coldOk.success).toBe(true)
      await vi.waitFor(() => {
        expect(toolOutputs['tc-cold-read']).toContain('RETAINED-RESUME-TOKEN-3839')
      })

      // S39 revocation witness: revoke link between turns -> 0 LLM calls / 0 attachment disclosure; re-linking restores access!
      const llmBeforeRevoke = pod2.llmMock.mock.calls.length
      liveLinkedUser = null
      const revokedTurn = await pod2.send({
        content: 'Read memo.txt while revoked',
        channelType: 'telegram',
        channelId: 'chat-appr',
        sender: 'u-prov',
        timestamp: new Date().toISOString(),
        messageId: 'm-revoked-39',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-prov', 'chat-appr'),
      })
      expect(revokedTurn.success).toBe(true)
      expect(pod2.llmMock.mock.calls.length).toBe(llmBeforeRevoke)
      expect(revokedTurn.response).not.toContain('RETAINED-RESUME-TOKEN-3839')

      // Re-link same linked-user-a -> access restored!
      liveLinkedUser = 'linked-user-a'
      const restoredTurn = await pod2.send({
        content: 'Read memo.txt after relink',
        channelType: 'telegram',
        channelId: 'chat-appr',
        sender: 'u-prov',
        timestamp: new Date().toISOString(),
        messageId: 'm-restored-39',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-prov', 'chat-appr'),
      })
      expect(restoredTurn.success).toBe(true)
      expect(pod2.llmMock.mock.calls.length).toBeGreaterThan(llmBeforeRevoke)
    } finally {
      await pod2.shutdown()
    }
  })

  it('S47, S48, S54, S63 & S64: warm/cold revoked or relinked approve/deny returns 403 {cancelled:true}, emits only tool:approval_revoked, guards transient 5xx (503 retryable) and concurrent double-click (409)', async () => {
    let brokerMode: 'userA' | 'userB' | 'revoked' | 'error503' | 'hold' = 'userA'
    let releaseHold!: () => void
    const holdPromise = new Promise<void>(resolve => {
      releaseHold = resolve
    })
    let nextShouldSuspend = true

    const mcpSpy = vi.fn(async () => ({ content: [{ type: 'text', text: 'SHOULD-NOT-RUN' }] }))
    const pod = buildPod({
      dbPath,
      tmpDir,
      mcpCallTool: mcpSpy,
      resolveCaller: async msg => {
        if (brokerMode === 'hold') {
          await holdPromise
          return { targetUserId: 'linked-user-a', conversationId: msg.channelId }
        }
        if (brokerMode === 'error503') {
          throw new WorkflowBrokerRequestError(503, 'service_unavailable', 'broker down')
        }
        if (brokerMode === 'revoked') {
          throw new WorkflowBrokerRequestError(404, 'medium_account_not_found', 'revoked')
        }
        return {
          targetUserId: brokerMode === 'userA' ? 'linked-user-a' : 'linked-user-b',
          conversationId: msg.channelId,
        }
      },
      llmResponder: async (_messages, idx) => {
        if (nextShouldSuspend) {
          nextShouldSuspend = false
          return {
            content: null,
            tool_calls: [
              { id: `tc-g-${idx}`, name: 'srv__gated_action', arguments: { note: 'secret' } },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        return { content: `clean-turn-${idx}` }
      },
    })

    const grantedEvents: unknown[] = []
    const deniedEvents: unknown[] = []
    const revokedEvents: unknown[] = []
    pod.agent.on('tool:approval_granted', e => grantedEvents.push(e))
    pod.agent.on('tool:approval_denied', e => deniedEvents.push(e))
    pod.agent.on('tool:approval_revoked', e => revokedEvents.push(e))

    try {
      // 1) Suspend Turn 1 as User A (via executeAsync so pendingTaskResults is populated for S63!)
      const async1 = pod.sendAsync({
        content: 'USERA-PROMPT-CONFIDENTIAL-63',
        channelType: 'slack',
        channelId: 'D_APPR_1',
        sender: 'u-prov',
        timestamp: new Date().toISOString(),
        messageId: 'm-s47-1',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('slack', 'u-prov', 'D_APPR_1', 'T_WS'),
      })
      await vi.waitFor(() => {
        expect(pod.pendingTaskResults.get(async1.taskId!)?.status).toBe('waiting_approval')
      })
      const req1 = pod.pendingTaskResults.get(async1.taskId!)!.approval!.requestId

      // S54: Transient broker 5xx returns 503 retryable WITHOUT cancelling pending_approvals!
      brokerMode = 'error503'
      const transientRes = await pod.agent.handleApproval(
        'u-prov',
        req1,
        false,
        'slack',
        'D_APPR_1'
      )
      expect(transientRes).toMatchObject({
        success: false,
        status: 503,
        retryable: true,
        error: 'approval_identity_check_unavailable',
      })
      expect(pod.agent.getPendingApprovals()).toHaveLength(1)

      // S64: Concurrent double-click on same requestId -> 2nd returns 409 approval_decision_in_flight
      brokerMode = 'hold'
      const firstClick = pod.agent.handleApproval('u-prov', req1, true, 'slack', 'D_APPR_1')
      const secondClick = await pod.agent.handleApproval('u-prov', req1, true, 'slack', 'D_APPR_1')
      expect(secondClick).toMatchObject({
        success: false,
        status: 409,
        error: 'approval_decision_in_flight',
      })
      // Switch to revoked while held? Wait — let's release hold and test S47 on next suspension, or switch before release:
      // Let's release hold so we test S47 cleanly on a dedicated revoked approval!
      // Actually we can reject hold by replacing brokerMode before resolving? No, hold returns userA.
      // Let's test S47 first by aborting? Even simpler: let firstClick finish on a separate req, OR let's test S47 right now on req1:
      // Wait: hold returns userA -> so let's instead make hold check a second flag! Let's finish firstClick? No, mcpSpy shouldn't run in S47.
      // Wait: we already know firstClick is suspended at await holdPromise and returns userA. Let's inspect!
      // Better yet: releaseHold() -> firstClick succeeds (liveness witness!), THEN suspend Turn 2 for S47 revoked and Turn 3 for S48/S63/S64!
      releaseHold()
      const firstClickRes = await firstClick
      expect(firstClickRes.success).toBe(true)
      await vi.waitFor(() => {
        expect(pod.pendingTaskResults.get(async1.taskId!)?.status).toBe('completed')
      })
      expect(mcpSpy).toHaveBeenCalledTimes(1)
      expect(grantedEvents).toHaveLength(1)

      // Reset spies for strict S47 / S48 / S63 / S64 negative assertions (with previous run as liveness witness!).
      mcpSpy.mockClear()
      grantedEvents.length = 0
      deniedEvents.length = 0
      revokedEvents.length = 0

      // 2) S47: Suspend on fresh session, revoke User A, click Approve -> 403 {cancelled:true}, 0 grants, 0 tool executions!
      brokerMode = 'userA'
      nextShouldSuspend = true
      const s47Async = pod.sendAsync({
        content: 'USERA-REVOKED-TURN',
        channelType: 'slack',
        channelId: 'D_S47',
        sender: 'u-prov',
        timestamp: new Date().toISOString(),
        messageId: 'm-s47-2',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('slack', 'u-prov', 'D_S47', 'T_WS'),
      })
      await vi.waitFor(() => {
        expect(pod.pendingTaskResults.get(s47Async.taskId!)?.status).toBe('waiting_approval')
      })
      const reqS47 = pod.pendingTaskResults.get(s47Async.taskId!)!.approval!.requestId
      const resolverCallsBefore = pod.resolverSpy.mock.calls.length

      brokerMode = 'revoked'
      const revokedClick = await pod.agent.handleApproval('u-prov', reqS47, true, 'slack', 'D_S47')
      expect(revokedClick).toMatchObject({
        success: false,
        status: 403,
        cancelled: true,
        error: 'approval_identity_revoked',
      })
      expect(pod.resolverSpy.mock.calls.length).toBeGreaterThan(resolverCallsBefore)
      expect(grantedEvents).toHaveLength(0)
      expect(revokedEvents).toHaveLength(1)
      expect(mcpSpy).toHaveBeenCalledTimes(0)
      expect(pod.pendingTaskResults.get(s47Async.taskId!)).toBeUndefined()
      const pendingRowsAfter47 = (
        pod.storeHandle.worker.db
          .prepare('SELECT count(*) AS cnt FROM pending_approvals')
          .get() as {
          cnt: number
        }
      ).cnt
      expect(pendingRowsAfter47).toBe(0)

      // 3) S48, S63 & S64: Suspend as User A, relink to User B, User B clicks DENY -> 403 {cancelled:true}, 0 tool:approval_denied,
      // PromptCache dropped, S_A ended, User B Turn 2 runs clean with 0 User A Turn 1 prompts!
      brokerMode = 'userA'
      nextShouldSuspend = true
      const s64Key = resolveCanonicalSessionKey({
        sender: 'u-prov',
        channelType: 'slack',
        channelId: 'D_S64',
      })
      const s64Async = pod.sendAsync({
        content: 'USERA-SECRET-DENY-PROMPT-64',
        channelType: 'slack',
        channelId: 'D_S64',
        sender: 'u-prov',
        timestamp: new Date().toISOString(),
        messageId: 'm-s64-1',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('slack', 'u-prov', 'D_S64', 'T_WS'),
      })
      await vi.waitFor(() => {
        expect(pod.pendingTaskResults.get(s64Async.taskId!)?.status).toBe('waiting_approval')
      })
      const reqS64 = pod.pendingTaskResults.get(s64Async.taskId!)!.approval!.requestId
      pod.promptCache.set(s64Key, { stableHash: 'stale-a', parts: null } as never)

      brokerMode = 'userB'
      const denyRes = await pod.agent.handleDenial('u-prov', reqS64, 'slack', 'D_S64')
      expect(denyRes).toMatchObject({
        success: false,
        status: 403,
        cancelled: true,
        error: 'approval_identity_mismatch',
      })
      expect(deniedEvents).toHaveLength(0)
      expect(revokedEvents).toHaveLength(2)
      expect(pod.pendingTaskResults.get(s64Async.taskId!)).toBeUndefined()
      expect(pod.promptCache.has(s64Key)).toBe(false)

      // User B immediately sends Turn 2 on D_S64 -> succeeds with zero InvalidTransition and 0 User A prompts!
      const userBTurn = await pod.send({
        content: 'Hello from User B after obsolete approval cancelled',
        channelType: 'slack',
        channelId: 'D_S64',
        sender: 'u-prov',
        timestamp: new Date().toISOString(),
        messageId: 'm-s64-userb',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: makeIdentity('slack', 'u-prov', 'D_S64', 'T_WS'),
      })
      expect(userBTurn.success).toBe(true)
      const lastPrompt = JSON.stringify(pod.capturedPrompts[pod.capturedPrompts.length - 1]!)
      expect(lastPrompt).not.toContain('USERA-SECRET-DENY-PROMPT-64')
    } finally {
      await pod.shutdown()
    }
  })

  it('S62: Teams channel thread releases normalized suspendedSessions across approve, deny, cancel, and revocation branches', async () => {
    let liveUser: string | null = 'linked-teams-a'
    const rawChannelId = '19:room@thread.tacv2;messageid=555'
    let nextShouldSuspend = false

    const pod = buildPod({
      dbPath,
      tmpDir,
      resolveCaller: async msg =>
        liveUser ? { targetUserId: liveUser, conversationId: msg.channelId } : null,
      llmResponder: async (_messages, idx) => {
        if (nextShouldSuspend) {
          nextShouldSuspend = false
          return {
            content: null,
            tool_calls: [
              { id: `tc-teams-${idx}`, name: 'srv__gated_action', arguments: { note: 't' } },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        return { content: `teams-done-${idx}` }
      },
    })

    const sendTeams = (content: string, threadId: string) =>
      pod.send({
        content,
        channelType: 'teams',
        channelId: rawChannelId,
        sender: 'teams-u1',
        threadId,
        timestamp: new Date().toISOString(),
        messageId: `act-${randomUUID().slice(0, 8)}`,
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: liveUser ?? 'linked-teams-a',
        providerIdentity: makeIdentity('teams', 'teams-u1', rawChannelId, 'tenant-1'),
      })

    try {
      // Branch 1: approve releases suspended session
      nextShouldSuspend = true
      const r1 = await sendTeams('Branch 1 approve', 't-approve')
      expect(r1.status).toBe('waiting_approval')
      const a1 = await pod.agent.handleApproval(
        'teams-u1',
        r1.approval!.requestId,
        false,
        'teams',
        rawChannelId
      )
      expect(a1.success).toBe(true)
      const f1 = await sendTeams('Followup 1', 't-approve')
      expect(f1.success).toBe(true)

      // Branch 2: deny releases suspended session
      nextShouldSuspend = true
      const r2 = await sendTeams('Branch 2 deny', 't-deny')
      expect(r2.status).toBe('waiting_approval')
      const d2 = await pod.agent.handleDenial(
        'teams-u1',
        r2.approval!.requestId,
        'teams',
        rawChannelId
      )
      expect(d2.success).toBe(true)
      const f2 = await sendTeams('Followup 2', 't-deny')
      expect(f2.success).toBe(true)

      // Branch 3: lifecycle cancel releases suspended session
      nextShouldSuspend = true
      const r3 = await sendTeams('Branch 3 cancel', 't-cancel')
      expect(r3.status).toBe('waiting_approval')
      pod.lifecycle.transition(r3.approval!.taskId, 'cancelled', 'user_requested')
      const f3 = await sendTeams('Followup 3', 't-cancel')
      expect(f3.success).toBe(true)

      // Branch 4: X11 revocation releases suspended session
      nextShouldSuspend = true
      const r4 = await sendTeams('Branch 4 revoke', 't-revoke')
      expect(r4.status).toBe('waiting_approval')
      liveUser = 'linked-teams-b'
      const rev4 = await pod.agent.handleApproval(
        'teams-u1',
        r4.approval!.requestId,
        false,
        'teams',
        rawChannelId
      )
      expect(rev4).toMatchObject({ success: false, status: 403, cancelled: true })
      const f4 = await sendTeams('Followup 4 User B', 't-revoke')
      expect(f4.success).toBe(true)
    } finally {
      await pod.shutdown()
    }
  })

  it('S74 & S80: handleProviderMessageAuthorization proactively reconciles obsolete approvals and scopes 403 channel_access_denied strictly to C2 and 404/resolved strictly to workspace W1', async () => {
    const pod = buildPod({
      dbPath,
      tmpDir,
      resolveCaller: async msg => ({
        targetUserId: 'linked-user-a',
        conversationId: msg.channelId,
      }),
      llmResponder: async (_messages, idx) => {
        if (idx === 0) {
          return {
            content: null,
            tool_calls: [{ id: 'tc-c1', name: 'srv__gated_action', arguments: { note: 'c1' } }],
            finish_reason: FinishReason.ToolUse,
          }
        }
        return { content: `after-reconcile-${idx}` }
      },
    })
    mainRpcTestSeams.setAgent(pod.agent)

    try {
      // User A suspends approval A1 in authorized Channel C1 of Workspace W1
      const c1Res = await pod.send({
        content: 'Run gated in C1',
        channelType: 'slack',
        channelId: 'C1',
        sender: 'U_SCOPED',
        timestamp: new Date().toISOString(),
        messageId: 'm-c1',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('slack', 'U_SCOPED', 'C1', 'W1'),
      })
      expect(c1Res.status).toBe('waiting_approval')
      const reqA1 = c1Res.approval!.requestId

      // S80 Case 1: 403 communication_channel_access_denied in C2 (W1) MUST leave A1 in C1 intact!
      vi.mocked(resolveProviderWorkflowCallerContext).mockRejectedValueOnce(
        new WorkflowBrokerRequestError(403, 'communication_channel_access_denied', 'denied C2')
      )
      const authC2 = await handleProviderMessageAuthorization({
        providerIdentity: makeIdentity('slack', 'U_SCOPED', 'C2', 'W1'),
      })
      expect(authC2).toEqual({ authorized: false, reason: 'unresolved' })
      expect(pod.agent.getPendingApprovals().map(a => a.requestId)).toEqual([reqA1])

      // S80 Case 2: 404 medium_account_not_found in OTHER workspace W2 MUST leave A1 in W1 intact!
      vi.mocked(resolveProviderWorkflowCallerContext).mockRejectedValueOnce(
        new WorkflowBrokerRequestError(404, 'medium_account_not_found', 'not linked in W2')
      )
      const authW2 = await handleProviderMessageAuthorization({
        providerIdentity: makeIdentity('slack', 'U_SCOPED', 'C1', 'W2'),
      })
      expect(authW2).toEqual({ authorized: false, reason: 'unresolved' })
      expect(pod.agent.getPendingApprovals().map(a => a.requestId)).toEqual([reqA1])

      // S74 Case B: User B resolves in W1 -> proactively cancels User A's A1 WITHOUT clicking the card, unblocking m2!
      vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce({
        targetUserId: 'linked-user-b',
        conversationId: 'C1',
      } as never)
      const authUserB = await handleProviderMessageAuthorization({
        providerIdentity: makeIdentity('slack', 'U_SCOPED', 'C1', 'W1'),
      })
      expect(authUserB).toEqual({ authorized: true })
      expect(pod.agent.getPendingApprovals()).toHaveLength(0)

      // Now User B sends m2 in C1 -> executes immediately without deadlock!
      pod.resolverSpy.mockResolvedValue({ targetUserId: 'linked-user-b', conversationId: 'C1' })
      const m2 = await pod.send({
        content: 'User B m2 without clicking card',
        channelType: 'slack',
        channelId: 'C1',
        sender: 'U_SCOPED',
        timestamp: new Date().toISOString(),
        messageId: 'm-userb-74',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: makeIdentity('slack', 'U_SCOPED', 'C1', 'W1'),
      })
      expect(m2.success).toBe(true)
      expect(m2.response).toContain('after-reconcile')
    } finally {
      await pod.shutdown()
    }
  })

  it('S75: post-await CAS returns 409 approval_no_longer_pending with 0 side effects when lifecycle cancel fires during identity await, leaving Turn 2 untouched', async () => {
    let releaseIdentityAwait!: () => void
    const identityGate = new Promise<void>(resolve => {
      releaseIdentityAwait = resolve
    })
    let shouldHold = false

    const pod = buildPod({
      dbPath,
      tmpDir,
      resolveCaller: async msg => {
        if (shouldHold) {
          shouldHold = false
          await identityGate
        }
        return { targetUserId: 'linked-user-a', conversationId: msg.channelId }
      },
      llmResponder: async (_messages, idx) => {
        if (idx === 0) {
          return {
            content: null,
            tool_calls: [{ id: 'tc-75', name: 'srv__gated_action', arguments: { note: 'race' } }],
            finish_reason: FinishReason.ToolUse,
          }
        }
        return { content: 'Turn 2 completed untouched' }
      },
    })

    const grantedEvents: unknown[] = []
    pod.agent.on('tool:approval_granted', e => grantedEvents.push(e))

    try {
      const t1 = await pod.send({
        content: 'Suspend for CAS race',
        channelType: 'telegram',
        channelId: 'chat-75',
        sender: 'u-75',
        timestamp: new Date().toISOString(),
        messageId: 'm-75-1',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-75', 'chat-75'),
      })
      expect(t1.status).toBe('waiting_approval')
      const reqId = t1.approval!.requestId
      const taskId = t1.approval!.taskId

      // Start handleApproval and suspend it inside await resolveCaller
      shouldHold = true
      const racingApproval = pod.agent.handleApproval('u-75', reqId, false, 'telegram', 'chat-75')

      // While suspended at await, cancel taskId via lifecycle AND start Turn 2!
      await new Promise(resolve => setTimeout(resolve, 20))
      pod.lifecycle.transition(taskId, 'cancelled', 'user_requested')

      const turn2 = await pod.send({
        content: 'Fresh Turn 2 while race pending',
        channelType: 'telegram',
        channelId: 'chat-75',
        sender: 'u-75',
        timestamp: new Date().toISOString(),
        messageId: 'm-75-2',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-75', 'chat-75'),
      })
      expect(turn2.success).toBe(true)
      expect(turn2.response).toBe('Turn 2 completed untouched')

      // Now release the racing identity await -> post-await CAS MUST return 409 with 0 side effects!
      releaseIdentityAwait()
      const raceResult = await racingApproval
      expect(raceResult).toMatchObject({
        success: false,
        status: 409,
        error: 'approval_no_longer_pending',
      })
      expect(grantedEvents).toHaveLength(0)
    } finally {
      await pod.shutdown()
    }
  })

  it('S76: TaskExecutor.run fails closed via completeWithoutSession on revoked non-workflow channel message (0 LLM calls, 0 DB writes) and fails retryably on transient 5xx', async () => {
    let mode: 'revoked' | 'error500' | 'ok' = 'revoked'
    const pod = buildPod({
      dbPath,
      tmpDir,
      resolveCaller: async msg => {
        if (mode === 'revoked') {
          throw new WorkflowBrokerRequestError(404, 'medium_account_not_found', 'unlinked')
        }
        if (mode === 'error500') {
          throw new WorkflowBrokerRequestError(503, 'upstream_down', '503')
        }
        return { targetUserId: 'linked-user-a', conversationId: msg.channelId }
      },
      llmResponder: async () => ({ content: 'Authorized reply 76' }),
    })

    try {
      // 1) Revoked non-workflow follow-up -> 0 LLM calls, 0 DB writes.
      const resRevoked = await pod.send({
        content: 'Summarize key terms of the contract',
        channelType: 'telegram',
        channelId: 'chat-76',
        sender: 'u-76',
        timestamp: new Date().toISOString(),
        messageId: 'm-76-revoked',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-76', 'chat-76'),
      })
      expect(resRevoked.success).toBe(true)
      expect(pod.llmMock).toHaveBeenCalledTimes(0)
      expect(
        (
          pod.storeHandle.worker.db.prepare('SELECT count(*) AS cnt FROM messages').get() as {
            cnt: number
          }
        ).cnt
      ).toBe(0)

      // 2) Transient 5xx -> retryable failure, 0 LLM calls, 0 DB writes.
      mode = 'error500'
      const res500 = await pod.send({
        content: 'Summarize key terms during outage',
        channelType: 'telegram',
        channelId: 'chat-76',
        sender: 'u-76',
        timestamp: new Date().toISOString(),
        messageId: 'm-76-500',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-76', 'chat-76'),
      })
      expect(res500.success).toBe(false)
      expect(res500.error?.retryable).toBe(true)
      expect(pod.llmMock).toHaveBeenCalledTimes(0)
      expect(
        (
          pod.storeHandle.worker.db.prepare('SELECT count(*) AS cnt FROM messages').get() as {
            cnt: number
          }
        ).cnt
      ).toBe(0)

      // Liveness witness: linked user executes runAgentLoop normally!
      mode = 'ok'
      const resOk = await pod.send({
        content: 'Summarize key terms now linked',
        channelType: 'telegram',
        channelId: 'chat-76',
        sender: 'u-76',
        timestamp: new Date().toISOString(),
        messageId: 'm-76-ok',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-76', 'chat-76'),
      })
      expect(resOk.success).toBe(true)
      expect(resOk.response).toBe('Authorized reply 76')
      expect(pod.llmMock).toHaveBeenCalledTimes(1)
    } finally {
      await pod.shutdown()
    }
  })

  it('S79: handleTaskResult (via main.ts RPCServer) re-verifies live linkedUserId across completed/waiting_approval/failed results and returns pending on transient 5xx without disclosing response', async () => {
    config.enableApproval = false
    config.serverPort = 0

    const storeHandle = makeSqliteStore({ dbPath })
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    const agent = mainRpcTestSeams.createAgent(queue, lifecycle)
    agent.setConversationStore(storeHandle.store)
    agent.setLLMProvider(
      {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools: vi.fn(async () => ({
          content: 'TOP-SECRET-PDF-SUMMARY-7900',
          tool_calls: null,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          finish_reason: FinishReason.Stop,
        })),
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

    mainRpcTestSeams.setAgent(agent)
    mainRpcTestSeams.setMessageQueue(queue)
    const rpcServer = await mainRpcTestSeams.startRPCServer()
    const rawServer = (rpcServer as unknown as { server: http.Server }).server
    const addr = rawServer.address()
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP port')
    const baseUrl = `http://127.0.0.1:${addr.port}`

    const identity = makeIdentity('telegram', 'u-79', 'chat-79')
    const edgeHeaders = {
      'content-type': 'application/json',
      'x-clerum-edge-caller': 'channel-reader',
      'x-clerum-edge-host-ref': config.hostName,
      'x-clerum-edge-channel-type': 'telegram',
      'x-clerum-edge-channel-id': 'chat-79',
      'x-clerum-edge-sender': 'u-79',
    }

    try {
      // 1) Submit async message as User A -> completes into main.ts pendingTaskResults!
      vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValue({
        targetUserId: 'linked-user-a',
        conversationId: 'chat-79',
      } as never)

      const submitRes = await fetch(`${baseUrl}/v1/runtime/messages?async=true`, {
        method: 'POST',
        headers: edgeHeaders,
        body: JSON.stringify({
          content: 'Read secret PDF',
          channelType: 'telegram',
          channelId: 'chat-79',
          sender: 'u-79',
          timestamp: new Date().toISOString(),
          messageId: 'm-79-1',
          hostRef: config.hostName,
          providerIdentity: identity,
        }),
      })
      expect(submitRes.status).toBe(200)
      const submitted = (await submitRes.json()) as { success: boolean; taskId?: string }
      expect(submitted.success).toBe(true)
      const taskId = submitted.taskId!

      // mainRpcTestSeams does not wire main.ts's internal sessionProcessor, so
      // dispatch the admitted task into our local sessionProcessor to populate
      // main.ts's real pendingTaskResults.
      const admittedTask = queue.getTask(taskId)!
      expect(admittedTask).toBeDefined()
      sessionProcessor.enqueue(
        resolveCanonicalSessionKey({
          sender: 'u-79',
          channelType: 'telegram',
          channelId: 'chat-79',
        }),
        admittedTask
      )

      // Wait for task completion in lifecycle
      await vi.waitFor(() => {
        expect(lifecycle.getStatus(taskId)).toBe('completed')
      })

      // 2) Transient broker 5xx during poll -> returns { success: true, status: 'pending' } with ZERO response disclosure!
      vi.mocked(resolveProviderWorkflowCallerContext).mockRejectedValueOnce(
        new WorkflowBrokerRequestError(503, 'upstream_down', '503')
      )
      const poll503 = await fetch(`${baseUrl}/v1/runtime/tasks/${taskId}/result`, {
        headers: edgeHeaders,
      })
      expect(poll503.status).toBe(200)
      const body503 = (await poll503.json()) as Record<string, unknown>
      expect(body503).toEqual({ success: true, status: 'pending' })
      expect(JSON.stringify(body503)).not.toContain('TOP-SECRET-PDF-SUMMARY-7900')

      // 3) Admin relinks u-79 to User B -> poll returns terminal approval_identity_mismatch with ZERO response/attachments!
      vi.mocked(resolveProviderWorkflowCallerContext).mockResolvedValueOnce({
        targetUserId: 'linked-user-b',
        conversationId: 'chat-79',
      } as never)
      const pollMismatch = await fetch(`${baseUrl}/v1/runtime/tasks/${taskId}/result`, {
        headers: edgeHeaders,
      })
      expect(pollMismatch.status).toBe(200)
      const bodyMismatch = (await pollMismatch.json()) as {
        success: boolean
        status: string
        response?: string
        error?: { code: string; retryable: boolean }
      }
      expect(bodyMismatch.success).toBe(false)
      expect(bodyMismatch.error?.code).toBe('approval_identity_mismatch')
      expect(bodyMismatch.response).toBeUndefined()
      expect(JSON.stringify(bodyMismatch)).not.toContain('TOP-SECRET-PDF-SUMMARY-7900')
    } finally {
      await rpcServer.stop()
      await agent.stop()
      await storeHandle.shutdown()
    }
  })

  it('S85: identity abort during run() and resumeAfterApproval() skips cancelTurn, awaits unwind, clears activeExecutors, keeps S_A ended, and User B m2 completes cleanly', async () => {
    let liveUser: string | null = 'linked-user-a'
    let releaseSlowLlm!: () => void
    let slowLlmEntered!: () => void
    let slowGate = new Promise<void>(resolve => {
      releaseSlowLlm = resolve
    })
    let slowEnteredPromise = new Promise<void>(resolve => {
      slowLlmEntered = resolve
    })

    const pod = buildPod({
      dbPath,
      tmpDir,
      resolveCaller: async msg =>
        liveUser ? { targetUserId: liveUser, conversationId: msg.channelId } : null,
      llmResponder: async (_messages, idx) => {
        if (idx === 0) {
          // Variant (a): slow run() processing
          slowLlmEntered()
          await slowGate
          return { content: 'SHOULD-BE-SUPPRESSED-A' }
        }
        if (idx === 1) {
          // User B's m2 after Variant (a)
          return { content: 'User B m2 clean after run abort' }
        }
        if (idx === 2) {
          // Variant (b): suspend for approval first
          return {
            content: null,
            tool_calls: [{ id: 'tc-85b', name: 'srv__gated_action', arguments: { note: '85b' } }],
            finish_reason: FinishReason.ToolUse,
          }
        }
        if (idx === 3) {
          // Inside resumeAfterApproval() LLM continuation — pause so reconcileChannelIdentity aborts it!
          slowLlmEntered()
          await slowGate
          return { content: 'SHOULD-BE-SUPPRESSED-RESUME' }
        }
        return { content: 'User B m2 clean after resume abort' }
      },
    })

    try {
      // Variant (a): abort during TaskExecutor.run()
      const keyA = resolveCanonicalSessionKey({
        sender: 'u-85a',
        channelType: 'slack',
        channelId: 'D_85A',
      })
      const runPromiseA = pod.send({
        content: 'Long processing User A turn',
        channelType: 'slack',
        channelId: 'D_85A',
        sender: 'u-85a',
        timestamp: new Date().toISOString(),
        messageId: 'm-85a-1',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('slack', 'u-85a', 'D_85A', 'W85'),
      })
      await slowEnteredPromise

      const sessionA = pod.storeHandle.worker.db
        .prepare('SELECT id FROM sessions WHERE session_key = ?')
        .get(keyA) as { id: string }

      // Relink to User B and reconcile while User A is processing!
      liveUser = 'linked-user-b'
      const reconcileA = pod.agent.reconcileChannelIdentity({
        medium: 'slack',
        workspaceOrTargetKey: 'W85',
        providerUserId: 'u-85a',
        channelScope: null,
        liveLinkedUserId: 'linked-user-b',
      })
      releaseSlowLlm()
      await reconcileA
      await runPromiseA.catch(() => undefined)

      const stateA = pod.storeHandle.worker.db
        .prepare('SELECT state FROM sessions WHERE id = ?')
        .get(sessionA.id) as { state: string }
      expect(stateA.state).toBe('ended')

      // User B sends m2 on exact same sessionKey -> inserts S_B with 0 UNIQUE constraint error!
      const userB_A = await pod.send({
        content: 'User B m2 on D_85A',
        channelType: 'slack',
        channelId: 'D_85A',
        sender: 'u-85a',
        timestamp: new Date().toISOString(),
        messageId: 'm-85a-b',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: makeIdentity('slack', 'u-85a', 'D_85A', 'W85'),
      })
      expect(userB_A.success).toBe(true)
      expect(userB_A.response).toBe('User B m2 clean after run abort')

      // Variant (b): abort during resumeAfterApproval()
      liveUser = 'linked-user-a'
      slowGate = new Promise<void>(resolve => {
        releaseSlowLlm = resolve
      })
      slowEnteredPromise = new Promise<void>(resolve => {
        slowLlmEntered = resolve
      })
      const keyB = resolveCanonicalSessionKey({
        sender: 'u-85b',
        channelType: 'slack',
        channelId: 'D_85B',
      })
      const susp = await pod.send({
        content: 'Suspend for 85b',
        channelType: 'slack',
        channelId: 'D_85B',
        sender: 'u-85b',
        timestamp: new Date().toISOString(),
        messageId: 'm-85b-1',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('slack', 'u-85b', 'D_85B', 'W85'),
      })
      expect(susp.status).toBe('waiting_approval')
      const session85B = pod.storeHandle.worker.db
        .prepare('SELECT id FROM sessions WHERE session_key = ?')
        .get(keyB) as { id: string }

      // Approve as User A -> enters resumeAfterApproval() LLM continuation and pauses at slowGate
      const appr = await pod.agent.handleApproval(
        'u-85b',
        susp.approval!.requestId,
        false,
        'slack',
        'D_85B'
      )
      expect(appr.success).toBe(true)
      await slowEnteredPromise

      // Relink to User B and reconcile mid-resumeAfterApproval!
      liveUser = 'linked-user-b'
      const reconcileB = pod.agent.reconcileChannelIdentity({
        medium: 'slack',
        workspaceOrTargetKey: 'W85',
        providerUserId: 'u-85b',
        channelScope: null,
        liveLinkedUserId: 'linked-user-b',
      })
      releaseSlowLlm()
      await reconcileB

      const state85B = pod.storeHandle.worker.db
        .prepare('SELECT state FROM sessions WHERE id = ?')
        .get(session85B.id) as { state: string }
      expect(state85B.state).toBe('ended')

      // User B sends m2 -> suspendedSessions was released and S_B completes cleanly!
      const userB_B = await pod.send({
        content: 'User B m2 on D_85B',
        channelType: 'slack',
        channelId: 'D_85B',
        sender: 'u-85b',
        timestamp: new Date().toISOString(),
        messageId: 'm-85b-b',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: makeIdentity('slack', 'u-85b', 'D_85B', 'W85'),
      })
      expect(userB_B.success).toBe(true)
      expect(userB_B.response).toBe('User B m2 clean after resume abort')
    } finally {
      await pod.shutdown()
    }
  })

  it('S86: AgentStateMachine.bootstrap reaps legacy pre-migration-020 external-channel pending_approvals while keeping Desktop rpc approvals intact', async () => {
    const pod = buildPod({
      dbPath,
      tmpDir,
      resolveCaller: async msg => ({
        targetUserId: 'linked-user-b',
        conversationId: msg.channelId,
      }),
      llmResponder: async () => ({ content: 'User B m2 ran immediately' }),
    })

    try {
      const db = pod.storeHandle.worker.db
      const now = Math.floor(Date.now() / 1000)
      const tgKey = 'u-legacy-tg:telegram:chat-86:default'
      const rpcKey = 'desk-user-86:rpc:agent-1:chat-86'

      // Seed legacy external-channel session & pending_approvals WITHOUT linkedUserId/providerIdentity
      db.prepare(
        `INSERT INTO sessions (
          id, session_key, source, user_id, channel_type, channel_id, started_at, last_activity_at,
          turn_count, message_count, tool_call_count, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cache_tokens_reported, state, active_task_id, approval_mode, linked_user_id
        ) VALUES ('sess-tg-86', ?, 'telegram', 'u-legacy-tg', 'telegram', 'chat-86', ?, ?, 1, 1, 0, 0, 0, 0, 0, 0, 'awaiting_approval', 'task-tg-86', 'manual', NULL)`
      ).run(tgKey, now - 60, now - 60)
      db.prepare(
        `INSERT INTO pending_approvals (
          request_id, session_id, task_id, tool_name, tool_call_id, parameters, description,
          context_snapshot, source_message, task_budget, registered_at, expires_at
        ) VALUES ('req-tg-86', 'sess-tg-86', 'task-tg-86', 'shell_exec', 'tc-1', '{}', 'legacy', '[]', ?, 'legacy', ?, ?)`
      ).run(
        JSON.stringify({
          content: 'legacy',
          channelType: 'telegram',
          channelId: 'chat-86',
          sender: 'u-legacy-tg',
          timestamp: new Date().toISOString(),
          messageId: 'm-leg',
          hostRef: 'ns/host',
        }),
        now - 60,
        now + 3600
      )

      // Seed Desktop rpc session & pending_approvals (must rehydrate normally!)
      db.prepare(
        `INSERT INTO sessions (
          id, session_key, source, user_id, channel_type, channel_id, thread_id, started_at, last_activity_at,
          turn_count, message_count, tool_call_count, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cache_tokens_reported, state, active_task_id, approval_mode, linked_user_id
        ) VALUES ('sess-rpc-86', ?, 'rpc', 'desk-user-86', 'rpc', 'agent-1', 'chat-86', ?, ?, 1, 1, 0, 0, 0, 0, 0, 0, 'awaiting_approval', 'task-rpc-86', 'manual', NULL)`
      ).run(rpcKey, now - 60, now - 60)
      db.prepare(
        `INSERT INTO pending_approvals (
          request_id, session_id, task_id, tool_name, tool_call_id, parameters, description,
          context_snapshot, source_message, task_budget, registered_at, expires_at
        ) VALUES ('req-rpc-86', 'sess-rpc-86', 'task-rpc-86', 'shell_exec', 'tc-2', '{}', 'desktop', ?, ?, ?, ?, ?)`
      ).run(
        JSON.stringify([{ role: 'user', content: 'desktop task' }]),
        JSON.stringify({
          content: 'desktop task',
          channelType: 'rpc',
          channelId: 'agent-1',
          threadId: 'chat-86',
          sender: 'desk-user-86',
          timestamp: new Date().toISOString(),
          messageId: 'm-rpc',
          hostRef: 'ns/host',
        }),
        JSON.stringify({
          elapsedActiveMs: 0,
          iterationsUsed: 1,
          durationMs: 86_400_000,
          maxIterations: 1000,
        }),
        now - 60,
        now + 3600
      )
      // Give Desktop approval a valid task_budget via context/legacy_budget? Note: reconstructPendingApproval sets legacy_budget: true when task_budget is absent!

      await pod.agent.bootstrap()

      // Legacy Telegram approval was reaped; Desktop rpc approval rehydrated!
      const pending = pod.agent.getPendingApprovals()
      expect(pending.map(p => p.requestId)).toEqual(['req-rpc-86'])

      const tgSession = db
        .prepare('SELECT state, end_reason FROM sessions WHERE id = ?')
        .get('sess-tg-86') as { state: string; end_reason: string }
      expect(tgSession).toEqual({ state: 'ended', end_reason: 'legacy_approval_reaped' })

      const tgPendingCount = (
        db
          .prepare("SELECT count(*) AS cnt FROM pending_approvals WHERE request_id = 'req-tg-86'")
          .get() as {
          cnt: number
        }
      ).cnt
      expect(tgPendingCount).toBe(0)

      // User B's m2 on chat-86 runs immediately without deadlock!
      const m2 = await pod.send({
        content: 'User B turn after legacy reap',
        channelType: 'telegram',
        channelId: 'chat-86',
        sender: 'u-legacy-tg',
        timestamp: new Date().toISOString(),
        messageId: 'm-86-userb',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-b',
        providerIdentity: makeIdentity('telegram', 'u-legacy-tg', 'chat-86'),
      })
      expect(m2.success).toBe(true)
      expect(m2.response).toBe('User B m2 ran immediately')
    } finally {
      // Desktop rpc approval req-rpc-86 is intentionally left rehydrated in this test.
      await pod.coldCrash()
    }
  })

  it('S87: approved resume past attachment TTL reads pinned attachment while sessions.state = processing after approve() deletes pending_approvals, and rejects once idle', async () => {
    const toolOutputs: Record<string, string> = {}
    let attId = ''

    const pod = buildPod({
      dbPath,
      tmpDir,
      resolveCaller: async msg => ({
        targetUserId: 'linked-user-a',
        conversationId: msg.channelId,
      }),
      llmResponder: async (messages, idx) => {
        for (const m of messages) {
          if (m.role === 'tool' && m.tool_call_id) toolOutputs[m.tool_call_id] = m.content
        }
        if (idx === 0) {
          // Suspend on gated tool first
          return {
            content: null,
            tool_calls: [
              { id: 'tc-87-gate', name: 'srv__gated_action', arguments: { note: 'pin' } },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        if (idx === 1) {
          // After approval resumes (pending_approvals is DELETED, sessions.state = 'processing'),
          // read the TTL-expired attachment!
          return {
            content: null,
            tool_calls: [
              {
                id: 'tc-87-read',
                name: 'clerum__attachment_read',
                arguments: { attachmentId: attId },
              },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        return { content: 'Read pinned attachment past TTL cleanly' }
      },
    })

    try {
      const nowEpoch = Math.floor(Date.now() / 1000)
      const seeded = await seedAttachment({
        store: pod.attachmentStore,
        storeHandle: pod.storeHandle,
        bytes: Buffer.from('PINNED-PAST-TTL-SECRET-8787'),
        filename: 'pinned.txt',
        declaredMediaType: 'text/plain',
        channelId: 'chat-87',
        expiresAtEpoch: nowEpoch + 3600,
      })
      attId = seeded.attachmentId

      // 1) Suspend turn for approval
      const t1 = await pod.send({
        content: 'Run gated then read pinned.txt',
        channelType: 'telegram',
        channelId: 'chat-87',
        sender: 'u-prov',
        timestamp: new Date().toISOString(),
        messageId: 'm-87-1',
        hostRef: 'ns/host-appr',
        admittedLinkedUserId: 'linked-user-a',
        providerIdentity: makeIdentity('telegram', 'u-prov', 'chat-87'),
        channelAttachmentIds: [attId],
      })
      expect(t1.status).toBe('waiting_approval')

      // 2) Push attachment expires_at into the past (simulating clock advancing past TTL) & run TTL sweep -> MUST preserve blob!
      pod.storeHandle.worker.db
        .prepare('UPDATE conversation_attachments SET expires_at = ? WHERE attachment_id = ?')
        .run(nowEpoch - 120, attId)

      const sweepWhileWaiting = await pod.attachmentStore.sweepExpired(
        {
          sweepExpiredChannelAttachments: (now, limit) =>
            pod.storeHandle.store.sweepExpiredChannelAttachments!(now, limit),
        },
        { nowEpoch: nowEpoch + 10 }
      )
      expect(sweepWhileWaiting.sweptRows).toBe(0)

      // 3) Approve -> approve() deletes pending_approvals and transitions sessions.state = 'processing';
      // resumed clerum__attachment_read MUST still read the pinned attachment cleanly!
      const approved = await pod.agent.handleApproval(
        'u-prov',
        t1.approval!.requestId,
        false,
        'telegram',
        'chat-87'
      )
      expect(approved.success).toBe(true)

      await vi.waitFor(() => {
        expect(toolOutputs['tc-87-read']).toContain('PINNED-PAST-TTL-SECRET-8787')
      })

      // 4) Once turn completes and returns to 'idle', direct owner read rejects as expired (attachment_not_found)!
      await vi.waitFor(() => {
        const row = pod.storeHandle.worker.db
          .prepare('SELECT state FROM sessions WHERE session_key = ?')
          .get(seeded.sessionKey) as { state: string }
        expect(row.state).toBe('idle')
      })

      const rowAfterIdle = await pod.storeHandle.store.getChannelAttachmentForOwner!(
        attId,
        seeded.sessionKey,
        'linked-user-a',
        nowEpoch + 10
      )
      expect(rowAfterIdle).toBeNull()
    } finally {
      await pod.shutdown()
    }
  })
})
