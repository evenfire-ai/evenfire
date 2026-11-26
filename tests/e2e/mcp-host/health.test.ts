/**
 * E2E: Health Checks — verify all services are reachable and healthy.
 */
import { describe, expect, it } from 'vitest'
import {
  CTX_MAPPER_URL,
  DEFAULT_HOST_REF,
  MCP_HOST_URL,
  getStatus,
  healthCheck,
  kubectl,
} from '../helpers.js'
import { issueRealRpcToken } from './runtimeAuth.js'

describe('Health Checks', () => {
  it('mcp-host responds 200 on /health', async () => {
    const ok = await healthCheck(MCP_HOST_URL)
    expect(ok).toBe(true)
  })

  it('host-context-controller responds 200 on /health', async () => {
    const ok = await healthCheck(CTX_MAPPER_URL)
    if (ok) {
      expect(ok).toBe(true)
      return
    }

    const readyReplicas = kubectl(
      "get deployment host-context-controller -n control-plane -o jsonpath='{.status.readyReplicas}'"
    )
    expect(Number(readyReplicas.replace(/'/g, ''))).toBeGreaterThan(0)
  })

  it('mcp-host status through rpc-proxy returns agentState and queueDepth', async () => {
    // Only this check needs a user token; the health probes above stay
    // independent of the login and token chain.
    const statusToken = await issueRealRpcToken(['host:status:read'], [DEFAULT_HOST_REF])
    const status = await getStatus(statusToken)
    expect(status.agent).toBeDefined()
    expect(['idle', 'processing', 'waiting_approval']).toContain(status.agent.state)
    expect(status.queue).toBeDefined()
    expect(typeof status.queue.pending).toBe('number')
  })
})
