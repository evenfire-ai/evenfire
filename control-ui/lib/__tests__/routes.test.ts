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
    expect(CONTROL_ROUTES.globalFileSystem).not.toBe(CONTROL_ROUTES.agentFiles.root)
    expect(CONTROL_ROUTES.agentFiles.detail('main drive')).toBe('/agent-files/main%20drive')
  })

  it('does not expose an LLM Models Codex subscription owner path', () => {
    expect('codexSubscription' in CONTROL_ROUTES.llmModels).toBe(false)
  })

  it('nests ChatGPT subscriptions under Secrets LLM', () => {
    expect(CONTROL_ROUTES.secrets.llmSubscriptions).toBe('/secrets/llm/subscriptions')
    expect(CONTROL_ROUTES.secrets.subscription).toBe('/secrets/llm/subscriptions')
  })

  it('builds the full-screen LLM secret edit route with optional return context', () => {
    expect(CONTROL_ROUTES.secrets.editLlm('chatllm-api-keys')).toBe(
      '/secrets/llm/chatllm-api-keys/edit'
    )
    expect(CONTROL_ROUTES.secrets.editLlm('chatllm api keys', { from: '/agents/foo/model' })).toBe(
      '/secrets/llm/chatllm%20api%20keys/edit?from=%2Fagents%2Ffoo%2Fmodel'
    )
  })
})
