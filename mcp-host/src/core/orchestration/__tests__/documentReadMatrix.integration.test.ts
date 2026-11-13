/**
 * #656 / #1093 — provider matrix through the real Host tool loop.
 *
 * Codex and Grok are real subscription providers; their subscriptions are
 * replaced at the local HTTP proxy boundary. The upstream simulation sees the
 * provider request and decides which native reader to call, exactly as the
 * model would. It never executes a tool or fabricates a tool result.
 *
 * PR A expectation: PDF and XLSX take `clerum__document_read`; MD and TXT take
 * `clerum__attachment_read`. The random token exists only in the file body, so
 * the final provider answer proves the bytes reached the model by that branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Workbook } from 'exceljs'
import jwt from 'jsonwebtoken'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { type RequestListener, createServer } from 'node:http'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import { LlmPortAdapter } from '../../../core/adapters/llmPortAdapter'
import { makeFakeConversation } from '../../../core/conversation/__testing__/makeFakeConversation'
import { SimpleEventEmitter } from '../../../core/orchestration/eventEmitter'
import { buildLoopConfig } from '../../../core/orchestration/loopConfig'
import { runToolUseLoop } from '../../../core/orchestration/toolUseLoop'
import { buildTurnContextBlock } from '../../../core/orchestration/turnContext'
import { ATTACHED_FILES_INSTRUCTION } from '../../../core/orchestration/turnContext'
import { DefaultReasoningPort } from '../../../core/reasoning/port'
import { DefaultPromptBuilder } from '../../../core/reasoning/promptBuilder'
import { BasicSafety } from '../../../core/safety/safety'
import type { Attachment, ChatMessage } from '../../../core/types'
import type { SingleTurnProvider } from '../../../llm'
import { CodexLlmProxyClient } from '../../../llm/codexLlmProxyClient'
import { CodexSubscriptionProvider } from '../../../llm/codexSubscription'
import { GrokLlmProxyClient } from '../../../llm/grokLlmProxyClient'
import { GrokSubscriptionProvider } from '../../../llm/grokSubscription'
import { AttachmentReadLedger } from '../../attachments/attachmentReadBudget'
import { NativeToolRegistry } from '../../tools/nativeToolRegistry'

const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const privateKey = keyPair.privateKey
const publicKey = keyPair.publicKey

const bodyToken = () => `DOCUMENT_READ_CODE:${randomBytes(12).toString('hex')}`

async function pdfWithText(text: string): Promise<Buffer> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([540, 180])
  page.drawText(text, { x: 36, y: 120, size: 12, font })
  return Buffer.from(await document.save())
}

async function xlsxWithToken(token: string): Promise<Buffer> {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheet('Report')
  sheet.addRow(['token'])
  sheet.addRow([token])
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function markdownWithToken(token: string): Promise<Buffer> {
  return Buffer.from(`# Report\n\n${token}\n`, 'utf8')
}

async function textWithToken(token: string): Promise<Buffer> {
  return Buffer.from(`${token}\nsecond line\n`, 'utf8')
}

const FORMAT_MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/markdown',
  txt: 'text/plain',
} as const

type Format = keyof typeof FORMAT_MIME

async function attachmentFor(provider: string, format: Format, token: string): Promise<Attachment> {
  const bytes =
    format === 'pdf'
      ? await pdfWithText(token)
      : format === 'xlsx'
        ? await xlsxWithToken(token)
        : format === 'md'
          ? await markdownWithToken(token)
          : await textWithToken(token)
  const extension = format === 'md' ? 'md' : format
  const result = validateIncomingAttachments(
    [
      {
        id: `${provider}-${format}`,
        kind: 'file',
        mimeType: FORMAT_MIME[format],
        detectedMediaType: FORMAT_MIME[format],
        encoding: 'base64',
        dataBase64: bytes.toString('base64'),
        filename: `body-only.${extension}`,
        sizeBytes: bytes.length,
        digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
    { maxCount: 4, maxBytes: 2_000_000, maxFileBytes: 1_000_000, messageId: 'message-1' }
  )
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  const attachment = result.attachments![0]!
  expect(attachment.kind).toBe('file')
  return attachment
}

type ProxyApps = { runtimeApp: RequestListener; close(): Promise<void> }
type SimulatedStreamInput = {
  redeem: (input: unknown) => Promise<unknown>
  onFrame: (frame: unknown) => Promise<void> | void
  request: unknown
}
type SimulatedRequest = {
  messages?: Array<{ content?: unknown }>
}
type ProxyModule = {
  createProxyApps(
    config: Record<string, unknown>,
    deps: {
      controlApiClient: { redeem: () => Promise<void> }
      streamCompletion: (input: SimulatedStreamInput) => Promise<{ outcome: 'success' }>
    }
  ): ProxyApps
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function startLocalSubscription(provider: 'codex' | 'grok'): Promise<{
  provider: SingleTurnProvider
  providerCalls: Array<{ branch: string; stage: 'read' | 'answer' }>
}> {
  const base = `../../../../../${provider}-llm-proxy/src/`
  const proxyModule = await vi.importActual<ProxyModule>(`${base}server.ts`)
  const variant = provider === 'grok' ? 'grok' : 'codex'
  const model = provider === 'grok' ? 'grok-4.6' : 'gpt-5.3-codex'
  const platform = jwt.sign(
    {
      sub: 'default/document-matrix-host',
      hostRefs: ['document-matrix-host'],
      workflowControlScopes: [`llm:${variant}:execute`],
      scope: 'workflow:approval:request',
    },
    privateKey,
    { algorithm: 'RS256', issuer: 'control-api', audience: 'workflow-approvals', expiresIn: 300 }
  )
  const providerCalls: Array<{ branch: string; stage: 'read' | 'answer' }> = []
  const redeem = vi.fn(async () => undefined)
  const stream = vi.fn(async (input: SimulatedStreamInput) => {
    await input.redeem({
      executionTicket: 'accepted-by-the-control-api-double',
      requestHash: 'accepted-by-the-control-api-double',
    })
    const request = (input.request ?? {}) as SimulatedRequest
    const messageText = (content: unknown): string => {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .map(part =>
          part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''
        )
        .join('\n')
    }
    const providerView = (request.messages ?? []).map(message => messageText(message.content))
    const wire = providerView.join('\n')
    const attachmentId = /attached_file: id="([^"\n]+)"/.exec(wire)?.[1]
    if (!attachmentId) throw new Error('the provider request omitted the attached_file id')

    if (wire.includes(bodyTokenPrefix())) {
      providerCalls.push({ branch: 'answer', stage: 'answer' })
      const token = wire.match(new RegExp(`${bodyTokenPrefix()}[a-f0-9]{24}`))?.[0]
      if (!token) throw new Error('the provider request lost the body token')
      const tokenDigest = createHash('sha256').update(token, 'utf8').digest('hex')
      await input.onFrame({ type: 'text', text: tokenDigest })
      return { outcome: 'success' as const }
    }

    const reader = /attached_file:[^\n]*reader=(\w+)/.exec(wire)?.[1]
    const branch =
      reader === 'pdf' || reader === 'xlsx'
        ? 'clerum__document_read'
        : reader === 'text' || reader === 'none'
          ? 'clerum__attachment_read'
          : null
    if (!branch) throw new Error('the provider request omitted a supported reader')
    providerCalls.push({ branch, stage: 'read' })
    await input.onFrame({
      type: 'tool_call',
      id: `call-${provider}-${providerCalls.length}`,
      name: branch,
      arguments: { attachmentId },
    })
    return { outcome: 'success' as const }
  })

  const apps = proxyModule.createProxyApps(
    {
      runtimePort: 0,
      adminPort: 0,
      probePort: 0,
      maxBodyBytes: 4_000_000,
      maxVisualBodyBytes: 8_000_000,
      maxStreamDurationMs: 10_000,
      maxDeadlineMs: 10_000,
      upstreamIdleTimeoutMs: 10_000,
      heartbeatIntervalMs: 15_000,
      jwtIssuer: 'control-api',
      jwtPublicKey: publicKey,
      executionEnabled: true,
      controlApiBaseUrl: '',
      controlApiServiceName: `${variant}-llm-proxy`,
      controlApiServiceToken: '',
    },
    {
      controlApiClient: { redeem },
      streamCompletion: stream as never,
    }
  )
  const listener = createServer(apps.runtimeApp).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('the local proxy has no port')
  cleanup.push(async () => {
    listener.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      listener.close(error => (error ? reject(error) : resolve()))
    )
    await apps.close()
  })

  const url = `http://127.0.0.1:${address.port}/internal/runtime/v1/${variant}/completions`
  const clientOptions = { runtimeUrl: url, readPlatformJwt: () => platform }
  const client =
    provider === 'grok'
      ? new GrokLlmProxyClient(clientOptions)
      : new CodexLlmProxyClient(clientOptions)
  const authorize = vi.fn(async (input: { requestHash: string }) => {
    const providerAttemptId = randomUUIDValue()
    const executionTicket = jwt.sign(
      {
        jti: providerAttemptId,
        typ: `${variant}-execution-ticket`,
        hostRef: 'document-matrix-host',
        model,
        requestHash: input.requestHash,
        providerAttemptId,
      },
      privateKey,
      {
        algorithm: 'RS256',
        issuer: 'control-api',
        audience: `${variant}-llm-proxy`,
        expiresIn: 300,
      }
    )
    return {
      providerAttemptId,
      requestHash: input.requestHash,
      executionTicket,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }
  })
  const subscriptionDeps = {
    authorizer: { authorize },
    proxy: client,
    attemptContext: () => ({
      policyRevision: 1,
      policyHash: 'c'.repeat(64),
      hostRef: 'document-matrix-host',
    }),
  }
  return {
    provider:
      provider === 'grok'
        ? new GrokSubscriptionProvider(model, subscriptionDeps as never)
        : new CodexSubscriptionProvider(model, subscriptionDeps as never),
    providerCalls,
  }
}

function bodyTokenPrefix(): string {
  return 'DOCUMENT_READ_CODE:'
}

function randomUUIDValue(): string {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

describe('document read provider matrix (#656)', () => {
  it.each([
    ['codex', 'pdf'],
    ['codex', 'xlsx'],
    ['codex', 'md'],
    ['codex', 'txt'],
    ['grok', 'pdf'],
    ['grok', 'xlsx'],
    ['grok', 'md'],
    ['grok', 'txt'],
  ] as const)(
    '%s routes %s through the PR A reader and delivers its body token',
    async (provider, format) => {
      const token = bodyToken()
      const tokenDigest = createHash('sha256').update(token, 'utf8').digest('hex')
      const attachment = await attachmentFor(provider, format, token)
      const { provider: subscription, providerCalls } = await startLocalSubscription(provider)
      const adapter = new LlmPortAdapter(
        subscription,
        provider === 'grok' ? 'grok-4.6' : 'gpt-5.3-codex',
        provider === 'grok' ? 'grok-subscription' : 'codex-subscription'
      )
      const registry = new NativeToolRegistry(
        {
          workspacePath: '/tmp',
          shellTimeout: 5_000,
          toolTimeout: 60_000,
          toolProgressInterval: 30_000,
          httpAllowlist: [],
          envAllowlist: ['PATH'],
          memoryMaxSize: 1_048_576,
          attachmentTextReadMaxBytes: 65_536,
        },
        `conversation-${provider}-${format}`,
        undefined,
        {
          content: 'Summarize the attached file.',
          channelType: 'rpc',
          channelId: 'agent-1',
          sender: 'user-1',
          timestamp: '2026-10-13T10:00:00Z',
          messageId: 'message-1',
          hostRef: 'host-1',
          attachments: [attachment],
        },
        undefined,
        undefined,
        undefined,
        {
          maxBytes: 3_145_728,
          ledger: new AttachmentReadLedger(),
          contextWindowTokens: 100_000,
        }
      )
      expect(registry.get('clerum__attachment_read')).not.toBeNull()
      if (format === 'pdf' || format === 'xlsx') {
        expect(registry.get('clerum__document_read')).not.toBeNull()
      } else {
        expect(registry.get('clerum__document_read')).toBeNull()
      }

      const block = buildTurnContextBlock({
        date: new Date('2026-10-13T10:00:00.000Z'),
        channel: { type: 'desktop' },
        attachedFiles: [
          {
            attachmentId: attachment.id,
            name: attachment.fileReference!.name,
            class: attachment.fileReference!.class,
            byteLength: attachment.fileReference!.byteLength,
            reader: attachment.fileReference!.reader,
            mismatch: false,
            declaredMediaType: FORMAT_MIME[format],
            detectedMediaType: FORMAT_MIME[format],
          },
        ],
      })
      expect(block).toContain(ATTACHED_FILES_INSTRUCTION)
      const initialMessages: ChatMessage[] = [
        { role: 'system', content: `${block}\nAnswer from the attached file.` },
        { role: 'user', content: 'Summarize the attached file.' },
      ]
      const loopConfig = buildLoopConfig({
        reasoning: new DefaultReasoningPort(
          adapter,
          new DefaultPromptBuilder({ nativeToolPresentation: 'direct' }),
          'Use the offered attachment reader before answering.'
        ),
        toolRegistry: registry,
        safety: new BasicSafety(),
        events: new SimpleEventEmitter(),
        conversation: makeFakeConversation(),
        maxIterations: 4,
        toolTimeout: 60_000,
        toolProgressInterval: 30_000,
      })
      loopConfig.measureToolMessage = message =>
        Math.max(Math.ceil(Buffer.byteLength(message.content ?? '', 'utf8') / 4) + 4, 1)
      const result = await runToolUseLoop(loopConfig, initialMessages)
      if (result.type !== 'response') {
        throw new Error(`the loop failed: ${result.type}`)
      }
      expect(result.content).toBe(tokenDigest)

      expect(providerCalls).toHaveLength(2)
      expect(providerCalls[0]).toEqual({
        branch:
          format === 'pdf' || format === 'xlsx'
            ? 'clerum__document_read'
            : 'clerum__attachment_read',
        stage: 'read',
      })
      expect(providerCalls[1]).toEqual({ branch: 'answer', stage: 'answer' })
    }
  )
})
