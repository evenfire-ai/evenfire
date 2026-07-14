import { expect } from '@playwright/test'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import { K8S_CONTEXT } from '../workflowUi'

export const CHANNELS_NS = 'channels'
export const TELEGRAM_PROVIDER_DEPLOYMENT = 'e2e-telegram-provider'
export const TELEGRAM_PROVIDER_SERVICE = 'e2e-telegram-provider'
export const TELEGRAM_PROVIDER_EGRESS_POLICY = 'e2e-telegram-provider-channel-reader-egress'
export const TELEGRAM_API_ROOT = 'http://e2e-telegram-provider.channels.svc.cluster.local:443'
export const TELEGRAM_BOT_TOKEN = '123456:AAFthirdpartyfirstparty'
export const TELEGRAM_CHAT_ID = '424242'
export const TELEGRAM_PROVIDER_USER_ID = '123456'
export const TELEGRAM_ALT_CHAT_ID = '424243'
export const TELEGRAM_ALT_PROVIDER_USER_ID = '123457'
export const TELEGRAM_CHANNEL_NAME = 'e2e-third-party-authn-first-party-mcphost-telegram'
export const TELEGRAM_CREDENTIALS_SECRET = `cc-${TELEGRAM_CHANNEL_NAME}-credentials`

export type FakeTelegramClientPortForward = {
  url: string
  stop: () => void
}

export type FakeTelegramBinding = {
  providerChannelId: string
  providerUserId: string
  providerChannelType?: 'private' | 'group' | 'supergroup'
}

const DEFAULT_TELEGRAM_BINDINGS: FakeTelegramBinding[] = [
  { providerChannelId: TELEGRAM_CHAT_ID, providerUserId: TELEGRAM_PROVIDER_USER_ID },
]

function kubectl(args: string[], input?: string, timeout = 30_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    input,
    timeout,
  })
}

function sleepOneSecond(): void {
  execFileSync('sleep', ['1'])
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('unable to allocate local port'))
        }
      })
    })
  })
}

async function waitForHttpOk(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function runningReadyPodName(labelSelector: string): string {
  const raw = kubectl(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'pod',
      '-l',
      labelSelector,
      '--field-selector=status.phase=Running',
      '-o',
      'json',
    ],
    undefined,
    10_000
  )
  const list = JSON.parse(raw) as {
    items?: Array<{
      metadata?: { name?: string }
      status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean }> }
    }>
  }
  const pod = (list.items ?? []).find(item => {
    const statuses = item.status?.containerStatuses ?? []
    return (
      item.status?.phase === 'Running' &&
      statuses.length > 0 &&
      statuses.every(status => status.ready)
    )
  })
  return pod?.metadata?.name ?? ''
}

function indentYaml(value: string, spaces = 4): string {
  const pad = ' '.repeat(spaces)
  return value
    .trim()
    .split('\n')
    .map(line => `${pad}${line}`)
    .join('\n')
}

const providerClientHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Telegram E2E Client</title>
    <style>
      body { margin: 0; font: 16px system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #eef6fb; color: #10202f; }
      main { max-width: 760px; margin: 32px auto; background: #fff; border: 1px solid #c8d8e4; border-radius: 10px; padding: 24px; box-shadow: 0 18px 40px rgba(20, 48, 70, 0.12); }
      h1 { margin: 0 0 18px; font-size: 24px; }
      label { display: block; margin: 14px 0 6px; font-weight: 650; }
      input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid #b6c7d4; border-radius: 8px; padding: 10px 12px; font: inherit; }
      textarea { min-height: 96px; resize: vertical; }
      button { margin-top: 16px; border: 0; border-radius: 8px; padding: 11px 18px; font: inherit; font-weight: 700; background: #2388c7; color: white; cursor: pointer; }
      button.approve { background: #23805a; }
      button:disabled { opacity: .7; cursor: wait; }
      .status { min-height: 24px; margin-top: 14px; font-weight: 650; color: #236c45; }
      .log { margin-top: 22px; border-top: 1px solid #d8e4ec; padding-top: 16px; }
      .message { margin: 8px 0; padding: 10px 12px; border-radius: 8px; background: #f5f9fc; border: 1px solid #d8e4ec; }
      .message strong { display: block; font-size: 13px; color: #536b7c; text-transform: uppercase; letter-spacing: .03em; }
      .approval-card { display: none; margin: 0 0 18px; padding: 16px; border: 1px solid #b9d9ca; border-radius: 10px; background: #f4fbf7; }
      .approval-card h2 { margin: 0 0 8px; font-size: 18px; }
      .approval-card p { margin: 0; color: #405064; }
      .identity-card { margin: 0 0 18px; padding: 14px 16px; border: 1px solid #d2e2ed; border-radius: 10px; background: #f8fbfd; }
      .identity-card span { display: block; color: #536b7c; font-size: 13px; }
      .identity-card strong { display: block; margin-top: 4px; font-size: 17px; }
      .recipes-card { display: none; margin: 0 0 18px; padding: 16px; border: 1px solid #bed4e4; border-radius: 10px; background: #f6fbff; }
      .recipes-card h2 { margin: 0 0 10px; font-size: 18px; }
      .recipes-card ul { margin: 0; padding-left: 20px; }
      .recipes-card li { margin: 6px 0; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>Telegram E2E Client</h1>
      <section class="recipes-card" data-testid="telegram-workflow-list-card">
        <h2>Workflow recipes</h2>
        <ul data-testid="telegram-workflow-list"></ul>
      </section>
      <section class="approval-card" data-testid="telegram-approval-card">
        <h2>Workflow approval request</h2>
        <p data-testid="telegram-approval-copy"></p>
        <button class="approve" type="button" data-testid="telegram-approve-workflow">Approve workflow</button>
      </section>
      <form data-testid="telegram-form">
        <input id="message-id" name="messageId" data-testid="telegram-message-id" type="hidden" value="7001" />
        <input id="provider-user-id" name="providerUserId" data-testid="telegram-provider-user-id" type="hidden" value="${TELEGRAM_PROVIDER_USER_ID}" />
        <input id="provider-channel-id" name="providerChannelId" data-testid="telegram-provider-channel-id" type="hidden" value="${TELEGRAM_CHAT_ID}" />
        <input id="provider-channel-type" name="providerChannelType" data-testid="telegram-provider-channel-type" type="hidden" value="private" />
        <input id="conversation-label" name="conversationLabel" data-testid="telegram-conversation-label" type="hidden" value="Alfredo Lopez - Telegram private chat" />
        <section class="identity-card" data-testid="telegram-conversation-card" aria-label="Telegram conversation">
          <span>Telegram conversation</span>
          <strong data-testid="telegram-conversation-name">Alfredo Lopez - Telegram private chat</strong>
          <span>Fake provider route for channel-reader</span>
        </section>
        <label for="conversation-select">Conversation</label>
        <select id="conversation-select" name="conversationSelect" data-testid="telegram-conversation-select">
          <option value="Alfredo Lopez - Telegram private chat" data-user-id="${TELEGRAM_PROVIDER_USER_ID}" data-channel-id="${TELEGRAM_CHAT_ID}" data-channel-type="private">Alfredo Lopez - Telegram private chat</option>
        </select>
        <label for="message-text">Message</label>
        <textarea id="message-text" name="messageText" data-testid="telegram-message-text"></textarea>
        <button type="submit" data-testid="telegram-send">Send Telegram message</button>
      </form>
      <div class="status" data-testid="telegram-status"></div>
      <section class="log">
        <h2>Bot replies</h2>
        <div data-testid="telegram-bot-replies"></div>
      </section>
    </main>
    <script>
      const form = document.querySelector('[data-testid="telegram-form"]')
      const status = document.querySelector('[data-testid="telegram-status"]')
      const replies = document.querySelector('[data-testid="telegram-bot-replies"]')
      const workflowListCard = document.querySelector('[data-testid="telegram-workflow-list-card"]')
      const workflowList = document.querySelector('[data-testid="telegram-workflow-list"]')
      const approvalCard = document.querySelector('[data-testid="telegram-approval-card"]')
      const approvalCopy = document.querySelector('[data-testid="telegram-approval-copy"]')
      const approveWorkflow = document.querySelector('[data-testid="telegram-approve-workflow"]')
      const conversationName = document.querySelector('[data-testid="telegram-conversation-name"]')
      const conversationSelect = document.querySelector('[data-testid="telegram-conversation-select"]')

      function registerTelegramConversation(identity) {
        const label = String(identity && identity.conversationLabel || '').trim()
        const userId = String(identity && identity.providerUserId || '').trim()
        const channelId = String(identity && identity.providerChannelId || '').trim()
        const channelType = String(identity && identity.providerChannelType || 'private').trim()
        if (!label || !userId || !channelId) return
        let option = Array.from(conversationSelect.options).find(item => item.value === label)
        if (!option) {
          option = document.createElement('option')
          option.value = label
          option.textContent = label
          conversationSelect.appendChild(option)
        }
        option.dataset.userId = userId
        option.dataset.channelId = channelId
        option.dataset.channelType = channelType || 'private'
      }

      window.__registerTelegramConversation = registerTelegramConversation

      function refreshConversationLabel() {
        conversationName.textContent = form.conversationLabel.value || 'Telegram private chat'
      }

      function applySelectedConversation() {
        const selected = conversationSelect.selectedOptions[0]
        if (!selected) return
        form.providerUserId.value = selected.dataset.userId || ''
        form.providerChannelId.value = selected.dataset.channelId || ''
        form.providerChannelType.value = selected.dataset.channelType || 'private'
        form.conversationLabel.value = selected.value || selected.textContent || ''
        refreshConversationLabel()
      }

      function workflowRecipesFromText(text) {
        const names = new Set()
        const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        const genericWords = new Set(['approval', 'field', 'health', 'input', 'inputs', 'list', 'marker', 'name', 'names', 'only', 'recipe', 'recipes', 'result', 'run', 'status', 'trigger'])
        const addName = value => {
          if (!value || uuidLike.test(value) || genericWords.has(value.toLowerCase())) return
          names.add(value)
        }
        for (const line of String(text || '').split('\n')) {
          const table = line.match(/^\|\s*\x60([a-z0-9][a-z0-9-]*)\x60\s*\|/i)
          if (table) addName(table[1])
          const boldBullet = line.match(/^-\s+\*\*([a-z0-9][a-z0-9-]*)\*\*/i)
          if (boldBullet) addName(boldBullet[1])
          const bullet = line.match(/^-\s+\x60?([a-z0-9][a-z0-9-]*)\x60?\s*:/i)
          if (bullet) addName(bullet[1])
          const plainBullet = line.match(/^[-*•]\s+\x60?([a-z0-9][a-z0-9-]*)\x60?(?:\s|$)/i)
          if (plainBullet) addName(plainBullet[1])
        }
        for (const quoted of String(text || '').matchAll(/\x60([a-z0-9][a-z0-9-]*)\x60/gim)) {
          addName(quoted[1])
        }
        for (const bold of String(text || '').matchAll(/\*\*([a-z0-9][a-z0-9-]*)\*\*/gim)) {
          addName(bold[1])
        }
        for (const slug of String(text || '').matchAll(/\be2e-[a-z0-9][a-z0-9-]*\b/gim)) {
          addName(slug[0])
        }
        for (const named of String(text || '').matchAll(/\bworkflow(?:\s+recipe)?(?:\s+named|\s+name)?\s+([a-z0-9][a-z0-9-]*)\b/gim)) {
          addName(named[1])
        }
        return Array.from(names)
      }

      async function refreshReplies() {
        const activeChatId = form.providerChannelId.value.trim()
        const res = await fetch('/__test/sentMessages?chatId=' + encodeURIComponent(activeChatId))
        const body = await res.json()
        replies.innerHTML = ''
        workflowList.innerHTML = ''
        workflowListCard.style.display = 'none'
        approvalCard.style.display = 'none'
        approveWorkflow.dataset.approvalTarget = ''
        approveWorkflow.dataset.decisionMessageId = ''
        const visibleRecipes = new Set()
        for (const msg of body.sentMessages || []) {
          const botText = msg.text || ''
          const recipes = workflowRecipesFromText(botText)
          const isUnavailable = /(not available|unable to run|cannot run|can't run|cannot trigger|not authorized|not permitted|no access|doesn'?t exist|could not verify|did you mean)/i.test(botText)
          const isWorkflowList = /(available workflow recipes|workflow recipes|workflow_list|recipes you can|can trigger|can run|available to this conversation)/i.test(botText) || recipes.length > 1
          if (isWorkflowList && !isUnavailable) {
            for (const recipe of recipes) visibleRecipes.add(recipe)
          }
          const item = document.createElement('div')
          item.className = 'message'
          item.dataset.testid = 'telegram-bot-reply'
          item.innerHTML = '<strong>Clerum bot</strong><span></span>'
          if (msg.document) {
            const documentName = msg.document.file_name || 'document'
            const documentSize = msg.document.file_size || 0
            const documentMime = msg.document.mime_type || ''
            item.dataset.documentFilename = documentName
            item.dataset.documentSize = String(documentSize)
            item.dataset.documentMime = documentMime
            item.dataset.documentSample = msg.documentTextSample || ''
            item.dataset.documentSha256 = msg.documentSha256 || ''
            item.querySelector('span').textContent =
              '[document] ' + documentName + ' (' + documentSize + ' bytes) ' + (msg.caption || '')
          } else {
            item.querySelector('span').textContent = msg.text || msg.method || ''
          }
          replies.appendChild(item)
          if (msg.workflowApproval) {
            approvalCard.style.display = 'block'
            approvalCopy.textContent = msg.workflowApproval.recipeName
              ? 'Approve workflow ' + msg.workflowApproval.recipeName
              : msg.workflowApproval.title || msg.text || 'Approve workflow trigger'
            approveWorkflow.dataset.approvalTarget = msg.workflowApproval.recipeName || ''
            approveWorkflow.dataset.decisionMessageId = String(msg.workflowApproval.decisionMessageId || '7001')
          }
        }
        if (visibleRecipes.size > 0) {
          workflowListCard.style.display = 'block'
          for (const recipe of visibleRecipes) {
            const item = document.createElement('li')
            item.textContent = recipe
            workflowList.appendChild(item)
          }
        }
      }

      form.addEventListener('submit', async event => {
        event.preventDefault()
        const button = form.querySelector('button')
        button.disabled = true
        status.textContent = 'Sending...'
        const payload = {
          chatId: form.providerChannelId.value,
          chatType: form.providerChannelType.value,
          userId: form.providerUserId.value,
          messageId: form.messageId.value,
          text: form.messageText.value,
        }
        const response = await fetch('/__test/pushUpdate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await response.json().catch(() => ({}))
        button.disabled = false
        if (!response.ok) {
          status.textContent = body.error || 'Telegram send failed'
          status.style.color = '#9d2f2f'
          return
        }
        status.textContent = 'Telegram message sent'
        status.style.color = '#236c45'
        await refreshReplies()
      })

      conversationSelect.addEventListener('change', () => {
        applySelectedConversation()
        refreshReplies()
      })

      approveWorkflow.addEventListener('click', () => {
        const approvalTarget = approveWorkflow.dataset.approvalTarget
        if (!approvalTarget) {
          status.textContent = 'No Telegram approval request is visible'
          status.style.color = '#9d2f2f'
          return
        }
        form.messageId.value = approveWorkflow.dataset.decisionMessageId || '7001'
        form.messageText.value = '/approve ' + approvalTarget
        form.requestSubmit()
      })

      applySelectedConversation()
      refreshReplies()
      setInterval(refreshReplies, 1000)
    </script>
  </body>
</html>`

const providerServerScript = String.raw`
const http = require('http')
const crypto = require('crypto')

const TELEGRAM_HTML = ${JSON.stringify(providerClientHtml)}

let nextUpdateId = 1000
let nextOutboundMessageId = 5000
let nextDecisionMessageId = Math.floor(Date.now() / 1000) * 1000
let getUpdatesCount = 0
const updates = []
const sentMessages = []
const receivedMessageKeys = new Set()

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []
    req.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function headerParam(header, name) {
  const match = String(header || '').match(new RegExp(name + '=(?:"([^"]*)"|([^;\\r\\n]*))', 'i'))
  return (match && (match[1] || match[2]) || '').trim()
}

function stripBoundaryCrlf(value) {
  if (value.length >= 2 && value[value.length - 2] === 13 && value[value.length - 1] === 10) {
    return value.subarray(0, value.length - 2)
  }
  return value
}

function inferTelegramDocumentMime(filename, multipartMimeType) {
  const normalized = String(multipartMimeType || '').trim().toLowerCase()
  if (normalized && normalized !== 'application/octet-stream') return multipartMimeType
  const ext = String(filename || '').split('.').pop().toLowerCase()
  const byExt = {
    md: 'text/markdown',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
  }
  return byExt[ext] || multipartMimeType || 'application/octet-stream'
}

function parseMultipartBody(raw, contentType) {
  const boundary = String(contentType.match(/boundary=([^;]+)/i)?.[1] || '').trim()
  if (!boundary) return {}
  const out = {}
  const delimiter = Buffer.from('--' + boundary)
  let start = raw.indexOf(delimiter)
  while (start >= 0) {
    start += delimiter.length
    const next = raw.indexOf(delimiter, start)
    if (next < 0) break
    let part = raw.subarray(start, next)
    if (part.length >= 2 && part[0] === 45 && part[1] === 45) break
    if (part.length >= 2 && part[0] === 13 && part[1] === 10) part = part.subarray(2)
    part = stripBoundaryCrlf(part)
    const splitAt = part.indexOf(Buffer.from('\r\n\r\n'))
    if (splitAt < 0) continue
    const header = part.subarray(0, splitAt).toString('utf8')
    const value = part.subarray(splitAt + 4)
    const name = headerParam(header, 'name')
    if (!name) continue
    const filename = headerParam(header, 'filename')
    const mimeType = header.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || ''
    if (filename) {
      out[name] = {
        file_name: filename,
        mime_type: inferTelegramDocumentMime(filename, mimeType),
        file_size: value.byteLength,
        text_sample: value.toString('utf8', 0, Math.min(value.byteLength, 4096)),
        sha256: crypto.createHash('sha256').update(value).digest('hex'),
      }
    } else {
      out[name] = value.toString('utf8')
    }
    start = next
  }
  return out
}

function parseBody(raw, req) {
  if (!raw || raw.length === 0) return {}
  const contentType = String(req.headers['content-type'] || '')
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'))
    } catch {
      return {}
    }
  }
  if (contentType.includes('multipart/form-data')) {
    return parseMultipartBody(raw, contentType)
  }
  return Object.fromEntries(new URLSearchParams(raw.toString('utf8')))
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function telegramOk(result) {
  return { ok: true, result }
}

function workflowApprovalFromBotText(text) {
  const recipeMatch = String(text || '').match(/sandbox-recipes\/([a-z0-9-]+)/i)
  const approvalTargetMatch = String(text || '').match(/\/approve\s+([a-z0-9][a-z0-9-]*)/i)
  const requestedForMatch = String(text || '').match(/Approval requested for workflow\s+([a-z0-9][a-z0-9-]*)/i)
  const genericApprovalTargets = new Set(['always', 'cancel', 'continue', 'to'])
  const approvalTarget = approvalTargetMatch ? approvalTargetMatch[1] : ''
  if (
    !recipeMatch &&
    !requestedForMatch &&
    (!approvalTarget || genericApprovalTargets.has(approvalTarget.toLowerCase()))
  ) {
    return null
  }
  const [title = 'Approve workflow trigger', ...bodyLines] = String(text || '').split('\n')
  const recipeName = recipeMatch
    ? recipeMatch[1]
    : requestedForMatch
      ? requestedForMatch[1]
      : approvalTarget
  return {
    recipeName,
    title,
    body: bodyLines.join('\n').trim(),
    decisionMessageId: nextDecisionMessageId++,
  }
}

function resolveTelegramDocument(body) {
  const document = body.document
  if (document && typeof document === 'object') return document
  if (typeof document === 'string' && document.startsWith('attach://')) {
    const key = document.slice('attach://'.length)
    const uploaded = body[key]
    return uploaded && typeof uploaded === 'object' ? uploaded : null
  }
  if (typeof document === 'string' && document.trim()) {
    return {
      file_name: document.trim(),
      mime_type: 'application/octet-stream',
      file_size: 0,
      text_sample: '',
      sha256: '',
    }
  }
  return null
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const raw = await readBody(req)
  const body = parseBody(raw, req)

  if (url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      updates: updates.length,
      sentMessages: sentMessages.length,
      getUpdatesCount,
    })
    return
  }

  if (url.pathname === '/__test/pushUpdate') {
    const chatId = Number(body.chatId)
    const userId = Number(body.userId)
    const text = String(body.text || '')
    const chatType = String(body.chatType || 'private')
    const messageId = Number(body.messageId || nextUpdateId)
    if (!Number.isFinite(chatId) || !Number.isFinite(userId) || !text) {
      json(res, 400, { error: 'chatId, userId, and text are required' })
      return
    }
    const messageKey = [chatId, userId, messageId].join(':')
    if (receivedMessageKeys.has(messageKey)) {
      json(res, 200, { ok: true, duplicate: true })
      return
    }
    receivedMessageKeys.add(messageKey)
    const update = {
      update_id: nextUpdateId++,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: chatType },
        from: {
          id: userId,
          is_bot: false,
          first_name: 'E2E',
          username: 'e2e_provider_user',
        },
        text,
      },
    }
    updates.push(update)
    json(res, 200, { ok: true, update })
    return
  }

  if (url.pathname === '/__test/sentMessages') {
    const chatId = url.searchParams.get('chatId')
    const filtered = chatId
      ? sentMessages.filter(message => String(message.chat && message.chat.id) === chatId)
      : sentMessages
    json(res, 200, { ok: true, sentMessages: filtered })
    return
  }

  if (url.pathname === '/__test/ui' || url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(TELEGRAM_HTML)
    return
  }

  const methodMatch = url.pathname.match(/^\/bot[^/]+\/([^/]+)$/)
  const method = methodMatch ? methodMatch[1] : ''

  if (method === 'getMe') {
    json(
      res,
      200,
      telegramOk({
        id: 888001,
        is_bot: true,
        first_name: 'Clerum E2E',
        username: 'clerum_e2e_bot',
      })
    )
    return
  }

  if (method === 'deleteWebhook') {
    json(res, 200, telegramOk(true))
    return
  }

  if (method === 'getUpdates') {
    getUpdatesCount += 1
    const offset = Number(body.offset || url.searchParams.get('offset') || 0)
    const result = updates.filter(update => update.update_id >= offset)
    json(res, 200, telegramOk(result))
    return
  }

  if (method === 'sendMessage' || method === 'editMessageText') {
    const text = String(body.text || '')
    const message = {
      message_id: nextOutboundMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(body.chat_id || 0), type: 'private' },
      text,
      method,
      workflowApproval: workflowApprovalFromBotText(text),
    }
    sentMessages.push(message)
    json(res, 200, telegramOk(message))
    return
  }

  if (method === 'sendDocument') {
    const chatId = Number(body.chat_id || 0)
    const document = resolveTelegramDocument(body)
    const caption = String(body.caption || '')
    if (!Number.isFinite(chatId) || chatId === 0) {
      json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat_id is required' })
      return
    }
    if (!document) {
      json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: document is required' })
      return
    }
    if (caption.length > 1024) {
      json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: caption is too long' })
      return
    }
    const documentTextSample = String(document.text_sample || '')
    const documentSha256 = String(document.sha256 || '')
    const telegramDocument = {
      file_id: 'fake-document-' + nextOutboundMessageId,
      file_unique_id: 'fake-document-unique-' + nextOutboundMessageId,
      file_name: String(document.file_name || 'document'),
      mime_type: String(document.mime_type || 'application/octet-stream'),
      file_size: Number(document.file_size || 0),
    }
    const telegramMessage = {
      message_id: nextOutboundMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      caption,
      document: telegramDocument,
      method,
    }
    sentMessages.push({ ...telegramMessage, documentTextSample, documentSha256 })
    json(res, 200, telegramOk(telegramMessage))
    return
  }

  json(res, 404, { ok: false, error_code: 404, description: 'method not mocked' })
})

server.listen(3000, '0.0.0.0', () => {
  console.log('[fake-telegram-provider] listening on :3000')
})
`

function fakeTelegramProviderYaml(): string {
  return `
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${TELEGRAM_PROVIDER_DEPLOYMENT}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/e2e: "true"
data:
  server.js: |
${indentYaml(providerServerScript, 4)}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${TELEGRAM_PROVIDER_DEPLOYMENT}
  namespace: ${CHANNELS_NS}
  labels:
    app: ${TELEGRAM_PROVIDER_DEPLOYMENT}
    clerum.io/e2e: "true"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${TELEGRAM_PROVIDER_DEPLOYMENT}
  template:
    metadata:
      labels:
        app: ${TELEGRAM_PROVIDER_DEPLOYMENT}
        clerum.io/e2e: "true"
    spec:
      containers:
        - name: provider
          image: clerum/channel-reader:test
          imagePullPolicy: IfNotPresent
          command: ["node", "/app/fake-telegram/server.js"]
          ports:
            - containerPort: 3000
          volumeMounts:
            - name: fake-telegram-script
              mountPath: /app/fake-telegram
              readOnly: true
      volumes:
        - name: fake-telegram-script
          configMap:
            name: ${TELEGRAM_PROVIDER_DEPLOYMENT}
---
apiVersion: v1
kind: Service
metadata:
  name: ${TELEGRAM_PROVIDER_SERVICE}
  namespace: ${CHANNELS_NS}
  labels:
    app: ${TELEGRAM_PROVIDER_DEPLOYMENT}
    clerum.io/e2e: "true"
spec:
  selector:
    app: ${TELEGRAM_PROVIDER_DEPLOYMENT}
  ports:
    - name: http-telegram
      port: 443
      targetPort: 3000
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${TELEGRAM_PROVIDER_SERVICE}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/e2e: "true"
spec:
  podSelector:
    matchLabels:
      app: ${TELEGRAM_PROVIDER_DEPLOYMENT}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: channel-reader
      ports:
        - protocol: TCP
          port: 3000
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${TELEGRAM_PROVIDER_EGRESS_POLICY}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/e2e: "true"
spec:
  podSelector:
    matchLabels:
      app: channel-reader
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: ${TELEGRAM_PROVIDER_DEPLOYMENT}
      ports:
        - protocol: TCP
          port: 3000
`
}

export function installFakeTelegramProvider(): void {
  kubectl(['apply', '-f', '-'], fakeTelegramProviderYaml(), 30_000)
  kubectl(
    ['-n', CHANNELS_NS, 'rollout', 'restart', `deployment/${TELEGRAM_PROVIDER_DEPLOYMENT}`],
    undefined,
    20_000
  )
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'rollout',
      'status',
      `deployment/${TELEGRAM_PROVIDER_DEPLOYMENT}`,
      '--timeout=120s',
    ],
    undefined,
    130_000
  )
}

export async function openFakeTelegramClientPortForward(): Promise<FakeTelegramClientPortForward> {
  const port = await freeLocalPort()
  const child = spawn(
    'kubectl',
    [
      '--context',
      K8S_CONTEXT,
      '-n',
      CHANNELS_NS,
      'port-forward',
      '--address=127.0.0.1',
      `svc/${TELEGRAM_PROVIDER_SERVICE}`,
      `${port}:443`,
    ],
    { stdio: 'ignore' }
  )
  const url = `http://127.0.0.1:${port}/__test/ui`
  try {
    await waitForHttpOk(`http://127.0.0.1:${port}/health`)
  } catch (err) {
    stopPortForward(child)
    throw err
  }
  return {
    url,
    stop: () => stopPortForward(child),
  }
}

function stopPortForward(child: ChildProcess): void {
  if (child.killed) return
  child.kill('SIGTERM')
}

export function removeFakeTelegramProvider(): void {
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'delete',
      'service,deployment,configmap,networkpolicy',
      TELEGRAM_PROVIDER_DEPLOYMENT,
      '--ignore-not-found=true',
      '--wait=false',
    ],
    undefined,
    30_000
  )
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'delete',
      'networkpolicy',
      TELEGRAM_PROVIDER_EGRESS_POLICY,
      '--ignore-not-found=true',
      '--wait=false',
    ],
    undefined,
    20_000
  )
}

export function configureChannelReaderTelegramApiRoot(hostName = 'chatllm'): void {
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'patch',
      'configmap',
      'clerum-channel-reader-config',
      '--type=merge',
      '-p',
      JSON.stringify({ data: { CLERUM_TELEGRAM_API_ROOT: TELEGRAM_API_ROOT } }),
    ],
    undefined,
    10_000
  )
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'set',
      'env',
      `deployment/channel-reader-${hostName}`,
      `CLERUM_TELEGRAM_API_ROOT=${TELEGRAM_API_ROOT}`,
    ],
    undefined,
    20_000
  )
}

