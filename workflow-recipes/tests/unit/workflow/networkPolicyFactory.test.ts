import { describe, expect, it } from 'vitest'
import {
  NetworkPolicyConfig,
  PUBLIC_HTTP_EGRESS_EXCEPT_CIDRS,
  buildWorkflowNetworkPolicies,
  truncateRfc1123,
  truncateRfc1123WithHash,
} from '../../../src/workflow/networkPolicyFactory'

const npConfig: NetworkPolicyConfig = {
  recipeName: 'test-wf',
  sandboxNamespace: 'sandbox-recipes',
  controlPlaneNamespace: 'control-plane',
  mcpServerNamespace: 'mcp-server',
  wrcPort: 8082,
  mcpHostPort: 8080,
}

function hasPublicHttpEgressRule(policy: {
  spec?: {
    egress?: Array<{
      to?: Array<{ ipBlock?: { cidr?: string; except?: string[] } }>
      ports?: Array<{ port?: number | string }>
    }>
  }
}): boolean {
  return Boolean(
    policy.spec?.egress?.some(rule => {
      const ports = new Set(rule.ports?.map(port => port.port))
      return (
        ports.has(443) &&
        ports.has(80) &&
        rule.to?.some(target => {
          const block = target.ipBlock
          const requiredExcludes = [
            '0.0.0.0/8',
            '10.0.0.0/8',
            '100.64.0.0/10',
            '127.0.0.0/8',
            '169.254.0.0/16',
            '172.16.0.0/12',
            '192.0.0.0/24',
            '192.0.2.0/24',
            '192.31.196.0/24',
            '192.52.193.0/24',
            '192.88.99.0/24',
            '192.168.0.0/16',
            '192.175.48.0/24',
            '198.51.100.0/24',
            '198.18.0.0/15',
            '203.0.113.0/24',
            '224.0.0.0/4',
            '240.0.0.0/4',
          ]
          return Boolean(
            block?.cidr &&
            (block.cidr !== '0.0.0.0/0' ||
              requiredExcludes.every(item => block.except?.includes(item)))
          )
        })
      )
    })
  )
}

function publicHttpEgressCidrs(policy: {
  spec?: {
    egress?: Array<{
      to?: Array<{ ipBlock?: { cidr?: string } }>
      ports?: Array<{ port?: number | string }>
    }>
  }
}): string[] {
  return (
    policy.spec?.egress
      ?.filter(rule => {
        const ports = new Set(rule.ports?.map(port => port.port))
        return ports.has(443) && ports.has(80)
      })
      .flatMap(rule => rule.to?.map(target => target.ipBlock?.cidr).filter(Boolean) ?? []) ?? []
  )
}

