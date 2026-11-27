import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { resourceNameProblem } from '@clerum/gfs-interaction-policy'
import { config } from '../config'
import { WorkflowBrokerRequestError } from '../core/tools/workflowBrokerClient'
import { runMigrations } from '../db/migrate'
import { createDispatcher, dispatch } from '../db/worker/dispatcher'
import type {
  InsertChannelAttachmentResult,
  RetainedChannelAttachmentRow,
} from '../db/worker/protocol'
import { ChannelAttachmentStore } from '../internalTools/channelAttachmentStore'
import type { RuntimeLifecycleGate } from '../lifecycle/statelessHeartbeat'
import { JPEG_2X2_BASE64, PNG_2X2_BASE64 } from '../llm/__tests__/codexImageFixtures'
import { RPCServer } from '../server'
import {
  ChannelAttachmentIngestTracker,
  createChannelAttachmentIngestHandler,
  parseChannelAttachmentMetaHeader,
} from '../server/channelAttachmentIngest'
import type { ChannelAttachmentIngestMetadataV1, ChannelAttachmentReceiptV1 } from '../server/types'
import { withRpcProxyEdgeTestAuthentication } from './rpcProxyEdgeTestHeaders'

function encodeMeta(meta: ChannelAttachmentIngestMetadataV1): string {
  return Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url')
}

function makeMeta(
  overrides: Partial<ChannelAttachmentIngestMetadataV1> = {}
): ChannelAttachmentIngestMetadataV1 {
  return {
    channelType: 'telegram',
    channelId: 'chat-101',
    sender: 'tg-user-1',
    messageId: `msg-${randomUUID().slice(0, 8)}`,
    providerIdentity: {
      medium: 'telegram',
      providerUserId: 'tg-user-1',
      providerChannelId: 'chat-101',
      providerEventId: `evt-${randomUUID().slice(0, 8)}`,
    },
    providerAttachmentId: `file-${randomUUID().slice(0, 8)}`,
    filename: 'report.pdf',
    declaredMediaType: 'application/pdf',
    ...overrides,
  }
}

function channelReaderHeaders(
  meta: ChannelAttachmentIngestMetadataV1,
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    'content-type': 'application/octet-stream',
    'x-clerum-edge-caller': 'channel-reader',
    'x-clerum-edge-host-ref': config.hostName,
    'x-clerum-edge-channel-type': meta.channelType,
    'x-clerum-edge-channel-id': meta.channelId,
    'x-clerum-edge-sender': meta.sender,
    'x-clerum-attachment-meta': encodeMeta(meta),
    ...overrides,
  }
}