export function restoreChannelReaderTelegramApiRoot(hostName = 'chatllm'): void {
  try {
    kubectl(
      [
        '-n',
        CHANNELS_NS,
        'patch',
        'configmap',
        'clerum-channel-reader-config',
        '--type=json',
        '-p',
        JSON.stringify([{ op: 'remove', path: '/data/CLERUM_TELEGRAM_API_ROOT' }]),
      ],
      undefined,
      10_000
    )
  } catch {
    // Already absent is the desired cleanup state.
  }
  try {
    kubectl(
      [
        '-n',
        CHANNELS_NS,
        'set',
        'env',
        `deployment/channel-reader-${hostName}`,
        'CLERUM_TELEGRAM_API_ROOT-',
      ],
      undefined,
      20_000
    )
  } catch {
    // Deployment may already be gone during cleanup in failed local gates.
  }
}

export function applyTelegramCommunicationChannel(
  hostName = 'chatllm',
  bindings: FakeTelegramBinding[] = DEFAULT_TELEGRAM_BINDINGS
): void {
  const telegramGroups = bindings
    .map(
      binding => `    - channelId: "${binding.providerChannelId}"
      chatType: "${binding.providerChannelType || 'private'}"
      userIds:
        - "${binding.providerUserId}"`
    )
    .join('\n')
  const yaml = `
apiVersion: v1
kind: Secret
metadata:
  name: ${TELEGRAM_CREDENTIALS_SECRET}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/component: channel-reader
type: Opaque
stringData:
  telegram-bot-token: "${TELEGRAM_BOT_TOKEN}"
---
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: ${TELEGRAM_CHANNEL_NAME}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/third-party-authn-first-party-mcphost: "true"
spec:
  hostRef: ${hostName}
  credentialsSecretRef:
    name: ${TELEGRAM_CREDENTIALS_SECRET}
  telegram:
${telegramGroups}
`
  kubectl(['apply', '-f', '-'], yaml, 30_000)
}

