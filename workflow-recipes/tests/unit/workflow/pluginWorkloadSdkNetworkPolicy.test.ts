import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  NetworkPolicyConfig,
  buildWorkflowNetworkPolicies,
} from '../../../src/workflow/networkPolicyFactory'

// Plugin Workload SDK NetworkPolicy generation (plan §6.1, OQ-4).
// Two additive policies open the SDK port (8099) between same-recipe plugin
// workloads and the recipe's mcp-host: ingress at the mcp-host + egress at
// the workloads. deny-all-sandbox-recipes makes both directions necessary.

const SDK_PORT = 8099

const baseConfig: NetworkPolicyConfig = {
  recipeName: 'test-wf',
  sandboxNamespace: 'sandbox-recipes',
  controlPlaneNamespace: 'control-plane',
  mcpServerNamespace: 'mcp-server',
  wrcPort: 8082,
  mcpHostPort: 8080,
  includeMcpHost: true,
}

function sdkPolicies(config: NetworkPolicyConfig): k8s.V1NetworkPolicy[] {
  return buildWorkflowNetworkPolicies(config).filter(p =>
    (p.metadata?.name ?? '').includes('-workload-to-mcp-host-sdk-')
  )
}

const ingressPolicy = (config: NetworkPolicyConfig) =>
  sdkPolicies(config).find(p => p.metadata?.name?.endsWith('-sdk-ingress'))
const egressPolicy = (config: NetworkPolicyConfig) =>
  sdkPolicies(config).find(p => p.metadata?.name?.endsWith('-sdk-egress'))
const brokerPolicy = (config: NetworkPolicyConfig) =>
  buildWorkflowNetworkPolicies(config).find(p =>
    p.metadata?.name?.endsWith('-mcp-host-to-wrc-sdk-broker')
  )

describe('Plugin Workload SDK NetworkPolicies', () => {
  it('emits no SDK policies when the capability access flag is unset', () => {
    expect(sdkPolicies(baseConfig)).toHaveLength(0)
  })

  it('emits no SDK policies when the flag is explicitly false', () => {
    expect(sdkPolicies({ ...baseConfig, pluginWorkloadSdkSandboxAccess: false })).toHaveLength(0)
  })

  it('emits exactly the ingress + egress pair when access is enabled', () => {
    const policies = sdkPolicies({ ...baseConfig, pluginWorkloadSdkSandboxAccess: true })
    expect(policies).toHaveLength(2)
    expect(policies.map(p => p.metadata?.name).sort()).toEqual([
      'test-wf-workload-to-mcp-host-sdk-egress',
      'test-wf-workload-to-mcp-host-sdk-ingress',
    ])
  })

  it('opens the SDK mcp-host credential broker only to WRC', () => {
    const policy = brokerPolicy({ ...baseConfig, pluginWorkloadSdkSandboxAccess: true })!
    expect(policy.spec?.podSelector?.matchLabels).toEqual({
      'clerum.io/recipe': 'test-wf',
      'clerum.io/component': 'workflow-mcp-host',
    })
    expect(policy.spec?.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'control-plane' },
            },
            podSelector: { matchLabels: { app: 'workflow-recipes' } },
          },
        ],
        ports: [{ port: 8082, protocol: 'TCP' }],
      },
    ])
    expect(brokerPolicy({ ...baseConfig, pluginWorkloadSdkSandboxAccess: false })).toBeUndefined()
  })

  it('does NOT emit SDK policies on the coordinator-only path (includeMcpHost false)', () => {
    // The SDK server only runs on the recipe mcp-host; when it is absent the
    // factory returns early and never includes the SDK lane.
    const policies = sdkPolicies({
      ...baseConfig,
      includeMcpHost: false,
      pluginWorkloadSdkSandboxAccess: true,
    })
    expect(policies).toHaveLength(0)
  })

  describe('ingress policy (at the mcp-host)', () => {
    const policy = () => ingressPolicy({ ...baseConfig, pluginWorkloadSdkSandboxAccess: true })!

    it('selects the recipe mcp-host pod', () => {
      expect(policy().spec?.podSelector?.matchLabels).toEqual({
        'clerum.io/recipe': 'test-wf',
        'clerum.io/component': 'workflow-mcp-host',
      })
    })

    it('opens only the SDK port for Ingress', () => {
      expect(policy().spec?.policyTypes).toEqual(['Ingress'])
      expect(policy().spec?.ingress?.[0].ports).toEqual([{ port: SDK_PORT, protocol: 'TCP' }])
    })

    it('allows only same-recipe plugin workload pods as the source', () => {
      // In-memory the field is `_from` (the k8s client renames it to `from`
      // only on serialization — see the factory comment).
      const from = (policy().spec?.ingress?.[0] as { _from?: k8s.V1NetworkPolicyPeer[] })._from
      expect(from?.[0].podSelector?.matchLabels).toEqual({ 'clerum.io/recipe': 'test-wf' })
      expect(from?.[0].podSelector?.matchExpressions).toEqual([
        { key: 'clerum.io/workload', operator: 'Exists' },
      ])
      // No namespaceSelector → intra-namespace only (sandbox-recipes).
      expect(from?.[0].namespaceSelector).toBeUndefined()
    })

    it('serializes _from to the K8s "from" field (no _from leaks)', () => {
      const yaml = k8s.dumpYaml(policy())
      expect(yaml).toContain('from:')
      expect(yaml).not.toContain('_from:')
    })
  })

  describe('egress policy (at the plugin workloads)', () => {
    const policy = () => egressPolicy({ ...baseConfig, pluginWorkloadSdkSandboxAccess: true })!

    it('selects same-recipe plugin workload pods', () => {
      expect(policy().spec?.podSelector?.matchLabels).toEqual({ 'clerum.io/recipe': 'test-wf' })
      expect(policy().spec?.podSelector?.matchExpressions).toEqual([
        { key: 'clerum.io/workload', operator: 'Exists' },
      ])
    })

    it('opens egress only to the recipe mcp-host on the SDK port', () => {
      expect(policy().spec?.policyTypes).toEqual(['Egress'])
      const rule = policy().spec?.egress?.[0]
      expect(rule?.ports).toEqual([{ port: SDK_PORT, protocol: 'TCP' }])
      expect(rule?.to?.[0].podSelector?.matchLabels).toEqual({
        'clerum.io/recipe': 'test-wf',
        'clerum.io/component': 'workflow-mcp-host',
      })
    })
  })

  it('labels both policies for finalizer cleanup (recipe + managed-by=wrc)', () => {
    const policies = sdkPolicies({ ...baseConfig, pluginWorkloadSdkSandboxAccess: true })
    for (const p of policies) {
      expect(p.metadata?.labels).toMatchObject({
        'clerum.io/recipe': 'test-wf',
        'clerum.io/managed-by': 'wrc',
      })
      expect(p.metadata?.namespace).toBe('sandbox-recipes')
    }
  })
})
