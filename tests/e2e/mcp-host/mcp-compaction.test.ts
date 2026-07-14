/**
 * E2E: MCP Tool Compaction — validate context compaction under real MCP workload.
 *
 * Unlike context-compaction.test.ts (which uses short conversational messages),
 * this suite deliberately generates large context via:
 *   - Multi-step Airtable queries (list bases → list tables → describe schema)
 *   - Multi-step MongoDB queries (list databases → list collections → schema)
 *   - memory_write calls to persist findings across turns
 *   - Cross-system synthesis turns that build on prior tool results
 *
 * Each MCP tool call appends tool-call + tool-result messages to the conversation,
 * and tool results can be hundreds to thousands of tokens each. This exercises
 * the compaction path far more aggressively than plain text turns.
 *
 * Prerequisites:
 *   1. Minikube running with mcp-host, airtable-server, mongodb-server deployed
 *   2. Real API keys in secrets (airtable, mongodb credentials)
 *   3. CLERUM_CONTEXT_MAX_TOKENS set low (e.g. "500") to trigger compaction
 *   4. Port-forwarding active:
 *        kubectl port-forward -n mcp-host svc/chatllm 8080:8080
 *
 * Run:
 *   cd tests/e2e && E2E_RUN_MCP_COMPACTION=1 npx vitest run mcp-compaction.test.ts
 */
import { afterAll, describe as baseDescribe, expect, it } from 'vitest'
import {
  MCP_HOST_URL,
  fetchJson,
  getPodLogs,
  getStatus,
  mcpHostExec,
  sendMessage,
  waitForIdle,
} from '../helpers.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Isolated user for this test suite — keeps conversation separate from others. */
const MCP_USER = 'mcp-compaction-user'

/** Today's date for daily log path. */
const TODAY = new Date().toISOString().slice(0, 10)
const RUN_MCP_COMPACTION = /^(1|true|yes)$/i.test(process.env.E2E_RUN_MCP_COMPACTION ?? '')
const describe = baseDescribe.skipIf(!RUN_MCP_COMPACTION)

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

/** Count occurrences of a pattern in pod logs. */
function countInLogs(pattern: RegExp, tailLines = 2000): number {
  const logs = getPodLogs('mcp-host', 'mcp-host', tailLines)
  return (logs.match(pattern) || []).length
}

// ---------------------------------------------------------------------------
// Phase 1: Airtable deep-dive (generates large tool result context)
// ---------------------------------------------------------------------------