export function removeTelegramCommunicationChannel(): void {
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'delete',
      'communicationchannel',
      TELEGRAM_CHANNEL_NAME,
      '--ignore-not-found=true',
      '--wait=false',
    ],
    undefined,
    20_000
  )
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'delete',
      'secret',
      TELEGRAM_CREDENTIALS_SECRET,
      '--ignore-not-found=true',
      '--wait=false',
    ],
    undefined,
    20_000
  )
}

export function waitForChannelReader(hostName = 'chatllm'): void {
  kubectl(
    ['-n', CHANNELS_NS, 'rollout', 'restart', `deployment/channel-reader-${hostName}`],
    undefined,
    20_000
  )
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'rollout',
      'status',
      `deployment/channel-reader-${hostName}`,
      '--timeout=180s',
    ],
    undefined,
    190_000
  )
  const ready = kubectl(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'deploy',
      `channel-reader-${hostName}`,
      '-o',
      'jsonpath={.status.readyReplicas}/{.spec.replicas}',
    ],
    undefined,
    10_000
  ).trim()
  expect(ready).toBe('1/1')
}

export function expectChannelReaderLoadedTelegram(hostName = 'chatllm'): void {
  let loaded = false
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const logs = kubectl(
      ['-n', CHANNELS_NS, 'logs', `deployment/channel-reader-${hostName}`, '--tail=160'],
      undefined,
      15_000
    )
    loaded =
      logs.includes('[Main] needsTelegram: true') && logs.includes('[Telegram] Connected as @')
    if (loaded) break
    sleepOneSecond()
  }
  expect(loaded, 'channel-reader must load the real Telegram adapter before human input').toBe(true)
}

