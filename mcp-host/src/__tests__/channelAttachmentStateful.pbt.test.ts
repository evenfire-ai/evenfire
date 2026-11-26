import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildAttachmentFileReference,
  classifyBytes,
  resourceNameProblem,
} from '@clerum/gfs-interaction-policy'
import { AgentStateMachine } from '../agent/stateMachine'
import { config } from '../config'
import { LlmPortAdapter } from '../core/adapters/llmPortAdapter'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../core/conversation/persistence/__tests__/testHelpers'
import { SqliteColdStartLoader } from '../core/conversation/persistence/sqliteColdStartLoader'
import { LlmErrorCode } from '../core/errors'
import { type ChatMessage, ConversationState, FinishReason } from '../core/types'
import type { RetainedChannelAttachmentRow } from '../db/worker/protocol'
import {
  ChannelAttachmentStore,
  normalizeChannelFilename,
  validateStrictChannelImageContainer,
} from '../internalTools/channelAttachmentStore'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { JPEG_2X2_BASE64, PNG_2X2_BASE64 } from '../llm/__tests__/codexImageFixtures'
import { PromptCache } from '../llm/promptCache'
import { IncomingMessageHandler, type PendingTaskEntry } from '../messageHandler'
import { MessageQueue } from '../queue/messageQueue'
import { ResultStore } from '../resultStore'
import type { IncomingMessage, ProviderIdentity } from '../server/types'
import { SessionProcessor, resolveCanonicalSessionKey } from '../session'
import { resolveVisualDeliveryLimits } from '../visualInput/deliveryLimits'

const HEALTHY_STATFS = async () => ({
  bsize: 4096n,
  blocks: (100n * 1024n * 1024n * 1024n) / 4096n,
  bavail: (50n * 1024n * 1024n * 1024n) / 4096n,
})

interface ModelAttachment {
  attachmentId: string
  sessionKey: string
  linkedUserId: string
  sha256: string
  expiresAt: number
  isImage: boolean
  visualValid: boolean
  deleted: boolean
}

interface ReferenceModel {
  /** Current live linked user for the provider account (`null` = revoked). */
  liveLinkedUserId: string | null
  /** Whether channel C2 is denied (403) while C1 stays authorized. */
  deniedC2: boolean
  /** Logical clock in epoch seconds. */
  clockEpoch: number
  /** Known attachments keyed by attachmentId. */
  attachments: Map<string, ModelAttachment>
  /** Pending approval currently active on C1 (if any). */
  pendingApproval: {
    requestId: string
    taskId: string
    linkedUserId: string
    sessionKey: string
  } | null
  /** Last completed messageId + linkedUserId for duplicate redelivery checks. */
  lastDelivered: {
    messageId: string
    linkedUserId: string
    response: string
  } | null
  /** Total LLM calls counted by attachment-only checks (SF6). */
  llmCallCount: number
  /** Tracked per-user secret sentinels to verify SF1 zero cross-user leakage. */
  sentinelsByUser: Map<string, string[]>
  /** Number of commands executed. */
  stepCount: number
}

interface RealSystem {
  tmpDir: string
  dbPath: string
  storeHandle: StoreHandle
  attachmentStore: ChannelAttachmentStore
  promptCache: PromptCache
  queue: MessageQueue
  lifecycle: TaskLifecycle
  pendingTaskResults: ResultStore<PendingTaskEntry>
  agent: AgentStateMachine
  sessionProcessor: SessionProcessor
  llmMock: ReturnType<typeof vi.fn>
  capturedPrompts: Array<{ linkedUserAtSend: string | null; messages: ChatMessage[] }>
  nextLlmPlan: 'reply' | 'suspend'
  liveLinkedUserRef: { current: string | null }
  scheduler: fc.Scheduler
  scheduleResolverAwait: { current: boolean }
  restartPod: () => Promise<void>
  cleanup: () => Promise<void>
}

const PROVIDER_USER = 'pbt-u1'
const CHANNEL_C1 = 'C1-pbt'
const CHANNEL_C2 = 'C2-pbt'
const WORKSPACE_W1 = 'W1-pbt'
const SESSION_KEY_C1 = resolveCanonicalSessionKey({
  sender: PROVIDER_USER,
  channelType: 'slack',
  channelId: CHANNEL_C1,
})

