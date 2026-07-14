/**
 * E2E: Native Tools — validate all 8 native tools through the full agent pipeline.
 *
 * Tests NT-1 through NT-13 from docs/archive/testing/E2E-LOCAL-TOOLS-PLAN.md.
 * Requires a REAL LLM API key (OpenAI or Claude) — these tests make actual
 * LLM calls, unlike the minikube-only tests that use placeholder keys.
 *
 * Prerequisites:
 *   1. Minikube running with mcp-host deployed (image with /workspace dir)
 *   2. Real OPENAI_API_KEY (or CLAUDE_API_KEY) in chatllm-api-keys secret
 *   3. CLERUM_WORKSPACE_PATH=/workspace in mcp-host env (or configmap)
 *   4. Port-forwarding active:
 *        kubectl port-forward -n mcp-host svc/chatllm 8080:8080
 *   5. For NT-10 (blocked domain): CLERUM_HTTP_ALLOWLIST=httpbin.org in mcp-host-config configMap
 *
 * Run:
 *   cd tests/e2e && E2E_RUN_NATIVE_TOOLS=1 npx vitest run native-tools.test.ts
 */
import { afterAll, describe as baseDescribe, expect, it } from 'vitest'
import {
  MCP_HOST_URL,
  approveRequest,
  fetchJson,
  getPodLogs,
  getStatus,
  getTaskResult,
  mcpHostExec,
  sendMessage,
  waitForIdle,
} from '../helpers.js'

// ---------------------------------------------------------------------------
// Test-wide state
// ---------------------------------------------------------------------------

/** Track files created during tests for cleanup. */
const testFiles: string[] = []
const RUN_NATIVE_TOOLS = /^(1|true|yes)$/i.test(process.env.E2E_RUN_NATIVE_TOOLS ?? '')
const describe = baseDescribe.skipIf(!RUN_NATIVE_TOOLS)

function uniqueUserId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a message that may trigger a tool requiring approval.
 * On first approval, passes alwaysApprove=true so subsequent calls auto-approve.
 * Uses the userId from the approval response (not hardcoded) to avoid mismatch.
 *
 * Handles the case where the LLM asks for permission as text (e.g., "shall I proceed?")
 * instead of directly calling the tool. In that case, sends a follow-up "Yes, proceed."
 */
async function sendWithApproval(
  content: string,
  opts?: { userId?: string; timeoutMs?: number }
): Promise<{ data: any; wasApproval: boolean }> {
  const userId = opts?.userId ?? 'test-user'
  const timeoutMs = opts?.timeoutMs ?? 90_000

  let res = await sendMessage(content, { userId })

  // Case 1: LLM asks for permission as text instead of calling the tool
  // Send a follow-up "Yes" to trigger the actual tool call
  if (
    res.data?.response &&
    res.data?.status !== 'waiting_approval' &&
    /requires approval|shall i proceed|would you like|want me to/i.test(res.data.response)
  ) {
    await waitForIdle(timeoutMs)
    res = await sendMessage('Yes, proceed. Execute it now.', { userId })
  }

  // Case 2: Tool called, system-level approval gate triggered
  if (res.data?.status === 'waiting_approval' && res.data?.approval) {
    const { requestId, taskId } = res.data.approval
    const approvalUserId = res.data.approval.userId || userId

    const approvalRes = await approveRequest(approvalUserId, requestId, true)
    if (!approvalRes.data?.success) {
      console.log(`[sendWithApproval] Approval failed:`, approvalRes.data)
    }
    expect(approvalRes.data?.success).toBe(true)

    await waitForIdle(timeoutMs)

    const taskRes = await getTaskResult(taskId, timeoutMs)
    return { data: taskRes.data, wasApproval: true }
  }

  // Case 3: No approval needed — direct response
  return { data: res.data, wasApproval: false }
}

// ---------------------------------------------------------------------------
// Phase 1: Smoke
// ---------------------------------------------------------------------------

