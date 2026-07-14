/**
 * E2E: Message Flow — verify end-to-end message processing.
 *
 * NOTE: These tests use the real mcp-host with placeholder API keys.
 * The LLM call will fail, but we can verify:
 *   - Message is accepted and queued
 *   - Agent transitions from idle → processing → back to idle
 *   - Queue depth changes correctly
 *   - The failure is graceful (no crash)
 */
import { describe, expect, it } from 'vitest'
import { MCP_HOST_URL, getPodLogs, getStatus, sendMessage, sleep, waitForIdle } from '../helpers.js'

describe('Message Flow', () => {
  it('POST /message returns 200 and queues the message', async () => {
    const before = await getStatus()
    const initialProcessed = before.agent.tasksProcessed

    const res = await sendMessage('Hello from E2E test')
    expect(res.status).toBe(200)

    // Give the agent a moment to pick up the task
    await sleep(500)

    // The message should be processing or already processed
    const after = await getStatus()
    const stateChanged =
      after.agent.state === 'processing' || after.agent.tasksProcessed > initialProcessed
    const queued = after.queue.pending > 0 || after.queue.processing > 0
    expect(stateChanged || queued).toBe(true)
  })

  it('agent returns to idle after processing (even if LLM fails)', async () => {
    // Wait for the agent to finish processing (LLM will fail with placeholder key)
    const status = await waitForIdle(30_000)
    expect(status.agent.state).toBe('idle')
  })

  it('task is counted as processed', async () => {
    const status = await getStatus()
    // At least 1 task should have been processed (success or failure)
    expect(status.agent.tasksProcessed).toBeGreaterThanOrEqual(1)
  })

  it('multiple messages are all accepted', async () => {
    const promises = []
    for (let i = 0; i < 3; i++) {
      promises.push(sendMessage(`Burst message ${i + 1}`))
    }
    const results = await Promise.all(promises)
    for (const res of results) {
      expect(res.status).toBe(200)
    }

    // Wait for all to be processed
    await waitForIdle(60_000)
  })

  it('mcp-host does not crash after failed LLM call', async () => {
    // If we got here, the pod didn't crash. Verify health is still ok.
    const res = await fetch(`${MCP_HOST_URL}/v1/runtime/health`)
    expect(res.status).toBe(200)

    // Check logs for no crash indicators
    const logs = getPodLogs('mcp-host', 'mcp-host', 30)
    expect(logs).not.toContain('FATAL')
    expect(logs).not.toContain('unhandledRejection')
  })
})