export function expectChannelReaderHasNoProviderHttpIngress(hostName = 'chatllm'): void {
  const services = kubectl(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'svc',
      '-l',
      'app=channel-reader',
      '-o',
      'jsonpath={.items[*].metadata.name}',
    ],
    undefined,
    10_000
  ).trim()
  expect(services, 'channel-reader exposes no HTTP/provider ingress service').toBe('')

  const ports = kubectl(
    [
      '-n',
      CHANNELS_NS,
      'get',
      'deploy',
      `channel-reader-${hostName}`,
      '-o',
      'jsonpath={.spec.template.spec.containers[0].ports[*].containerPort}',
    ],
    undefined,
    10_000
  ).trim()
  expect(ports, 'channel-reader deployment has no HTTP provider port').toBe('')
}

export function expectChannelReaderCanReachMcpHost(hostName = 'chatllm'): void {
  const labelSelector = `app=channel-reader,clerum.io/host=${hostName}`
  const script = `
const url = 'http://${hostName}.mcp-host.svc.cluster.local:8080/v1/runtime/health';
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 2000);
(async () => {
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    process.stdout.write(JSON.stringify({ status: response.status, body }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: String(error && error.message || error) }));
  } finally {
    clearTimeout(timeout);
  }
})();
`
  let lastProbe: unknown = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const pod = runningReadyPodName(labelSelector)
      if (!pod) {
        lastProbe = 'channel-reader pod not ready'
        sleepOneSecond()
        continue
      }
      const raw = kubectl(
        ['-n', CHANNELS_NS, 'exec', pod, '--', 'node', '-e', script],
        undefined,
        15_000
      )
      lastProbe = JSON.parse(raw)
      if (JSON.stringify(lastProbe) === JSON.stringify({ status: 200, body: { status: 'ok' } })) {
        return
      }
    } catch (err) {
      lastProbe = err instanceof Error ? err.message : String(err)
    }
    sleepOneSecond()
  }
  expect(lastProbe).toEqual({ status: 200, body: { status: 'ok' } })
}

