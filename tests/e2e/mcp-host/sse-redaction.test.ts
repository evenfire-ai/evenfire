/**
 * E2E: SSE Redaction Boundary
 *
 * Validates that ConfigStore-managed per-Host secret values are redacted
 * from every SSE progress event reaching subscribers, end-to-end through
 * the full mcp-host pipeline (messageHandler → agent → taskExecutor →
 * SseProgressReporter → HTTP/SSE).
 *
 * Test surface vs. unit canary:
 *   - Unit canary in src/agent/__tests__/taskExecutor.test.ts builds a real
 *     TaskExecutor with mocked LLM and asserts redaction. That covers the
 *     boundary code path but bypasses messageHandler's pre-registration.
 *   - This e2e exercises the WHOLE chain: real K8s Secret → ConfigStore
 *     watch → messageHandler pre-registers reporter with safety →
 *     SSE wire → subscriber. Catches any wiring gap (e.g. the messageHandler
 *     2-arg-form bug found by PR #209 review).
 *
 * Prerequisites:
 *   1. Minikube running with mcp-host deployed from this branch.
 *   2. kubectl context = clerum-test (or override KUBECTL_CONTEXT).
 *   3. Port-forward: `kubectl port-forward svc/chatllm -n mcp-host 8080:8080`.
 *   4. Real LLM API key in chatllm-api-keys (must support shell_exec).
 *
 * Run:
 *   cd tests/e2e && npx vitest run mcp-host/sse-redaction.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import { MCP_HOST_URL, kubectl, sleep } from '../helpers.js'

const require = createRequire(import.meta.url)
const jwt = require('jsonwebtoken')

// Probe value chosen to bypass BasicSafety.SECRET_PATTERNS so the test
// specifically exercises the ConfigStore literal-substring redaction pass.
// Long enough to dodge the <4-char short-secret skip in safety.ts:304.
const PROBE = 'zzPROBEvalueNotMatchingRegex987654321'
const PROBE_KEY = 'PROBE_FOR_REDACTION'
const HOST_REF = 'chatllm'
const NAMESPACE = 'mcp-host'
const SECRET_NAME = `host-${HOST_REF}-env-secret`

interface SseEvent {
  event: string
  data: Record<string, unknown>
}

let authToken: string

/** Sign a cluster-internal JWT directly with control-api's private key. */
function generateClusterJwt(): string {
  const keyB64 = execSync(
    "kubectl --context=clerum-test get secret control-api-secrets -n control-plane -o jsonpath='{.data.CONTROL_API_RPC_JWT_PRIVATE_KEY}'",
    { encoding: 'utf-8' }
  ).replace(/'/g, '')
  const privateKey = Buffer.from(keyB64, 'base64').toString('utf-8')

  return jwt.sign(
    {
      sub: 'e2e-sse-redaction',
      typ: 'user',
      teamId: 'e2e-team',
      scopes: [
        'host:message:invoke',
        'host:task:read',
        'host:activity:read',
        'host:approval:write',
      ],
      hostRefs: [HOST_REF],
      jti: `e2e-sse-redaction-${Date.now()}`,
    },
    privateKey,
    {
      algorithm: 'RS256',
      issuer: 'control-api',
      audience: 'rpc-proxy',
      expiresIn: '1h',
    }
  )
}

/** POST /v1/runtime/messages?async=true and return the new taskId + sender. */
async function postAsyncMessage(content: string): Promise<{ taskId: string; sender: string }> {
  // Per-run unique conversation key avoids tripping over a leftover
  // waiting_approval conversation from prior runs (chatllm has approval
  // enabled for shell_exec on telegram).
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const sender = `e2e-test-${runId}`
  const res = await fetch(`${MCP_HOST_URL}/v1/runtime/messages?async=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      content,
      hostRef: HOST_REF,
      channelId: `e2e-redaction-${runId}`,
      sender,
      channelType: 'telegram',
      timestamp: new Date().toISOString(),
      messageId: `e2e-redact-${runId}`,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`async POST failed: status=${res.status} body=${text}`)
  }
  const body = (await res.json()) as { taskId?: string; success?: boolean }
  if (!body.taskId) {
    throw new Error(`async POST returned no taskId: ${JSON.stringify(body)}`)
  }
  return { taskId: body.taskId, sender }
}

/** POST /v1/runtime/approvals/approve. */
async function approveRequest(userId: string, requestId: string): Promise<void> {
  const res = await fetch(`${MCP_HOST_URL}/v1/runtime/approvals/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ userId, requestId, alwaysApprove: true }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`approve failed: status=${res.status} body=${text}`)
  }
}

/**
 * Subscribe to /progress/stream and collect events until terminal/timeout.
 * Auto-approves any `suspended` event using the provided sender userId so the
 * task can complete and emit tool_complete + terminal events.
 */
