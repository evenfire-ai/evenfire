import { describe, expect, it } from 'vitest'
import { type NetworkPolicyConfig, buildWorkflowNetworkPolicies } from './networkPolicyFactory'

const baseConfig: NetworkPolicyConfig = {
  recipeName: 'daily-report',
  sandboxNamespace: 'sandbox-recipes',
  controlPlaneNamespace: 'control-plane',
  mcpServerNamespace: 'mcp-server',
  wrcPort: 8081,
  mcpHostPort: 8080,
}

describe('workflow GFS NetworkPolicy', () => {
  it('opens only workflow mcp-host egress to gfsc when a recipe includes mcp-host', () => {
    const policies = buildWorkflowNetworkPolicies(baseConfig, [])
    const policy = policies.find(np => np.metadata?.name === 'daily-report-mcp-host-to-gfs')

    expect(policy).toBeDefined()
    expect(policy?.metadata?.namespace).toBe('sandbox-recipes')
    expect(policy?.spec?.podSelector?.matchLabels).toMatchObject({
      'clerum.io/recipe': 'daily-report',
      'clerum.io/component': 'workflow-mcp-host',
    })

    const rule = policy?.spec?.egress?.[0]
    expect(rule?.ports?.[0]).toMatchObject({ port: 8087, protocol: 'TCP' })
    expect(rule?.to?.[0]?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']).toBe(
      'gfs'
    )
    expect(rule?.to?.[0]?.podSelector?.matchLabels?.app).toBe('gfs-controller')
  })

  it('honors configured GFS namespace and gfsc port', () => {
    const policies = buildWorkflowNetworkPolicies({
      ...baseConfig,
      gfsNamespace: 'custom-gfs',
      gfscPort: 19087,
    })
    const policy = policies.find(np => np.metadata?.name === 'daily-report-mcp-host-to-gfs')
    const rule = policy?.spec?.egress?.[0]

    expect(rule?.ports?.[0].port).toBe(19087)
    expect(rule?.to?.[0]?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']).toBe(
      'custom-gfs'
    )
  })

  it('does not emit the GFS egress policy when no workflow mcp-host is included', () => {
    const policies = buildWorkflowNetworkPolicies({ ...baseConfig, includeMcpHost: false })

    expect(policies.some(np => np.metadata?.name === 'daily-report-mcp-host-to-gfs')).toBe(false)
  })

  it('opens coordinator egress to gfsc only when workflow output publishing is enabled', () => {
    const withoutPublish = buildWorkflowNetworkPolicies({ ...baseConfig, includeMcpHost: false })
    expect(withoutPublish.some(np => np.metadata?.name === 'daily-report-coordinator-to-gfs')).toBe(
      false
    )

    const withPublish = buildWorkflowNetworkPolicies({
      ...baseConfig,
      includeMcpHost: false,
      includeCoordinatorGfs: true,
    })
    const policy = withPublish.find(np => np.metadata?.name === 'daily-report-coordinator-to-gfs')

    expect(policy?.spec?.podSelector?.matchLabels).toMatchObject({
      'clerum.io/recipe': 'daily-report',
      'clerum.io/component': 'workflow-coordinator',
    })
    const rule = policy?.spec?.egress?.[0]
    expect(rule?.ports?.[0]).toMatchObject({ port: 8087, protocol: 'TCP' })
    expect(rule?.to?.[0]?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']).toBe(
      'gfs'
    )
  })
})
