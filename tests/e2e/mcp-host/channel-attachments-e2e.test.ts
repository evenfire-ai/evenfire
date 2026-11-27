/**
 * Live-cluster Minikube E2E — Universal Inbound Channel File Handling (#1640).
 *
 * Follows /e2e-test-guardian: exercises the real deployed Minikube control-plane
 * and mcp-host runtime without mocking core behavior or bypassing auth/DB paths.
 *
 * Preconditions (explicitly named setup & cleaned up in afterAll):
 *   - Running branch-owned Minikube profile with port-forwarded mcp-host
 *     (`MCP_HOST_URL`) and kubectl context (`KUBE_CONTEXT` / `MINIKUBE_PROFILE`).
 *   - Temporary `CommunicationChannel` CRD in namespace `channels` and temporary
 *     verified `workflow_approval_medium_accounts` row in `control-postgres`
 *     linking a synthetic Telegram user to the real seeded user in `users`.
 *
 * Journeys verified (with real pod PVC + SQLite business signals):
 *   1. Negative route/auth guards: unauthenticated, wrong edge caller, and
 *      unlinked Telegram user fail closed with zero SQLite rows written.
 *   2. Streaming inbound attachment ingest: UTF-8 text file, valid in-memory
 *      2x2 PNG (`visualValid: true`), spoofed PNG (`visualValid: false`), and
 *      idempotent duplicate upload (`deduplicated: true`) — verified both via
 *      HTTP receipts AND directly inside `mcp-host/chatllm` (`/workspace/.clerum-state/channel-attachments/`
 *      mode `0600` + SHA-256 + SQLite `conversation_attachments` rows).
 *   3. Negative metadata/sender guards: malformed header and sender mismatch
 *      fail closed with zero extra rows persisted.
 *   4. Deterministic attachment-only ingest-error turn (`POST /v1/runtime/messages`):
 *      completes deterministically without external LLM calls, surfaces the
 *      exact filename error, and records the session bound to `linked_user_id`.
 *   5. Live mid-session unlink isolation: disabling the medium link in
 *      `control-postgres` immediately causes subsequent ingest for the same
 *      Telegram user to fail closed with zero new SQLite rows written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { DEFAULT_HOST_REF, KUBE_CONTEXT, MCP_HOST_NAMESPACE, MCP_HOST_URL } from '../helpers.js'

const require = createRequire(import.meta.url)
const { realPng } =
  require('../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs') as {
    realPng: (width: number, height: number, seed?: number) => Buffer
  }

const CHANNELS_NAMESPACE = 'channels'
const CONTROL_PLANE_NAMESPACE = 'control-plane'
const RUN_ID = `e2e1640-${Date.now().toString(36)}`
const CHANNEL_CRD_NAME = `e2e-attach-${RUN_ID}`
const CHANNEL_SECRET_NAME = `e2e-attach-secret-${RUN_ID}`
const TG_CHAT_ID = `chat-${RUN_ID}`
const TG_LINKED_USER = `tg-linked-${RUN_ID}`
const TG_UNLINKED_USER = `tg-unlinked-${RUN_ID}`

function kubectl(args: string[], input?: string): string {
  return execFileSync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function psql(sql: string): string {
  return kubectl([
    '-n',
    CONTROL_PLANE_NAMESPACE,
    'exec',
    'deploy/control-postgres',
    '--',
    'psql',
    '-U',
    'postgres',
    '-d',
    'profiles',
    '-Atqc',
    sql,
  ])
}

function execInHostNode(script: string, args: string[] = []): string {
  return kubectl([
    '-n',
    MCP_HOST_NAMESPACE,
    'exec',
    `deploy/${DEFAULT_HOST_REF}`,
    '--',
    'node',
    '-e',
    script,
    ...args,
  ])
}

function encodeMeta(meta: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url')
}

function buildProviderIdentity(providerUserId: string, providerEventId: string) {
  return {
    medium: 'telegram' as const,
    providerUserId,
    providerChannelId: TG_CHAT_ID,
    providerChannelType: 'private',
    providerEventId,
    providerTarget: {
      hostRef: DEFAULT_HOST_REF,
      communicationChannelNamespace: CHANNELS_NAMESPACE,
      communicationChannelName: CHANNEL_CRD_NAME,
    },
  }
}

function channelReaderIngestHeaders(opts: {
  sender: string
  meta: Record<string, unknown>
  caller?: string
  contentType?: string
}): Record<string, string> {
  return {
    'content-type': opts.contentType ?? 'application/octet-stream',
    'x-clerum-edge-caller': opts.caller ?? 'channel-reader',
    'x-clerum-edge-host-ref': DEFAULT_HOST_REF,
    'x-clerum-edge-request-id': `req-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`,
    'x-clerum-edge-channel-type': 'telegram',
    'x-clerum-edge-channel-id': TG_CHAT_ID,
    'x-clerum-edge-sender': opts.sender,
    'x-clerum-attachment-meta': encodeMeta(opts.meta),
  }
}

function queryHostAttachments(sessionPrefix: string): Array<{
  attachment_id: string
  session_key: string
  linked_user_id: string
  provider_attachment_id: string
  byte_length: number
  sha256: string
  visual_valid: number
  storage_rel_path: string
}> {
  const out = execInHostNode(
    `
    const Database = require('better-sqlite3');
    const db = new Database('/workspace/state.db', { readonly: true });
    const rows = db.prepare(
      'SELECT attachment_id, session_key, linked_user_id, provider_attachment_id, byte_length, sha256, visual_valid, storage_rel_path FROM conversation_attachments WHERE session_key LIKE ? ORDER BY created_at ASC'
    ).all(process.argv[1]);
    console.log(JSON.stringify(rows));
    `,
    [`%${sessionPrefix}%`]
  )
  return JSON.parse(out)
}

function inspectHostAttachmentFile(relPath: string): {
  exists: boolean
  modeOctal: string | null
  byteLength: number | null
  sha256: string | null
} {
  const out = execInHostNode(
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const full = path.join('/workspace/.clerum-state/channel-attachments', process.argv[1]);
    if (!fs.existsSync(full)) {
      console.log(JSON.stringify({ exists: false, modeOctal: null, byteLength: null, sha256: null }));
      process.exit(0);
    }
    const stat = fs.statSync(full);
    const bytes = fs.readFileSync(full);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    console.log(JSON.stringify({
      exists: true,
      modeOctal: (stat.mode & 0o777).toString(8).padStart(4, '0'),
      byteLength: stat.size,
      sha256,
    }));
    `,
    [relPath]
  )
  return JSON.parse(out)
}

describe('Live-Cluster Minikube E2E: Inbound Channel File Handling (#1640)', () => {
  let seededUserId = ''
  const createdAttachmentIds: string[] = []
  const createdRelPaths: string[] = []

  beforeAll(async () => {
    // 1. Fail-loud health preflight against deployed mcp-host
    const healthRes = await fetch(`${MCP_HOST_URL}/v1/runtime/health`, {
      signal: AbortSignal.timeout(10_000),
    })
    expect(healthRes.status, `mcp-host health must be 200 at ${MCP_HOST_URL}`).toBe(200)

    // 2. Discover real seeded user authorized for DEFAULT_HOST_REF in control-postgres
    seededUserId = psql(
      `SELECT user_id FROM user_agents WHERE agent_name = '${DEFAULT_HOST_REF}' ORDER BY created_at ASC LIMIT 1;`
    )
    expect(
      seededUserId,
      `control-postgres must contain a user authorized for agent ${DEFAULT_HOST_REF}`
    ).toMatch(/^[0-9a-f-]{36}$/i)

    // 3. Create temporary Secret + CommunicationChannel CRD authorized for seededUserId + TG_LINKED_USER
    kubectl([
      '-n',
      CHANNELS_NAMESPACE,
      'create',
      'secret',
      'generic',
      CHANNEL_SECRET_NAME,
      '--from-literal=telegram-bot-token=e2e-test-token',
    ])
    const crdYaml = [
      'apiVersion: clerum.io/v1alpha1',
      'kind: CommunicationChannel',
      'metadata:',
      `  name: ${CHANNEL_CRD_NAME}`,
      `  namespace: ${CHANNELS_NAMESPACE}`,
      'spec:',
      `  hostRef: ${DEFAULT_HOST_REF}`,
      '  credentialsSecretRef:',
      `    name: ${CHANNEL_SECRET_NAME}`,
      '  access:',
      '    users:',
      `      - "${seededUserId}"`,
      '  telegramSettings:',
      '    botHandle: "e2e_attach_bot"',
      '  telegram:',
      `    - channelId: "${TG_CHAT_ID}"`,
      '      chatType: private',
      `      confirmedByUserId: "${seededUserId}"`,
      `      confirmedAt: "${new Date().toISOString()}"`,
      `      userIds: ["${TG_LINKED_USER}"]`,
    ].join('\n')
    kubectl(['apply', '-f', '-'], crdYaml)

    // 4. Link TG_LINKED_USER in control-postgres workflow_approval_medium_accounts
    const channelRef = `${CHANNELS_NAMESPACE}/${CHANNEL_CRD_NAME}`
    psql(
      `INSERT INTO workflow_approval_medium_accounts (user_id, medium, provider_user_id, provider_channel_id, communication_channel_ref, verified_at) VALUES ('${seededUserId}', 'telegram', '${TG_LINKED_USER}', '${TG_CHAT_ID}', '${channelRef}', NOW());`
    )
  }, 30_000)

  afterAll(() => {
    try {
      psql(
        `DELETE FROM workflow_approval_medium_accounts WHERE provider_user_id IN ('${TG_LINKED_USER}', '${TG_UNLINKED_USER}');`
      )
    } catch {
      // Best-effort cleanup
    }
    try {
      kubectl([
        '-n',
        CHANNELS_NAMESPACE,
        'delete',
        'communicationchannel',
        CHANNEL_CRD_NAME,
        '--ignore-not-found',
      ])
    } catch {
      // Best-effort cleanup
    }
    try {
      kubectl([
        '-n',
        CHANNELS_NAMESPACE,
        'delete',
        'secret',
        CHANNEL_SECRET_NAME,
        '--ignore-not-found',
      ])
    } catch {
      // Best-effort cleanup
    }
    if (createdAttachmentIds.length > 0 || createdRelPaths.length > 0) {
      try {
        execInHostNode(
          `
          const fs = require('node:fs');
          const path = require('node:path');
          const Database = require('better-sqlite3');
          const ids = JSON.parse(process.argv[1]);
          const rels = JSON.parse(process.argv[2]);
          const db = new Database('/workspace/state.db');
          for (const id of ids) {
            db.prepare('DELETE FROM conversation_attachments WHERE attachment_id = ?').run(id);
          }
          db.prepare('DELETE FROM sessions WHERE channel_id = ?').run(process.argv[3]);
          db.close();
          for (const rel of rels) {
            const full = path.join('/workspace/.clerum-state/channel-attachments', rel);
            if (fs.existsSync(full)) fs.rmSync(full, { force: true });
          }
          `,
          [JSON.stringify(createdAttachmentIds), JSON.stringify(createdRelPaths), TG_CHAT_ID]
        )
      } catch {
        // Best-effort cleanup
      }
    }
  }, 30_000)

  it('Journey 1 (negative guards): rejects unauthenticated, wrong-caller, and unlinked Telegram user with zero SQLite rows', async () => {
    const payload = Buffer.from('unauthorized-probe')

    const noAuthRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    })
    expect([401, 403]).toContain(noAuthRes.status)

    const wrongCallerRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderIngestHeaders({
        caller: 'rpc-proxy',
        sender: TG_LINKED_USER,
        meta: {
          channelType: 'telegram',
          channelId: TG_CHAT_ID,
          sender: TG_LINKED_USER,
          messageId: `msg-wrong-caller-${RUN_ID}`,
          providerAttachmentId: `att-wrong-caller-${RUN_ID}`,
          filename: 'nope.txt',
          declaredMediaType: 'text/plain',
          providerIdentity: buildProviderIdentity(TG_LINKED_USER, `ev-wc-${RUN_ID}`),
        },
      }),
      body: payload,
    })
    expect([401, 403]).toContain(wrongCallerRes.status)

    const unlinkedRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderIngestHeaders({
        sender: TG_UNLINKED_USER,
        meta: {
          channelType: 'telegram',
          channelId: TG_CHAT_ID,
          sender: TG_UNLINKED_USER,
          messageId: `msg-unlinked-${RUN_ID}`,
          providerAttachmentId: `att-unlinked-${RUN_ID}`,
          filename: 'unlinked.txt',
          declaredMediaType: 'text/plain',
          providerIdentity: buildProviderIdentity(TG_UNLINKED_USER, `ev-unlinked-${RUN_ID}`),
        },
      }),
      body: payload,
    })
    expect([403, 404]).toContain(unlinkedRes.status)

    // Business signal: zero rows persisted in live SQLite for this run's chat
    expect(queryHostAttachments(TG_CHAT_ID)).toHaveLength(0)
  })

  it('Journey 2 (happy path + demotion + dedup): streams text, valid PNG, and spoofed PNG into live PVC (0600) and SQLite conversation_attachments', async () => {
    const textBytes = Buffer.from(`Evenfire live-cluster E2E attachment ${RUN_ID}\n`, 'utf8')
    const textSha = createHash('sha256').update(textBytes).digest('hex')
    const pngBytes = Buffer.from(realPng(2, 2, 7))
    const pngSha = createHash('sha256').update(pngBytes).digest('hex')
    const spoofBytes = Buffer.from('not-a-real-png-container', 'utf8')
    const spoofSha = createHash('sha256').update(spoofBytes).digest('hex')

    // 2a. Valid UTF-8 text file
    const textMeta = {
      channelType: 'telegram',
      channelId: TG_CHAT_ID,
      sender: TG_LINKED_USER,
      messageId: `msg-text-${RUN_ID}`,
      providerAttachmentId: `att-text-${RUN_ID}`,
      filename: 'quarterly-notes.txt',
      declaredMediaType: 'text/plain',
      providerIdentity: buildProviderIdentity(TG_LINKED_USER, `ev-text-${RUN_ID}`),
    }
    const textRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderIngestHeaders({ sender: TG_LINKED_USER, meta: textMeta }),
      body: textBytes,
    })
    expect([200, 201]).toContain(textRes.status)
    const textReceipt = (await textRes.json()) as {
      ok: boolean
      attachmentId: string
      fileReference: { name: string; byteLength: number; class: string; reader: string }
      visualValid?: boolean
    }
    expect(textReceipt.ok).toBe(true)
    expect(textReceipt.attachmentId).toBeTruthy()
    expect(textReceipt.fileReference.name).toBe('quarterly-notes.txt')
    expect(textReceipt.fileReference.byteLength).toBe(textBytes.length)
    expect(textReceipt.fileReference.class).toBe('text')
    expect(textReceipt.fileReference.reader).toBe('text')
    createdAttachmentIds.push(textReceipt.attachmentId)

    // 2b. Idempotent duplicate re-upload returns identical attachmentId + deduplicated: true
    const dupRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderIngestHeaders({ sender: TG_LINKED_USER, meta: textMeta }),
      body: textBytes,
    })
    expect([200, 201]).toContain(dupRes.status)
    const dupReceipt = (await dupRes.json()) as {
      ok: boolean
      attachmentId: string
      deduplicated?: boolean
    }
    expect(dupReceipt.ok).toBe(true)
    expect(dupReceipt.attachmentId).toBe(textReceipt.attachmentId)
    expect(dupReceipt.deduplicated).toBe(true)

    // 2c. Valid in-memory 2x2 PNG -> visualValid: true, width: 2, height: 2
    const pngRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderIngestHeaders({
        sender: TG_LINKED_USER,
        meta: {
          channelType: 'telegram',
          channelId: TG_CHAT_ID,
          sender: TG_LINKED_USER,
          messageId: `msg-png-${RUN_ID}`,
          providerAttachmentId: `att-png-${RUN_ID}`,
          filename: 'diagram.png',
          declaredMediaType: 'image/png',
          providerIdentity: buildProviderIdentity(TG_LINKED_USER, `ev-png-${RUN_ID}`),
        },
      }),
      body: pngBytes,
    })
    expect([200, 201]).toContain(pngRes.status)
    const pngReceipt = (await pngRes.json()) as {
      ok: boolean
      attachmentId: string
      visualValid?: boolean
      width?: number
      height?: number
    }
    expect(pngReceipt.ok).toBe(true)
    expect(pngReceipt.visualValid).toBe(true)
    expect(pngReceipt.width).toBe(2)
    expect(pngReceipt.height).toBe(2)
    createdAttachmentIds.push(pngReceipt.attachmentId)

    // 2d. Spoofed PNG -> fail-closed demotion (visualValid: false or omitted as non-image)
    const spoofRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderIngestHeaders({
        sender: TG_LINKED_USER,
        meta: {
          channelType: 'telegram',
          channelId: TG_CHAT_ID,
          sender: TG_LINKED_USER,
          messageId: `msg-spoof-${RUN_ID}`,
          providerAttachmentId: `att-spoof-${RUN_ID}`,
          filename: 'spoof.png',
          declaredMediaType: 'image/png',
          providerIdentity: buildProviderIdentity(TG_LINKED_USER, `ev-spoof-${RUN_ID}`),
        },
      }),
      body: spoofBytes,
    })
    expect([200, 201]).toContain(spoofRes.status)
    const spoofReceipt = (await spoofRes.json()) as {
      ok: boolean
      attachmentId: string
      visualValid?: boolean
    }
    expect(spoofReceipt.ok).toBe(true)
    expect(spoofReceipt.visualValid).not.toBe(true)
    createdAttachmentIds.push(spoofReceipt.attachmentId)

    // 2e. Business signal verification directly inside live mcp-host/chatllm pod
    const rows = queryHostAttachments(TG_CHAT_ID)
    expect(rows).toHaveLength(3)

    const byId = new Map(rows.map(r => [r.attachment_id, r]))
    const textRow = byId.get(textReceipt.attachmentId)!
    const pngRow = byId.get(pngReceipt.attachmentId)!
    const spoofRow = byId.get(spoofReceipt.attachmentId)!

    expect(textRow.linked_user_id).toBe(seededUserId)
    expect(textRow.sha256).toBe(textSha)
    expect(textRow.byte_length).toBe(textBytes.length)

    expect(pngRow.linked_user_id).toBe(seededUserId)
    expect(pngRow.sha256).toBe(pngSha)
    expect(pngRow.visual_valid).toBe(1)

    expect(spoofRow.linked_user_id).toBe(seededUserId)
    expect(spoofRow.sha256).toBe(spoofSha)
    expect(spoofRow.visual_valid).toBe(0)

    for (const row of [textRow, pngRow, spoofRow]) {
      createdRelPaths.push(row.storage_rel_path)
      const disk = inspectHostAttachmentFile(row.storage_rel_path)
      expect(disk.exists).toBe(true)
      expect(disk.modeOctal).toBe('0600')
      expect(disk.byteLength).toBe(row.byte_length)
      expect(disk.sha256).toBe(row.sha256)
    }
  })

  it('Journey 3 (negative metadata/sender guards): rejects malformed meta and sender header mismatch with zero new rows', async () => {
    const beforeCount = queryHostAttachments(TG_CHAT_ID).length
    expect(beforeCount).toBe(3)

    const badMetaRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-clerum-edge-caller': 'channel-reader',
        'x-clerum-edge-host-ref': DEFAULT_HOST_REF,
        'x-clerum-edge-request-id': `req-badmeta-${RUN_ID}`,
        'x-clerum-edge-channel-type': 'telegram',
        'x-clerum-edge-channel-id': TG_CHAT_ID,
        'x-clerum-edge-sender': TG_LINKED_USER,
        'x-clerum-attachment-meta': '!!!not-base64url!!!',
      },
      body: Buffer.from('bad-meta'),
    })
    expect(badMetaRes.status).toBe(400)

    const mismatchRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderIngestHeaders({
        sender: 'different-edge-sender',
        meta: {
          channelType: 'telegram',
          channelId: TG_CHAT_ID,
          sender: TG_LINKED_USER,
          messageId: `msg-mismatch-${RUN_ID}`,
          providerAttachmentId: `att-mismatch-${RUN_ID}`,
          filename: 'mismatch.txt',
          declaredMediaType: 'text/plain',
          providerIdentity: buildProviderIdentity(TG_LINKED_USER, `ev-mismatch-${RUN_ID}`),
        },
      }),
      body: Buffer.from('mismatch'),
    })
    expect([400, 403]).toContain(mismatchRes.status)
    expect(queryHostAttachments(TG_CHAT_ID)).toHaveLength(beforeCount)
  })

  it('Journey 4 (deterministic attachment-only turn): POST /v1/runtime/messages completes without LLM and binds session linked_user_id', async () => {
    const res = await fetch(`${MCP_HOST_URL}/v1/runtime/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-clerum-edge-caller': 'channel-reader',
        'x-clerum-edge-host-ref': DEFAULT_HOST_REF,
        'x-clerum-edge-request-id': `req-turn-${RUN_ID}`,
        'x-clerum-edge-channel-type': 'telegram',
        'x-clerum-edge-channel-id': TG_CHAT_ID,
        'x-clerum-edge-sender': TG_LINKED_USER,
      },
      body: JSON.stringify({
        content: '',
        hostRef: DEFAULT_HOST_REF,
        channelType: 'telegram',
        channelId: TG_CHAT_ID,
        sender: TG_LINKED_USER,
        timestamp: new Date().toISOString(),
        messageId: `msg-attach-err-${RUN_ID}`,
        providerIdentity: buildProviderIdentity(TG_LINKED_USER, `ev-attach-err-${RUN_ID}`),
        attachmentIngestErrors: [
          {
            filename: 'oversize-e2e.pdf',
            code: 'file_too_large',
            message: 'File exceeds the 11 MiB limit',
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success?: boolean; response?: string }
    expect(body.success).toBe(true)
    expect(body.response).toContain('oversize-e2e.pdf')

    // Business signal: live SQLite session row bound to seededUserId
    const sessionRowJson = execInHostNode(
      `
      const Database = require('better-sqlite3');
      const db = new Database('/workspace/state.db', { readonly: true });
      const row = db.prepare('SELECT id, linked_user_id, state FROM sessions WHERE channel_id = ? ORDER BY started_at DESC LIMIT 1').get(process.argv[1]);
      console.log(JSON.stringify(row ?? null));
      `,
      [TG_CHAT_ID]
    )
    const sessionRow = JSON.parse(sessionRowJson) as {
      id: string
      linked_user_id: string
      state: string
    } | null
    expect(sessionRow).not.toBeNull()
    expect(sessionRow!.linked_user_id).toBe(seededUserId)
  })

  it('Journey 5 (live mid-session unlink isolation): disabling the medium account in Postgres immediately blocks subsequent ingest', async () => {
    const beforeCount = queryHostAttachments(TG_CHAT_ID).length
    expect(beforeCount).toBe(3)

    psql(
      `UPDATE workflow_approval_medium_accounts SET disabled_at = NOW() WHERE provider_user_id = '${TG_LINKED_USER}';`
    )

    const revokedRes = await fetch(`${MCP_HOST_URL}/v1/runtime/channel-attachments/ingest`, {
      method: 'POST',
      headers: channelReaderIngestHeaders({
        sender: TG_LINKED_USER,
        meta: {
          channelType: 'telegram',
          channelId: TG_CHAT_ID,
          sender: TG_LINKED_USER,
          messageId: `msg-revoked-${RUN_ID}`,
          providerAttachmentId: `att-revoked-${RUN_ID}`,
          filename: 'after-unlink.txt',
          declaredMediaType: 'text/plain',
          providerIdentity: buildProviderIdentity(TG_LINKED_USER, `ev-revoked-${RUN_ID}`),
        },
      }),
      body: Buffer.from('must-not-be-stored'),
    })

    expect([403, 404]).toContain(revokedRes.status)
    expect(queryHostAttachments(TG_CHAT_ID)).toHaveLength(beforeCount)
  })
})