function pbtIdentity(channelId = CHANNEL_C1): ProviderIdentity {
  return {
    medium: 'slack',
    providerUserId: PROVIDER_USER,
    providerWorkspaceId: WORKSPACE_W1,
    providerChannelId: channelId,
    providerChannelType: 'channel',
    providerTarget: {
      hostRef: 'ns/host-pbt',
      communicationChannelNamespace: 'channels',
      communicationChannelName: 'slack-pbt',
    },
  }
}

async function createRealSystem(scheduler: fc.Scheduler): Promise<RealSystem> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-ch-pbt-'))
  const dbPath = path.join(tmpDir, 'state.db')
  const liveLinkedUserRef = { current: 'user-a' as string | null }
  const scheduleResolverAwait = { current: false }
  const capturedPrompts: Array<{ linkedUserAtSend: string | null; messages: ChatMessage[] }> = []

  const sys: Partial<RealSystem> = {
    tmpDir,
    dbPath,
    liveLinkedUserRef,
    scheduleResolverAwait,
    capturedPrompts,
    nextLlmPlan: 'reply',
    scheduler,
  }

  function wireRuntime(): void {
    const storeHandle = makeSqliteStore({ dbPath })
    const attachmentStore = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
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
    agent.setApprovalConfig({
      defaultPolicy: 'allow_all',
      tools: { srv__pbt_gate: true },
    } as never)
    agent.setChannelCallerContextResolver(async msg => {
      if (scheduleResolverAwait.current) {
        await scheduler.schedule(Promise.resolve())
      }
      const u = liveLinkedUserRef.current
      if (!u) return null
      return { targetUserId: u, conversationId: msg.channelId }
    })

    const llmMock = vi.fn(async (messages: ChatMessage[]) => {
      capturedPrompts.push({
        linkedUserAtSend: liveLinkedUserRef.current,
        messages: messages.map(m => ({ ...m })),
      })
      if (sys.nextLlmPlan === 'suspend') {
        sys.nextLlmPlan = 'reply'
        return {
          content: null,
          tool_calls: [
            { id: `tc-pbt-${randomUUID().slice(0, 6)}`, name: 'srv__pbt_gate', arguments: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          finish_reason: FinishReason.ToolUse,
        }
      }
      return {
        content: `pbt-reply-for-${liveLinkedUserRef.current ?? 'none'}`,
        tool_calls: null,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
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
    agent.setMcpManager({
      getAllTools: () => [
        {
          name: 'srv__pbt_gate',
          description: 'PBT approval gated tool',
          inputSchema: { type: 'object', properties: {} },
          serverName: 'srv',
        },
      ],
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'pbt-gated-ok' }] })),
    } as never)

    const sessionProcessor = new SessionProcessor({
      maxConcurrent: 4,
      lifecycle,
      executor: task => agent.executeTask(task),
    })
    agent.setSessionProcessor(sessionProcessor)
    agent.setColdStartLoader(new SqliteColdStartLoader(storeHandle.store))

    sys.storeHandle = storeHandle
    sys.attachmentStore = attachmentStore
    sys.promptCache = promptCache
    sys.queue = queue
    sys.lifecycle = lifecycle
    sys.pendingTaskResults = pendingTaskResults
    sys.agent = agent
    sys.sessionProcessor = sessionProcessor
    sys.llmMock = llmMock
  }

  wireRuntime()

  sys.restartPod = async () => {
    // Abrupt pod restart: close DB without draining pending_approvals, then re-wire & bootstrap().
    await sys.storeHandle!.shutdown()
    wireRuntime()
    await sys.agent!.bootstrap()
  }

  sys.cleanup = async () => {
    try {
      // Avoid 10s grace-period wait in agent.stop() when a run ends with a
      // cold-rehydrated pending approval still open; close SQLite & temp dir cleanly.
      if (sys.agent!.getPendingApprovals().length === 0) {
        await sys.agent!.stop()
      }
    } catch {
      /* ignore */
    }
    try {
      await sys.storeHandle!.shutdown()
    } catch {
      /* ignore */
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  }

  return sys as RealSystem
}

/**
 * Verify SF1–SF10 and L1–L3 invariants at rest after every command.
 */
