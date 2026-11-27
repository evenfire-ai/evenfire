import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelWorkflowRun } from '../api'

const RUN_ID = '0d4f1b52-7c1e-4a8e-9a57-2c3f4d5e6f70'
const OPERATOR_ID = '5b0c8f0e-3a52-4f7c-8d0e-6a1b2c3d4e5f'

// The 200 body of the operator cancel route: the run as `mapDbRun` returns it for
// an admin reader (`control-api/src/services/workflows/workflowRunReadService.ts`),
// here a running run with a child whose request is stored.
const CANCELED_RUN_DTO = {
  id: RUN_ID,
  source: 'live',
  approvalRequestId: null,
  phase: 'Running',
  triggeredAt: '2026-05-07T23:11:00.000Z',
  startedAt: '2026-05-07T23:11:01.000Z',
  completedAt: null,
  message: null,
  cancelRequestedAt: '2026-05-07T23:11:30.000Z',
  canceledBy: `operator:${OPERATOR_ID}`,
  actor: { type: 'admin-ui', adminUserId: OPERATOR_ID },
  executionRef: { namespace: 'sandbox recipes', name: 'cancel-me-0d4f1b52' },
}

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}

describe('cancelWorkflowRun', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts to the admin cancel route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, CANCELED_RUN_DTO))
    vi.stubGlobal('fetch', fetchMock)

    await expect(cancelWorkflowRun('sandbox recipes', 'cancel/me', RUN_ID)).resolves.toEqual(
      CANCELED_RUN_DTO
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `/control-api/api/v1/admin/workflows/sandbox%20recipes/cancel%2Fme/runs/${RUN_ID}/cancel`,
      expect.objectContaining({ method: 'POST', body: undefined })
    )
  })

  it.each([
    [404, 'Not Found', 'workflow_run_not_found'],
    [409, 'Conflict', 'workflow_run_not_cancellable'],
  ])('rejects with the server code of a %i answer', async (status, statusText, code) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, { error: code }, statusText))
    vi.stubGlobal('fetch', fetchMock)

    await expect(cancelWorkflowRun('sandbox-recipes', 'cancel-me', RUN_ID)).rejects.toMatchObject({
      status,
      code,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
