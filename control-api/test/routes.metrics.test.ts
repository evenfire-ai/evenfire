import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express, { type Express } from 'express'
import http from 'node:http'
import request from 'supertest'
import {
  approvalsCreatedTotal,
  approvalsDecidedTotal,
  mcpHostJwtIssueTotal,
  rateLimitHitsTotal,
} from '../src/observability/metrics.js'
import { createMetricsRouter } from '../src/routes/metrics.js'

/**
 * /metrics must:
 *   - Respond 200 without any auth headers (Prometheus scrape is cluster-local).
 *   - Return Prometheus text format (Content-Type starts with text/plain).
 *   - Expose the workflow-approval app metrics that Gap #1 requires.
 *   - Expose default process metrics (node_* / process_*).
 */
describe('GET /metrics', () => {
  let server: http.Server
  let api: ReturnType<typeof request>

  function buildApp(): express.Application {
    const app = express()
    app.use(createMetricsRouter())
    return app
  }

  function startTestServer(app: Express): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0)
      server.once('listening', () => resolve(server))
      server.once('error', reject)
    })
  }

  function closeTestServer(server: http.Server | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!server?.listening) {
        resolve()
        return
      }
      server.close(err => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  beforeEach(async () => {
    // Own the server lifecycle; Supertest's implicit app server is flaky
    // when this file runs beside larger route suites under Vitest workers.
    server = await startTestServer(buildApp())
    api = request(server)
  })

  afterEach(async () => {
    await closeTestServer(server)
  })

  it('returns 200 without authentication', async () => {
    const res = await api.get('/metrics')
    expect(res.status).toBe(200)
  })

  it('returns Prometheus text content-type', async () => {
    const res = await api.get('/metrics')
    expect(String(res.headers['content-type'])).toMatch(/text\/plain/)
  })

  it('exposes user approval request lifecycle counters in the body', async () => {
    // Increment each metric once so they appear in the output (counters with
    // zero values are also emitted by prom-client, but incrementing guarantees
    // a stable non-zero value to assert against).
    approvalsCreatedTotal.inc({ status: 'pending' }, 1)
    approvalsDecidedTotal.inc({ decision: 'approve' }, 1)
    mcpHostJwtIssueTotal.inc({ kind: 'access' }, 1)
    rateLimitHitsTotal.inc({ bucket_type: 'recipe_request', result: 'allowed' }, 1)

    const res = await api.get('/metrics')
    expect(res.status).toBe(200)
    const body = String(res.text)

    // App counters
    expect(body).toContain('user_approval_requests_created_total')
    expect(body).toContain('user_approval_requests_decided_total')
    expect(body).toContain('user_approval_requests_expired_total')
    expect(body).toContain('user_approval_requests_cancelled_total')
    expect(body).toContain('workflow_auth_issue_total')
    expect(body).toContain('workflow_auth_refresh_total')
    expect(body).toContain('mcp_host_http_total')
    expect(body).toContain('mcp_host_http_duration_seconds')
    expect(body).toContain('user_approval_requests_expiry_runs_total')
    expect(body).toContain('user_approval_requests_archive_runs_total')
    expect(body).toContain('rate_limit_hits_total')
  })

  it('exposes default node process metrics', async () => {
    const res = await api.get('/metrics')
    expect(res.status).toBe(200)
    const body = String(res.text)
    // `prom-client` default metrics always include these three on any platform.
    expect(body).toMatch(/process_cpu_seconds_total|process_cpu_user_seconds_total/)
    expect(body).toMatch(/nodejs_heap_size_total_bytes|nodejs_heap_size_used_bytes/)
    expect(body).toContain('process_start_time_seconds')
  })
})
