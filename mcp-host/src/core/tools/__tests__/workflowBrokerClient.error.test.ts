import { describe, expect, it, vi } from 'vitest'
import { WorkflowBrokerClient, WorkflowBrokerRequestError } from '../workflowBrokerClient'

function clientWithResponse(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status }))
  )
  return new WorkflowBrokerClient(
    (key: string) => (key === 'MCP_HOST_GATEWAY_URL' ? 'http://gateway.test' : undefined),
    { getWorkflowControlToken: async () => 'token' }
  )
}

describe('WorkflowBrokerClient.request error typing', () => {
  it('throws WorkflowBrokerRequestError with status and code for a 404', async () => {
    const client = clientWithResponse(404, JSON.stringify({ error: 'medium_account_not_found' }))
    await expect(client.request('/api/v1/x', { method: 'POST' })).rejects.toMatchObject({
      status: 404,
      code: 'medium_account_not_found',
    })
    await expect(client.request('/api/v1/x', { method: 'POST' })).rejects.toBeInstanceOf(
      WorkflowBrokerRequestError
    )
  })

  it('sets code to null when the body carries no recognizable error code', async () => {
    const client = clientWithResponse(500, 'upstream exploded')
    await expect(client.request('/api/v1/x', { method: 'POST' })).rejects.toMatchObject({
      status: 500,
      code: null,
    })
  })
})