async function assertInvariants(m: ReferenceModel, r: RealSystem): Promise<void> {
  const db = r.storeHandle.worker.db

  // SF9: Zero leaked activeReservedBytes and zero orphan .partial files at rest.
  expect(r.attachmentStore.getActiveReservedBytes()).toBe(0)
  const storeDir = r.attachmentStore.getStoreDir()!
  try {
    const files = await fs.readdir(storeDir)
    expect(files.filter(f => f.endsWith('.partial'))).toHaveLength(0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  // SF6: pending_approvals.context_snapshot NEVER contains raw PNG/JPEG base64 image parts.
  const pendingRows = db
    .prepare('SELECT request_id, context_snapshot FROM pending_approvals')
    .all() as Array<{ request_id: string; context_snapshot: string }>
  for (const row of pendingRows) {
    expect(row.context_snapshot).not.toContain(PNG_2X2_BASE64)
    expect(row.context_snapshot).not.toContain(JPEG_2X2_BASE64)
  }

  // SF1 / R71: Partial unique index guarantees at most 1 active (state != 'ended') session per session_key.
  const activeSessions = db
    .prepare(
      "SELECT id, state, linked_user_id FROM sessions WHERE session_key = ? AND state != 'ended'"
    )
    .all(SESSION_KEY_C1) as Array<{ id: string; state: string; linked_user_id: string | null }>
  expect(activeSessions.length).toBeLessThanOrEqual(1)

  // SF5 & L1: Every 'ready' row in conversation_attachments has valid NFC name and intact SHA-256 blob on PVC.
  const dbAttachments = db
    .prepare("SELECT * FROM conversation_attachments WHERE status = 'ready'")
    .all() as RetainedChannelAttachmentRow[]
  for (const row of dbAttachments) {
    const parsedRef = JSON.parse(row.file_reference_json) as { name: string }
    expect(resourceNameProblem(parsedRef.name)).toBeNull()
    const verifiedBytes = await r.attachmentStore.readVerified(row.storage_rel_path, row.sha256)
    expect(createHash('sha256').update(verifiedBytes).digest('hex')).toBe(row.sha256)
  }

  // SF10: If a pending approval is active, every attachment owned by that session_key & linkedUserId MUST still exist in SQLite & PVC.
  if (m.pendingApproval) {
    for (const att of m.attachments.values()) {
      if (
        !att.deleted &&
        att.sessionKey === m.pendingApproval.sessionKey &&
        att.linkedUserId === m.pendingApproval.linkedUserId
      ) {
        const existsInDb = db
          .prepare('SELECT 1 FROM conversation_attachments WHERE attachment_id = ?')
          .get(att.attachmentId)
        expect(existsInDb).toBeDefined()
      }
    }
  }

  // SF1: No LLM prompt sent while linked to User X ever contains any secret sentinel written by User Y != X.
  for (const entry of r.capturedPrompts) {
    if (!entry.linkedUserAtSend) continue
    const serialized = JSON.stringify(entry.messages)
    for (const [otherUser, sentinels] of m.sentinelsByUser.entries()) {
      if (otherUser === entry.linkedUserAtSend) continue
      for (const s of sentinels) {
        expect(serialized).not.toContain(s)
      }
    }
  }
}

class IngestAndAttachmentOnlyCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  constructor(
    readonly kind: 'text' | 'png' | 'motion_jpeg' | 'binary',
    readonly filename: string | null,
    readonly ttlSeconds: number
  ) {}
  check(m: ReferenceModel): boolean {
    return m.liveLinkedUserId !== null && m.pendingApproval === null
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    const linkedUser = m.liveLinkedUserId!
    const bytes =
      this.kind === 'png'
        ? Buffer.from(PNG_2X2_BASE64, 'base64')
        : this.kind === 'motion_jpeg'
          ? Buffer.concat([Buffer.from(JPEG_2X2_BASE64, 'base64'), Buffer.from('mp4-tail')])
          : this.kind === 'binary'
            ? Buffer.from([0x00, 0x01, 0xde, 0xad, 0xbe, 0xef])
            : Buffer.from(`PBT-TEXT-${linkedUser}-${m.stepCount}`)
    const declaredMediaType =
      this.kind === 'png'
        ? 'image/png'
        : this.kind === 'motion_jpeg'
          ? 'image/jpeg'
          : this.kind === 'binary'
            ? 'application/octet-stream'
            : 'text/plain'

    const put = await r.attachmentStore.putBuffer({ bytes, linkedUserId: linkedUser })
    const classification = classifyBytes({
      bytes,
      totalByteLength: bytes.length,
      declaredMediaType,
      filename: this.filename,
    })
    const normalizedName = normalizeChannelFilename(
      this.filename,
      classification.class,
      put.attachmentId.slice(0, 8)
    )
    const ref = buildAttachmentFileReference({
      attachmentId: put.attachmentId,
      messageId: `m-ing-${m.stepCount}`,
      name: normalizedName,
      declaredMediaType,
      byteLength: put.byteLength,
      digestHex: put.sha256,
      classification,
    })
    if (!ref.ok) throw new Error(ref.message)

    const isImage = classification.class === 'png' || classification.class === 'jpeg'
    const framing = isImage
      ? validateStrictChannelImageContainer(bytes, classification.class)
      : { width: null, height: null, visualValid: false }
    const expiresAt = m.clockEpoch + this.ttlSeconds

    await r.storeHandle.store.insertChannelAttachment!({
      attachment_id: put.attachmentId,
      session_key: SESSION_KEY_C1,
      linked_user_id: linkedUser,
      provider_event_id: `evt-${m.stepCount}`,
      provider_attachment_id: `patt-${m.stepCount}`,
      storage_rel_path: put.storageRelPath,
      sha256: put.sha256,
      byte_length: put.byteLength,
      file_reference_json: JSON.stringify(ref.value),
      width: framing.width,
      height: framing.height,
      visual_valid: framing.visualValid ? 1 : 0,
      created_at: m.clockEpoch,
      expires_at: expiresAt,
      status: 'ready',
    })

    m.attachments.set(put.attachmentId, {
      attachmentId: put.attachmentId,
      sessionKey: SESSION_KEY_C1,
      linkedUserId: linkedUser,
      sha256: put.sha256,
      expiresAt,
      isImage,
      visualValid: framing.visualValid,
      deleted: false,
    })

    // Attachment-only turn -> L2 & SF6: 0 LLM calls, deterministic reply naming normalized file!
    const llmBefore = r.llmMock.mock.calls.length
    const handler = new IncomingMessageHandler(
      {
        content: '',
        channelType: 'slack',
        channelId: CHANNEL_C1,
        sender: PROVIDER_USER,
        timestamp: new Date().toISOString(),
        messageId: `m-ao-${m.stepCount}`,
        hostRef: 'ns/host-pbt',
        admittedLinkedUserId: linkedUser,
        providerIdentity: pbtIdentity(CHANNEL_C1),
        channelAttachmentIds: [put.attachmentId],
      },
      {
        messageQueue: r.queue,
        agent: r.agent,
        pendingTaskResults: r.pendingTaskResults,
        getModel: () => 'gpt-4o',
        sanitizeAttachments: a => a,
        sessionProcessor: r.sessionProcessor,
        taskLifecycle: r.lifecycle,
      }
    )
    const res = await handler.execute()
    expect(res.success).toBe(true)
    expect(r.llmMock.mock.calls.length).toBe(llmBefore)
    expect(res.response).toContain(normalizedName)
    await assertInvariants(m, r)
  }
  toString(): string {
    return `IngestAndAttachmentOnly(${this.kind}, ${String(this.filename)}, ttl=${this.ttlSeconds})`
  }
}

class FollowUpTextTurnCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  constructor(readonly suspendForApproval: boolean) {}
  check(m: ReferenceModel): boolean {
    return m.pendingApproval === null
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    const currentLinked = m.liveLinkedUserId
    const sentinel = currentLinked ? `SENTINEL_${currentLinked}_${m.stepCount}` : 'REVOKED_PROMPT'
    const messageId = `m-txt-${m.stepCount}`
    r.nextLlmPlan = this.suspendForApproval && currentLinked !== null ? 'suspend' : 'reply'

    const llmBefore = r.llmMock.mock.calls.length
    const handler = new IncomingMessageHandler(
      {
        content: `Turn ${m.stepCount} ${sentinel}`,
        channelType: 'slack',
        channelId: CHANNEL_C1,
        sender: PROVIDER_USER,
        timestamp: new Date().toISOString(),
        messageId,
        hostRef: 'ns/host-pbt',
        ...(currentLinked ? { admittedLinkedUserId: currentLinked } : {}),
        providerIdentity: pbtIdentity(CHANNEL_C1),
      },
      {
        messageQueue: r.queue,
        agent: r.agent,
        pendingTaskResults: r.pendingTaskResults,
        getModel: () => 'gpt-4o',
        sanitizeAttachments: a => a,
        sessionProcessor: r.sessionProcessor,
        taskLifecycle: r.lifecycle,
      }
    )
    const res = await handler.execute()

    if (currentLinked === null) {
      // SF3 / R76: revoked sender MUST make 0 LLM calls!
      expect(r.llmMock.mock.calls.length).toBe(llmBefore)
    } else if (this.suspendForApproval) {
      expect(res.success).toBe(true)
      expect(res.status).toBe('waiting_approval')
      const list = m.sentinelsByUser.get(currentLinked) ?? []
      list.push(sentinel)
      m.sentinelsByUser.set(currentLinked, list)
      m.pendingApproval = {
        requestId: res.approval!.requestId,
        taskId: res.approval!.taskId,
        linkedUserId: currentLinked,
        sessionKey: SESSION_KEY_C1,
      }
    } else {
      expect(res.success).toBe(true)
      const list = m.sentinelsByUser.get(currentLinked) ?? []
      list.push(sentinel)
      m.sentinelsByUser.set(currentLinked, list)
      m.lastDelivered = {
        messageId,
        linkedUserId: currentLinked,
        response: res.response ?? '',
      }
    }
    await assertInvariants(m, r)
  }
  toString(): string {
    return `FollowUpTextTurn(suspend=${this.suspendForApproval})`
  }
}

class DuplicateRedeliveryCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  check(m: ReferenceModel): boolean {
    return m.lastDelivered !== null && m.pendingApproval === null && m.liveLinkedUserId !== null
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    const prev = m.lastDelivered!
    const live = m.liveLinkedUserId!
    const llmBefore = r.llmMock.mock.calls.length
    const handler = new IncomingMessageHandler(
      {
        content: 'Redelivered message',
        channelType: 'slack',
        channelId: CHANNEL_C1,
        sender: PROVIDER_USER,
        timestamp: new Date().toISOString(),
        messageId: prev.messageId,
        hostRef: 'ns/host-pbt',
        admittedLinkedUserId: live,
        providerIdentity: pbtIdentity(CHANNEL_C1),
      },
      {
        messageQueue: r.queue,
        agent: r.agent,
        pendingTaskResults: r.pendingTaskResults,
        getModel: () => 'gpt-4o',
        sanitizeAttachments: a => a,
        sessionProcessor: r.sessionProcessor,
        taskLifecycle: r.lifecycle,
      }
    )
    const res = await handler.execute()
    if (live === prev.linkedUserId) {
      // Same user redelivery deduplicates cleanly (0 new LLM calls)
      expect(res.success).toBe(true)
      expect(r.llmMock.mock.calls.length).toBe(llmBefore)
    } else {
      // SF1 / R82: Different linkedUserId NEVER replays previous user's response!
      expect(res.success).toBe(true)
      expect(res.response).toBe(`pbt-reply-for-${live}`)
      expect(r.llmMock.mock.calls.length).toBe(llmBefore + 1)
    }
    await assertInvariants(m, r)
  }
  toString(): string {
    return 'DuplicateRedelivery'
  }
}

class UnlinkRelinkOrRevokeCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  constructor(
    readonly nextUser: 'user-a' | 'user-b' | null,
    readonly proactiveReconcile: boolean
  ) {}
  check(): boolean {
    return true
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    const prevPending = m.pendingApproval
    m.liveLinkedUserId = this.nextUser
    r.liveLinkedUserRef.current = this.nextUser

    if (this.proactiveReconcile) {
      await r.agent.reconcileChannelIdentity({
        medium: 'slack',
        workspaceOrTargetKey: WORKSPACE_W1,
        providerUserId: PROVIDER_USER,
        channelScope: null,
        liveLinkedUserId: this.nextUser,
      })
      if (prevPending && (this.nextUser === null || prevPending.linkedUserId !== this.nextUser)) {
        m.pendingApproval = null
      }
      if (m.lastDelivered && m.lastDelivered.linkedUserId !== this.nextUser) {
        m.lastDelivered = null
      }
    }
    await assertInvariants(m, r)
  }
  toString(): string {
    return `UnlinkRelinkOrRevoke(next=${String(this.nextUser)}, reconcile=${this.proactiveReconcile})`
  }
}

class DeniedChannel403ReconcileCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  check(): boolean {
    return true
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    // S80: 403 on C2 scopes strictly to C2 and NEVER cancels C1's pending approval!
    await r.agent.reconcileChannelIdentity({
      medium: 'slack',
      workspaceOrTargetKey: WORKSPACE_W1,
      providerUserId: PROVIDER_USER,
      channelScope: CHANNEL_C2,
      liveLinkedUserId: null,
    })
    if (m.pendingApproval) {
      expect(r.agent.getPendingApprovals().map(a => a.requestId)).toContain(
        m.pendingApproval.requestId
      )
    }
    await assertInvariants(m, r)
  }
  toString(): string {
    return 'DeniedChannel403Reconcile(C2)'
  }
}

class ResolvePendingApprovalCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  constructor(readonly action: 'approve' | 'deny' | 'cancel') {}
  check(m: ReferenceModel): boolean {
    return m.pendingApproval !== null
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    const pa = m.pendingApproval!
    if (this.action === 'cancel') {
      r.lifecycle.transition(pa.taskId, 'cancelled', 'user_requested')
      m.pendingApproval = null
      await assertInvariants(m, r)
      return
    }

    const res =
      this.action === 'approve'
        ? await r.agent.handleApproval(PROVIDER_USER, pa.requestId, false, 'slack', CHANNEL_C1)
        : await r.agent.handleDenial(PROVIDER_USER, pa.requestId, 'slack', CHANNEL_C1)

    const identityMatches = m.liveLinkedUserId !== null && m.liveLinkedUserId === pa.linkedUserId
    if (!identityMatches) {
      // SF3 / R47 / R48 / R64: fails closed 403 { cancelled: true }!
      expect(res).toMatchObject({ success: false, status: 403, cancelled: true })
    } else {
      expect(res.success).toBe(true)
      if (this.action === 'approve') {
        await vi.waitFor(() => {
          expect(r.agent.getPendingApprovals()).toHaveLength(0)
          const conv = r.agent.getConversationManager().getSessionByKey(SESSION_KEY_C1)
          expect(conv?.state).toBe(ConversationState.Idle)
        })
      }
    }
    m.pendingApproval = null
    await assertInvariants(m, r)
  }
  toString(): string {
    return `ResolvePendingApproval(${this.action})`
  }
}

class ColdPodRestartCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  check(): boolean {
    return true
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    await r.restartPod()
    m.lastDelivered = null // RAM TaskLifecycle cleared across pod restart
    if (m.pendingApproval) {
      expect(r.agent.getPendingApprovals().map(a => a.requestId)).toEqual([
        m.pendingApproval.requestId,
      ])
    } else {
      expect(r.agent.getPendingApprovals()).toHaveLength(0)
    }
    await assertInvariants(m, r)
  }
  toString(): string {
    return 'ColdPodRestart'
  }
}

class AdvanceClockAndSweepTtlCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  constructor(readonly deltaSeconds: number) {}
  check(): boolean {
    return true
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    m.clockEpoch += this.deltaSeconds
    await r.attachmentStore.sweepExpired(
      {
        sweepExpiredChannelAttachments: (now, limit) =>
          r.storeHandle.store.sweepExpiredChannelAttachments!(now, limit),
      },
      { nowEpoch: m.clockEpoch }
    )
    // Mark swept attachments deleted in model only when NOT pinned by pendingApproval
    for (const att of m.attachments.values()) {
      if (att.deleted) continue
      const pinned = m.pendingApproval !== null && att.sessionKey === m.pendingApproval.sessionKey
      if (!pinned && att.expiresAt < m.clockEpoch) {
        att.deleted = true
      }
    }
    await assertInvariants(m, r)
  }
  toString(): string {
    return `AdvanceClockAndSweepTtl(+${this.deltaSeconds}s)`
  }
}

class VisionFailoverDemotionCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  constructor(readonly target: 'non_vision' | 'codex_oversized') {}
  check(): boolean {
    return true
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    const sendSpy = vi.fn(async (_msgs: ChatMessage[]) => ({
      content: 'demoted-ok',
      tool_calls: null,
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      finish_reason: FinishReason.Stop,
    }))
    const provider = {
      getProviderType: () =>
        this.target === 'non_vision' ? ('openai' as const) : ('codex-subscription' as const),
      getVisualDeliveryLimits: () =>
        this.target === 'non_vision' ? null : resolveVisualDeliveryLimits('codex-subscription'),
      completeSingleTurnWithTools: sendSpy,
      completeSingleTurn: vi.fn(),
      classifyError: vi.fn(() => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: false,
        message: 'err',
      })),
    }
    const adapter = new LlmPortAdapter(
      provider as never,
      this.target === 'non_vision' ? 'text-only' : 'codex-vision',
      provider.getProviderType(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        capability: {
          state: this.target === 'non_vision' ? 'unsupported' : 'supported',
          evidence: {
            source: 'curated',
            reference: 'https://unit.invalid',
            checkedAt: '2026-10-02T00:00:00Z',
          },
        },
      })
    )

    const msg: ChatMessage = {
      role: 'user',
      content: 'Analyze image',
      imageOrigin: 'channel_retained',
      contentParts: [
        { type: 'text', text: 'Analyze image' },
        {
          type: 'image',
          mimeType: 'image/jpeg',
          data: JPEG_2X2_BASE64,
          width: this.target === 'codex_oversized' ? 4032 : 2,
          height: this.target === 'codex_oversized' ? 3024 : 2,
          filename: 'photo.jpg',
          visualValid: true,
          source: { kind: 'attachment', attachmentId: 'pbt-img', messageId: 'pbt-m' },
        },
      ],
    }

    // L4: channel_retained image demotes cleanly without throwing LlmError/VisualInputError!
    const out = await adapter.completeWithTools({ messages: [msg], tools: [] })
    expect(out.content).toBe('demoted-ok')
    const sent = sendSpy.mock.calls[0]![0]!
    expect(sent[0]!.contentParts).toBeUndefined()
    expect(sent[0]!.content).toContain('photo.jpg')
    await assertInvariants(m, r)
  }
  toString(): string {
    return `VisionFailoverDemotion(${this.target})`
  }
}

class QueuedUserATaskAfterRelinkCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  check(m: ReferenceModel): boolean {
    return m.pendingApproval !== null && m.pendingApproval.linkedUserId === 'user-a'
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    const queuedSentinel = `QUEUED_USERA_SECRET_${m.stepCount}`
    // Enqueue a User A task while User A's approval is suspended, then relink to User B + reconcile!
    const queuedHandler = new IncomingMessageHandler(
      {
        content: queuedSentinel,
        channelType: 'slack',
        channelId: CHANNEL_C1,
        sender: PROVIDER_USER,
        timestamp: new Date().toISOString(),
        messageId: `m-queued-${m.stepCount}`,
        hostRef: 'ns/host-pbt',
        admittedLinkedUserId: 'user-a',
        providerIdentity: pbtIdentity(CHANNEL_C1),
      },
      {
        messageQueue: r.queue,
        agent: r.agent,
        pendingTaskResults: r.pendingTaskResults,
        getModel: () => 'gpt-4o',
        sanitizeAttachments: a => a,
        sessionProcessor: r.sessionProcessor,
        taskLifecycle: r.lifecycle,
      }
    )
    const queuedPromise = queuedHandler.execute()

    m.liveLinkedUserId = 'user-b'
    r.liveLinkedUserRef.current = 'user-b'
    await r.agent.reconcileChannelIdentity({
      medium: 'slack',
      workspaceOrTargetKey: WORKSPACE_W1,
      providerUserId: PROVIDER_USER,
      channelScope: null,
      liveLinkedUserId: 'user-b',
    })
    m.pendingApproval = null
    m.lastDelivered = null

    const queuedRes = await queuedPromise
    expect(queuedRes.success).toBe(false)
    const leakedCount = (
      r.storeHandle.worker.db
        .prepare('SELECT count(*) AS cnt FROM messages WHERE content LIKE ?')
        .get(`%${queuedSentinel}%`) as { cnt: number }
    ).cnt
    expect(leakedCount).toBe(0)
    await assertInvariants(m, r)
  }
  toString(): string {
    return 'QueuedUserATaskAfterRelink'
  }
}

class ConcurrentApprovalRaceCmd implements fc.AsyncCommand<ReferenceModel, RealSystem> {
  constructor(readonly rival: 'double_click' | 'cancel' | 'reconcile_relink') {}
  check(m: ReferenceModel): boolean {
    return m.pendingApproval !== null
  }
  async run(m: ReferenceModel, r: RealSystem): Promise<void> {
    m.stepCount++
    const pa = m.pendingApproval!
    r.scheduleResolverAwait.current = true
    try {
      let decision1!: Awaited<ReturnType<AgentStateMachine['handleApproval']>>
      let decision2: Awaited<ReturnType<AgentStateMachine['handleApproval']>> | undefined

      const p1 = r.agent
        .handleApproval(PROVIDER_USER, pa.requestId, false, 'slack', CHANNEL_C1)
        .then(res => {
          decision1 = res
        })

      const p2 = r.scheduler.schedule(Promise.resolve()).then(async () => {
        if (this.rival === 'double_click') {
          decision2 = await r.agent.handleApproval(
            PROVIDER_USER,
            pa.requestId,
            false,
            'slack',
            CHANNEL_C1
          )
        } else if (this.rival === 'cancel') {
          r.lifecycle.transition(pa.taskId, 'cancelled', 'user_requested')
        } else {
          const nextUser = pa.linkedUserId === 'user-a' ? 'user-b' : 'user-a'
          m.liveLinkedUserId = nextUser
          r.liveLinkedUserRef.current = nextUser
          await r.agent.reconcileChannelIdentity({
            medium: 'slack',
            workspaceOrTargetKey: WORKSPACE_W1,
            providerUserId: PROVIDER_USER,
            channelScope: null,
            liveLinkedUserId: nextUser,
          })
          m.lastDelivered = null
        }
      })

      await r.scheduler.waitAll()
      await Promise.all([p1, p2])

      if (this.rival === 'double_click' && decision2) {
        // At most one of two concurrent clicks can succeed; the other returns 409 or already consumed.
        expect(decision1.success && decision2.success).toBe(false)
      }
      if (this.rival === 'cancel' || this.rival === 'reconcile_relink') {
        // No stale approval may remain pending after race settles.
        await vi.waitFor(() => {
          expect(r.agent.getPendingApprovals()).toHaveLength(0)
        })
      }
      if (decision1.success) {
        await vi.waitFor(() => {
          const conv = r.agent.getConversationManager().getSessionByKey(SESSION_KEY_C1)
          expect(!conv || conv.state === ConversationState.Idle).toBe(true)
        })
      }
      m.pendingApproval = null
    } finally {
      r.scheduleResolverAwait.current = false
    }
    await assertInvariants(m, r)
  }
  toString(): string {
    return `ConcurrentApprovalRace(${this.rival})`
  }
}