describe('NetworkPolicy Factory', () => {
  // Pass mcpServerNames so the 4th policy (mcp-host→mcp-servers) is included.
  const mcpServerNames = ['test-wf-redis-mcp']
  const policies = buildWorkflowNetworkPolicies(npConfig, mcpServerNames)

  it('creates exactly 9 NetworkPolicies when mcpServerNames is non-empty', () => {
    // sandbox-recipes: 1: coord→mcp-host egress, 1b: coord→mcp-host ingress,
    //   2: coord→wrc egress, 3: wrc→mcp-host ingress, 6: mcp-host→llm-api,
    //   4: mcp-host→servers, 7: mcp-host→approval-gateway, 8: mcp-host→gfs
    // mcp-server: 5: wf-mcp-host-ingress
    // NOTE: control-plane NPs (coord→wrc ingress, wrc→mcp-host egress) are STATIC
    // in deploy/base/control-plane/ — WRC cannot self-modify its own namespace.
    expect(policies).toHaveLength(9)
  })

  it('does not create broad internet egress for recipe MCP transport workloads', () => {
    expect(policies.map(policy => policy.metadata?.name)).not.toContain(
      'test-wf-mcp-servers-egress-internet'
    )
    expect(
      policies.find(policy => policy.metadata?.name?.endsWith('mcp-servers-egress-internet'))
    ).toBeUndefined()
  })

  it('keeps runtime public HTTP egress public-only by excluding private and special ranges', () => {
    expect(PUBLIC_HTTP_EGRESS_EXCEPT_CIDRS).toEqual(
      expect.arrayContaining([
        '10.0.0.0/8',
        '127.0.0.0/8',
        '169.254.0.0/16',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '224.0.0.0/4',
        '240.0.0.0/4',
      ])
    )
  })

  it('creates coord→mcp-host egress policy', () => {
    const policy = policies.find(p => p.metadata!.name === 'test-wf-coord-to-mcp-host')
    expect(policy).toBeDefined()
    expect(policy!.spec!.policyTypes).toEqual(['Egress'])
    expect(policy!.spec!.podSelector!.matchLabels!['clerum.io/component']).toBe(
      'workflow-coordinator'
    )
  })

  it('creates coord→WRC egress policy (cross-namespace)', () => {
    const policy = policies.find(p => p.metadata!.name === 'test-wf-coord-to-wrc')
    expect(policy).toBeDefined()
    expect(policy!.spec!.policyTypes).toEqual(['Egress'])
    const dnsRule = policy!.spec!.egress!.find(rule =>
      rule.ports?.some(port => port.port === 53 && port.protocol === 'UDP')
    )
    expect(dnsRule!.to![0].namespaceSelector!.matchLabels!['kubernetes.io/metadata.name']).toBe(
      'kube-system'
    )
    expect(
      policy!.spec!.egress![1].to![0].namespaceSelector!.matchLabels!['kubernetes.io/metadata.name']
    ).toBe('control-plane')
  })

  it('creates WRC→mcp-host ingress policy', () => {
    const policy = policies.find(p => p.metadata!.name === 'test-wf-wrc-to-mcp-host')
    expect(policy).toBeDefined()
    expect(policy!.spec!.policyTypes).toEqual(['Ingress'])
    expect(policy!.spec!.podSelector!.matchLabels!['clerum.io/component']).toBe('workflow-mcp-host')
  })

  it('creates mcp-host→mcp-servers egress policy with per-server pod selectors', () => {
    const policy = policies.find(p => p.metadata!.name === 'test-wf-mcp-host-to-servers')
    expect(policy).toBeDefined()
    expect(policy!.spec!.policyTypes).toEqual(['Egress'])
    // Per-server scoping: namespaceSelector AND podSelector (not blanket namespace)
    expect(
      policy!.spec!.egress![0].to![0].namespaceSelector!.matchLabels!['kubernetes.io/metadata.name']
    ).toBe('mcp-server')
    expect(policy!.spec!.egress![0].to![0].podSelector!.matchLabels!['clerum.io/mcpserver']).toBe(
      'test-wf-redis-mcp'
    )
    // Port restricted to 3000
    expect(policy!.spec!.egress![0].ports![0].port).toBe(3000)
  })

  it('creates one egress rule per MCP server', () => {
    const twoServers = ['test-wf-server-a', 'test-wf-server-b']
    const p2 = buildWorkflowNetworkPolicies(npConfig, twoServers)
    const mcpPolicy = p2.find(p => p.metadata!.name === 'test-wf-mcp-host-to-servers')
    expect(mcpPolicy).toBeDefined()
    expect(mcpPolicy!.spec!.egress).toHaveLength(2)
    expect(
      mcpPolicy!.spec!.egress![0].to![0].podSelector!.matchLabels!['clerum.io/mcpserver']
    ).toBe('test-wf-server-a')
    expect(
      mcpPolicy!.spec!.egress![1].to![0].podSelector!.matchLabels!['clerum.io/mcpserver']
    ).toBe('test-wf-server-b')
  })

  it('omits mcp-host→mcp-servers policy when mcpServerNames is empty', () => {
    const emptyPolicies = buildWorkflowNetworkPolicies(npConfig, [])
    // Without MCP servers: coord→mcp-host, coord→mcp-host-ingress, coord→wrc,
    // wrc→mcp-host, mcp-host→llm-api, mcp-host→approval-gateway = 7 NPs
    // NOTE: control-plane NPs are static (not created by factory).
    expect(emptyPolicies).toHaveLength(7)
    const mcpPolicy = emptyPolicies.find(p => p.metadata!.name === 'test-wf-mcp-host-to-servers')
    expect(mcpPolicy).toBeUndefined()
  })

  it('creates only coordinator-to-WRC plus WRC-to-artifact-reader policies for pure output workflows', () => {
    const purePolicies = buildWorkflowNetworkPolicies(
      { ...npConfig, includeMcpHost: false, includeArtifactReader: true, artifactReaderPort: 8080 },
      []
    )

    expect(purePolicies.map(policy => policy.metadata!.name)).toEqual([
      'test-wf-coord-to-wrc',
      'test-wf-wrc-to-artifact-reader',
    ])
    const artifactReaderPolicy = purePolicies[1]
    expect(artifactReaderPolicy.spec!.policyTypes).toEqual(['Ingress'])
    expect(artifactReaderPolicy.spec!.podSelector!.matchLabels).toEqual({
      'clerum.io/recipe': 'test-wf',
      'clerum.io/component': 'workflow-artifact-reader',
    })
    expect(artifactReaderPolicy.spec!.ingress![0]._from![0]).toMatchObject({
      namespaceSelector: {
        matchLabels: { 'kubernetes.io/metadata.name': 'control-plane' },
      },
      podSelector: { matchLabels: { app: 'workflow-recipes' } },
    })
    expect(artifactReaderPolicy.spec!.ingress![0].ports![0].port).toBe(8080)
  })

  it('does not create an artifact-reader policy for snippet workflows without output artifacts', () => {
    const purePolicies = buildWorkflowNetworkPolicies({ ...npConfig, includeMcpHost: false }, [])

    expect(purePolicies.map(policy => policy.metadata!.name)).toEqual(['test-wf-coord-to-wrc'])
  })

  it('creates snippet runner policies from declared capabilities when no mcp-host is needed', () => {
    const snippetPolicies = buildWorkflowNetworkPolicies(
      {
        ...npConfig,
        includeMcpHost: false,
        includeSnippetRunner: true,
        snippetRunnerWorkloadEgress: [{ resourceName: 'test-wf-postgres-1234abcd', port: 5432 }],
      },
      [],
      ['test-wf-mongo-mcp']
    )

    expect(snippetPolicies.map(policy => policy.metadata!.name)).toEqual([
      'test-wf-coord-to-wrc',
      'test-wf-coord-to-snippet-runner',
      'test-wf-coord-to-snippet-runner-ingress',
      'test-wf-snippet-runner-egress',
      'test-wf-snippet-runner-to-test-wf-postgres-1234abcd',
      'test-wf-snippet-mcp-ingress-test-wf-mongo-mcp',
    ])

    const egress = snippetPolicies.find(
      policy => policy.metadata!.name === 'test-wf-snippet-runner-egress'
    )!
    expect(egress.spec!.podSelector!.matchLabels!['clerum.io/component']).toBe(
      'workflow-snippet-runner'
    )
    expect(
      egress.spec!.egress!.some(rule =>
        rule.to?.some(
          target => target.podSelector?.matchLabels?.app === 'test-wf-postgres-1234abcd'
        )
      )
    ).toBe(true)
    expect(
      egress.spec!.egress!.some(rule =>
        rule.to?.some(
          target => target.podSelector?.matchLabels?.['clerum.io/mcpserver'] === 'test-wf-mongo-mcp'
        )
      )
    ).toBe(true)
    expect(
      egress.spec!.egress!.some(
        rule =>
          rule.to === undefined && rule.ports?.some(port => port.port === 443 || port.port === 80)
      )
    ).toBe(false)
    expect(hasPublicHttpEgressRule(egress)).toBe(false)
  })

  it('creates unique snippet workload ingress names for long recipe/workload names', () => {
    const longRecipe = 'e2e-layer3a-snippet-direct-db'
    const snippetPolicies = buildWorkflowNetworkPolicies(
      {
        ...npConfig,
        recipeName: longRecipe,
        includeMcpHost: false,
        includeSnippetRunner: true,
        snippetRunnerWorkloadEgress: [
          { resourceName: `${longRecipe}-mongo`, port: 27017 },
          { resourceName: `${longRecipe}-postgres`, port: 5432 },
        ],
      },
      []
    )

    const workloadIngressNames = snippetPolicies
      .map(policy => policy.metadata!.name!)
      .filter(name => name.includes('snippet-runner-to'))

    expect(workloadIngressNames).toHaveLength(2)
    expect(new Set(workloadIngressNames).size).toBe(2)
    for (const name of workloadIngressNames) {
      expect(name.length).toBeLessThanOrEqual(63)
      expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    }
  })

  it('grants public HTTP egress to snippet runner only when declared', () => {
    const snippetPolicies = buildWorkflowNetworkPolicies(
      {
        ...npConfig,
        includeMcpHost: false,
        includeSnippetRunner: true,
        snippetRunnerPublicHttpEgress: true,
        snippetRunnerPublicHttpEgressCidrs: ['93.184.216.34/32'],
      },
      []
    )
    const egress = snippetPolicies.find(
      policy => policy.metadata!.name === 'test-wf-snippet-runner-egress'
    )!

    expect(hasPublicHttpEgressRule(egress)).toBe(true)
    expect(publicHttpEgressCidrs(egress)).toEqual(['93.184.216.34/32'])
    expect(egress.metadata!.labels!['clerum.io/egress-class']).toBe('exact-host')
  })

  it('labels explicit public-web egress and keeps private/special ranges excluded', () => {
    const snippetPolicies = buildWorkflowNetworkPolicies(
      {
        ...npConfig,
        includeMcpHost: false,
        includeSnippetRunner: true,
        snippetRunnerPublicHttpEgress: true,
        snippetRunnerPublicHttpEgressClass: 'public-web',
      },
      []
    )
    const egress = snippetPolicies.find(
      policy => policy.metadata!.name === 'test-wf-snippet-runner-egress'
    )!

    expect(egress.metadata!.labels!['clerum.io/egress-class']).toBe('public-web')
    expect(publicHttpEgressCidrs(egress)).toEqual(['0.0.0.0/0'])
    expect(hasPublicHttpEgressRule(egress)).toBe(true)
  })

  it('fails closed when snippet runner HTTP egress is declared with an empty explicit CIDR list', () => {
    expect(() =>
      buildWorkflowNetworkPolicies(
        {
          ...npConfig,
          includeMcpHost: false,
          includeSnippetRunner: true,
          snippetRunnerPublicHttpEgress: true,
          snippetRunnerPublicHttpEgressCidrs: [],
        },
        []
      )
    ).toThrow('explicit CIDR list resolved to empty')
  })

  it('grants public HTTP egress to custom coordinator only when declared', () => {
    const customPolicies = buildWorkflowNetworkPolicies(
      {
        ...npConfig,
        includeMcpHost: false,
        coordinatorPublicHttpEgress: true,
        coordinatorPublicHttpEgressCidrs: ['93.184.216.34/32'],
      },
      []
    )
    const policy = customPolicies.find(item => item.metadata!.name === 'test-wf-coord-to-wrc')!

    expect(hasPublicHttpEgressRule(policy)).toBe(true)
    expect(publicHttpEgressCidrs(policy)).toEqual(['93.184.216.34/32'])
    expect(policy.metadata!.labels!['clerum.io/egress-class']).toBe('exact-host')
  })

  it('fails closed when custom coordinator HTTP egress is declared with an empty explicit CIDR list', () => {
    expect(() =>
      buildWorkflowNetworkPolicies(
        {
          ...npConfig,
          includeMcpHost: false,
          coordinatorPublicHttpEgress: true,
          coordinatorPublicHttpEgressCidrs: [],
        },
        []
      )
    ).toThrow('explicit CIDR list resolved to empty')
  })

  it('grants custom coordinator access only to declared workflow workloads', () => {
    const customPolicies = buildWorkflowNetworkPolicies(
      {
        ...npConfig,
        includeMcpHost: false,
        coordinatorWorkloadEgress: [{ resourceName: 'test-wf-postgres-1234abcd', port: 5432 }],
      },
      []
    )
    const coordinatorEgress = customPolicies.find(
      item => item.metadata!.name === 'test-wf-coord-to-wrc'
    )!
    const workloadIngress = customPolicies.find(
      item => item.metadata!.name === 'test-wf-coordinator-to-test-wf-postgres-1234abcd'
    )!

    expect(
      coordinatorEgress.spec!.egress!.some(rule =>
        rule.to?.some(
          target => target.podSelector?.matchLabels?.app === 'test-wf-postgres-1234abcd'
        )
      )
    ).toBe(true)
    expect(workloadIngress.spec!.podSelector!.matchLabels!.app).toBe('test-wf-postgres-1234abcd')
    expect(workloadIngress.spec!.ingress![0]._from![0].podSelector!.matchLabels).toMatchObject({
      'clerum.io/component': 'workflow-coordinator',
      'clerum.io/recipe': 'test-wf',
    })
    expect(workloadIngress.spec!.ingress![0].ports![0].port).toBe(5432)
  })

  it('does not grant public HTTP egress to workflow coordinator pods by default', () => {
    const coordinatorEgressPolicies = policies.filter(
      policy =>
        policy.spec?.policyTypes?.includes('Egress') &&
        policy.spec?.podSelector?.matchLabels?.['clerum.io/component'] === 'workflow-coordinator'
    )
    expect(coordinatorEgressPolicies.length).toBeGreaterThan(0)
    for (const policy of coordinatorEgressPolicies) {
      expect(
        policy.spec!.egress!.some(
          rule =>
            rule.to === undefined && rule.ports?.some(port => port.port === 443 || port.port === 80)
        )
      ).toBe(false)
      expect(hasPublicHttpEgressRule(policy)).toBe(false)
    }
  })

  it('all policies have NO ownerReferences (cross-namespace GC safety)', () => {
    // WorkflowRecipe and workflow runtime NetworkPolicies live in sandbox-recipes.
    // K8s GC 1.24+ deletes cross-namespace owned resources.
    for (const policy of policies) {
      expect(policy.metadata!.ownerReferences).toBeUndefined()
    }
  })

  it('all policies have recipe label', () => {
    for (const policy of policies) {
      expect(policy.metadata!.labels!['clerum.io/recipe']).toBe('test-wf')
    }
  })

  it('creates mcp-host-to-llm-api egress NP for external LLM API calls (port 443)', () => {
    const policy = policies.find(p => p.metadata!.name === 'test-wf-mcp-host-to-llm-api')
    expect(policy).toBeDefined()
    expect(policy!.metadata!.namespace).toBe('sandbox-recipes')
    expect(policy!.metadata!.labels!['clerum.io/egress-class']).toBe('public-web')
    expect(policy!.spec!.policyTypes).toEqual(['Egress'])
    expect(hasPublicHttpEgressRule(policy!)).toBe(true)
    expect(policy!.spec!.egress![0].to?.[0]?.ipBlock?.cidr).toBe('0.0.0.0/0')
    expect(policy!.spec!.egress![0].to?.[0]?.ipBlock?.except).toEqual(
      expect.arrayContaining(['10.0.0.0/8', '169.254.0.0/16', '192.168.0.0/16'])
    )
    expect(policy!.spec!.egress![0].ports!.map(port => port.port)).toEqual([443, 80])
  })

  it('does not grant recipe MCP servers implicit public HTTP egress', () => {
    const policy = policies.find(p => p.metadata!.name === 'test-wf-mcp-servers-egress-internet')
    expect(policy).toBeUndefined()
  })

  it('creates per-mcp-server wf-mcp-ingress NP in mcp-server namespace (NP-02/03)', () => {
    // One NP per mcp-server name. Policy name: `${recipe}-wf-mcp-ingress-${mcpServer}`.
    const policy = policies.find(
      p => p.metadata!.name === 'test-wf-wf-mcp-ingress-test-wf-redis-mcp'
    )
    expect(policy).toBeDefined()
    expect(policy!.metadata!.namespace).toBe('mcp-server')
    expect(policy!.spec!.policyTypes).toEqual(['Ingress'])
    // Allows sandbox-recipes workflow mcp-host to reach mcp-server workloads
    expect(
      policy!.spec!.ingress![0]._from![0].namespaceSelector!.matchLabels![
        'kubernetes.io/metadata.name'
      ]
    ).toBe('sandbox-recipes')
    expect(
      policy!.spec!.ingress![0]._from![0].podSelector!.matchLabels!['clerum.io/component']
    ).toBe('workflow-mcp-host')
    expect(policy!.spec!.ingress![0].ports![0].port).toBe(3000)
  })
})