describe('X4 — POST /v1/runtime/channel-attachments/ingest & handleMessageRoute guard', () => {
  let tmpDir: string
  let db: Database.Database
  let server: RPCServer
  let baseUrl: string
  let store: ChannelAttachmentStore
  let tracker: ChannelAttachmentIngestTracker
  let fenced: boolean
  let fencedCount: number
  let activityCount: number
  let resolveCaller: ReturnType<typeof vi.fn<() => Promise<{ targetUserId?: string } | null>>>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-ch-att-ingest-'))
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const deps = createDispatcher(db)

    store = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      maxFileBytes: 20_971_520,
      statfsFn: async () => ({
        bsize: 4096n,
        blocks: (100n * 1024n * 1024n * 1024n) / 4096n,
        bavail: (50n * 1024n * 1024n * 1024n) / 4096n,
      }),
    })
    tracker = new ChannelAttachmentIngestTracker()
    fenced = false
    fencedCount = 0
    activityCount = 0
    resolveCaller = vi.fn<() => Promise<{ targetUserId?: string } | null>>(async () => ({
      targetUserId: 'linked-user-1',
    }))

    const lifecycleGate: RuntimeLifecycleGate = {
      isIntakeFenced: () => fenced,
      noteFencedIntake: () => {
        fencedCount += 1
      },
      noteIntakeActivity: () => {
        activityCount += 1
      },
    }

    const ingestHandler = createChannelAttachmentIngestHandler({
      store,
      insertAttachment: row =>
        dispatch(
          { kind: 'insert_channel_attachment', payload: row },
          deps
        ) as Promise<InsertChannelAttachmentResult>,
      resolveCallerContext: resolveCaller,
      lifecycleGate,
      tracker,
      sessionStoreMode: 'sqlite',
      maxBytes: 20_971_520,
    })

    server = new RPCServer(0)
    server.setLifecycleGate(lifecycleGate)
    server.onChannelAttachmentIngest(ingestHandler)
    server.onMessage(async msg => ({
      success: true,
      status: 'completed',
      response: `ok:${msg.channelAttachmentIds?.length ?? 0}`,
    }))
    await server.start()
    const rawServer = (server as unknown as { server: http.Server }).server
    const address = rawServer.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await server.stop()
    db.close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('S21: fences ingest with 503 host_draining, calls noteFencedIntake, and succeeds once fence lifts', async () => {
    fenced = true
    const meta = makeMeta()
    const res1 = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta),
      body: Buffer.from('%PDF-1.4 fenced test'),
    })
    expect(res1.status).toBe(503)
    const body1 = (await res1.json()) as ChannelAttachmentReceiptV1
    expect(body1).toMatchObject({
      ok: false,
      error: { code: 'host_draining', retryable: true },
    })
    expect(fencedCount).toBe(1)
    expect(
      (db.prepare('SELECT count(*) AS cnt FROM conversation_attachments').get() as { cnt: number })
        .cnt
    ).toBe(0)

    // Liveness witness: lift fence and retry -> 200 OK.
    fenced = false
    const res2 = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta),
      body: Buffer.from('%PDF-1.4 fenced test'),
    })
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as ChannelAttachmentReceiptV1
    expect(body2.ok).toBe(true)
    expect(activityCount).toBe(1)
  })

  it('S22: rejects wrong caller, edge source mismatch, and >16 KiB metadata header with 403/400 and 0 writes', async () => {
    const meta = makeMeta()

    // Wrong edge caller (rpc-proxy) -> blocked by runtimeEdgeGuard(['channel-reader']) (401/403).
    const wrongCaller = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta, { 'x-clerum-edge-caller': 'rpc-proxy' }),
      body: Buffer.from('hello'),
    })
    expect([401, 403]).toContain(wrongCaller.status)

    // Mismatched x-clerum-edge-sender.
    const mismatchSender = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta, { 'x-clerum-edge-sender': 'different-sender' }),
      body: Buffer.from('hello'),
    })
    expect(mismatchSender.status).toBe(403)

    // Oversized x-clerum-attachment-meta (> 16 KiB): rejected by Node HTTP parser (431)
    // and independently rejected by parseChannelAttachmentMetaHeader (400).
    const oversizedMeta = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta, { 'x-clerum-attachment-meta': 'a'.repeat(16_385) }),
      body: Buffer.from('hello'),
    })
    expect([400, 431]).toContain(oversizedMeta.status)
    expect(parseChannelAttachmentMetaHeader('a'.repeat(16_385))).toMatchObject({ ok: false })

    // Malformed x-clerum-attachment-meta over HTTP -> 400.
    const malformedMeta = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta, { 'x-clerum-attachment-meta': 'not-valid-json' }),
      body: Buffer.from('hello'),
    })
    expect(malformedMeta.status).toBe(400)

    expect(
      (db.prepare('SELECT count(*) AS cnt FROM conversation_attachments').get() as { cnt: number })
        .cnt
    ).toBe(0)

    // Liveness witness: valid channel-reader request succeeds 200.
    const valid = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta),
      body: Buffer.from('hello valid'),
    })
    expect(valid.status).toBe(200)
  })

  it('S23: fails closed when linked user is unresolved (403) or broker is down (503 retryable) with 0 PVC/SQLite writes', async () => {
    const meta = makeMeta()

    resolveCaller.mockResolvedValueOnce(null)
    const unresolved = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta),
      body: Buffer.from('secret'),
    })
    expect(unresolved.status).toBe(403)

    resolveCaller.mockRejectedValueOnce(
      new WorkflowBrokerRequestError(404, 'medium_account_not_found', 'not linked')
    )
    const broker404 = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta),
      body: Buffer.from('secret'),
    })
    expect(broker404.status).toBe(403)

    resolveCaller.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const broker503 = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta),
      body: Buffer.from('secret'),
    })
    expect(broker503.status).toBe(503)
    const body503 = (await broker503.json()) as ChannelAttachmentReceiptV1
    expect(body503).toMatchObject({ ok: false, error: { retryable: true } })

    expect(
      (db.prepare('SELECT count(*) AS cnt FROM conversation_attachments').get() as { cnt: number })
        .cnt
    ).toBe(0)

    // Liveness witness: resolved caller returns 200.
    resolveCaller.mockResolvedValueOnce({ targetUserId: 'linked-user-1' })
    const okRes = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta),
      body: Buffer.from('secret'),
    })
    expect(okRes.status).toBe(200)
  })

  it('S28 & S49 & S58: classifies spoofed MIME by real bytes, normalizes null/unsafe/300-char filenames, and flags Motion-Photo JPEG visualValid=false without rejecting ingest', async () => {
    // S28: %PDF- bytes named notes.txt (text/plain) -> class: pdf, reader: pdf, mismatch: true.
    const spoofedPdfMeta = makeMeta({ filename: 'notes.txt', declaredMediaType: 'text/plain' })
    const pdfRes = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(spoofedPdfMeta),
      body: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    })
    expect(pdfRes.status).toBe(200)
    const pdfReceipt = (await pdfRes.json()) as Extract<ChannelAttachmentReceiptV1, { ok: true }>
    expect(pdfReceipt.fileReference.class).toBe('pdf')
    expect(pdfReceipt.fileReference.reader).toBe('pdf')
    expect(pdfReceipt.fileReference.mismatch).toBe(true)

    // S28: random binary bytes named pic.png -> binary_unsupported, reader: none.
    const fakePngMeta = makeMeta({ filename: 'pic.png', declaredMediaType: 'image/png' })
    const fakePngRes = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(fakePngMeta),
      body: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xde, 0xad, 0xbe, 0xef]),
    })
    expect(fakePngRes.status).toBe(200)
    const fakePngReceipt = (await fakePngRes.json()) as Extract<
      ChannelAttachmentReceiptV1,
      { ok: true }
    >
    expect(fakePngReceipt.fileReference.class).toBe('binary_unsupported')
    expect(fakePngReceipt.fileReference.reader).toBe('none')

    // S49: null filename (JPEG photo), path/control chars, "..", and 300-char filename.
    const validJpeg = Buffer.from(JPEG_2X2_BASE64, 'base64')
    const nullNameRes = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(makeMeta({ filename: null, declaredMediaType: 'image/jpeg' })),
      body: validJpeg,
    })
    expect(nullNameRes.status).toBe(200)
    const nullReceipt = (await nullNameRes.json()) as Extract<
      ChannelAttachmentReceiptV1,
      { ok: true }
    >
    expect(nullReceipt.fileReference.name).toMatch(/^attachment-[a-zA-Z0-9_-]+\.jpg$/)
    expect(resourceNameProblem(nullReceipt.fileReference.name)).toBeNull()
    expect(nullReceipt.visualValid).toBe(true)
    expect(nullReceipt.width).toBe(2)
    expect(nullReceipt.height).toBe(2)

    const unsafeNameRes = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(
        makeMeta({ filename: 'Q1/2026\x00report.pdf', declaredMediaType: 'application/pdf' })
      ),
      body: Buffer.from('%PDF-1.4\n%%EOF'),
    })
    expect(unsafeNameRes.status).toBe(200)
    const unsafeReceipt = (await unsafeNameRes.json()) as Extract<
      ChannelAttachmentReceiptV1,
      { ok: true }
    >
    expect(unsafeReceipt.fileReference.name).toBe('Q1_2026report.pdf')
    expect(resourceNameProblem(unsafeReceipt.fileReference.name)).toBeNull()

    const longNameRes = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(
        makeMeta({ filename: `${'x'.repeat(300)}.pdf`, declaredMediaType: 'application/pdf' })
      ),
      body: Buffer.from('%PDF-1.4\n%%EOF'),
    })
    expect(longNameRes.status).toBe(200)
    const longReceipt = (await longNameRes.json()) as Extract<
      ChannelAttachmentReceiptV1,
      { ok: true }
    >
    expect(longReceipt.fileReference.name.endsWith('.pdf')).toBe(true)
    expect([...longReceipt.fileReference.name].length).toBeLessThanOrEqual(255)
    expect(resourceNameProblem(longReceipt.fileReference.name)).toBeNull()

    // S58: Motion-Photo JPEG ingests 200 with visualValid: false (row.visual_valid === 0).
    const motionPhoto = Buffer.concat([validJpeg, Buffer.from('motion-photo-mp4-tail')])
    const motionRes = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(
        makeMeta({ filename: 'photo.jpg', declaredMediaType: 'image/jpeg' })
      ),
      body: motionPhoto,
    })
    expect(motionRes.status).toBe(200)
    const motionReceipt = (await motionRes.json()) as Extract<
      ChannelAttachmentReceiptV1,
      { ok: true }
    >
    expect(motionReceipt.visualValid).toBe(false)
    const dbRow = db
      .prepare('SELECT visual_valid FROM conversation_attachments WHERE attachment_id = ?')
      .get(motionReceipt.attachmentId) as { visual_valid: number }
    expect(dbRow.visual_valid).toBe(0)
  })

  it('S53: retains >11 MiB PDF when channelAttachmentMaxBytes is 20 MiB and sets documentReadOverLimit=true', async () => {
    const pdfPrefix = Buffer.from('%PDF-1.7\n')
    const bigPdf = Buffer.concat([pdfPrefix, Buffer.alloc(12 * 1024 * 1024, 0x20)])
    const meta = makeMeta({ filename: 'large-report.pdf', declaredMediaType: 'application/pdf' })
    const res = await fetch(`${baseUrl}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderHeaders(meta),
      body: bigPdf,
    })
    expect(res.status).toBe(200)
    const receipt = (await res.json()) as Extract<ChannelAttachmentReceiptV1, { ok: true }>
    expect(receipt.ok).toBe(true)
    expect(receipt.fileReference.class).toBe('pdf')
    expect(receipt.fileReference.reader).toBe('pdf')
    expect(receipt.documentReadOverLimit).toBe(true)
  })

  it('S60: pins ChannelAttachmentIngestTracker while slow ingest stream is in flight and awaits completion before drain', async () => {
    const deps = createDispatcher(db)
    const localTracker = new ChannelAttachmentIngestTracker()
    const handler = createChannelAttachmentIngestHandler({
      store,
      insertAttachment: row =>
        dispatch(
          { kind: 'insert_channel_attachment', payload: row },
          deps
        ) as Promise<InsertChannelAttachmentResult>,
      resolveCallerContext: async () => ({ targetUserId: 'linked-user-1' }),
      lifecycleGate: {
        isIntakeFenced: () => fenced,
        noteFencedIntake: () => {
          fencedCount += 1
        },
        noteIntakeActivity: () => {
          activityCount += 1
        },
      },
      tracker: localTracker,
      sessionStoreMode: 'sqlite',
    })

    const pngBytes = Buffer.from(PNG_2X2_BASE64, 'base64')
    let releaseChunk!: () => void
    const hold = new Promise<void>(resolve => {
      releaseChunk = resolve
    })
    const slowStream = Readable.from(
      (async function* () {
        yield pngBytes.subarray(0, 16)
        await hold
        yield pngBytes.subarray(16)
      })()
    )

    const meta = makeMeta({ filename: 'slow.png', declaredMediaType: 'image/png' })
    const ingestPromise = handler({
      metadata: meta,
      stream: slowStream,
      contentLength: pngBytes.length,
      caller: {
        caller: 'channel-reader',
        channelType: meta.channelType,
        channelId: meta.channelId,
        sender: meta.sender,
      },
    })

    // Synchronously active immediately after isIntakeFenced() === false!
    expect(localTracker.hasActive()).toBe(true)
    expect(localTracker.count).toBe(1)

    // HCC sends drain: true while slow ingest is in flight.
    fenced = true
    let drained = false
    const drainPromise = localTracker.waitForAll().then(() => {
      drained = true
    })

    // Second ingest after drain fence arrives -> 503 host_draining.
    const secondRes = await handler({
      metadata: makeMeta(),
      stream: Readable.from([Buffer.from('after-drain')]),
      caller: {
        caller: 'channel-reader',
        channelType: 'telegram',
        channelId: 'chat-101',
        sender: 'tg-user-1',
      },
    })
    expect(secondRes.status).toBe(503)
    expect(secondRes.body).toMatchObject({ ok: false, error: { code: 'host_draining' } })
    expect(drained).toBe(false)

    // Release slow stream -> commits cleanly and drain resolves with 0 partials.
    releaseChunk()
    const firstRes = await ingestPromise
    await drainPromise

    expect(firstRes.status).toBe(200)
    expect(firstRes.body.ok).toBe(true)
    expect(drained).toBe(true)
    expect(localTracker.hasActive()).toBe(false)
    const dirEntries = await fs.readdir(store.getStoreDir()!)
    expect(dirEntries.filter(f => f.endsWith('.partial'))).toHaveLength(0)
  })

  it('S31 & S33: handleMessageRoute rejects channelAttachmentIds on rpc (400), strips admittedLinkedUserId, and enforces <= 10 count on channel callers', async () => {
    const receivedMessages: unknown[] = []
    server.onMessage(async msg => {
      receivedMessages.push(msg)
      return { success: true, status: 'completed', response: 'ok' }
    })

    // S31: rpc caller sending channelAttachmentIds -> 400 Bad Request.
    const rpcReject = await fetch(`${baseUrl}/v1/runtime/messages`, {
      method: 'POST',
      headers: withRpcProxyEdgeTestAuthentication({
        'content-type': 'application/json',
        'x-clerum-edge-caller': 'rpc-proxy',
        'x-clerum-edge-host-ref': config.hostName,
        'x-clerum-edge-user-id': 'user-1',
      }),
      body: JSON.stringify({
        content: 'hello',
        channelType: 'rpc',
        channelId: 'agent-1',
        sender: 'user-1',
        timestamp: new Date().toISOString(),
        messageId: 'm-rpc-1',
        hostRef: 'ns/host',
        channelAttachmentIds: ['att-1'],
      }),
    })
    expect(rpcReject.status).toBe(400)
    expect(receivedMessages).toHaveLength(0)

    // S33: channel caller sending > 10 channelAttachmentIds -> 200 { success: false, error.code: 'FILE_REFERENCE_INVALID' }.
    const tooMany = await fetch(`${baseUrl}/v1/runtime/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-clerum-edge-caller': 'channel-reader',
        'x-clerum-edge-host-ref': config.hostName,
        'x-clerum-edge-channel-type': 'telegram',
        'x-clerum-edge-channel-id': 'chat-101',
        'x-clerum-edge-sender': 'tg-user-1',
      },
      body: JSON.stringify({
        content: 'analyze all',
        channelType: 'telegram',
        channelId: 'chat-101',
        sender: 'tg-user-1',
        timestamp: new Date().toISOString(),
        messageId: 'm-ch-too-many',
        hostRef: 'ns/host',
        channelAttachmentIds: Array.from({ length: 11 }, (_, i) => `att-${i}`),
      }),
    })
    expect(tooMany.status).toBe(200)
    expect(await tooMany.json()).toMatchObject({
      success: false,
      error: { code: 'FILE_REFERENCE_INVALID' },
    })

    // Liveness witness: valid channel request strips client-supplied admittedLinkedUserId and delivers 3 IDs.
    const validChannel = await fetch(`${baseUrl}/v1/runtime/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-clerum-edge-caller': 'channel-reader',
        'x-clerum-edge-host-ref': config.hostName,
        'x-clerum-edge-channel-type': 'telegram',
        'x-clerum-edge-channel-id': 'chat-101',
        'x-clerum-edge-sender': 'tg-user-1',
      },
      body: JSON.stringify({
        content: 'analyze 3 files',
        channelType: 'telegram',
        channelId: 'chat-101',
        sender: 'tg-user-1',
        timestamp: new Date().toISOString(),
        messageId: 'm-ch-ok',
        hostRef: 'ns/host',
        admittedLinkedUserId: 'spoofed-user',
        channelAttachmentIds: ['att-1', 'att-2', 'att-3'],
      }),
    })
    expect(validChannel.status).toBe(200)
    expect(receivedMessages).toHaveLength(1)
    expect(
      (receivedMessages[0] as { admittedLinkedUserId?: string }).admittedLinkedUserId
    ).toBeUndefined()
    expect(
      (receivedMessages[0] as { channelAttachmentIds?: string[] }).channelAttachmentIds
    ).toEqual(['att-1', 'att-2', 'att-3'])
  })
})
