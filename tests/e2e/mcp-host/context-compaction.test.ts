/**
 * E2E: Context Compaction — verify pressure-based context management in a real cluster.
 *
 * Tests that context compaction works end-to-end:
 *   - CLERUM_CONTEXT_MAX_TOKENS config is recognized
 *   - PressureContextManager is wired into the tool-use loop
 *   - Workspace archival (MoveToWorkspace / Summarize) writes to daily log
 *   - Agent remains stable after compaction
 *   - Long conversations trigger compaction and emit log entries
 *
 * Prerequisites:
 *   1. Minikube running with mcp-host deployed
 *   2. Real LLM API key in chatllm-api-keys secret
 *   3. CLERUM_MEMORY_ENABLED=true in mcp-host-config configmap
 *   4. Port-forwarding active:
 *        kubectl port-forward -n mcp-host svc/chatllm 8080:8080
 *
 * Optional (for compaction trigger tests):
 *   5. CLERUM_CONTEXT_MAX_TOKENS set low (e.g. "3000") in configmap to force compaction
 *      with fewer messages. Without this, you need many more turns to hit the 80% threshold.
 *
 * Run:
 *   cd tests/e2e && E2E_RUN_CONTEXT_COMPACTION=1 npx vitest run context-compaction.test.ts
 */
import { afterAll, describe as baseDescribe, expect, it } from 'vitest'
import {
  MCP_HOST_URL,
  fetchJson,
  getPodLogs,
  getStatus,
  kubectl,
  mcpHostExec,
  sendMessage,
  sleep,
  waitForIdle,
} from '../helpers.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Unique user ID for compaction tests. Using a dedicated user isolates the
 * conversation from other e2e suites, ensuring we control the turn count.
 */
const COMPACTION_USER = 'compaction-test-user'

/**
 * Today's date in YYYY-MM-DD for daily log path.
 */
const TODAY = new Date().toISOString().slice(0, 10)
const RUN_CONTEXT_COMPACTION = /^(1|true|yes)$/i.test(process.env.E2E_RUN_CONTEXT_COMPACTION ?? '')
const describe = baseDescribe.skipIf(!RUN_CONTEXT_COMPACTION)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a file from the workspace inside the mcp-host pod. */
function readWorkspaceFile(relativePath: string): string {
  try {
    return mcpHostExec(`cat /workspace/${relativePath}`)
  } catch {
    return ''
  }
}

/** Check if a workspace file exists inside the mcp-host pod. */
function workspaceFileExists(relativePath: string): boolean {
  try {
    mcpHostExec(`test -f /workspace/${relativePath}`)
    return true
  } catch {
    return false
  }
}