describe('truncateRfc1123', () => {
  it('returns the input unchanged when under the limit', () => {
    expect(truncateRfc1123('short-name')).toBe('short-name')
  })

  it('slices to 63 chars by default when longer', () => {
    const long = 'a'.repeat(70)
    expect(truncateRfc1123(long)).toBe('a'.repeat(63))
  })

  it('strips trailing dashes left by the slice (RFC 1123 regression)', () => {
    // Regression guard: market-data-dashboard recipe with workload `web-search`
    // produced a NetworkPolicy name that, post slice(0,63), ended in '-'.
    // K8s rejected with 422 "metadata.name: Invalid value … must end with an
    // alphanumeric character". Proves the strip kicks in.
    const name = 'market-data-dashboard-wf-mcp-ingress-market-data-dashboard-web-search'
    const out = truncateRfc1123(name)
    expect(out.length).toBeLessThanOrEqual(63)
    expect(out.endsWith('-')).toBe(false)
    expect(out).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
  })

  it('strips trailing dots as well (full RFC 1123 coverage)', () => {
    // DNS1123 subdomain also forbids trailing '.', covered by the same regex.
    expect(truncateRfc1123('name-with-dot.')).toBe('name-with-dot')
  })

  it('produces a valid name at exactly 63 chars (no false trim)', () => {
    const exact = 'a'.repeat(63)
    expect(truncateRfc1123(exact)).toBe(exact)
  })

  it('network-policy factory uses the helper for the mcp-ingress name', () => {
    const cfg: NetworkPolicyConfig = {
      recipeName: 'market-data-dashboard',
      sandboxNamespace: 'sandbox-recipes',
      controlPlaneNamespace: 'control-plane',
      mcpServerNamespace: 'mcp-server',
      wrcPort: 8082,
      mcpHostPort: 8080,
    }
    const policies = buildWorkflowNetworkPolicies(cfg, ['market-data-dashboard-web-search'])
    const mcpIngress = policies.find(p =>
      p.metadata!.name!.startsWith('market-data-dashboard-wf-mcp-ingress')
    )
    expect(mcpIngress).toBeDefined()
    expect(mcpIngress!.metadata!.name!.endsWith('-')).toBe(false)
    expect(mcpIngress!.metadata!.name!.length).toBeLessThanOrEqual(63)
    expect(mcpIngress!.metadata!.name!).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
  })
})

describe('truncateRfc1123WithHash', () => {
  it('returns the input unchanged when already valid and under the limit', () => {
    expect(truncateRfc1123WithHash('short-name')).toBe('short-name')
  })

  it('trims invalid trailing characters without adding a hash when under the limit', () => {
    expect(truncateRfc1123WithHash('name-with-dot.')).toBe('name-with-dot')
  })

  it('preserves uniqueness for long names with the same truncated prefix', () => {
    const prefix = 'e2e-layer3a-snippet-direct-db-snippet-runner-to-e2e-layer3a-snippet-direct-db'
    const mongo = truncateRfc1123WithHash(`${prefix}-mongo`)
    const postgres = truncateRfc1123WithHash(`${prefix}-postgres`)

    expect(mongo).not.toBe(postgres)
    expect(mongo.length).toBeLessThanOrEqual(63)
    expect(postgres.length).toBeLessThanOrEqual(63)
    expect(mongo).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    expect(postgres).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
  })
})