describe('Phase 1: Airtable MCP multi-step exploration', () => {
  it('MC-1: list all Airtable bases', async () => {
    const res = await sendMessage(
      'Use the airtable-server list_bases tool to list all my Airtable bases. ' +
        'For each base, tell me its name and ID.',
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(60_000)

    const response = (res.data?.response || '').toLowerCase()
    expect(response.length).toBeGreaterThan(20)
    console.log(`[MC-1] Airtable bases response: ${res.data?.response?.slice(0, 120)}...`)
  }, 90_000)

  it('MC-2: list tables in the first Airtable base', async () => {
    const res = await sendMessage(
      'Use airtable-server list_tables to list all tables in the first Airtable base you found. ' +
        'Report each table name and its ID.',
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(60_000)

    const response = res.data?.response || ''
    expect(response.length).toBeGreaterThan(10)
    console.log(`[MC-2] Tables response length: ${response.length} chars`)
  }, 90_000)

  it('MC-3: describe schema of the first table', async () => {
    const res = await sendMessage(
      'Use airtable-server describe_table to get the full schema of the first table you found. ' +
        'List all field names and their types.',
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(90_000)

    const response = res.data?.response || ''
    expect(response.length).toBeGreaterThan(20)
    console.log(`[MC-3] Schema response length: ${response.length} chars`)
  }, 120_000)

  it('MC-4: save Airtable findings to memory', async () => {
    const res = await sendMessage(
      'Use the memory_write tool to save a summary of what you found in Airtable. ' +
        "Key: 'airtable_summary'. Value: a concise summary of the bases and tables you explored.",
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(60_000)

    const response = (res.data?.response || '').toLowerCase()
    // Should confirm the write
    expect(response).toMatch(/saved|stored|written|memory|airtable/)
    console.log(`[MC-4] Memory write response: ${res.data?.response?.slice(0, 100)}...`)
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Phase 2: MongoDB deep-dive (another large tool result batch)
// ---------------------------------------------------------------------------

describe('Phase 2: MongoDB MCP multi-step exploration', () => {
  it('MC-5: list MongoDB databases', async () => {
    const res = await sendMessage(
      'Use the mongodb-server list-databases tool to list all available MongoDB databases. ' +
        'Report the name and size of each one.',
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(60_000)

    const response = res.data?.response || ''
    expect(response.length).toBeGreaterThan(20)
    console.log(`[MC-5] MongoDB databases: ${response.slice(0, 120)}...`)
  }, 90_000)

  it('MC-6: list collections in the first non-system database', async () => {
    const res = await sendMessage(
      "Use mongodb-server list-collections to list all collections in the 'clerum-test' database. " +
        'Report each collection name.',
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(60_000)

    const response = res.data?.response || ''
    expect(response.length).toBeGreaterThan(5)
    console.log(`[MC-6] Collections response: ${response.slice(0, 120)}...`)
  }, 90_000)

  it('MC-7: get collection schema and document count', async () => {
    const res = await sendMessage(
      'Use mongodb-server collection-schema and mongodb-server count to get the schema and document count ' +
        "of the first collection you found in 'clerum-test'. Report the field names and total count.",
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(90_000)

    const response = res.data?.response || ''
    expect(response.length).toBeGreaterThan(5)
    console.log(`[MC-7] Schema+count response length: ${response.length} chars`)
  }, 120_000)

  it('MC-8: save MongoDB findings to memory', async () => {
    const res = await sendMessage(
      "Use memory_write with key 'mongodb_summary' to save a concise summary of the MongoDB databases " +
        'and collections you explored.',
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(60_000)

    const response = (res.data?.response || '').toLowerCase()
    expect(response).toMatch(/saved|stored|written|memory|mongodb|database/)
    console.log(`[MC-8] MongoDB memory write: ${res.data?.response?.slice(0, 100)}...`)
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Phase 3: Cross-system synthesis (forces memory reads + longer reasoning)
// ---------------------------------------------------------------------------

describe('Phase 3: Cross-system synthesis', () => {
  it('MC-9: recall and compare both data sources from memory', async () => {
    const res = await sendMessage(
      "Use memory_read to retrieve both 'airtable_summary' and 'mongodb_summary'. " +
        'Then write a brief comparison: what kind of data is in Airtable vs MongoDB?',
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(90_000)

    const response = (res.data?.response || '').toLowerCase()
    expect(response.length).toBeGreaterThan(30)
    // Should mention both systems
    expect(response).toMatch(/airtable|mongodb|database|collection/)
    console.log(`[MC-9] Synthesis response length: ${response.length} chars`)
  }, 120_000)

  it('MC-10: run one more Airtable query to further grow context', async () => {
    const res = await sendMessage(
      'Use airtable-server list_records from the first table you explored earlier. ' +
        'Fetch up to 5 records and summarize what data they contain.',
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(90_000)

    const response = res.data?.response || ''
    expect(response.length).toBeGreaterThan(10)
    console.log(`[MC-10] Records response length: ${response.length} chars`)
  }, 120_000)

  it('MC-11: agent health check after heavy tool usage', async () => {
    const health = await fetchJson(`${MCP_HOST_URL}/v1/runtime/health`)
    expect(health.status).toBe(200)

    const status = await getStatus()
    expect(status.agent.state).toBe('idle')
    expect(status.agent.tasksSucceeded).toBeGreaterThanOrEqual(8)

    const logs = getPodLogs('mcp-host', 'mcp-host', 50)
    expect(logs).not.toContain('FATAL')
    expect(logs).not.toContain('unhandledRejection')

    console.log(
      `[MC-11] Tasks succeeded: ${status.agent.tasksSucceeded}, state: ${status.agent.state}`
    )
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Phase 4: Compaction verification
// ---------------------------------------------------------------------------

describe('Phase 4: Compaction verification', () => {
  it('MC-12: compaction events fired during MCP-heavy conversation', () => {
    const compactedCount = countInLogs(/\[ContextManager\] context:compacted/)
    const moveCount = countInLogs(/\[ContextManager\] MoveToWorkspace: archived/)
    const summarizeCount = countInLogs(/\[ContextManager\] Summarize: condensed/)

    const total = compactedCount + moveCount + summarizeCount

    console.log('[MC-12] Compaction events:')
    console.log(`  context:compacted: ${compactedCount}`)
    console.log(`  MoveToWorkspace:   ${moveCount}`)
    console.log(`  Summarize:         ${summarizeCount}`)
    console.log(`  Total:             ${total}`)

    // With 500-token budget and large MCP tool results, compaction MUST fire
    expect(total).toBeGreaterThan(0)
  })

  it('MC-13: daily log contains archived MCP conversation data', () => {
    const content = readWorkspaceFile(`daily/${TODAY}.md`)

    expect(content.length).toBeGreaterThan(0)
    console.log(`[MC-13] Daily log size: ${content.length} chars`)

    // Log should contain evidence of the MCP conversation
    const hasMcpData =
      content.includes('Airtable') ||
      content.includes('airtable') ||
      content.includes('MongoDB') ||
      content.includes('mongodb') ||
      content.includes('Context Compacted') ||
      content.includes('Context Summary')

    expect(hasMcpData).toBe(true)
  })

  it('MC-14: memory entries persisted despite compaction', async () => {
    // After compaction the tool-call messages are gone from context,
    // but memory_write entries live in the workspace KV store —
    // the agent should still be able to recall them.
    const res = await sendMessage(
      "Use memory_read to retrieve the key 'airtable_summary'. What does it say?",
      { userId: MCP_USER }
    )
    expect(res.status).toBe(200)
    await waitForIdle(60_000)

    const response = (res.data?.response || '').toLowerCase()
    // The summary should still mention Airtable-related content
    expect(response).toMatch(/airtable|base|table|found/)
    console.log(`[MC-14] Memory recall after compaction: ${res.data?.response?.slice(0, 120)}...`)
  }, 90_000)

  it('MC-15: no compaction errors in logs', () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 2000)

    expect(logs).not.toContain('[ContextManager] MoveToWorkspace: failed to archive')
    expect(logs).not.toContain('[ContextManager] Summarize: failed to write summary')
    expect(logs).not.toContain('TypeError')
    expect(logs).not.toContain('ReferenceError')
    expect(logs).not.toContain('heap out of memory')
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  try {
    mcpHostExec(`rm -f /workspace/daily/${TODAY}.md`)
    console.log(`[Cleanup] Removed daily log for ${TODAY}`)
  } catch {
    console.log('[Cleanup] Warning: could not clean up daily log')
  }
})
