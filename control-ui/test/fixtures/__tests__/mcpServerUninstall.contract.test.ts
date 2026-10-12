import { describe, expect, it } from 'vitest'
import { isMcpServerUninstallStage } from '../../../lib/api'
import { ALL_PENDING_BODIES } from '../mcpServerUninstall'

describe('MCP server uninstall producer golden contract', () => {
  it('knows every pending stage the producer emits in its golden wire bodies', () => {
    const stages = [...new Set(ALL_PENDING_BODIES.flatMap(body => body.pending))]

    expect(stages.sort()).toEqual(['dynamic_client', 'mcp_server', 'oauth_grants', 'secrets'])
    expect(stages.filter(stage => !isMcpServerUninstallStage(stage))).toEqual([])
  })

  it('reads the error and outcome codes the client recognises', () => {
    for (const body of ALL_PENDING_BODIES) {
      expect(body.error).toBe('mcp_server_uninstall_incomplete')
      expect(body.outcome).toBe('repair_required')
    }
  })
})
