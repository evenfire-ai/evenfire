import { describe, expect, it } from 'vitest'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '../navigation'

describe('desktop navigation routes', () => {
  it('keeps top-level destinations in one contract', () => {
    expect(DESKTOP_ROUTES).toMatchObject({
      chat: 'chat',
      agents: 'agents',
      connectors: 'mcp-servers',
      plugins: 'workflows',
      settings: 'settings',
    })
  })

  it('centralizes agent workspace destinations', () => {
    expect(AGENT_WORKSPACE_ROUTES.connectors).toBe('mcp-servers')
    expect(AGENT_WORKSPACE_ROUTES.sharedFiles).toBe('shared-files')
  })
})
