import { describe, expect, it } from 'vitest'
import { type NetworkPolicyConfig, buildWorkflowNetworkPolicies } from './networkPolicyFactory'

const baseConfig: NetworkPolicyConfig = {
  recipeName: 'codex-recipe',
  sandboxNamespace: 'sandbox-recipes',
  controlPlaneNamespace: 'control-plane',
  mcpServerNamespace: 'mcp-server',
  wrcPort: 8082,
  mcpHostPort: 8080,
}

describe('workflow Codex proxy NetworkPolicy', () => {
  it('opens mcp-host egress to the isolated Codex proxy from the eligibility projection', () => {
    const policies = buildWorkflowNetworkPolicies({
      ...baseConfig,
      includeCodexProxyEgress: true,
    })
    const policy = policies.find(np => np.metadata?.name === 'codex-recipe-mcp-host-to-codex-proxy')

    expect(policy).toBeDefined()
    expect(policy?.metadata?.namespace).toBe('sandbox-recipes')
    expect(policy?.metadata?.labels?.['clerum.io/policy-type']).toBe('codex-proxy-egress')
    expect(policy?.spec?.podSelector?.matchLabels).toMatchObject({
      'clerum.io/recipe': 'codex-recipe',
      'clerum.io/component': 'workflow-mcp-host',
    })
    const rule = policy?.spec?.egress?.[0]
    expect(rule?.ports?.[0]).toMatchObject({ port: 8080, protocol: 'TCP' })
    expect(rule?.to?.[0]?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']).toBe(
      'control-plane'
    )
    expect(rule?.to?.[0]?.podSelector?.matchLabels).toEqual({ app: 'codex-llm-proxy' })
  })

  it('does not emit Codex proxy egress unless the same projection asks for it', () => {
    const policies = buildWorkflowNetworkPolicies(baseConfig)
    expect(policies.some(np => np.metadata?.name === 'codex-recipe-mcp-host-to-codex-proxy')).toBe(
      false
    )
  })

  it('does not emit Codex proxy egress when the workflow mcp-host is omitted', () => {
    const policies = buildWorkflowNetworkPolicies({
      ...baseConfig,
      includeMcpHost: false,
      includeCodexProxyEgress: true,
    })
    expect(policies.some(np => np.metadata?.name === 'codex-recipe-mcp-host-to-codex-proxy')).toBe(
      false
    )
  })
})
