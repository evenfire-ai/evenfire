import { describe, expect, it } from 'vitest'
import {
  NetworkPolicyConfig,
  buildWorkflowNetworkPolicies,
} from '../../../src/workflow/networkPolicyFactory'

const npConfig: NetworkPolicyConfig = {
  recipeName: 'test-recipe',
  sandboxNamespace: 'sandbox-recipes',
  controlPlaneNamespace: 'control-plane',
  mcpServerNamespace: 'mcp-server',
  wrcPort: 8082,
  mcpHostPort: 8080,
}

describe('NetworkPolicy Factory — Approval Gateway NP #8', () => {
  const policies = buildWorkflowNetworkPolicies(npConfig, [])

  const approvalNP = policies.find(
    p => p.metadata!.name === 'test-recipe-mcp-host-to-approval-gateway'
  )

  // ── NP existence ────────────────────────────────────────────────────

  it('creates the approval gateway egress NP', () => {
    expect(approvalNP).toBeDefined()
  })

  // ── NP metadata ─────────────────────────────────────────────────────

  it('places NP in sandbox-recipes namespace', () => {
    expect(approvalNP!.metadata!.namespace).toBe('sandbox-recipes')
  })

  it('has recipe label', () => {
    expect(approvalNP!.metadata!.labels!['clerum.io/recipe']).toBe('test-recipe')
  })

  // ── NP spec — pod selector ──────────────────────────────────────────

  it('selects workflow-mcp-host pods', () => {
    const selector = approvalNP!.spec!.podSelector!.matchLabels!
    expect(selector['clerum.io/component']).toBe('workflow-mcp-host')
    expect(selector['clerum.io/recipe']).toBe('test-recipe')
  })

  // ── NP spec — egress rules ──────────────────────────────────────────

  it('is Egress-only policy', () => {
    expect(approvalNP!.spec!.policyTypes).toEqual(['Egress'])
  })

  it('targets control-plane namespace', () => {
    const egress = approvalNP!.spec!.egress![0]
    const peer = egress.to![0]
    expect(peer.namespaceSelector!.matchLabels!['kubernetes.io/metadata.name']).toBe(
      'control-plane'
    )
  })

  it('targets nginx-workflow-approval-gateway pods', () => {
    const egress = approvalNP!.spec!.egress![0]
    const peer = egress.to![0]
    expect(peer.podSelector!.matchLabels!['app']).toBe('nginx-workflow-approval-gateway')
  })

  it('allows traffic on port 8092 TCP', () => {
    const egress = approvalNP!.spec!.egress![0]
    expect(egress.ports).toEqual([{ port: 8092, protocol: 'TCP' }])
  })

  it('does not grant workflow mcp-host direct control-api egress', () => {
    const workflowMcpHostEgressPolicies = policies.filter(policy => {
      const selector = policy.spec?.podSelector?.matchLabels ?? {}
      return (
        policy.spec?.policyTypes?.includes('Egress') &&
        selector['clerum.io/recipe'] === 'test-recipe' &&
        selector['clerum.io/component'] === 'workflow-mcp-host'
      )
    })
    expect(workflowMcpHostEgressPolicies.length).toBeGreaterThan(0)

    for (const policy of workflowMcpHostEgressPolicies) {
      for (const rule of policy.spec?.egress ?? []) {
        expect(rule.ports?.map(port => port.port)).not.toContain(8090)
        for (const target of rule.to ?? []) {
          expect(target.podSelector?.matchLabels?.app).not.toBe('control-api')
        }
      }
    }
  })

  // ── Regression: other NPs unaffected ─────────────────────────────────

  it('does not duplicate or remove existing NPs', () => {
    // With no mcpServerNames: 7 policies total
    // (1 coord→mcp-host, 1b coord→mcp-host ingress, 2 coord→wrc,
    //  3 wrc→mcp-host, 6 mcp-host→llm-api, 8 mcp-host→approval-gateway, 9 mcp-host→gfs)
    expect(policies).toHaveLength(7)
  })
})
