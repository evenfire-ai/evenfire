import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminTracingPromptHistoryRouter } from '../src/routes/admin/tracing/promptHistory.routes.js'
import { createInternalApprovalPromptHistoryRouter } from '../src/routes/internal/tracing/approvalPromptHistory.routes.js'
import {
  type ApprovalPromptHistoryConfig,
  ApprovalPromptHistoryService,
  approvalPromptHistoryConfig,
  redactApprovalPrompt,
} from '../src/services/tracing/approvalPromptHistoryService.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'

const APPROVAL_ID = '11111111-1111-4111-8111-111111111111'
const KEY = Buffer.alloc(32, 7)
const enabled: ApprovalPromptHistoryConfig = {
  enabled: true,
  key: KEY,
  keyVersion: 'v1',
  maxBytes: 16_384,
  retentionDays: 30,
}

describe('ApprovalPromptHistoryService', () => {
  it('is disabled by default and fails closed when enabled configuration is incomplete', () => {
    expect(approvalPromptHistoryConfig({})).toEqual({ enabled: false, reason: 'disabled' })
    expect(
      approvalPromptHistoryConfig({ TRACING_APPROVAL_PROMPT_HISTORY_ENABLED: 'true' })
    ).toEqual({
      enabled: false,
      reason: 'unavailable',
    })
  })

  it('records only closed disabled, key-unavailable, and rejected capture reasons', async () => {
    const recorder = vi.fn()
    const capture = {
      approvalRequestId: APPROVAL_ID,
      approvalKind: 'workflow' as const,
      sourceKind: 'control_api_local' as const,
      origin: 'workflow_runtime' as const,
      prompt: 'FORBIDDEN_PROMPT_SENTINEL',
    }

    await new ApprovalPromptHistoryService(
      { query: vi.fn() } as never,
      { enabled: false, reason: 'disabled' },
      recorder
    ).capture(capture)
    await new ApprovalPromptHistoryService(
      { query: vi.fn() } as never,
      { enabled: false, reason: 'unavailable' },
      recorder
    ).capture(capture)
    await new ApprovalPromptHistoryService(
      { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) } as never,
      enabled,
      recorder
    ).capture(capture)

    expect(recorder.mock.calls).toEqual([
      ['agent_run', 'prompt_history_disabled'],
      ['agent_run', 'prompt_history_key_unavailable'],
      ['agent_run', 'prompt_history_rejected'],
    ])
    expect(JSON.stringify(recorder.mock.calls)).not.toMatch(
      /FORBIDDEN_PROMPT_SENTINEL|11111111|approvalRequestId/
    )
  })

  it('redacts assignments before encrypted persistence and decrypts only on explicit read', async () => {
    const query = vi.fn()
    let persisted: unknown[] = []
    query.mockImplementation((sql: string, values?: unknown[]) => {
      if (sql.includes('workflow_approval_requests'))
        return Promise.resolve({ rowCount: 1, rows: [{}] })
      if (sql.includes('INSERT INTO governed_approval_prompt_history')) {
        persisted = values ?? []
        return Promise.resolve({ rowCount: 1, rows: [{ approval_request_id: APPROVAL_ID }] })
      }
      throw new Error('unexpected query')
    })
    const service = new ApprovalPromptHistoryService({ query } as never, enabled)
    const result = await service.capture({
      approvalRequestId: APPROVAL_ID,
      approvalKind: 'workflow',
      sourceKind: 'control_api_local',
      origin: 'workflow_runtime',
      prompt: 'Approve operation with password=hunter2',
    })
    expect(result).toEqual({ status: 'captured' })
    const ciphertext = persisted[6] as Buffer
    expect(ciphertext.includes(Buffer.from('hunter2'))).toBe(false)
    expect(persisted[11]).toContain('"redacted":true')

    const readQuery = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          approval_kind: 'workflow',
          run_id: null,
          host_ref: null,
          session_id: null,
          origin: 'workflow_runtime',
          ciphertext,
          nonce: persisted[7],
          key_version: 'v1',
          redaction_summary: JSON.parse(String(persisted[11])),
          source_kind: 'control_api_local',
          captured_at: '2026-07-14T10:00:00.000Z',
          expires_at: '2099-08-13T10:00:00.000Z',
        },
      ],
    })
    const read = await new ApprovalPromptHistoryService(
      { query: readQuery } as never,
      enabled
    ).read(APPROVAL_ID)
    expect(read).toMatchObject({
      availability: 'available',
      prompt: { text: 'Approve operation with [REDACTED]' },
    })
  })

  it('returns unavailable when authenticated encryption metadata is changed', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          approval_kind: 'workflow',
          run_id: null,
          host_ref: null,
          session_id: null,
          origin: 'workflow_runtime',
          ciphertext: Buffer.alloc(17),
          nonce: Buffer.alloc(12),
          key_version: 'v1',
          redaction_summary: { redacted: false, replacementCount: 0 },
          source_kind: 'control_api_local',
          captured_at: new Date(),
          expires_at: '2099-01-01T00:00:00Z',
        },
      ],
    })
    await expect(
      new ApprovalPromptHistoryService({ query } as never, enabled).read(APPROVAL_ID)
    ).resolves.toEqual({
      approvalRequestId: APPROVAL_ID,
      availability: 'unavailable',
      prompt: null,
    })
  })

  it('uses a closed redaction summary without retaining a preview', () => {
    expect(redactApprovalPrompt('normal request')).toEqual({
      text: 'normal request',
      summary: { redacted: false, replacementCount: 0 },
    })
  })
})

describe('approval prompt history route', () => {
  it('sets no-store and returns the closed availability contract', async () => {
    const app = express()
    app.use(
      '/api/v1',
      createAdminTracingPromptHistoryRouter({
        read: vi.fn().mockResolvedValue({
          approvalRequestId: APPROVAL_ID,
          availability: 'none',
          prompt: null,
        }),
      })
    )
    const response = await request(app).get(
      `/api/v1/admin/tracing/approvals/${APPROVAL_ID}/prompt-history`
    )
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({
      approvalRequestId: APPROVAL_ID,
      availability: 'none',
      prompt: null,
    })
  })

  it('accepts capture only from an exact mcp-host runtime principal', async () => {
    const capture = vi.fn().mockResolvedValue({ status: 'captured' })
    const app = express()
    app.use('/api/v1', createInternalApprovalPromptHistoryRouter({ capture }))
    const { token } = issueMcpHostAccessJwt('sandbox-recipes', 'trace-recipe', ['host-a'])
    const body = {
      approvalRequestId: APPROVAL_ID,
      runId: '22222222-2222-4222-8222-222222222222',
      hostRef: 'host-a',
      sessionId: 'session-a',
      origin: 'direct_chat',
      prompt: 'Approve this bounded operation',
    }

    const accepted = await request(app)
      .post('/api/v1/internal/tracing/approval-prompt-history')
      .auth(token, { type: 'bearer' })
      .send(body)

    expect(accepted.status).toBe(202)
    expect(accepted.body).toEqual({ status: 'captured' })
    expect(capture).toHaveBeenCalledWith({
      ...body,
      approvalKind: 'tool',
      sourceKind: 'mcp_host_runtime',
    })

    await request(app)
      .post('/api/v1/internal/tracing/approval-prompt-history')
      .send(body)
      .expect(403)
    expect(capture).toHaveBeenCalledTimes(1)
  })
})
