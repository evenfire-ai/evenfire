import { expect, test } from '@playwright/test'
import { CONTROL_API } from './workflow-approval-quadrants/constants'
import {
  expectWorkflowApprovalReaderAvoidsControlPlaneGateway,
  expectWorkflowApprovalReaderNetworkPolicyTargetsMcpHostOnly,
} from './workflow-approval-quadrants/contracts'

const RUN_FIGURE_D = process.env.E2E_FIGURE_D_TELEGRAM_SLACK === '1'

test.describe('Figure D boundary: reader routes only through workflow runtime mcp-hosts', () => {
  test.skip(!RUN_FIGURE_D, 'Set E2E_FIGURE_D_TELEGRAM_SLACK=1 against a seeded minikube stack')

  test('rejects direct reader control-plane/gateway and chatllm target wiring', async () => {
    expectWorkflowApprovalReaderAvoidsControlPlaneGateway()
    expectWorkflowApprovalReaderNetworkPolicyTargetsMcpHostOnly()
  })

  test('does not expose the old reader decision route on control-api', async () => {
    const response = await fetch(`${CONTROL_API}/api/v1/workflow-approval-reader/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalRequestId: '99999999-8888-7777-6666-555555555555' }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).not.toBe(200)
  })
})
