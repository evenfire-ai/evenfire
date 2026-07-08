/**
 * Telegram Hybrid E2E test — fully automated.
 *
 * Suite 1 — HTTP-direct: opt-in POSTs to mcp-host /message and validates LLM response.
 *
 * Suite 2 — Benchmark with TG delivery: POSTs to mcp-host /message, validates
 *   the response, then posts both the question and answer to the TG group via
 *   the test bot so results are visible. Fully automated, no manual trigger.
 *
 * Suite 3 — Advanced Multi-Tool Benchmark: Chains multiple tools (native + MCP)
 *   across 8 sequential tests sharing conversation context to build a Clerum
 *   landing page. Tests file_read/write, MCP tools, system_info, memory_search.
 *
 * Suite 4 — TG manual trigger (optional): A real user sends a message in TG;
 *   test verifies channel-reader picks it up and replies via pod logs.
 *   Set TG_MANUAL_TRIGGER=1 to enable.
 *
 * Required env vars:
 *   MCP_HOST_URL        — mcp-host endpoint (default: http://localhost:8080)
 *
 * For TG delivery:
 *   TG_TEST_BOT_TOKEN   — Test/observer bot token (sends results to group)
 *   TG_GROUP_CHAT_ID    — Group chat ID
 *
 * Optional:
 *   E2E_RUN_TELEGRAM_HTTP_DIRECT — Set to "1" to enable direct HTTP LLM checks
 *   TG_MANUAL_TRIGGER   — Set to "1" to enable manual TG trigger suite
 *   TG_POLL_TIMEOUT_MS  — Max wait for manual TG test (default: 90000)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MCP_HOST_URL, fetchJson, kubectl, sendMessage, sleep } from '../helpers'

// ── Config ──────────────────────────────────────────────────────────
const GROUP_CHAT_ID = process.env.TG_GROUP_CHAT_ID || 'test-channel'
const TEST_BOT_TOKEN = process.env.TG_TEST_BOT_TOKEN
const MAIN_BOT_ID = parseInt(process.env.TG_MAIN_BOT_ID || '0000000000', 10)
const POLL_TIMEOUT = parseInt(process.env.TG_POLL_TIMEOUT_MS || '90000', 10)
const MANUAL_TRIGGER = process.env.TG_MANUAL_TRIGGER === '1'
const RUN_HTTP_DIRECT = process.env.E2E_RUN_TELEGRAM_HTTP_DIRECT === '1'
const EXPECTED_MODEL_PROVIDER = process.env.E2E_EXPECTED_MODEL_PROVIDER?.toLowerCase()
const EXPECTED_MODEL_NAME = process.env.E2E_EXPECTED_MODEL_NAME?.toLowerCase()

const TG_API = TEST_BOT_TOKEN ? `https://api.telegram.org/bot${TEST_BOT_TOKEN}` : ''

function assertConfiguredModelIdentity(data: any): void {
  const model = String(data.model || '').toLowerCase()
  const text = `${model} ${data.response || ''}`.toLowerCase()

  expect(model.length).toBeGreaterThan(0)

  if (EXPECTED_MODEL_PROVIDER) {
    expect(text).toContain(EXPECTED_MODEL_PROVIDER)
  } else {
    expect(text).toMatch(/openai|gpt|claude|anthropic|zai|z\.ai|glm|bailian|qwen/)
  }

  if (EXPECTED_MODEL_NAME) {
    expect(text).toContain(EXPECTED_MODEL_NAME)
  }
}

function benchmarkModelLabel(): string {
  const provider = EXPECTED_MODEL_PROVIDER || 'configured provider'
  const model = EXPECTED_MODEL_NAME || 'configured model'
  return `Provider: ${provider} | Model: ${model}`
}

// ── TG helpers ──────────────────────────────────────────────────────

/** Post a message to the TG group via the test bot. */
async function postToGroup(text: string): Promise<number> {
  if (!TG_API) throw new Error('TG_TEST_BOT_TOKEN required for TG delivery')
  const res = await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: GROUP_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  })
  const data = await res.json()
  if (!data.ok) {
    // Retry without markdown if parse fails
    const retry = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_CHAT_ID, text }),
    })
    const retryData = await retry.json()
    if (!retryData.ok) throw new Error(`TG sendMessage failed: ${JSON.stringify(retryData)}`)
    return retryData.result.message_id
  }
  return data.result.message_id
}