async function collectSseEvents(
  taskId: string,
  senderUserId: string,
  timeoutMs: number
): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  const url = `${MCP_HOST_URL}/v1/runtime/tasks/${taskId}/progress/stream`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Authorization: `Bearer ${authToken}` },
    })
    if (!res.ok || !res.body) {
      throw new Error(`SSE open failed: status=${res.status}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const lines = block.split('\n')
        let eventName = ''
        let dataLine = ''
        for (const l of lines) {
          if (l.startsWith('event: ')) eventName = l.slice(7).trim()
          if (l.startsWith('data: ')) dataLine = l.slice(6)
        }
        if (eventName && dataLine) {
          let parsed: Record<string, unknown> | null = null
          try {
            parsed = JSON.parse(dataLine)
            events.push({ event: eventName, data: parsed! })
          } catch {
            // ignore non-JSON keepalives
          }

          // Approve gated tools so the loop can resume and emit
          // tool_complete + terminal. Errors here are forwarded so the
          // assertion sees a clear failure rather than a timeout.
          if (eventName === 'suspended' && parsed && typeof parsed.requestId === 'string') {
            await approveRequest(senderUserId, parsed.requestId as string)
          }

          if (eventName === 'terminal') {
            reader.cancel()
            return events
          }
        }
      }
    }
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      // Timed out — return whatever we got so the assertions can diagnose.
      return events
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
  return events
}

/** GET /v1/runtime/tasks/:taskId/result with auth. */
async function getTaskResultAuthed(taskId: string, timeoutMs: number): Promise<unknown> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${MCP_HOST_URL}/v1/runtime/tasks/${taskId}/result`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    if (res.ok) {
      const data = (await res.json()) as { status?: string; response?: string }
      if (data.status === 'completed' || data.response) {
        return data
      }
    }
    await sleep(1000)
  }
  return null
}

describe('SSE redaction e2e — boundary chokepoint', () => {
  beforeAll(async () => {
    authToken = generateClusterJwt()

    // Recreate the per-Host env Secret so the probe is the only entry.
    try {
      kubectl(`delete secret ${SECRET_NAME} -n ${NAMESPACE} --ignore-not-found`)
    } catch {
      /* ignore */
    }
    kubectl(
      `create secret generic ${SECRET_NAME} -n ${NAMESPACE} --from-literal=${PROBE_KEY}=${PROBE}`
    )
    // ConfigStore watches the Secret; give the watch event a moment to land.
    await sleep(3000)
  })

  afterAll(() => {
    try {
      kubectl(`delete secret ${SECRET_NAME} -n ${NAMESPACE} --ignore-not-found`)
    } catch {
      /* ignore */
    }
  })

  it('does not leak ConfigStore probe through any SSE event payload', async () => {
    // Ask the LLM to run an explicit shell command containing the probe.
    // This forces the probe into both inputPreview (tool args) and
    // outputPreview (echo result) — two of the leak vectors closed by this
    // branch.
    const { taskId, sender } = await postAsyncMessage(
      `Run this exact shell command verbatim and report the output: echo ${PROBE}`
    )

    const events = await collectSseEvents(taskId, sender, 120_000)

    // Sanity 1: a terminal event was reached (not just a timeout return).
    const types = new Set(events.map(e => e.event))
    expect(types.has('terminal'), `no terminal event captured. types=${[...types].join(',')}`).toBe(
      true
    )

    // Sanity 2: at least one tool_start or tool_complete fired — otherwise the
    // LLM didn't call a tool and the redaction assertion would pass vacuously.
    expect(
      types.has('tool_start') || types.has('tool_complete'),
      `no tool events captured — LLM may not have called shell_exec. events=${JSON.stringify(events).slice(0, 500)}`
    ).toBe(true)

    // Primary assertion: probe NEVER appears in any captured event payload.
    const allText = JSON.stringify(events)
    expect(
      allText.includes(PROBE),
      `PROBE leaked in an SSE event payload — boundary redaction is broken. events=${allText.slice(0, 1500)}`
    ).toBe(false)

    // Secondary: redacted marker is present somewhere — proves redaction
    // actually fired. Without this, a silent-drop regression (e.g., a future
    // change that strips the field entirely) would pass the primary assertion
    // for the wrong reason.
    expect(allText).toContain(`[REDACTED:${PROBE_KEY}]`)

    // Bonus: the final task response (result endpoint) is also redacted.
    // sanitizeAssistantResponse covers this path; not part of the SSE
    // boundary, but cheap to assert here.
    const result = await getTaskResultAuthed(taskId, 30_000)
    expect(JSON.stringify(result)).not.toContain(PROBE)
  }, 180_000)
})
