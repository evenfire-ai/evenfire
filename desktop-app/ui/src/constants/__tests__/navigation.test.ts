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

  it('drops Contexts and Teams from the top-level contract (F2 deep removal)', () => {
    expect(DESKTOP_ROUTES).not.toHaveProperty('contexts')
    expect(DESKTOP_ROUTES).not.toHaveProperty('contextDetails')
    expect(DESKTOP_ROUTES).not.toHaveProperty('teams')
    expect(DESKTOP_ROUTES).not.toHaveProperty('teamDetails')
  })

  it('agent workspace routes are connectors/members/shared-files/activity only', () => {
    expect(AGENT_WORKSPACE_ROUTES).toEqual({
      connectors: 'mcp-servers',
      members: 'members',
      sharedFiles: 'shared-files',
      activity: 'activity',
    })
    expect(AGENT_WORKSPACE_ROUTES).not.toHaveProperty('details')
    expect(AGENT_WORKSPACE_ROUTES).not.toHaveProperty('contexts')
  })
})
