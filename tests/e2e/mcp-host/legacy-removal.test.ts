/**
 * E2E: Legacy Removal — verify Phase 7 legacy code is fully removed.
 *
 * After Phase 7, the codebase has a single agent pipeline with no feature flags,
 * no dual-path routing, and no legacy provider methods. These tests confirm
 * the cleanup via pod logs and HTTP responses.
 */
import { describe, expect, it } from 'vitest'
import { MCP_HOST_URL, fetchJson, getPodLogs, sendMessage, waitForIdle } from '../helpers.js'

describe('Legacy Removal (Phase 7)', () => {
  it("mcp-host startup logs do not contain 'USE_NEW_AGENT_LOOP'", () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 300)
    expect(logs).not.toContain('USE_NEW_AGENT_LOOP')
  })

  it("mcp-host startup logs do not contain '(new pipeline)' marker", () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 300)
    // The "(new pipeline)" marker was a temporary indicator during Phase 5-6;
    // it should be removed now that there's only one pipeline
    expect(logs).not.toContain('(new pipeline)')
  })

  it("mcp-host startup logs do not contain 'legacy' or 'Legacy' references", () => {
    const logs = getPodLogs('mcp-host', 'mcp-host', 300)
    const lower = logs.toLowerCase()
    expect(lower).not.toContain('legacy pipeline')
    expect(lower).not.toContain('legacy path')
    expect(lower).not.toContain('executeTaskLegacy'.toLowerCase())
  })

  it('mcp-host processes task via single pipeline', async () => {
    await sendMessage('legacy removal validation')
    await waitForIdle(30_000)

    const logs = getPodLogs('mcp-host', 'mcp-host', 200)
    // Single pipeline logs "Processing task" without branching markers
    expect(logs).toContain('[Agent] Processing task')
  })

  it('GET / API info does not mention feature flags', async () => {
    const res = await fetchJson(`${MCP_HOST_URL}/`)
    expect(res.status).toBe(200)
    const body = JSON.stringify(res.data)
    expect(body).not.toContain('feature')
    expect(body).not.toContain('flag')
    expect(body).not.toContain('USE_NEW_AGENT_LOOP')
  })

  it('mcp-host runs without CLERUM_USE_NEW_AGENT_LOOP env var set', () => {
    // Verify the pod is running (we got this far) and has no reference to the flag
    const logs = getPodLogs('mcp-host', 'mcp-host', 300)
    // Agent should be initialized and running
    expect(logs).toContain('[Agent]')
    // No feature flag env var should appear
    expect(logs).not.toContain('CLERUM_USE_NEW_AGENT_LOOP')
  })
})