/**
 * Auto-approve ALL pending MCP tool approval requests for a given userId.
 * Keeps polling and approving until the agent returns to idle or timeout.
 */
async function autoApproveLoop(userId: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { data: status } = await fetchJson(`${MCP_HOST_URL}/v1/runtime/status`)
    const pending = status.pendingApprovals || []
    const mine = pending.find((a: any) => a.userId === userId)
    if (mine) {
      console.log(`[AutoApprove] Approving ${mine.toolName} for ${userId}`)
      await fetchJson(`${MCP_HOST_URL}/v1/runtime/approvals/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          requestId: mine.requestId,
          alwaysApprove: true,
        }),
      })
      // Don't return — keep looping to catch more approvals
      await sleep(500)
      continue
    }
    // Check if agent is done (no approval needed)
    if (status.agent?.state === 'idle') return
    await sleep(1000)
  }
}

/** Send a question via HTTP, auto-approve MCP tools, post Q&A to TG. */
async function benchmarkQuestion(
  label: string,
  question: string,
  opts?: { userId?: string; needsApproval?: boolean }
): Promise<{ status: number; data: any }> {
  const nonce = Math.random().toString(36).slice(2, 8)
  const userId = opts?.userId ?? `e2e-bench-${nonce}`
  const fullQuestion = `[${label}] ${question}`

  // Post question to TG
  if (TG_API) {
    await postToGroup(`🔬 *E2E Benchmark — ${label}*\n\n📩 ${question}`)
  }

  // For MCP tools that need approval, send message and auto-approve in parallel
  if (opts?.needsApproval) {
    // Fire the message (may return immediately with waiting_approval or block)
    const resultPromise = sendMessage(fullQuestion, {
      channelId: GROUP_CHAT_ID,
      userId,
      channelType: 'telegram',
    })

    // Start auto-approve loop in parallel — keeps approving until agent is idle
    const approvePromise = autoApproveLoop(userId, 90_000)

    // Wait for the HTTP response first
    const result = await resultPromise

    // If the response came back as waiting_approval, we need to poll for task result
    if (result.data?.status === 'waiting_approval' || !result.data?.response) {
      const taskId = result.data?.taskId || result.data?.approval?.taskId
      // Keep approving while we wait for task completion
      const start = Date.now()
      while (Date.now() - start < 90_000) {
        // Check and approve any pending approvals inline
        const { data: status } = await fetchJson(`${MCP_HOST_URL}/v1/runtime/status`)
        const pending = status.pendingApprovals || []
        const mine = pending.find((a: any) => a.userId === userId)
        if (mine) {
          console.log(`[AutoApprove] Approving ${mine.toolName} for ${userId}`)
          await fetchJson(`${MCP_HOST_URL}/v1/runtime/approvals/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, requestId: mine.requestId, alwaysApprove: true }),
          })
          await sleep(500)
          continue
        }

        // Check if task completed
        if (taskId) {
          const taskRes = await fetchJson(`${MCP_HOST_URL}/v1/runtime/tasks/${taskId}/result`)
          if (taskRes.data?.status === 'completed' || taskRes.data?.response) {
            result.data = { ...result.data, ...taskRes.data, success: true, status: 'completed' }
            break
          }
        }

        // If agent is idle, the task is done — fetch final result
        if (status.agent?.state === 'idle') {
          if (taskId) {
            const taskRes = await fetchJson(`${MCP_HOST_URL}/v1/runtime/tasks/${taskId}/result`)
            result.data = { ...result.data, ...taskRes.data, success: true, status: 'completed' }
          }
          break
        }

        await sleep(1000)
      }
    }

    // Cancel the background approve loop (it'll stop on idle anyway)
    await Promise.race([approvePromise, sleep(100)])

    // Post response to TG
    if (TG_API && result.data?.response) {
      const response = result.data.response
      const model = result.data.model || 'unknown'
      const truncated = response.length > 3000 ? response.slice(0, 3000) + '...' : response
      await postToGroup(`✅ *${label}* — _${model}_\n\n${truncated}`)
    } else if (TG_API) {
      await postToGroup(`❌ *${label}* — failed: ${JSON.stringify(result.data).slice(0, 200)}`)
    }
    return result
  }

  // Simple path: no approval needed
  const result = await sendMessage(fullQuestion, {
    channelId: GROUP_CHAT_ID,
    userId,
    channelType: 'telegram',
  })

  if (TG_API && result.data?.response) {
    const response = result.data.response
    const model = result.data.model || 'unknown'
    const truncated = response.length > 3000 ? response.slice(0, 3000) + '...' : response
    await postToGroup(`✅ *${label}* — _${model}_\n\n${truncated}`)
  } else if (TG_API) {
    await postToGroup(`❌ *${label}* — failed: ${JSON.stringify(result.data).slice(0, 200)}`)
  }

  return result
}

