import { describe, expect, it } from 'vitest'
import {
  type NetworkPolicyConfig,
  buildCoordinatorGfsNetworkPolicy,
  buildWorkflowNetworkPolicies,
} from './networkPolicyFactory'

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

  it('omits coordinator lanes for a stepless SDK host while keeping mcp-host access', () => {
    const policies = buildWorkflowNetworkPolicies({
      ...baseConfig,
      includeCoordinator: false,
      pluginWorkloadSdkSandboxAccess: true,
    })
    const names = policies.map(policy => policy.metadata?.name)

    expect(names).not.toContain('daily-report-coord-to-mcp-host')
    expect(names).not.toContain('daily-report-coord-to-mcp-host-ingress')
    expect(names).not.toContain('daily-report-coord-to-wrc')
    expect(names).not.toContain('daily-report-coordinator-to-gfs')
    expect(names).toContain('daily-report-wrc-to-mcp-host')
    expect(names).toContain('daily-report-mcp-host-to-gfs')
    expect(names).toContain('daily-report-mcp-host-to-llm-api')
    expect(names).toContain('daily-report-workload-to-mcp-host-sdk-ingress')
  })

  it('allows public runtime egress only over HTTPS', () => {
    const policies = buildWorkflowNetworkPolicies({
      ...baseConfig,
      coordinatorPublicHttpEgress: true,
      coordinatorPublicHttpEgressClass: 'public-web',
    })
    const policy = policies.find(np => np.metadata?.name === 'daily-report-coord-to-wrc')
    const publicRule = policy?.spec?.egress?.find(rule =>
      rule.to?.some(destination => destination.ipBlock !== undefined)
    )

    expect(publicRule?.ports).toEqual([{ port: 443, protocol: 'TCP' }])
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

  it('uses the canonical coordinator GFS policy for custom destinations', () => {
    const policy = buildCoordinatorGfsNetworkPolicy({
      recipeName: 'daily-report',
      sandboxNamespace: 'sandbox-recipes',
      gfsNamespace: 'custom-gfs',
      gfscPort: 19087,
    })

    expect(policy).toEqual({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'daily-report-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        labels: {
          'clerum.io/recipe': 'daily-report',
          'clerum.io/managed-by': 'wrc',
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            'clerum.io/recipe': 'daily-report',
            'clerum.io/component': 'workflow-coordinator',
          },
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'custom-gfs' },
                },
                podSelector: { matchLabels: { app: 'gfs-controller' } },
              },
            ],
            ports: [{ port: 19087, protocol: 'TCP' }],
          },
        ],
      },
    })
  })
})
