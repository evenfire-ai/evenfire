/**
 * E2E: Approval Endpoints — verify Phase 6 approval/denial HTTP contract.
 *
 * These tests validate the endpoint contract (validation, error responses)
 * without triggering actual approval flows. The agent is idle during these
 * tests, so approve/deny return "Agent is not awaiting approval".
 */
import { describe, expect, it } from 'vitest'
import { MCP_HOST_URL, approveRequest, denyRequest, fetchJson } from '../helpers.js'

describe('Approval Endpoints (Phase 6)', () => {
  it("POST /v1/runtime/approvals/approve returns 200 with 'not awaiting approval' when idle", async () => {
    const res = await approveRequest('test-user', 'req-123')
    expect(res.status).toBe(200)
    expect(res.data.success).toBe(false)
    expect(res.data.error).toMatch(/not awaiting approval|no pending approval/i)
  })

  it("POST /v1/runtime/approvals/deny returns 200 with 'not awaiting approval' when idle", async () => {
    const res = await denyRequest('test-user', 'req-123')
    expect(res.status).toBe(200)
    expect(res.data.success).toBe(false)
    expect(res.data.error).toMatch(/not awaiting approval|no pending approval/i)
  })

  it('POST /approvals/approve with missing userId returns 400', async () => {
    const res = await fetchJson(`${MCP_HOST_URL}/v1/runtime/approvals/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-123' }),
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toContain('Missing userId or requestId')
  })

  it('POST /approvals/approve with missing requestId returns 400', async () => {
    const res = await fetchJson(`${MCP_HOST_URL}/v1/runtime/approvals/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'test-user' }),
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toContain('Missing userId or requestId')
  })

  it('POST /approvals/deny with missing userId returns 400', async () => {
    const res = await fetchJson(`${MCP_HOST_URL}/v1/runtime/approvals/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-123' }),
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toContain('Missing userId or requestId')
  })

  it('POST /approvals/deny with missing requestId returns 400', async () => {
    const res = await fetchJson(`${MCP_HOST_URL}/v1/runtime/approvals/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'test-user' }),
    })
    expect(res.status).toBe(400)
    expect(res.data.error).toContain('Missing userId or requestId')
  })

  it('POST /approvals/approve with empty body returns 400', async () => {
    const res = await fetchJson(`${MCP_HOST_URL}/v1/runtime/approvals/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('GET /approvals/approve returns 404 (only POST allowed)', async () => {
    const res = await fetchJson(`${MCP_HOST_URL}/v1/runtime/approvals/approve`)
    expect(res.status).toBe(404)
  })
})
