import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildAttachmentFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import { gfsStoreCallerIdentityForLinkedUser } from '../agent/gfsExecutionCapability'
import { AgentStateMachine } from '../agent/stateMachine'
import { config } from '../config'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../core/conversation/persistence/__tests__/testHelpers'
import { SqliteColdStartLoader } from '../core/conversation/persistence/sqliteColdStartLoader'
import { type ChatMessage, FinishReason } from '../core/types'
import type { RetainedChannelAttachmentRow } from '../db/worker/protocol'
import {
  createRetainedAttachmentByteLoader,
  hydrateActiveChannelAttachments,
  metadataAttachmentsFromHydrated,
} from '../internalTools/channelAttachmentHydration'
import {
  ChannelAttachmentStore,
  normalizeChannelFilename,
  validateStrictChannelImageContainer,
} from '../internalTools/channelAttachmentStore'
import { type GfscWriteClient, buildGfsAttachmentSaveTools } from '../internalTools/gfs'
import { GfscHttpError } from '../internalTools/gfsClient'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { PNG_2X2_BASE64 } from '../llm/__tests__/codexImageFixtures'
import { IncomingMessageHandler, type PendingTaskEntry } from '../messageHandler'
import { MessageQueue } from '../queue/messageQueue'
import { ResultStore } from '../resultStore'
import type { IncomingMessage, ProviderIdentity } from '../server/types'
import { SessionProcessor, resolveCanonicalSessionKey } from '../session'
import { channelAttachmentStoreDir, putTestBuffer } from './channelAttachmentTestHelpers'

const HEALTHY_STATFS = async () => ({
  bsize: 4096n,
  blocks: (100n * 1024n * 1024n * 1024n) / 4096n,
  bavail: (50n * 1024n * 1024n * 1024n) / 4096n,
})

function makeUnsignedGfsJwt(scopes: string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'host-test',
      scopes,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

interface RecordedGfscSave {
  drive: string
  parentResourceId: string
  name: string
  contentBase64: string
}

async function startMockGfscServer(opts?: {
  onSave?: (req: RecordedGfscSave) => { status: number; body: unknown }
}): Promise<{
  baseUrl: string
  saves: RecordedGfscSave[]
  close: () => Promise<void>
}> {
  const saves: RecordedGfscSave[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed: Record<string, unknown> = {}
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        parsed = {}
      }
      const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      const match = /^\/v1\/resources\/([^/]+)\/children$/.exec(parsedUrl.pathname)
      if (req.method === 'POST' && match) {
        const record: RecordedGfscSave = {
          drive: parsedUrl.searchParams.get('drive') ?? '',
          parentResourceId: decodeURIComponent(match[1]!),
          name: String(parsed.name ?? ''),
          contentBase64: String(parsed.contentBase64 ?? ''),
        }
        saves.push(record)
        const custom = opts?.onSave?.(record)
        if (custom) {
          res.statusCode = custom.status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(custom.body))
          return
        }
        res.statusCode = 201
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            resourceId: `res-${saves.length}`,
            drive: record.drive,
            name: record.name,
            version: 1,
            gfsUri: `gfs://${record.drive}/res-${saves.length}`,
          })
        )
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Expected TCP port')
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    saves,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

async function seedAttachment(params: {
  store: ChannelAttachmentStore
  storeHandle: StoreHandle
  bytes: Buffer
  filename: string
  declaredMediaType: string
  sender?: string
  channelId?: string
  linkedUserId?: string
  expiresAtEpoch?: number
}): Promise<{ attachmentId: string; storageRelPath: string; sessionKey: string }> {
  const sender = params.sender ?? 'tg-user-1'
  const channelId = params.channelId ?? 'chat-gfs'
  const linkedUserId = params.linkedUserId ?? 'linked-user-a'
  const sessionKey = resolveCanonicalSessionKey({
    sender,
    channelType: 'telegram',
    channelId,
  })
  const put = await putTestBuffer(params.store, { bytes: params.bytes, linkedUserId })
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
  return { attachmentId: put.attachmentId, storageRelPath: put.storageRelPath, sessionKey }
}

