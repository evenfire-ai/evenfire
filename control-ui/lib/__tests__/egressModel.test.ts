import { describe, expect, it } from 'vitest'
import {
  analyzeRegistryEgressSummary,
  analyzeWorkflowRecipeEgress,
  buildMcpEgressStatus,
  deriveEgressEditorInputs,
  egressStatusToRegistrySummary,
  registryEntryToEgressBindings,
  registrySummaryToEgressBindings,
} from '../egressModel'

describe('egressModel', () => {
  it('builds exact-host MCP egress bindings from normalized domains and ports', () => {
    const status = buildMcpEgressStatus(
      'exact-host',
      'API.Example.com, api.example.com\ncdn.example.com',
      '443, 80'
    )

    expect(status.errors).toEqual([])
    expect(status.bindings).toEqual([
      { dns: 'api.example.com', port: 443, protocol: 'TCP' },
      { dns: 'api.example.com', port: 80, protocol: 'TCP' },
      { dns: 'cdn.example.com', port: 443, protocol: 'TCP' },
      { dns: 'cdn.example.com', port: 80, protocol: 'TCP' },
    ])
  })

  it('builds public-web as one explicit class binding and registry summary', () => {
    const status = buildMcpEgressStatus('public-web', '', '443')

    expect(status.errors).toEqual([])
    expect(status.bindings).toEqual([{ egressClass: 'public-web' }])
    expect(egressStatusToRegistrySummary(status)).toEqual({
      domains: [],
      ports: [80, 443],
      wideCidr: true,
    })
  })

  it('blocks exact-host configs that exceed the CRD maxItems boundary', () => {
    const domains = Array.from({ length: 7 }, (_, index) => `api-${index}.example.com`).join(',')
    const status = buildMcpEgressStatus('exact-host', domains, '43, 80, 443')

    expect(status.bindingCount).toBe(21)
    expect(status.errors.join(' ')).toMatch(/CRD maximum is 20/)
    expect(status.bindings).toBeUndefined()
  })

  it('builds exact-cidr MCP egress bindings for public IPv4 CIDRs and IP literals', () => {
    const status = buildMcpEgressStatus('exact-cidr', '8.8.8.8, 1.1.1.0/24', '443')

    expect(status.errors).toEqual([])
    expect(status.bindings).toEqual([
      { cidr: '8.8.8.8/32', port: 443, protocol: 'TCP' },
      { cidr: '1.1.1.0/24', port: 443, protocol: 'TCP' },
    ])
    expect(egressStatusToRegistrySummary(status)).toBeUndefined()
  })

  it('blocks exact-cidr configs that target private or reserved ranges', () => {
    const status = buildMcpEgressStatus('exact-cidr', '10.0.0.0/8, 169.254.169.254', '443')

    expect(status.bindings).toBeUndefined()
    expect(status.errors.join(' ')).toMatch(/private, metadata, link-local/)
  })

  it('blocks exact-host domains that target metadata, internal, or cluster-local hostnames', () => {
    const status = buildMcpEgressStatus(
      'exact-host',
      'metadata.goog, api.internal, kubernetes.default.svc, postgres.sandbox-recipes.svc.cluster.local',
      '443'
    )

    expect(status.bindings).toBeUndefined()
    expect(status.errors.join(' ')).toMatch(/public DNS hostname/)
    expect(status.errors.join(' ')).toMatch(/cluster-internal service DNS/)
  })

  it('analyzes legacy wideCidr as explicit public-web without exposing raw CIDR language', () => {
    const analysis = analyzeRegistryEgressSummary({
      domains: ['search.example.com'],
      ports: [443],
      wideCidr: true,
    })

    expect(analysis).toMatchObject({
      mode: 'public-web',
      targets: ['search.example.com'],
      ports: [80, 443],
      bindingCount: 1,
    })
    expect(
      registrySummaryToEgressBindings({ domains: [], ports: [80, 443], wideCidr: true })
    ).toEqual([{ egressClass: 'public-web' }])
  })

  it('derives remote registry endpoint egress for the install editor', () => {
    expect(
      registryEntryToEgressBindings({
        server_mode: 'remote',
        mcp_server_meta: { remoteEndpoints: [{ url: 'https://MCP.Sentry.io/sse' }] },
      })
    ).toEqual([{ dns: 'mcp.sentry.io', port: 443, protocol: 'TCP' }])
  })

  it('uses the URL scheme default port for remote registry endpoint egress', () => {
    expect(
      registryEntryToEgressBindings({
        server_mode: 'remote',
        mcp_server_meta: { remoteEndpoints: [{ url: 'http://MCP.Sentry.io/sse' }] },
      })
    ).toEqual([{ dns: 'mcp.sentry.io', port: 80, protocol: 'TCP' }])
  })

  it('round-trips exact-host bindings through editor inputs', () => {
    const bindings = [
      { dns: 'api.example.com', port: 443, protocol: 'TCP' as const },
      { dns: 'cdn.example.com', port: 443, protocol: 'TCP' as const },
    ]
    const inputs = deriveEgressEditorInputs(bindings)
    const status = buildMcpEgressStatus(inputs.mode, inputs.domainInput, inputs.portInput)

    expect(inputs).toMatchObject({ mode: 'exact-host' })
    expect(status.errors).toEqual([])
    expect(status.bindings).toEqual(bindings)
  })

  it('round-trips exact-cidr bindings only when the editor enables CIDR authoring', () => {
    const bindings = [{ cidr: '8.8.8.8/32', port: 443, protocol: 'TCP' as const }]

    expect(deriveEgressEditorInputs(bindings)).toMatchObject({ mode: 'advanced' })
    expect(deriveEgressEditorInputs(bindings, { allowCidr: true })).toMatchObject({
      mode: 'exact-cidr',
      domainInput: '8.8.8.8/32',
      portInput: '443',
    })
  })

  it('reports transport workload default-deny without flagging non-transport workloads', () => {
    const findings = analyzeWorkflowRecipeEgress({
      spec: {
        workloads: [
          { id: 'database', image: 'postgres:16' },
          { id: 'search-mcp', transport: { type: 'streamableHttp' } },
        ],
      },
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      label: 'Transport workload "search-mcp"',
      mode: 'none',
      severity: 'info',
    })
  })

  it('reports egress for non-transport workloads that declare egressBindings', () => {
    const findings = analyzeWorkflowRecipeEgress({
      spec: {
        workloads: [
          {
            id: 'analyzer',
            type: 'deployment',
            egressBindings: [
              { dns: 'api.github.com', port: 443, protocol: 'TCP' },
              { dns: 'mirror.gcr.io', port: 443, protocol: 'TCP' },
            ],
          },
          // A plain workload with no egress stays silent (no default-deny noise).
          { id: 'db', type: 'statefulset', image: 'postgres:16' },
        ],
      },
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      label: 'Workload "analyzer"',
      mode: 'exact-host',
      bindingCount: 2,
    })
    expect(findings[0].targets).toEqual(['api.github.com', 'mirror.gcr.io'])
    expect(findings[0].ports).toEqual([443])
  })

  it('reports exact-host, public-web, and over-limit workload egress findings', () => {
    const findings = analyzeWorkflowRecipeEgress({
      spec: {
        workloads: [
          {
            id: 'exact-mcp',
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'api.example.com', port: 443, protocol: 'TCP' }],
          },
          {
            id: 'public-web-mcp',
            transport: { type: 'streamableHttp' },
            egressBindings: [{ egressClass: 'public-web' }],
          },
          {
            id: 'too-wide-mcp',
            transport: { type: 'streamableHttp' },
            egressBindings: Array.from({ length: 21 }, (_, index) => ({
              dns: `api-${index}.example.com`,
              port: 443,
              protocol: 'TCP',
            })),
          },
        ],
      },
    })

    expect(findings).toContainEqual(
      expect.objectContaining({ label: 'Transport workload "exact-mcp"', mode: 'exact-host' })
    )
    expect(findings).toContainEqual(
      expect.objectContaining({
        label: 'Transport workload "public-web-mcp"',
        mode: 'public-web',
        severity: 'warning',
      })
    )
    expect(findings).toContainEqual(
      expect.objectContaining({
        label: 'Transport workload "too-wide-mcp"',
        bindingCount: 21,
        severity: 'error',
      })
    )
  })

  it('reports runtime and step HTTP egress findings', () => {
    const findings = analyzeWorkflowRecipeEgress({
      spec: {
        runtimeEgress: { http: { egressClass: 'public-web' } },
        steps: [
          {
            id: 'fetch',
            run: {
              capabilities: {
                http: { allowedHosts: ['api.example.com'] },
              },
            },
          },
        ],
      },
    })

    expect(findings).toContainEqual(
      expect.objectContaining({
        key: 'runtime-http-egress',
        mode: 'public-web',
        severity: 'warning',
      })
    )
    expect(findings).toContainEqual(
      expect.objectContaining({
        key: 'step-0-http-egress',
        label: 'Step "fetch" HTTP egress',
        mode: 'exact-host',
      })
    )
  })

  it('summarizes provider bindings as provider-mode warnings, not exact-host info', () => {
    const findings = analyzeWorkflowRecipeEgress({
      spec: {
        workloads: [
          {
            id: 'netblock-sync',
            type: 'cronjob',
            egressBindings: [
              {
                egressClass: 'provider',
                dns: 'api.github.com',
                port: 443,
                protocol: 'TCP',
                provider: { name: 'github', categories: ['all'] },
              },
            ],
          },
        ],
      },
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      label: 'Workload "netblock-sync"',
      mode: 'provider',
      severity: 'warning',
      bindingCount: 1,
    })
    expect(findings[0].targets).toEqual(['api.github.com'])
    expect(findings[0].providers).toEqual(['github (all)'])
    expect(findings[0].message).toMatch(/catalog/)
    expect(findings[0].message).not.toMatch(/Exact-host/)
  })

  it('reports provider entries declared on spec.ui.egress.external', () => {
    const findings = analyzeWorkflowRecipeEgress({
      spec: {
        workloads: [{ id: 'dashboard', type: 'deployment', image: 'dash:1' }],
        ui: {
          workloadRef: 'dashboard',
          port: 3000,
          egress: {
            external: [
              {
                fqdn: 'objects.githubusercontent.com',
                port: 443,
                provider: { name: 'github', categories: ['artifacts'] },
              },
              { fqdn: 'plain.example.com', port: 443 },
            ],
          },
        },
      },
    })

    expect(findings).toContainEqual(
      expect.objectContaining({
        key: 'ui-egress-provider',
        label: 'Sandbox UI egress',
        mode: 'provider',
        severity: 'warning',
        bindingCount: 1,
        targets: ['objects.githubusercontent.com'],
        providers: ['github (artifacts)'],
      })
    )
  })

  it('reports invalid public-web HTTP shapes before the backend rejects them', () => {
    const findings = analyzeWorkflowRecipeEgress({
      spec: {
        runtimeEgress: {
          http: { egressClass: 'public-web', allowedHosts: ['api.example.com'] },
        },
        steps: [
          {
            id: 'fetch',
            run: {
              capabilities: {
                http: { egressClass: 'public-web', allowedHosts: ['api.example.com'] },
              },
            },
          },
        ],
      },
    })

    expect(findings).toContainEqual(
      expect.objectContaining({
        key: 'runtime-http-egress',
        severity: 'error',
        message: 'runtimeEgress.http.allowedHosts must be omitted when egressClass is public-web.',
      })
    )
    expect(findings).toContainEqual(
      expect.objectContaining({
        key: 'step-0-http-egress',
        severity: 'error',
        message: 'Step HTTP allowedHosts must be omitted when egressClass is public-web.',
      })
    )
  })
})