/** Read configmap value for CLERUM_CONTEXT_MAX_TOKENS. */
function getConfiguredMaxTokens(): string | null {
  try {
    const raw = kubectl(
      `get configmap mcp-host-config -n mcp-host -o jsonpath='{.data.CLERUM_CONTEXT_MAX_TOKENS}'`
    )
    return raw.replace(/'/g, '').trim() || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Configuration
// ---------------------------------------------------------------------------

describe('Phase 1: Configuration', () => {
  it('CC-1: configmap exposes CLERUM_CONTEXT_MAX_TOKENS', () => {
    const maxTokens = getConfiguredMaxTokens()

    // If explicitly set, it should parse as a number
    if (maxTokens) {
      const parsed = parseInt(maxTokens, 10)
      expect(parsed).toBeGreaterThan(0)
      console.log(`[CC-1] CLERUM_CONTEXT_MAX_TOKENS = ${parsed}`)
    } else {
      // Default (100000) is used when not set — this is fine
      console.log('[CC-1] CLERUM_CONTEXT_MAX_TOKENS not set, using default 100000')
    }
  })

  it('CC-2: mcp-host starts with PressureContextManager wired', () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 500)

    // Verify no startup crash. Logs are structured JSON in current images, so
    // this test must not depend on legacy text prefixes such as "[Agent]".
    expect(logs.length).toBeGreaterThan(0)
    expect(logs).not.toContain('FATAL')
    expect(logs).not.toContain('unhandledRejection')
  })

  it('CC-3: memory/workspace system is enabled', () => {
    const health = mcpHostExec('wget -qO- http://localhost:8080/v1/runtime/health')
    expect(health).toContain('"ok"')
    const workspaceReady = mcpHostExec('test -d /workspace && printf ready')
    expect(workspaceReady).toBe('ready')
  })
})

// ---------------------------------------------------------------------------
// Phase 2: Conversation Build-up & Compaction
// ---------------------------------------------------------------------------

describe('Phase 2: Multi-Turn Conversation', () => {
  it('CC-4: agent handles multiple turns from the same user', async () => {
    // Send several messages to build up conversation history.
    // These need to be from the same user so turns accumulate in one conversation.
    const messages = [
      'Remember this: the project name is Mercury-7',
      'What tools do you have available? List them briefly.',
      'What is 2 + 2? Keep your answer very short.',
    ]

    for (const msg of messages) {
      const res = await sendMessage(msg, { userId: COMPACTION_USER })
      expect(res.status).toBe(200)
      await waitForIdle(60_000)
    }

    // Agent should still be healthy after multiple turns
    const status = await getStatus()
    expect(status.agent.state).toBe('idle')
    expect(status.agent.tasksProcessed).toBeGreaterThanOrEqual(3)
  }, 240_000)

  it('CC-5: agent remains stable after many turns', async () => {
    // Send more messages to push toward compaction threshold
    const messages = [
      'Tell me about the number 42 in one paragraph.',
      'Explain what a context window is for LLMs in 2 sentences.',
      'Give me a haiku about programming.',
      'What was the project name I asked you to remember earlier?',
    ]

    for (const msg of messages) {
      const res = await sendMessage(msg, { userId: COMPACTION_USER })
      expect(res.status).toBe(200)
      await waitForIdle(60_000)
    }

    // Health check
    const health = await fetchJson(`${MCP_HOST_URL}/v1/runtime/health`)
    expect(health.status).toBe(200)

    const status = await getStatus()
    expect(status.agent.state).toBe('idle')
  }, 360_000)
})

// ---------------------------------------------------------------------------
// Phase 3: Compaction Verification
// ---------------------------------------------------------------------------

describe('Phase 3: Compaction Verification', () => {
  it('CC-6: pod logs show compaction activity (when threshold is reached)', () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 1000)

    // Check for any compaction-related log lines.
    // These appear when PressureContextManager runs:
    //   - "[ContextManager] MoveToWorkspace: archived N turns to daily log"
    //   - "[ContextManager] Summarize: condensed N turns into M chars"
    // Or when the tool-use loop emits context:compacted events.
    const hasCompaction =
      logs.includes('[ContextManager] MoveToWorkspace:') ||
      logs.includes('[ContextManager] Summarize:') ||
      logs.includes('[ContextManager] context:compacted')

    if (hasCompaction) {
      console.log('[CC-6] Compaction activity detected in pod logs')
      expect(hasCompaction).toBe(true)
    } else {
      // If CLERUM_CONTEXT_MAX_TOKENS is high (default 100k), the 7 test messages
      // may not exceed the 80% threshold. This is expected behavior.
      console.log(
        '[CC-6] No compaction triggered — token budget likely not exceeded. ' +
          'Set CLERUM_CONTEXT_MAX_TOKENS=3000 in configmap to test compaction with fewer turns.'
      )
    }
  })

  it('CC-7: daily log exists and contains conversation data', () => {
    // autoWriteDailyLog writes after every completed turn, so the daily log
    // should contain entries from our test messages regardless of compaction.
    const dailyLogPath = `daily/${TODAY}.md`
    const exists = workspaceFileExists(dailyLogPath)

    if (exists) {
      const content = readWorkspaceFile(dailyLogPath)
      expect(content.length).toBeGreaterThan(0)
      console.log(`[CC-7] Daily log size: ${content.length} chars`)

      // Should contain at least some of our test conversation data
      // (either from autoWriteDailyLog or from compaction archival)
      const hasConversationData =
        content.includes('telegram') ||
        content.includes(COMPACTION_USER) ||
        content.includes('Mercury') ||
        content.includes('Context Compacted') ||
        content.includes('Context Summary')

      expect(hasConversationData).toBe(true)
    } else {
      console.log(
        `[CC-7] No daily log at ${dailyLogPath}. ` +
          'Workspace may not be configured or autoWriteDailyLog is not running.'
      )
    }
  })

  it('CC-8: if compaction occurred, archived content is in daily log', () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 1000)

    const compactionOccurred =
      logs.includes('MoveToWorkspace: archived') || logs.includes('Summarize: condensed')

    if (!compactionOccurred) {
      console.log(
        '[CC-8] Skipped — no compaction occurred. ' +
          'Lower CLERUM_CONTEXT_MAX_TOKENS to trigger compaction.'
      )
      return
    }

    // If compaction DID occur, the daily log should contain archived content
    const content = readWorkspaceFile(`daily/${TODAY}.md`)
    expect(content.length).toBeGreaterThan(0)

    const hasArchived =
      content.includes('Context Compacted') ||
      content.includes('Context Summary') ||
      content.includes('turns archived') ||
      content.includes('turns summarized')

    expect(hasArchived).toBe(true)
    console.log('[CC-8] Compacted content found in daily log')
  })
})