export function fakeTelegramPollingCount(): number {
  const script = `
fetch('http://127.0.0.1:3000/health')
  .then(async response => {
    process.stdout.write(await response.text());
    if (!response.ok) process.exit(1);
  })
  .catch(error => {
    process.stderr.write(String(error && error.message || error));
    process.exit(1);
  });
`
  const raw = kubectl(
    [
      '-n',
      CHANNELS_NS,
      'exec',
      `deploy/${TELEGRAM_PROVIDER_DEPLOYMENT}`,
      '--',
      'node',
      '-e',
      script,
    ],
    undefined,
    10_000
  )
  const parsed = JSON.parse(raw) as { getUpdatesCount?: number }
  return Number(parsed.getUpdatesCount ?? 0)
}

export type FakeTelegramSentMessage = {
  message_id: number
  date: number
  chat: { id: number; type: string }
  text: string
  method: string
  workflowApproval?: unknown
}

/**
 * Injects an inbound Telegram update into the fake provider queue so
 * channel-reader can poll it via getUpdates (used for /verify enrollment).
 */
export function pushFakeTelegramUpdate(params: {
  chatId: string
  userId: string
  text: string
  chatType?: string
  messageId?: number
}): void {
  const payload = JSON.stringify({
    chatId: params.chatId,
    userId: params.userId,
    text: params.text,
    chatType: params.chatType || 'private',
    messageId: params.messageId ?? Date.now() % 1_000_000_000,
  })
  const script = `
fetch('http://127.0.0.1:3000/__test/pushUpdate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: ${JSON.stringify(payload)},
})
  .then(async response => {
    process.stdout.write(await response.text());
    if (!response.ok) process.exit(1);
  })
  .catch(error => {
    process.stderr.write(String(error && error.message || error));
    process.exit(1);
  });
`
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'exec',
      `deploy/${TELEGRAM_PROVIDER_DEPLOYMENT}`,
      '--',
      'node',
      '-e',
      script,
    ],
    undefined,
    15_000
  )
}

/**
 * Reads the outbound messages the fake Telegram provider has emitted via
 * `sendMessage`/`editMessageText`. This is the business signal that proves a
 * notification fell back to the Telegram channel after the desktop grace
 * window expired. Optionally filters by Telegram chat id.
 */
export function fakeTelegramSentMessages(chatId?: string): FakeTelegramSentMessage[] {
  const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''
  const script = `
fetch('http://127.0.0.1:3000/__test/sentMessages${query}')
  .then(async response => {
    process.stdout.write(await response.text());
    if (!response.ok) process.exit(1);
  })
  .catch(error => {
    process.stderr.write(String(error && error.message || error));
    process.exit(1);
  });
`
  const raw = kubectl(
    [
      '-n',
      CHANNELS_NS,
      'exec',
      `deploy/${TELEGRAM_PROVIDER_DEPLOYMENT}`,
      '--',
      'node',
      '-e',
      script,
    ],
    undefined,
    10_000
  )
  const parsed = JSON.parse(raw) as { sentMessages?: FakeTelegramSentMessage[] }
  return parsed.sentMessages ?? []
}