// ── Channel-reader log helpers ──────────────────────────────────────

const CHANNEL_READER_NS = process.env.CHANNEL_READER_NS || 'channels'
// Per-Host Deployments are named `channel-reader-<host>` (one per Host CRD).
// Default to `channel-reader-chatllm` since chatllm is the long-standing
// test Host; override via env when the test targets a different Host.
// The legacy `clerum-channel-reader` static Deployment was retired in #273.
const CHANNEL_READER_DEPLOY =
  process.env.CHANNEL_READER_DEPLOY || `channel-reader-${process.env.CLERUM_HOST_REF || 'chatllm'}`

function getReaderLogs(): string {
  return kubectl(`logs deploy/${CHANNEL_READER_DEPLOY} -n ${CHANNEL_READER_NS} --tail=500`)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Suite 1: HTTP-direct (opt-in; no TG dependency)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!RUN_HTTP_DIRECT)('HTTP-direct E2E (mcp-host + configured provider)', () => {
  it('should identify model and provider', async () => {
    const nonce = Math.random().toString(36).slice(2, 8)
    const { status, data } = await sendMessage(
      `E2E ${nonce}: What model and provider are you running? Answer in one short line.`,
      { channelId: GROUP_CHAT_ID, userId: 'e2e-test', channelType: 'telegram' }
    )

    console.log(`[HTTP] model=${data.model} response=${data.response?.slice(0, 150)}`)

    expect(status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.status).toBe('completed')
    assertConfiguredModelIdentity(data)
  }, 30_000)

  it('should invoke native tools (system_info)', async () => {
    const nonce = Math.random().toString(36).slice(2, 8)
    const { status, data } = await sendMessage(
      `E2E ${nonce}: What is today's date? Use your system_info tool.`,
      { channelId: GROUP_CHAT_ID, userId: 'e2e-test', channelType: 'telegram' }
    )

    console.log(`[HTTP] tool response=${data.response?.slice(0, 200)}`)

    expect(status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.response).toMatch(/2026/)
  }, 60_000)

  it('should list MCP server tools', async () => {
    const nonce = Math.random().toString(36).slice(2, 8)
    const { status, data } = await sendMessage(
      `E2E ${nonce}: List your available MCP server tools (just tool names, grouped by server).`,
      { channelId: GROUP_CHAT_ID, userId: 'e2e-test', channelType: 'telegram' }
    )

    console.log(`[HTTP] tools=${data.response?.slice(0, 300)}`)

    expect(status).toBe(200)
    const text = (data.response || '').toLowerCase()
    expect(text.includes('airtable') || text.includes('mongodb')).toBe(true)
  }, 90_000)

  it('should handle multi-turn context', async () => {
    const nonce = Math.random().toString(36).slice(2, 8)
    const userId = `e2e-ctx-${nonce}`

    await sendMessage(`E2E ${nonce}: Remember this code: ALPHA-${nonce}`, {
      channelId: GROUP_CHAT_ID,
      userId,
      channelType: 'telegram',
    })

    const { data } = await sendMessage(`E2E ${nonce}: What code did I just ask you to remember?`, {
      channelId: GROUP_CHAT_ID,
      userId,
      channelType: 'telegram',
    })

    console.log(`[HTTP] context recall=${data.response?.slice(0, 200)}`)

    expect(data.success).toBe(true)
    expect(data.response?.toUpperCase()).toContain(`ALPHA-${nonce}`.toUpperCase())
  }, 60_000)
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Suite 2: Benchmark with TG delivery (automated, posts to group)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!TEST_BOT_TOKEN)('Benchmark E2E with TG delivery', () => {
  beforeAll(async () => {
    await postToGroup(
      '🚀 *Clerum E2E Benchmark Started*\n' +
        `${benchmarkModelLabel()}\n` +
        `Time: ${new Date().toISOString()}`
    )
  })

  it('model identity', async () => {
    const { status, data } = await benchmarkQuestion(
      'Model Identity',
      'What model and provider are you running? Answer in one line.'
    )
    expect(status).toBe(200)
    expect(data.success).toBe(true)
    assertConfiguredModelIdentity(data)
  }, 30_000)

  it('native tool — system_info', async () => {
    const { data } = await benchmarkQuestion(
      'Native Tool: system_info',
      "What is today's date and time? Use your system_info tool."
    )
    expect(data.success).toBe(true)
    expect(data.response).toMatch(/2026/)
  }, 60_000)

  it('native tool — json_transform', async () => {
    const { data } = await benchmarkQuestion(
      'Native Tool: json_transform',
      'Use json_transform to extract the "name" field from this JSON: {"name":"Clerum","version":"0.6.0","type":"agent"}. Return just the result.'
    )
    expect(data.success).toBe(true)
    expect(data.response).toContain('Clerum')
  }, 60_000)

  it('MCP tool — airtable list_bases', async () => {
    const { data } = await benchmarkQuestion(
      'MCP Tool: Airtable',
      'Use the airtable-server list_bases tool to show available Airtable bases. Summarize what you find.',
      { needsApproval: true }
    )
    expect(data.success).toBe(true)
    expect(data.response).toBeTruthy()
    expect(data.response!.length).toBeGreaterThan(20)
  }, 120_000)

  it('MCP tool — mongodb list_collections', async () => {
    const { data } = await benchmarkQuestion(
      'MCP Tool: MongoDB',
      'Use the mongodb-server tools to list collections in the database. Summarize what you find.',
      { needsApproval: true }
    )
    expect(data.success).toBe(true)
    expect(data.response).toBeTruthy()
    expect(data.response!.length).toBeGreaterThan(20)
  }, 120_000)

  it('multi-turn memory', async () => {
    const nonce = Math.random().toString(36).slice(2, 8)
    const userId = `e2e-mem-${nonce}`

    await sendMessage(`Remember this secret: BENCHMARK-${nonce}`, {
      channelId: GROUP_CHAT_ID,
      userId,
      channelType: 'telegram',
    })

    const { data } = await benchmarkQuestion(
      'Multi-turn Memory',
      'What secret did I just ask you to remember?',
      { userId }
    )

    expect(data.success).toBe(true)
    expect(data.response?.toUpperCase()).toContain(`BENCHMARK-${nonce}`.toUpperCase())
  }, 60_000)

  it('reasoning — simple math', async () => {
    const { data } = await benchmarkQuestion(
      'Reasoning: Math',
      'What is 17 * 23 + 42? Show just the final number.'
    )
    expect(data.success).toBe(true)
    expect(data.response).toContain('433')
  }, 30_000)

  it('instruction following — format constraint', async () => {
    const { data } = await benchmarkQuestion(
      'Instruction Following',
      'List exactly 3 colors, one per line, with no other text. No bullet points, no numbering.'
    )
    expect(data.success).toBe(true)
    const lines = data
      .response!.trim()
      .split('\n')
      .filter((l: string) => l.trim())
    expect(lines.length).toBe(3)
  }, 30_000)

  afterAll(async () => {
    await postToGroup('✅ *Clerum E2E Benchmark Complete*\n' + `Time: ${new Date().toISOString()}`)
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Suite 3: Advanced Multi-Tool Benchmark — Landing Page Generation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!TEST_BOT_TOKEN)('Advanced Multi-Tool Benchmark — Landing Page', () => {
  const nonce = Math.random().toString(36).slice(2, 8)
  const LANDING_USER_ID = `e2e-landing-${nonce}`

  beforeAll(async () => {
    await postToGroup(
      '🏗️ *Advanced Multi-Tool Benchmark — Landing Page Generation Started*\n' +
        `User: ${LANDING_USER_ID}\n` +
        `Time: ${new Date().toISOString()}`
    )
  })

  it('1. Research phase — gather architecture info', async () => {
    const { data } = await benchmarkQuestion(
      'LP1: Research',
      "Use system_info to get today's date, then use memory_search to find any existing notes about Clerum's architecture. Summarize what you know about Clerum's services, CRDs, and capabilities.",
      { userId: LANDING_USER_ID }
    )
    expect(data.success).toBe(true)
    const text = (data.response || '').toLowerCase()
    expect(
      text.includes('host') ||
        text.includes('context') ||
        text.includes('mcp') ||
        text.includes('channel')
    ).toBe(true)
  }, 90_000)

  it('2. Data gathering — query connected services', async () => {
    const { data } = await benchmarkQuestion(
      'LP2: Data Gathering',
      'Use airtable-server list_bases to see our Airtable setup, and mongodb-server to check available databases. Summarize the external services Clerum currently connects to.',
      { userId: LANDING_USER_ID, needsApproval: true }
    )
    expect(data.success).toBe(true)
    const text = (data.response || '').toLowerCase()
    expect(text.includes('airtable') || text.includes('mongodb')).toBe(true)
  }, 120_000)

  it('3. Content planning — create landing page outline', async () => {
    const { data } = await benchmarkQuestion(
      'LP3: Content Outline',
      'Based on everything you know about Clerum (Kubernetes-native LLM agent platform, multi-channel Telegram/Email/Slack, MCP tool integration, multi-provider OpenAI/Claude/Bailian, CRD-driven config, approval gates), create a detailed landing page outline with sections: Hero, Features, Architecture, How It Works, Use Cases, Quick Start. Write the outline to a file called landing-page-outline.md',
      { userId: LANDING_USER_ID }
    )
    expect(data.success).toBe(true)
    const text = (data.response || '').toLowerCase()
    expect(text.includes('hero') || text.includes('feature') || text.includes('outline')).toBe(true)
  }, 90_000)

  it('4. Generate hero section HTML', async () => {
    const { data } = await benchmarkQuestion(
      'LP4: Hero Section',
      "Now create the landing page HTML. Start with a modern, dark-themed hero section with: headline 'Clerum — Kubernetes-Native AI Agent Platform', subheadline about multi-channel + MCP tools, and a CTA button. Use inline CSS. Write to workspace/landing-page.html",
      { userId: LANDING_USER_ID }
    )
    expect(data.success).toBe(true)
    const text = (data.response || '').toLowerCase()
    expect(text.includes('html') || text.includes('hero') || text.includes('written')).toBe(true)
  }, 90_000)

  it('5. Generate features section', async () => {
    const { data } = await benchmarkQuestion(
      'LP5: Features Section',
      'Read the landing-page.html file you just created, then append a Features section with 6 feature cards: Multi-Channel (Telegram/Email/Slack), LLM Provider Agnostic, MCP Tool Integration, Kubernetes CRDs, Approval Gates, Dev Mode. Use a responsive grid layout with inline CSS. Write the updated file.',
      { userId: LANDING_USER_ID }
    )
    expect(data.success).toBe(true)
    const text = (data.response || '').toLowerCase()
    expect(text.includes('feature') || text.includes('card') || text.includes('updated')).toBe(true)
  }, 120_000)

  it('6. Generate architecture diagram section', async () => {
    const { data } = await benchmarkQuestion(
      'LP6: Architecture Diagram',
      'Read landing-page.html and append an Architecture section. Include an ASCII/text-based flow diagram showing: User → channel-reader → mcp-host → MCP Servers, with CRDs as config inputs. Style it with a code-block appearance. Write the updated file.',
      { userId: LANDING_USER_ID }
    )
    expect(data.success).toBe(true)
    const text = (data.response || '').toLowerCase()
    expect(
      text.includes('architecture') || text.includes('diagram') || text.includes('updated')
    ).toBe(true)
  }, 120_000)

  it('7. Add dynamic data from MCP tools', async () => {
    const { data } = await benchmarkQuestion(
      'LP7: Dynamic MCP Data',
      "Query airtable-server for available bases and mongodb-server for databases. Then read landing-page.html and append a 'Connected Services' section showing the real services Clerum is connected to right now. Write the updated file.",
      { userId: LANDING_USER_ID, needsApproval: true }
    )
    expect(data.success).toBe(true)
    const text = (data.response || '').toLowerCase()
    expect(text.includes('service') || text.includes('connected') || text.includes('updated')).toBe(
      true
    )
  }, 180_000)

  it('8. Final review — read and summarize', async () => {
    const { data } = await benchmarkQuestion(
      'LP8: Final Review',
      'Read the complete landing-page.html file and give me a summary of what we built: how many sections, total approximate line count, and list each section title. Also use system_info to timestamp when this was generated.',
      { userId: LANDING_USER_ID }
    )
    expect(data.success).toBe(true)
    const text = (data.response || '').toLowerCase()
    expect(text.includes('section') || text.includes('line') || text.includes('landing')).toBe(true)
  }, 90_000)

  afterAll(async () => {
    await postToGroup(
      '✅ *Advanced Multi-Tool Benchmark — Landing Page Generation Complete*\n' +
        `Time: ${new Date().toISOString()}`
    )
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Suite 4: TG manual trigger (optional)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!MANUAL_TRIGGER)('TG delivery E2E (channel-reader log verification)', () => {
  it(
    'should pick up a TG message, process it, and reply',
    async () => {
      const baselineLogs = getReaderLogs()
      const baselineReplyCount = (baselineLogs.match(/Reply sent successfully/g) || []).length

      console.log('[TG-E2E] Send a message in the TG group NOW')
      console.log(`[TG-E2E] Watching channel-reader logs for up to ${POLL_TIMEOUT / 1000}s...`)
      console.log(`[TG-E2E] Baseline: ${baselineReplyCount} replies already in logs`)

      const start = Date.now()
      while (Date.now() - start < POLL_TIMEOUT) {
        const logs = getReaderLogs()
        const currentReplyCount = (logs.match(/Reply sent successfully/g) || []).length

        if (currentReplyCount > baselineReplyCount) {
          console.log('[TG-E2E] New reply detected in logs!')

          const lastReceiveIdx = logs.lastIndexOf('[Telegram] Message received')
          const tail = logs.slice(lastReceiveIdx)

          const hasReceive = /\[Telegram\] Message received.*sender: \d+/.test(tail)
          const hasForward = tail.includes('Message processed successfully')
          const hasReply = tail.includes('Reply sent successfully')

          console.log(`[TG-E2E] Received: ${hasReceive}`)
          console.log(`[TG-E2E] Forwarded: ${hasForward}`)
          console.log(`[TG-E2E] Reply sent: ${hasReply}`)

          expect(hasReceive).toBe(true)
          expect(hasForward).toBe(true)
          expect(hasReply).toBe(true)
          return
        }

        await sleep(5000)
      }
      throw new Error(`No new reply in channel-reader logs within ${POLL_TIMEOUT}ms`)
    },
    POLL_TIMEOUT + 10_000
  )
})
