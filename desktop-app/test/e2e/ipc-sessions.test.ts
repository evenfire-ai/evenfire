/**
 * Session isolation E2E tests.
 *
 * Validates that threadId-based session routing works end-to-end:
 * IPC harness → rpc-proxy → mcp-host → LLM → response.
 *
 * Prerequisites:
 * - Cluster running with session management code deployed
 * - Port-forwards: external-rest-api:8091, rpc-proxy:8094
 * - .env.e2e configured
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  E2E_EMAIL,
  E2E_HOST_REF,
  E2E_PASSWORD,
  invoke,
  setupHarness,
  teardownHarness,
  waitForIdle,
} from './helpers.js'

// ── Helper: send message with threadId and wait for LLM response ────

async function sendAndWait(
  content: string,
  threadId?: string,
  timeoutMs = 45_000
): Promise<string> {
  const payload: Record<string, unknown> = {
    content,
    channelType: 'rpc',
    sender: 'e2e-test',
  }
  if (threadId !== undefined) {
    payload.threadId = threadId
  }

  const result = (await invoke('rpc:invokeHostMessage', {
    hostRef: E2E_HOST_REF,
    payload,
    hostRefs: [E2E_HOST_REF],
    options: { async: true },
  })) as { taskId?: string; response?: string }

  // Synchronous response (rare, but handle it)
  if (!result.taskId) {
    return result.response ?? JSON.stringify(result)
  }

  // Async: poll until agent is idle, then fetch result
  await waitForIdle(E2E_HOST_REF, timeoutMs)

  const taskResult = (await invoke('rpc:getTaskResult', {
    hostRef: E2E_HOST_REF,
    taskId: result.taskId,
    hostRefs: [E2E_HOST_REF],
  })) as { response?: string } | null

  if (!taskResult?.response) {
    throw new Error(`No response for task ${result.taskId}`)
  }
  return taskResult.response
}

// ── Setup ───────────────────────────────────────────────────────────

describe('Session isolation e2e', () => {
  beforeAll(async () => {
    await setupHarness()
    await invoke('auth:passwordLogin', { email: E2E_EMAIL, password: E2E_PASSWORD })
  })

  afterAll(async () => {
    await teardownHarness()
  })

  // ════════════════════════════════════════════════════════════════════
  // Suite 1: Session Routing
  // ════════════════════════════════════════════════════════════════════

  describe('Suite 1: Session routing', () => {
    it('1. same threadId preserves conversation context', async () => {
      const session = randomUUID()
      const code = `ALPHA-${randomUUID().slice(0, 8).toUpperCase()}`

      await sendAndWait(
        `The passphrase for THIS conversation is: ${code}. Just say "confirmed".`,
        session
      )
      const response = await sendAndWait(
        'What passphrase did I give you in THIS conversation?',
        session
      )

      expect(response.toUpperCase()).toContain(code)
    }, 60_000)

    it('2. different threadId isolates conversation context', async () => {
      const sessionA = randomUUID()
      const sessionB = randomUUID()
      const secret = `XRAY-${randomUUID().slice(0, 8).toUpperCase()}`

      await sendAndWait(
        `The secret passphrase for THIS conversation is: ${secret}. Just say "confirmed".`,
        sessionA
      )
      const response = await sendAndWait(
        'What is the secret passphrase I gave you in THIS conversation? If I never gave you one in this conversation, reply with exactly the word: NONE',
        sessionB
      )

      expect(response.toUpperCase()).toContain('NONE')
    }, 60_000)

    it('3. two sessions coexist independently', async () => {
      const sessionA = randomUUID()
      const sessionB = randomUUID()
      const codeA = `FOXTROT-${randomUUID().slice(0, 6).toUpperCase()}`
      const codeB = `TANGO-${randomUUID().slice(0, 6).toUpperCase()}`

      // Establish context in both sessions
      await sendAndWait(
        `The passphrase for THIS conversation is: ${codeA}. Just say "confirmed".`,
        sessionA
      )
      await sendAndWait(
        `The passphrase for THIS conversation is: ${codeB}. Just say "confirmed".`,
        sessionB
      )

      // Query each session — must see only its own passphrase
      const responseA = await sendAndWait(
        'What passphrase did I give you in THIS conversation?',
        sessionA
      )
      const responseB = await sendAndWait(
        'What passphrase did I give you in THIS conversation?',
        sessionB
      )

      expect(responseA.toUpperCase()).toContain(codeA)
      expect(responseA.toUpperCase()).not.toContain(codeB)
      expect(responseB.toUpperCase()).toContain(codeB)
      expect(responseB.toUpperCase()).not.toContain(codeA)
    }, 60_000)
  })

  // ════════════════════════════════════════════════════════════════════
  // Suite 2: Multi-turn session integrity
  // ════════════════════════════════════════════════════════════════════

  describe('Suite 2: Multi-turn session integrity', () => {
    it('4. 3-turn conversation coherence within a session', async () => {
      const session = randomUUID()

      await sendAndWait(
        'I am building a React app with TypeScript. Remember these two facts.',
        session
      )

      const r2 = await sendAndWait('What framework am I using?', session)
      expect(r2.toLowerCase()).toContain('react')

      const r3 = await sendAndWait('And what language?', session)
      expect(r3.toLowerCase()).toContain('typescript')
    }, 60_000)

    it('5. cross-session context leak under interleaved messages', async () => {
      const sessionA = randomUUID()
      const sessionB = randomUUID()
      const nameA = `Zephyr-${randomUUID().slice(0, 4)}`
      const nameB = `Quasar-${randomUUID().slice(0, 4)}`

      // Interleave context setup between sessions
      await sendAndWait(
        `In THIS conversation, my name is ${nameA}. Just say "hello ${nameA}".`,
        sessionA
      )
      await sendAndWait(
        `In THIS conversation, my name is ${nameB}. Just say "hello ${nameB}".`,
        sessionB
      )

      // Query A — must see nameA, not nameB
      const responseA = await sendAndWait(
        'What is my name that I told you in THIS conversation?',
        sessionA
      )
      expect(responseA).toContain(nameA)
      expect(responseA).not.toContain(nameB)

      // Query B — must see nameB, not nameA
      const responseB = await sendAndWait(
        'What is my name that I told you in THIS conversation?',
        sessionB
      )
      expect(responseB).toContain(nameB)
      expect(responseB).not.toContain(nameA)
    }, 60_000)

    it('6. session survives across async polling cycles', async () => {
      const session = randomUUID()
      const keyword = `NEBULA-${randomUUID().slice(0, 6).toUpperCase()}`

      // First async round-trip — establish context
      await sendAndWait(
        `The keyword for THIS conversation is: ${keyword}. Just say "keyword saved".`,
        session
      )

      // Second async round-trip — same session, verify context survived
      const r2 = await sendAndWait('What keyword did I give you in THIS conversation?', session)
      expect(r2.toUpperCase()).toContain(keyword)
    }, 60_000)
  })

  // ════════════════════════════════════════════════════════════════════
  // Suite 3: Edge cases
  // ════════════════════════════════════════════════════════════════════

  describe('Suite 3: Edge cases', () => {
    it('7. no threadId falls back to default session', async () => {
      // Both messages omit threadId — should share the default session
      await sendAndWait('Remember the color: blue. Just confirm.', undefined)
      const response = await sendAndWait('What color did I mention?', undefined)

      expect(response.toLowerCase()).toContain('blue')
    }, 60_000)

    it('8. empty string threadId treated same as missing', async () => {
      // First message with empty string threadId
      await sendAndWait('Remember the number 42. Just confirm.', '')
      // Second message with undefined threadId — should be same session
      const response = await sendAndWait('What number did I mention?', undefined)

      expect(response).toContain('42')
    }, 60_000)
  })

  // ════════════════════════════════════════════════════════════════════
  // Suite 4: Concurrent execution
  // ════════════════════════════════════════════════════════════════════

  describe('Suite 4: Concurrent execution', () => {
    /**
     * Send a message async and return the taskId without waiting for completion.
     */
    async function sendAsync(content: string, threadId: string): Promise<string> {
      const payload: Record<string, unknown> = {
        content,
        channelType: 'rpc',
        sender: 'e2e-test',
        threadId,
      }
      const result = (await invoke('rpc:invokeHostMessage', {
        hostRef: E2E_HOST_REF,
        payload,
        hostRefs: [E2E_HOST_REF],
        options: { async: true },
      })) as { taskId?: string }

      if (!result.taskId) throw new Error('Expected async taskId')
      return result.taskId
    }

    /**
     * Poll for a task result until it appears or timeout.
     */
    async function pollResult(taskId: string, timeoutMs = 45_000): Promise<string> {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        try {
          const result = (await invoke('rpc:getTaskResult', {
            hostRef: E2E_HOST_REF,
            taskId,
            hostRefs: [E2E_HOST_REF],
          })) as { response?: string } | null
          if (result?.response) return result.response
        } catch {
          // Task not ready yet
        }
        await new Promise(r => setTimeout(r, 1000))
      }
      throw new Error(`Task ${taskId} did not complete within ${timeoutMs}ms`)
    }

    it('9. two sessions process concurrently without blocking', async () => {
      const sessionA = randomUUID()
      const sessionB = randomUUID()

      // Send both messages immediately — don't wait between them
      const taskIdA = await sendAsync(
        'List exactly 3 benefits of TypeScript in one sentence each. Be brief.',
        sessionA
      )
      const taskIdB = await sendAsync(
        'List exactly 3 benefits of Python in one sentence each. Be brief.',
        sessionB
      )

      // Wait for agent to finish all tasks
      await waitForIdle(E2E_HOST_REF, 45_000)

      // Fetch both results
      const responseA = await pollResult(taskIdA)
      const responseB = await pollResult(taskIdB)

      // Both should have completed with meaningful responses
      expect(responseA.length).toBeGreaterThan(50)
      expect(responseB.length).toBeGreaterThan(50)
      // Responses should be different (not the same content served to both)
      expect(responseA).not.toBe(responseB)
    }, 60_000)

    it('10. different users process concurrently without blocking', async () => {
      const RPC_PROXY = process.env.RPC_PROXY_BASE_URL || 'http://localhost:8094'
      const EXT_API = process.env.EXTERNAL_REST_API_BASE_URL || 'http://localhost:8091'

      // Helper: get an RPC token for a user via direct HTTP
      async function getRpcToken(email: string): Promise<string> {
        const loginResp = await fetch(`${EXT_API}/api/v1/auth/password-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: E2E_PASSWORD }),
        })
        const loginText = await loginResp.text()
        expect(loginResp.status, loginText).toBe(200)
        const loginData = JSON.parse(loginText) as { token: string }

        const tokenResp = await fetch(`${EXT_API}/api/v1/rpc/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${loginData.token}`,
          },
          body: JSON.stringify({
            scopes: ['host:message:invoke'],
            hostRefs: [E2E_HOST_REF],
          }),
        })
        const tokenText = await tokenResp.text()
        expect(tokenResp.status, tokenText).toBe(200)
        const tokenData = JSON.parse(tokenText) as { token: string }
        return tokenData.token
      }

      // Helper: send async message via direct HTTP to rpc-proxy
      async function sendDirect(
        rpcToken: string,
        content: string,
        threadId: string
      ): Promise<string> {
        const resp = await fetch(
          `${RPC_PROXY}/api/v1/rpc/hosts/${E2E_HOST_REF}/messages?async=true`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${rpcToken}`,
            },
            body: JSON.stringify({ content, channelType: 'rpc', sender: 'e2e-test', threadId }),
          }
        )
        const text = await resp.text()
        expect(resp.status, text).toBe(200)
        const data = JSON.parse(text) as { taskId?: string }
        if (!data.taskId) throw new Error('Expected async taskId')
        return data.taskId
      }

      // Helper: poll task result via direct HTTP
      async function pollDirect(
        rpcToken: string,
        taskId: string,
        timeoutMs = 45_000
      ): Promise<string> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          const resp = await fetch(
            `${RPC_PROXY}/api/v1/rpc/hosts/${E2E_HOST_REF}/tasks/${taskId}/result`,
            { headers: { Authorization: `Bearer ${rpcToken}` } }
          )
          const text = await resp.text()
          if (resp.status === 200) {
            const data = JSON.parse(text) as { response?: string }
            if (data?.response) return data.response
          } else if (resp.status !== 404) {
            throw new Error(`Task result failed with HTTP ${resp.status}: ${text}`)
          }
          await new Promise(r => setTimeout(r, 1000))
        }
        throw new Error(`Task ${taskId} did not complete within ${timeoutMs}ms`)
      }

      // Get separate RPC tokens for two real users
      const aliceToken = await getRpcToken('dev@clerum.local')
      const bobToken = await getRpcToken('bob@clerum.local')

      const aliceThread = randomUUID()
      const bobThread = randomUUID()

      // Send both messages simultaneously — different users, different tokens
      const [aliceTaskId, bobTaskId] = await Promise.all([
        sendDirect(aliceToken, 'Say exactly: ALICE_OK', aliceThread),
        sendDirect(bobToken, 'Say exactly: BOB_OK', bobThread),
      ])

      // Wait for agent to finish
      await waitForIdle(E2E_HOST_REF, 45_000)

      // Fetch both results with their respective tokens
      const aliceResp = await pollDirect(aliceToken, aliceTaskId)
      const bobResp = await pollDirect(bobToken, bobTaskId)

      // Both users got responses
      expect(aliceResp.length).toBeGreaterThan(0)
      expect(bobResp.length).toBeGreaterThan(0)
    }, 60_000)

    it('11. /bg background task does not block interactive session', async () => {
      const interactiveSession = randomUUID()

      // Send a /bg task — should return immediately with taskId (async)
      const bgPayload: Record<string, unknown> = {
        content:
          '/bg List 10 popular programming languages with a one-sentence description for each.',
        channelType: 'rpc',
        sender: 'e2e-test',
        threadId: randomUUID(), // threadId doesn't matter — /bg creates ephemeral session
      }
      const bgResult = (await invoke('rpc:invokeHostMessage', {
        hostRef: E2E_HOST_REF,
        payload: bgPayload,
        hostRefs: [E2E_HOST_REF],
        options: { async: true },
      })) as { taskId?: string; status?: string }

      // /bg should return immediately with pending status
      expect(bgResult.taskId).toBeTruthy()

      // NOW send an interactive message — should not be blocked by the /bg task
      const interactiveResponse = await sendAndWait(
        'Say exactly: INTERACTIVE_OK',
        interactiveSession
      )

      // Interactive response came back while /bg is potentially still running
      expect(interactiveResponse.toUpperCase()).toContain('INTERACTIVE_OK')

      // Background task should also eventually complete
      await waitForIdle(E2E_HOST_REF, 45_000)
      const bgTaskResult = (await invoke('rpc:getTaskResult', {
        hostRef: E2E_HOST_REF,
        taskId: bgResult.taskId,
        hostRefs: [E2E_HOST_REF],
      })) as { response?: string } | null

      expect(bgTaskResult?.response).toBeTruthy()
      expect(bgTaskResult!.response!.length).toBeGreaterThan(50)
    }, 60_000)

    it('12. approval on one session does not block another session', async () => {
      const approvalSession = randomUUID()
      const freeSession = randomUUID()

      // Session A: Ask the LLM to use the mock-echo-server tool
      // This should trigger approval since MCP tools require it
      const approvalTaskId = await sendAsync(
        "Use the mock-echo-server__echo tool to echo the text 'hello world'. You MUST call this tool.",
        approvalSession
      )

      // Give the agent a moment to process and hit the approval gate
      await new Promise(r => setTimeout(r, 5000))

      // Session B: Send a simple message that doesn't need tools
      // Use sendAsync + pollResult since waitForIdle won't work
      // (agent is "awaiting_approval" from Session A)
      const freeTaskId = await sendAsync('Say exactly: FREE_SESSION_OK', freeSession)

      // Poll for Session B's result — it should complete even though A is blocked
      const freeResponse = await pollResult(freeTaskId)

      // Session B completed while Session A is still awaiting approval
      expect(freeResponse.toUpperCase()).toContain('FREE_SESSION_OK')

      // Cleanup: check for pending approvals and deny them so subsequent tests
      // can use waitForIdle (which requires agent state === "idle")
      const statusResp = (await invoke('rpc:getHostStatus', {
        hostRef: E2E_HOST_REF,
        hostRefs: [E2E_HOST_REF],
      })) as { pendingApprovals?: Array<{ requestId: string }> }

      if (statusResp.pendingApprovals) {
        for (const approval of statusResp.pendingApprovals) {
          await invoke('rpc:denyApproval', {
            hostRef: E2E_HOST_REF,
            userId: 'e2e-test',
            requestId: approval.requestId,
            hostRefs: [E2E_HOST_REF],
          }).catch(() => {
            /* best effort */
          })
        }
      }
      // Wait for agent to settle after denial
      await waitForIdle(E2E_HOST_REF, 10_000).catch(() => {})
    }, 60_000)
  })
})