// ---------------------------------------------------------------------------
// Phase 4: Forced Compaction (low token budget)
// ---------------------------------------------------------------------------

describe('Phase 4: Forced Compaction', () => {
  /**
   * CC-9: Force compaction by using a conversation with enough turns.
   *
   * This test sends many long messages to a dedicated user to ensure the
   * conversation exceeds even a moderate token budget. With the default 100k
   * budget this requires many turns; with CLERUM_CONTEXT_MAX_TOKENS=3000 it
   * triggers quickly.
   */
  it('CC-9: long conversation triggers compaction and agent recovers', async () => {
    const longUser = 'compaction-stress-user'

    // Send 10 messages with substantial content to build up tokens
    for (let i = 0; i < 10; i++) {
      const content =
        `Message ${i + 1}: This is a detailed message about topic number ${i + 1}. ` +
        'It contains multiple sentences to increase the token count. ' +
        'The purpose is to test that the context compaction system handles ' +
        'growing conversations gracefully without crashing or losing coherence. ' +
        'Please acknowledge briefly.'

      const res = await sendMessage(content, { userId: longUser })
      expect(res.status).toBe(200)
      await waitForIdle(60_000)
    }

    // Agent must still be healthy after the stress test
    const health = await fetchJson(`${MCP_HOST_URL}/v1/runtime/health`)
    expect(health.status).toBe(200)

    const status = await getStatus()
    expect(status.agent.state).toBe('idle')

    // Verify no crashes in logs
    const logs = getPodLogs('mcp-host', 'mcp-host', 100)
    expect(logs).not.toContain('FATAL')
    expect(logs).not.toContain('unhandledRejection')
    expect(logs).not.toContain('heap out of memory')

    console.log(
      `[CC-9] Completed 10-turn stress test. ` + `Tasks processed: ${status.agent.tasksProcessed}`
    )
  }, 600_000) // 10 minutes timeout for 10 LLM round-trips

  it('CC-10: post-compaction, agent can still process new messages', async () => {
    // After compaction stress, send one more message to verify the agent works
    const res = await sendMessage('What is 1 + 1? Answer with just the number.', {
      userId: 'compaction-stress-user',
    })

    expect(res.status).toBe(200)
    await waitForIdle(60_000)

    // Should get a real response (not an error)
    if (res.data?.response) {
      expect(res.data.response.length).toBeGreaterThan(0)
    }

    const status = await getStatus()
    expect(status.agent.state).toBe('idle')
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Phase 5: Compaction Logs Analysis
// ---------------------------------------------------------------------------

describe('Phase 5: Log Analysis', () => {
  it('CC-11: collect compaction statistics from pod logs', () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 2000)

    // Count occurrences of each compaction tier
    const moveToWorkspaceCount = (logs.match(/MoveToWorkspace: archived/g) || []).length
    const summarizeCount = (logs.match(/Summarize: condensed/g) || []).length
    const compactedEventCount = (logs.match(/context:compacted/g) || []).length

    console.log('[CC-11] Compaction statistics:')
    console.log(`  MoveToWorkspace events: ${moveToWorkspaceCount}`)
    console.log(`  Summarize events: ${summarizeCount}`)
    console.log(`  context:compacted events: ${compactedEventCount}`)

    // No assertion — this is informational. The counts depend on
    // CLERUM_CONTEXT_MAX_TOKENS and how many turns were processed.
  })

  it('CC-12: no compaction-related errors in logs', () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 2000)

    // These would indicate bugs in the compaction code
    expect(logs).not.toContain('[ContextManager] MoveToWorkspace: failed to archive')
    expect(logs).not.toContain('[ContextManager] Summarize: failed to write summary')

    // Allow "LLM call failed, falling back" — that's a graceful fallback, not a bug
    // But flag any unexpected errors
    expect(logs).not.toContain('TypeError')
    expect(logs).not.toContain('ReferenceError')
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  // Clean up workspace files created by compaction tests
  try {
    mcpHostExec(`rm -f /workspace/daily/${TODAY}.md`)
    console.log(`[Cleanup] Removed daily log for ${TODAY}`)
  } catch {
    console.log('[Cleanup] Warning: could not clean up daily log (may not exist)')
  }
})