describe('Stateful fast-check PBT — Channel attachments, identity isolation, approval resume & TTL (SF1-SF10, L1-L3)', () => {
  const origEnableApproval = config.enableApproval

  beforeEach(() => {
    config.enableApproval = true
  })

  afterEach(() => {
    config.enableApproval = origEnableApproval
  })

  it(
    'preserves SF1-SF10 and L1-L3 across arbitrary concurrent command schedules on real SQLite & ChannelAttachmentStore',
    { timeout: 30_000 },
    async () => {
      const commandArb = fc.commands(
        [
          fc
            .record({
              kind: fc.constantFrom<'text' | 'png' | 'motion_jpeg' | 'binary'>(
                'text',
                'png',
                'motion_jpeg',
                'binary'
              ),
              filename: fc.constantFrom<string | null>(
                null,
                'report.txt',
                'Q1/2026\x00bad.pdf',
                '..',
                'photo.png'
              ),
              ttlSeconds: fc.constantFrom(60, 3600),
            })
            .map(x => new IngestAndAttachmentOnlyCmd(x.kind, x.filename, x.ttlSeconds)),
          fc.boolean().map(suspend => new FollowUpTextTurnCmd(suspend)),
          fc.constant(new DuplicateRedeliveryCmd()),
          fc
            .record({
              nextUser: fc.constantFrom<'user-a' | 'user-b' | null>('user-a', 'user-b', null),
              reconcile: fc.boolean(),
            })
            .map(x => new UnlinkRelinkOrRevokeCmd(x.nextUser, x.reconcile)),
          fc.constant(new DeniedChannel403ReconcileCmd()),
          fc
            .constantFrom<'approve' | 'deny' | 'cancel'>('approve', 'deny', 'cancel')
            .map(action => new ResolvePendingApprovalCmd(action)),
          fc.constant(new ColdPodRestartCmd()),
          fc.constantFrom(30, 120, 7200).map(delta => new AdvanceClockAndSweepTtlCmd(delta)),
          fc
            .constantFrom<'non_vision' | 'codex_oversized'>('non_vision', 'codex_oversized')
            .map(target => new VisionFailoverDemotionCmd(target)),
          fc.constant(new QueuedUserATaskAfterRelinkCmd()),
          fc
            .constantFrom<
              'double_click' | 'cancel' | 'reconcile_relink'
            >('double_click', 'cancel', 'reconcile_relink')
            .map(rival => new ConcurrentApprovalRaceCmd(rival)),
        ],
        { maxCommands: 10 }
      )

      await fc.assert(
        fc.asyncProperty(fc.scheduler(), commandArb, async (scheduler, cmds) => {
          const real = await createRealSystem(scheduler)
          const model: ReferenceModel = {
            liveLinkedUserId: 'user-a',
            deniedC2: false,
            clockEpoch: Math.floor(Date.now() / 1000),
            attachments: new Map(),
            pendingApproval: null,
            lastDelivered: null,
            llmCallCount: 0,
            sentinelsByUser: new Map(),
            stepCount: 0,
          }
          try {
            await fc.asyncModelRun(() => ({ model, real }), cmds)
            await assertInvariants(model, real)
          } finally {
            await real.cleanup()
          }
        }),
        { numRuns: 30, seed: 20261640 }
      )
    }
  )
})