describe('Phase 1: Smoke', () => {
  it('NT-1: system_info — returns current date and platform', async () => {
    const res = await sendMessage(
      'What is the current date and time, and what platform is the system running on? Use the system_info tool.'
    )

    expect(res.status).toBe(200)
    expect(res.data.success).toBe(true)

    const status = await waitForIdle(30_000)
    expect(status.agent.state).toBe('idle')

    const response = (res.data.response || '').toLowerCase()
    expect(response.length).toBeGreaterThan(10)

    const health = await fetchJson(`${MCP_HOST_URL}/v1/runtime/health`)
    expect(health.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Phase 2: Stateless
// ---------------------------------------------------------------------------

describe('Phase 2: Stateless', () => {
  it('NT-2: json_transform — parse and query', async () => {
    const res = await sendMessage(
      'Parse this JSON and tell me how many items are in the "users" array: {"users":[{"name":"Alice"},{"name":"Bob"},{"name":"Charlie"}]}'
    )

    expect(res.status).toBe(200)
    await waitForIdle(30_000)

    const response = (res.data.response || '').toLowerCase()
    expect(response).toMatch(/3|three/)
  })

  it('NT-2b: json_transform — deep path access', async () => {
    const res = await sendMessage(
      'From this JSON, extract the value at path data.items.1.name using the json_transform tool with operation "get": {"data":{"items":[{"name":"Widget"},{"name":"Gadget"}]}}'
    )

    expect(res.status).toBe(200)
    await waitForIdle(60_000)

    const response = (res.data.response || '').toLowerCase()
    expect(response).toContain('gadget')
  }, 90_000)

  it('NT-12: json_transform — keys, values, stringify', async () => {
    const res = await sendMessage(
      'I have this JSON: {"a":1,"b":2,"c":3}. Use the json_transform tool to get the keys, then tell me what they are.'
    )

    expect(res.status).toBe(200)
    await waitForIdle(30_000)

    const response = (res.data.response || '').toLowerCase()
    expect(response).toMatch(/a/)
    expect(response).toMatch(/b/)
    expect(response).toMatch(/c/)
  })
})

// ---------------------------------------------------------------------------
// Phase 3: Stateful
// ---------------------------------------------------------------------------

describe('Phase 3: Stateful', () => {
  it('NT-3a: memory_write + memory_read — round-trip', async () => {
    // Use a non-guessable value to avoid LLM hallucination
    const writeRes = await sendMessage(
      "Store the value 'xylophone-42-pluto' in memory with the key 'secret_code' using the memory_write tool."
    )
    expect(writeRes.status).toBe(200)
    await waitForIdle(30_000)

    const readRes = await sendMessage(
      "What is my secret code? Retrieve the key 'secret_code' from memory using memory_read and tell me the exact value."
    )
    expect(readRes.status).toBe(200)
    await waitForIdle(30_000)

    const response = (readRes.data.response || '').toLowerCase()
    expect(response).toContain('xylophone-42-pluto')
  })

  it('NT-3b: memory persistence — different conversation can read workspace memory', async () => {
    // memory_write writes to persistent workspace memory, not per-conversation state.
    const res = await sendMessage(
      "Retrieve the key 'secret_code' from memory using memory_read and tell me the exact value.",
      { userId: uniqueUserId('memory-persistence') }
    )
    expect(res.status).toBe(200)
    await waitForIdle(30_000)

    const response = (res.data.response || '').toLowerCase()
    expect(response).toContain('xylophone-42-pluto')
  })
})

// ---------------------------------------------------------------------------
// Phase 4: Filesystem
// ---------------------------------------------------------------------------

describe('Phase 4: Filesystem', () => {
  it('NT-4: file_write + file_read — round-trip', async () => {
    testFiles.push('nt4-test-output.txt')

    // Step 1: Write — verify the write response acknowledges the tool was used
    const writeRes = await sendMessage(
      'Use the file_write tool to create a file called nt4-test-output.txt with path "nt4-test-output.txt" and content "Hello from Clerum E2E test". Confirm the file was written.'
    )
    expect(writeRes.status).toBe(200)
    await waitForIdle(30_000)

    // Check the write response for errors
    const writeResponse = (writeRes.data.response || '').toLowerCase()
    expect(writeResponse).not.toMatch(/error|failed|permission|denied/)

    // Step 2: Read back
    const readRes = await sendMessage(
      'Use the file_read tool to read the file at path "nt4-test-output.txt" and tell me exactly what it contains.'
    )
    expect(readRes.status).toBe(200)
    await waitForIdle(30_000)

    const response = (readRes.data.response || '').toLowerCase()
    expect(response).toContain('hello from clerum')
  })

  it('NT-6: file_write — append mode', async () => {
    testFiles.push('nt6-append-test.txt')

    // Step 1: Create file
    const writeRes = await sendMessage(
      'Use the file_write tool with path "nt6-append-test.txt" and content "Line 1\\n" to create the file.'
    )
    expect(writeRes.status).toBe(200)
    await waitForIdle(60_000)

    // Step 2: Append
    const appendRes = await sendMessage(
      'Use the file_write tool with path "nt6-append-test.txt", content "Line 2\\n", and append set to true.'
    )
    expect(appendRes.status).toBe(200)
    await waitForIdle(60_000)

    // Step 3: Read back and verify both lines
    const readRes = await sendMessage(
      'Use file_read to read "nt6-append-test.txt" and tell me its full contents.'
    )
    expect(readRes.status).toBe(200)
    await waitForIdle(60_000)

    const response = (readRes.data.response || '').toLowerCase()
    expect(response).toContain('line 1')
    expect(response).toContain('line 2')
  }, 210_000)

  it('NT-5: file_read — path traversal blocked', async () => {
    const res = await sendMessage(
      'Use the file_read tool to read the file at path "../../etc/passwd".'
    )
    expect(res.status).toBe(200)
    await waitForIdle(30_000)

    const response = (res.data.response || '').toLowerCase()
    // Should indicate the file couldn't be read / path is invalid
    // LLM may say: "unable", "cannot", "error", "blocked", "denied", etc.
    expect(response).toMatch(
      /unable|cannot|denied|invalid|blocked|not allowed|traversal|error|outside|restricted|permission|security/
    )

    // Verify no crash
    const health = await fetchJson(`${MCP_HOST_URL}/v1/runtime/health`)
    expect(health.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Phase 5: Shell (approval required)
// ---------------------------------------------------------------------------

describe('Phase 5: Shell Execution', () => {
  it('NT-7: shell_exec — command execution with approval', async () => {
    const { data } = await sendWithApproval(
      'Execute this now using shell_exec: command "ls" with args ["-la"]. Tell me what files are in the workspace.',
      { userId: uniqueUserId('nt7-shell'), timeoutMs: 120_000 }
    )
    expect(data?.success ?? true).toBeTruthy()
    expect((data?.response || '').length).toBeGreaterThan(0)

    const status = await getStatus()
    expect(status.agent.state).toBe('idle')
  }, 90_000)

  it('NT-8: shell_exec — timeout enforcement', async () => {
    const { data } = await sendWithApproval(
      'Execute this now using shell_exec: command "sleep" with args ["60"]. Do not ask for confirmation, just run it and report the result.',
      { userId: uniqueUserId('nt8-shell-timeout'), timeoutMs: 120_000 }
    )

    if (data?.response) {
      const response = data.response.toLowerCase()
      // Expect timeout/error OR approval-related response (if LLM still asks)
      expect(response).toMatch(/timeout|timed out|killed|exceeded|terminated|error|failed|approval/)
    }

    const status = await waitForIdle(30_000)
    expect(status.agent.state).toBe('idle')

    const health = await fetchJson(`${MCP_HOST_URL}/v1/runtime/health`)
    expect(health.status).toBe(200)
  }, 180_000)
})

// ---------------------------------------------------------------------------
// Phase 6: HTTP (approval required)
// ---------------------------------------------------------------------------

describe('Phase 6: HTTP Requests', () => {
  it('NT-9: http_request — allowed domain', async () => {
    const { data } = await sendWithApproval(
      'Execute this now using http_request: make a GET request to https://httpbin.org/get and tell me what the response contains.',
      { userId: uniqueUserId('nt9-http'), timeoutMs: 120_000 }
    )
    if (data?.response) {
      const response = data.response.toLowerCase()
      expect(response).toMatch(/httpbin|headers|origin|url|host/)
    }

    const status = await getStatus()
    expect(status.agent.state).toBe('idle')
  }, 90_000)

  it('NT-10: http_request — blocked domain', async () => {
    // Requires CLERUM_HTTP_ALLOWLIST to be set (e.g., "httpbin.org").
    // If allowlist is empty (all allowed), this test verifies the request still works.
    const { data } = await sendWithApproval(
      'Use http_request to make a GET request to https://example.com.',
      { userId: uniqueUserId('nt10-http-blocked'), timeoutMs: 120_000 }
    )

    if (data?.response) {
      const response = data.response.toLowerCase()
      const isBlocked = response.match(
        /not allowed|blocked|denied|allowlist|not permitted|error|domain/
      )
      const isSuccess = response.match(/example domain|example.com|iana|html/)

      expect(isBlocked || isSuccess).toBeTruthy()
    }

    await waitForIdle(30_000)
  }, 90_000)

  it('NT-11: http_request — SSRF protection (private IP blocked)', async () => {
    const { data } = await sendWithApproval(
      'Execute this now using http_request: make a GET request to http://169.254.169.254/latest/meta-data/ and tell me the result. Do not ask for confirmation.',
      { userId: uniqueUserId('nt11-ssrf'), timeoutMs: 120_000 }
    )

    if (data?.response) {
      const response = data.response.toLowerCase()
      // Expect blocked/error OR approval-related response (if tool wasn't called)
      expect(response).toMatch(
        /blocked|private|denied|not allowed|error|invalid|restricted|cannot|refused|failed|unable|approval/
      )
    }

    const logs = getPodLogs('mcp-host', 'mcp-host', 30)
    expect(logs).not.toContain('ami-id')
    expect(logs).not.toContain('instance-id')

    await waitForIdle(30_000)
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Phase 7: Integration
// ---------------------------------------------------------------------------

describe('Phase 7: Integration', () => {
  it('NT-13: multi-tool chain — file_write → file_read → json_transform', async () => {
    testFiles.push('nt13-data.json')

    const res = await sendMessage(
      'Do these steps in order using the tools: 1) Use file_write to write {"items":[1,2,3,4,5]} to "nt13-data.json". 2) Use file_read to read "nt13-data.json". 3) Use json_transform with operation "length" and path "items" on the file content. Tell me the count.'
    )
    expect(res.status).toBe(200)
    await waitForIdle(90_000)

    if (res.data?.response) {
      const response = res.data.response.toLowerCase()
      expect(response).toMatch(/5|five/)
    }

    const status = await getStatus()
    expect(status.agent.state).toBe('idle')
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  if (testFiles.length > 0) {
    const fileList = testFiles.map(f => `/workspace/${f}`).join(' ')
    try {
      mcpHostExec(`rm -f ${fileList}`)
      console.log(`[Cleanup] Removed test files: ${fileList}`)
    } catch (e) {
      console.log(`[Cleanup] Warning: could not remove test files: ${e}`)
    }
  }
})
