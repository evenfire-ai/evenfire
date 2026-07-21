import { describe, expect, it } from 'vitest'
import { CONTROL_ROUTES, isControlRouteSection } from '@constants/routes'

describe('CONTROL_ROUTES', () => {
  it('encodes dynamic path segments once', () => {
    expect(CONTROL_ROUTES.plugins.run('team one', 'plugin/name', 'run #1')).toBe(
      '/plugins/team%20one/plugin%2Fname/runs/run%20%231'
    )
    expect(CONTROL_ROUTES.usersAndTeams.user('user/name')).toBe(
      '/users-and-teams/users/user%2Fname'
    )
  })

  it('builds transient query state and omits empty values', () => {
    expect(CONTROL_ROUTES.secrets.new({ scope: 'mcp', name: 'remote connector', unused: '' })).toBe(
      '/secrets/new?scope=mcp&name=remote+connector'
    )
  })

  it('matches only the requested route section', () => {
    expect(isControlRouteSection('/agents/example/overview', CONTROL_ROUTES.agents.root)).toBe(true)
    expect(isControlRouteSection('/agents-old', CONTROL_ROUTES.agents.root)).toBe(false)
  })

  it('uses the canonical directory section names in public paths', () => {
    expect(CONTROL_ROUTES.agentFiles.root).toBe('/agent-files')
    expect(CONTROL_ROUTES.agentOutputs.root).toBe('/agent-outputs/recipe-artifacts')
    expect(CONTROL_ROUTES.globalFileSystem).toBe('/global-file-system')
  })
})