describe('S44 & E9 — Explicit EvenDrive save (clerum__gfs_save_attachment) for retained channel files & images', () => {
  let tmpDir: string
  let dbPath: string
  const origEnableApproval = config.enableApproval
  const origGfsToken = process.env.MCP_HOST_GFS_TOKEN
  const origGfscWriterUrl = process.env.MCP_HOST_GFSC_WRITER_BASE_URL
  const origGfscBaseUrl = process.env.MCP_HOST_GFSC_BASE_URL

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-ch-gfs-'))
    dbPath = path.join(tmpDir, 'state.db')
    config.enableApproval = false
  })

  afterEach(async () => {
    config.enableApproval = origEnableApproval
    if (origGfsToken === undefined) delete process.env.MCP_HOST_GFS_TOKEN
    else process.env.MCP_HOST_GFS_TOKEN = origGfsToken
    if (origGfscWriterUrl === undefined) delete process.env.MCP_HOST_GFSC_WRITER_BASE_URL
    else process.env.MCP_HOST_GFSC_WRITER_BASE_URL = origGfscWriterUrl
    if (origGfscBaseUrl === undefined) delete process.env.MCP_HOST_GFSC_BASE_URL
    else process.env.MCP_HOST_GFSC_BASE_URL = origGfscBaseUrl
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function buildRuntime(opts: {
    dbPath: string
    tmpDir: string
    llmResponder: (
      messages: ChatMessage[],
      idx: number
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
      maxFileBytes: 20_971_520,
      statfsFn: HEALTHY_STATFS,
    })
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    const pendingTaskResults = new ResultStore<PendingTaskEntry>(10 * 60 * 1000, e => e.storedAt)
    const agent = new AgentStateMachine(queue, lifecycle, {
      autoStart: false,
      channelCallerContextResolver: async msg =>
        msg.sender === 'tg-user-1'
          ? { targetUserId: 'linked-user-a', conversationId: msg.channelId }
          : null,
    })
    agent.setConversationStore(storeHandle.store)
    agent.setChannelAttachmentStore(attachmentStore)
    agent.setPendingTaskResults(pendingTaskResults)
    let callIdx = 0
    agent.setLLMProvider(
      {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools: vi.fn(async (messages: ChatMessage[]) => {
          const out = await opts.llmResponder(messages, callIdx++)
          return {
            content: out.content,
            tool_calls: out.tool_calls ?? null,
            usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 },
            finish_reason: out.finish_reason ?? FinishReason.Stop,
          }
        }),
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
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)
    const sessionProcessor = new SessionProcessor({
      maxConcurrent: 4,
      lifecycle,
      executor: task => agent.executeTask(task),
    })
    agent.setSessionProcessor(sessionProcessor)
    agent.setColdStartLoader(new SqliteColdStartLoader(storeHandle.store))

    const send = (content: string, extra?: Partial<IncomingMessage>) => {
      const identity: ProviderIdentity = {
        medium: 'telegram',
        providerUserId: 'tg-user-1',
        providerChannelId: 'chat-gfs',
        providerTarget: {
          hostRef: 'ns/host',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'tg',
        },
      }
      const handler = new IncomingMessageHandler(
        {
          content,
          channelType: 'telegram',
          channelId: 'chat-gfs',
          sender: 'tg-user-1',
          timestamp: new Date().toISOString(),
          messageId: `msg-${randomUUID().slice(0, 8)}`,
          hostRef: 'ns/host',
          admittedLinkedUserId: 'linked-user-a',
          providerIdentity: identity,
          ...extra,
        },
        {
          messageQueue: queue,
          agent,
          pendingTaskResults,
          getModel: () => 'gpt-4o',
          sanitizeAttachments: a => a,
          sessionProcessor,
          taskLifecycle: lifecycle,
        }
      )
      return handler.execute()
    }

    return {
      storeHandle,
      attachmentStore,
      agent,
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

  it('S44: attachment-only Turn 1 makes 0 createFileFromBytes calls; explicit save works on Turn 1, Turn N+1, and after cold-restart approval resume with exact base64 bytes', async () => {
    const gfsc = await startMockGfscServer()
    process.env.MCP_HOST_GFS_TOKEN = makeUnsignedGfsJwt(['gfs.read', 'gfs.write'])
    process.env.MCP_HOST_GFSC_WRITER_BASE_URL = gfsc.baseUrl
    process.env.MCP_HOST_GFSC_BASE_URL = gfsc.baseUrl

    const pdfBytes = Buffer.from('%PDF-1.4\nExact-EvenDrive-Save-PDF-Payload\n%%EOF\n')
    const pngBytes = Buffer.from(PNG_2X2_BASE64, 'base64')
    const turn1DocBytes = Buffer.from('Turn 1 immediate save payload')

    let pdfId = ''
    let pngId = ''
    let t1DocId = ''
    let approvalReqId = ''

    // Pod 1: Attachment-only Turn 1 (0 saves), Turn 2 explicit save of retained PDF, Turn 3 immediate save on Turn 1, Turn 4 suspend for approval to save PNG.
    const pod1 = buildRuntime({
      dbPath,
      tmpDir,
      llmResponder: async (_messages, idx) => {
        if (idx === 0) {
          // Turn 2: explicitly save retained PDF from Turn 1
          return {
            content: null,
            tool_calls: [
              {
                id: 'tc-save-pdf',
                name: 'clerum__gfs_save_attachment',
                arguments: {
                  drive: 'team-drive',
                  parentResourceId: 'folder-1',
                  attachmentId: pdfId,
                },
              },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        if (idx === 1) {
          return { content: 'Saved contract.pdf to EvenDrive' }
        }
        if (idx === 2) {
          // Turn 3: explicitly save file attached on the same turn
          return {
            content: null,
            tool_calls: [
              {
                id: 'tc-save-same-turn',
                name: 'clerum__gfs_save_attachment',
                arguments: {
                  drive: 'team-drive',
                  parentResourceId: 'folder-2',
                  attachmentId: t1DocId,
                },
              },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        if (idx === 3) {
          return { content: 'Saved immediate.txt to EvenDrive' }
        }
        // Turn 4 (with approval enabled): suspend on clerum__gfs_save_attachment for retained PNG
        return {
          content: null,
          tool_calls: [
            {
              id: 'tc-save-png-cold',
              name: 'clerum__gfs_save_attachment',
              arguments: { drive: 'team-drive', parentResourceId: 'folder-3', attachmentId: pngId },
            },
          ],
          finish_reason: FinishReason.ToolUse,
        }
      },
    })

    try {
      const seededPdf = await seedAttachment({
        store: pod1.attachmentStore,
        storeHandle: pod1.storeHandle,
        bytes: pdfBytes,
        filename: 'contract.pdf',
        declaredMediaType: 'application/pdf',
      })
      pdfId = seededPdf.attachmentId

      const seededPng = await seedAttachment({
        store: pod1.attachmentStore,
        storeHandle: pod1.storeHandle,
        bytes: pngBytes,
        filename: 'receipt.png',
        declaredMediaType: 'image/png',
      })
      pngId = seededPng.attachmentId

      // 1) Attachment-only Turn 1 -> 0 createFileFromBytes calls (liveness witness: confirmation reply names both files).
      const turn1 = await pod1.send('', { channelAttachmentIds: [pdfId, pngId] })
      expect(turn1.success).toBe(true)
      expect(turn1.response).toContain('contract.pdf')
      expect(turn1.response).toContain('receipt.png')
      expect(gfsc.saves).toHaveLength(0)

      // 2) Turn N+1 explicit save of retained PDF -> exact original bytes sent to gfsc!
      const turn2 = await pod1.send('Save contract.pdf to EvenDrive folder-1')
      expect(turn2.success).toBe(true)
      expect(turn2.response).toBe('Saved contract.pdf to EvenDrive')
      expect(gfsc.saves).toHaveLength(1)
      expect(gfsc.saves[0]).toEqual({
        drive: 'team-drive',
        parentResourceId: 'folder-1',
        name: 'contract.pdf',
        contentBase64: pdfBytes.toString('base64'),
      })

      // 3) Same-turn explicit save of newly attached file
      const seededT1Doc = await seedAttachment({
        store: pod1.attachmentStore,
        storeHandle: pod1.storeHandle,
        bytes: turn1DocBytes,
        filename: 'immediate.txt',
        declaredMediaType: 'text/plain',
      })
      t1DocId = seededT1Doc.attachmentId
      const turn3 = await pod1.send('Save immediate.txt right away', {
        channelAttachmentIds: [t1DocId],
      })
      expect(turn3.success).toBe(true)
      expect(gfsc.saves).toHaveLength(2)
      expect(gfsc.saves[1]!.contentBase64).toBe(turn1DocBytes.toString('base64'))

      // 4) Suspend on approval for saving retained PNG, then cold-restart pod!
      config.enableApproval = true
      pod1.agent.setApprovalConfig({
        defaultPolicy: 'allow_all',
        tools: { clerum__gfs_save_attachment: true },
      } as never)
      const turn4 = await pod1.send('Save receipt.png to folder-3')
      expect(turn4.success).toBe(true)
      expect(turn4.status).toBe('waiting_approval')
      approvalReqId = turn4.approval!.requestId
      expect(gfsc.saves).toHaveLength(2)
    } finally {
      await pod1.coldCrash()
    }

    // Pod 2: cold restart -> bootstrap() -> approve -> clerum__gfs_save_attachment loads SHA-256 verified PNG bytes and saves!
    const pod2 = buildRuntime({
      dbPath,
      tmpDir,
      llmResponder: async () => ({ content: 'Saved receipt.png after cold restart' }),
    })
    pod2.agent.setApprovalConfig({
      defaultPolicy: 'allow_all',
      tools: { clerum__gfs_save_attachment: true },
    } as never)
    try {
      await pod2.agent.bootstrap()
      const decision = await pod2.agent.handleApproval(
        'tg-user-1',
        approvalReqId,
        false,
        'telegram',
        'chat-gfs'
      )
      expect(decision.success).toBe(true)

      await vi.waitFor(() => {
        expect(gfsc.saves).toHaveLength(3)
      })
      expect(gfsc.saves[2]).toEqual({
        drive: 'team-drive',
        parentResourceId: 'folder-3',
        name: 'receipt.png',
        contentBase64: pngBytes.toString('base64'),
      })
    } finally {
      await pod2.shutdown()
      await gfsc.close()
    }
  })

  it('S44 & E9: fails closed with 0 createFileFromBytes on cross-user, expired, and corrupted-blob save attempts, and surfaces gfsc 413 limit_exceeded cleanly', async () => {
    const storeHandle = makeSqliteStore({ dbPath })
    const attachmentStore = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: HEALTHY_STATFS,
    })

    const createFileFromBytes = vi.fn(async (args: RecordedGfscSave) => ({
      resourceId: 'res-ok',
      name: args.name,
    }))
    const mockClient: GfscWriteClient = {
      accessible: vi.fn(),
      list: vi.fn(),
      read: vi.fn(),
      stat: vi.fn(),
      resolve: vi.fn(),
      write: vi.fn(),
      createFolder: vi.fn(),
      createFile: vi.fn(),
      createFileFromBytes,
      rename: vi.fn(),
      copy: vi.fn(),
    }

    try {
      const ownerBytes = Buffer.from('OWNER-GOOD-FILE-BYTES')
      const tamperedBytes = Buffer.from('TAMPERED-FILE-BYTES')
      const expiredBytes = Buffer.from('EXPIRED-FILE-BYTES')

      const good = await seedAttachment({
        store: attachmentStore,
        storeHandle,
        bytes: ownerBytes,
        filename: 'good.txt',
        declaredMediaType: 'text/plain',
        linkedUserId: 'linked-user-a',
      })
      const tampered = await seedAttachment({
        store: attachmentStore,
        storeHandle,
        bytes: tamperedBytes,
        filename: 'tampered.txt',
        declaredMediaType: 'text/plain',
        linkedUserId: 'linked-user-a',
      })
      const expired = await seedAttachment({
        store: attachmentStore,
        storeHandle,
        bytes: expiredBytes,
        filename: 'expired.txt',
        declaredMediaType: 'text/plain',
        linkedUserId: 'linked-user-a',
        expiresAtEpoch: Math.floor(Date.now() / 1000) - 600,
      })

      // Tamper 1 byte of tampered.txt on disk
      const tamperedPath = path.join(channelAttachmentStoreDir(tmpDir), tampered.storageRelPath)
      const modified = Buffer.from(tamperedBytes)
      modified[0] = modified[0]! ^ 0xff
      await fs.writeFile(tamperedPath, modified, { mode: 0o600 })

      const hydratedA = await hydrateActiveChannelAttachments({
        conversationStore: storeHandle.store,
        sessionKey: good.sessionKey,
        linkedUserId: 'linked-user-a',
      })
      const metadataA = metadataAttachmentsFromHydrated(hydratedA)

      // 1) Cross-user save attempt (User B's byte loader with User A's attachmentId) -> fails closed, 0 gfsc calls.
      const userBLoader = createRetainedAttachmentByteLoader({
        channelAttachmentStore: attachmentStore,
        conversationStore: storeHandle.store,
        sessionKey: good.sessionKey,
        linkedUserId: 'linked-user-b',
      })
      const [userBSaveTool] = buildGfsAttachmentSaveTools(mockClient, [], {
        attachments: metadataA,
        loadBytes: userBLoader,
      })
      const crossUserRes = await userBSaveTool!.execute(
        { drive: 'd1', parentResourceId: 'f1', attachmentId: good.attachmentId },
        ''
      )
      expect(crossUserRes.success).toBe(false)
      expect(crossUserRes.error).toContain('attachment_not_found')
      expect(createFileFromBytes).toHaveBeenCalledTimes(0)

      // 2) Expired attachment save attempt -> fails closed, 0 gfsc calls.
      const ownerLoader = createRetainedAttachmentByteLoader({
        channelAttachmentStore: attachmentStore,
        conversationStore: storeHandle.store,
        sessionKey: good.sessionKey,
        linkedUserId: 'linked-user-a',
      })
      const [ownerSaveTool] = buildGfsAttachmentSaveTools(mockClient, [], {
        attachments: [
          ...metadataA,
          {
            id: expired.attachmentId,
            kind: 'file',
            mimeType: 'text/plain',
            encoding: 'base64',
            dataBase64: undefined as unknown as string,
            filename: 'expired.txt',
          },
        ],
        loadBytes: ownerLoader,
      })
      const expiredRes = await ownerSaveTool!.execute(
        { drive: 'd1', parentResourceId: 'f1', attachmentId: expired.attachmentId },
        ''
      )
      expect(expiredRes.success).toBe(false)
      expect(expiredRes.error).toContain('attachment_not_found')
      expect(createFileFromBytes).toHaveBeenCalledTimes(0)

      // 3) Corrupted blob save attempt -> fails closed with attachment_integrity_failed, 0 gfsc calls.
      const corruptRes = await ownerSaveTool!.execute(
        { drive: 'd1', parentResourceId: 'f1', attachmentId: tampered.attachmentId },
        ''
      )
      expect(corruptRes.success).toBe(false)
      expect(corruptRes.error).toContain('attachment_integrity_failed')
      expect(createFileFromBytes).toHaveBeenCalledTimes(0)

      // Liveness witness: untampered owner file saves cleanly with exact base64 bytes!
      const okRes = await ownerSaveTool!.execute(
        { drive: 'd1', parentResourceId: 'f1', attachmentId: good.attachmentId },
        ''
      )
      expect(okRes.success).toBe(true)
      expect(createFileFromBytes).toHaveBeenCalledTimes(1)
      expect(createFileFromBytes.mock.calls[0]![0]).toMatchObject({
        drive: 'd1',
        parentResourceId: 'f1',
        name: 'good.txt',
        contentBase64: ownerBytes.toString('base64'),
      })

      // 4) Accepted operational limit (E9): gfsc 413 limit_exceeded surfaces cleanly via mutationFail without leaking raw body.
      createFileFromBytes.mockRejectedValueOnce(
        new GfscHttpError(413, 'internal-secret-path=/var/gfs/write-body-too-large')
      )
      const limitRes = await ownerSaveTool!.execute(
        { drive: 'd1', parentResourceId: 'f1', attachmentId: good.attachmentId },
        ''
      )
      expect(limitRes.success).toBe(false)
      expect(limitRes.error).toContain('limit_exceeded')
      expect(limitRes.error).not.toContain('/var/gfs/write-body-too-large')
    } finally {
      await storeHandle.shutdown()
    }
  })

  it('T-BR04: settleGfsRetentionOwner releases external-channel GFS pins using gfsStoreCallerIdentityForLinkedUser on completion and preserves pins while waiting_approval', async () => {
    config.enableApproval = true
    const releaseReceiptOwner = vi.fn(async () => undefined)
    const mockGfsStore = {
      isAvailable: () => true,
      releaseReceiptOwner,
    }

    let callCount = 0
    const runtime = buildRuntime({
      dbPath,
      tmpDir,
      llmResponder: async () => {
        callCount += 1
        if (callCount === 1) {
          return {
            content: null,
            tool_calls: [
              { id: 'tc-gfs-pin', name: 'shell_exec', arguments: { command: 'echo ok' } },
            ],
            finish_reason: FinishReason.ToolUse,
          }
        }
        return { content: 'Done with pin' }
      },
    })
    runtime.agent.setGfsDownloadStore(mockGfsStore as never)
    runtime.agent.setApprovalConfig({
      defaultPolicy: 'allow_all',
      tools: { shell_exec: true },
    } as never)

    try {
      const suspended = await runtime.send('Run gated task with GFS pin')
      expect(suspended.status).toBe('waiting_approval')
      // Pin MUST remain retained while waiting_approval (not aborted).
      expect(releaseReceiptOwner).toHaveBeenCalledTimes(0)

      const approved = await runtime.agent.handleApproval(
        'tg-user-1',
        suspended.approval!.requestId,
        false,
        'telegram',
        'chat-gfs'
      )
      expect(approved.success).toBe(true)

      await vi.waitFor(() => {
        expect(releaseReceiptOwner).toHaveBeenCalledTimes(1)
      })
      expect(releaseReceiptOwner).toHaveBeenCalledWith(
        suspended.approval!.taskId,
        gfsStoreCallerIdentityForLinkedUser('linked-user-a')
      )
    } finally {
      await runtime.shutdown()
    }
  })
})
