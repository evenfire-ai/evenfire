import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decideUserApprovalDecision,
  listPendingUserApprovalDecisions,
} from '../src/services/userApprovalDecisionsService.js'

const controlApiRequestMock = vi.hoisted(() => vi.fn())

vi.mock('../src/controlApiClient.js', () => ({
  controlApiRequest: controlApiRequestMock,
}))

describe('userApprovalDecisionsService', () => {
  beforeEach(() => {
    controlApiRequestMock.mockReset()
  })

  it('lists pending user approval decisions with the requested limit', async () => {
    controlApiRequestMock.mockResolvedValueOnce({ items: [{ id: 'approval-1' }] })

    const result = await listPendingUserApprovalDecisions('session-token', 12)

    expect(result).toEqual({ items: [{ id: 'approval-1' }] })
    expect(controlApiRequestMock).toHaveBeenCalledWith(
      'GET',
      '/external/workflow-approvals/pending',
      {
        userSessionToken: 'session-token',
        query: { limit: '12' },
      }
    )
  })

  it('uses the default pending decision limit', async () => {
    controlApiRequestMock.mockResolvedValueOnce({ items: [] })

    await listPendingUserApprovalDecisions('session-token')

    expect(controlApiRequestMock).toHaveBeenCalledWith(
      'GET',
      '/external/workflow-approvals/pending',
      {
        userSessionToken: 'session-token',
        query: { limit: '20' },
      }
    )
  })

  it('posts approval decisions without optional notes', async () => {
    controlApiRequestMock.mockResolvedValueOnce({ ok: true })

    const result = await decideUserApprovalDecision('session-token', 'approval/1', 'approve')

    expect(result).toEqual({ ok: true })
    expect(controlApiRequestMock).toHaveBeenCalledWith(
      'POST',
      '/external/workflow-approvals/approval%2F1/decide',
      {
        userSessionToken: 'session-token',
        body: { decision: 'approve' },
      }
    )
  })

  it('posts approval decisions with optional notes', async () => {
    controlApiRequestMock.mockResolvedValueOnce({ ok: true })

    await decideUserApprovalDecision('session-token', 'approval-1', 'deny', 'not safe')

    expect(controlApiRequestMock).toHaveBeenCalledWith(
      'POST',
      '/external/workflow-approvals/approval-1/decide',
      {
        userSessionToken: 'session-token',
        body: { decision: 'deny', note: 'not safe' },
      }
    )
  })
})
