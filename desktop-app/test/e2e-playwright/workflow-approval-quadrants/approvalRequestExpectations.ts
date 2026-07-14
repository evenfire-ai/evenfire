import { type APIRequestContext, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { apiRequest } from '../workflowUi'
import { CONTROL_API, type RuntimeTokens } from './constants'

export async function expectCreateTeamApprovalRejected(
  _request: APIRequestContext,
  tokens: RuntimeTokens,
  namespace: string,
  name: string,
  teamId: string,
  expectedStatus: number,
  expectedError?: string,
  caller = `${namespace}/${name}`
): Promise<void> {
  const response = await apiRequest(
    'POST',
    `${CONTROL_API}/api/v1/workflow-approvals/request`,
    JSON.stringify({
      recipeNamespace: namespace,
      recipeName: name,
      target: { teamId },
      payload: {
        message: `Approve ${namespace}/${name}`,
        metadata: { workflowTrigger: { namespace, name, caller } },
      },
      ttlSeconds: 300,
    }),
    {
      Authorization: `Bearer ${tokens.mcpHostAccessToken}`,
      'Idempotency-Key': `${name}-reject-${randomUUID()}`,
    }
  )

  expect(response.status, response.body).toBe(expectedStatus)
  if (expectedError) {
    expect(JSON.parse(response.body)).toMatchObject({ error: expectedError })
  }
}
