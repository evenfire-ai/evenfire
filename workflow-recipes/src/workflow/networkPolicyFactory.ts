/**
 * NetworkPolicy factory for workflow inter-Pod communication.
 *
 * Creates four per-recipe NetworkPolicies that enforce the security model:
 * - coordinator → mcp_host (sandbox-recipes)
 * - coordinator → WRC (sandbox-recipes egress to control-plane)
 * - WRC → mcp_host (control-plane egress to sandbox-recipes)
 * - WRC → artifact_reader (sandbox-recipes ingress for workflows without mcp_host)
 * - mcp_host → mcp-servers (sandbox-recipes egress to mcp-server namespace)
 * */
import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { PLUGIN_WORKLOAD_SDK_PORT } from './resourceNames'

/**
 * Truncate a name to K8s metadata.name limits (63 chars for NetworkPolicy
 * labels / DNS1123 label), stripping any trailing non-alphanumeric characters
 * left by the cut so the result satisfies RFC 1123 (`[a-z0-9]([-a-z0-9]*[a-z0-9])?`).
 *
 * Without the trim, a bare `.slice(0, 63)` can leave a trailing `-` when the
 * cut lands on a hyphen — K8s rejects such names with 422 BadRequest
 * ("metadata.name: Invalid value"), aborting the reconcile. Observed on
 * recipes with long names like `market-data-dashboard` (21 chars) combined
 * with a workload-derived suffix pushing the full NP name past 63 chars.
 */
export function truncateRfc1123(name: string, max = 63): string {
  return name.slice(0, max).replace(/[^a-z0-9]+$/, '')
}

/**
 * Truncate a Kubernetes metadata.name while preserving uniqueness for long
 * generated names. Plain truncation can collapse distinct resources that share
 * the same prefix, for example per-workload ingress policies for long recipe
 * names where the differing resource suffix lands past char 63.
 */
export function truncateRfc1123WithHash(name: string, max = 63): string {
  const normalized =
    name
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '') || 'x'
  if (normalized.length <= max) return normalized

  const hash = createHash('sha256')
    .update(normalized || name)
    .digest('hex')
    .slice(0, 8)
  const prefixMax = Math.max(1, max - hash.length - 1)
  const prefix = truncateRfc1123(normalized || 'x', prefixMax) || 'x'
  return `${prefix}-${hash}`
}

export interface NetworkPolicyConfig {
  recipeName: string
  sandboxNamespace: string
  controlPlaneNamespace: string
  mcpServerNamespace: string
  gfsNamespace?: string
  wrcPort: number
  mcpHostPort: number
  gfscPort?: number
  includeMcpHost?: boolean
  includeCoordinatorGfs?: boolean
  includeArtifactReader?: boolean
  includeSnippetRunner?: boolean
  coordinatorPublicHttpEgress?: boolean
  coordinatorPublicHttpEgressClass?: 'exact-host' | 'public-web'
  coordinatorPublicHttpEgressCidrs?: string[]
  coordinatorWorkloadEgress?: Array<{ resourceName: string; port: number }>
  snippetRunnerPublicHttpEgress?: boolean
  snippetRunnerPublicHttpEgressClass?: 'exact-host' | 'public-web'
  snippetRunnerPublicHttpEgressCidrs?: string[]
  artifactReaderPort?: number
  snippetRunnerPort?: number
  snippetRunnerWorkloadEgress?: Array<{ resourceName: string; port: number }>
  /**
   * Plugin Workload SDK (plan §6.1, OQ-4). When true, emit the two L3/L4
   * policies that open the SDK port (8099) between same-recipe plugin
   * workloads and this recipe's mcp-host: ingress at the mcp-host + egress
   * at the workloads (both additive on top of deny-all-sandbox-recipes).
   * Only set when the recipe declares the capability AND the feature flag
   * is on AND the recipe mcp-host is included.
   */
  pluginWorkloadSdkSandboxAccess?: boolean
}

export function buildCoordinatorGfsNetworkPolicy(
  config: Pick<NetworkPolicyConfig, 'recipeName' | 'sandboxNamespace' | 'gfsNamespace' | 'gfscPort'>
): k8s.V1NetworkPolicy {
  const gfsNamespace = config.gfsNamespace ?? 'gfs'
  const gfscPort = config.gfscPort ?? 8087

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${config.recipeName}-coordinator-to-gfs`,
      namespace: config.sandboxNamespace,
      labels: {
        'clerum.io/recipe': config.recipeName,
        'clerum.io/managed-by': 'wrc',
      },
    },
    spec: {
      podSelector: {
        matchLabels: {
          'clerum.io/recipe': config.recipeName,
          'clerum.io/component': 'workflow-coordinator',
        },
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': gfsNamespace },
              },
              podSelector: {
                matchLabels: { app: 'gfs-controller' },
              },
            },
          ],
          ports: [{ port: gfscPort, protocol: 'TCP' }],
        },
      ],
    },
  }
}

export const PUBLIC_HTTP_EGRESS_EXCEPT_CIDRS = [
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

function buildPublicHttpEgressRule(cidrs?: string[]): k8s.V1NetworkPolicyEgressRule {
  const exactCidrs = [...new Set(cidrs ?? [])].filter(Boolean)
  if (cidrs !== undefined && exactCidrs.length === 0) {
    throw new Error('buildPublicHttpEgressRule: explicit CIDR list resolved to empty')
  }
  if (exactCidrs.length > 0) {
    return {
      to: exactCidrs.map(cidr => ({ ipBlock: { cidr } })),
      ports: [
        { port: 443, protocol: 'TCP' },
        { port: 80, protocol: 'TCP' },
      ],
    }
  }

  return {
    to: [
      {
        ipBlock: {
          cidr: '0.0.0.0/0',
          except: PUBLIC_HTTP_EGRESS_EXCEPT_CIDRS,
        },
      },
    ],
    ports: [
      { port: 443, protocol: 'TCP' },
      { port: 80, protocol: 'TCP' },
    ],
  }
}

export function buildWorkflowNetworkPolicies(
  config: NetworkPolicyConfig,
  mcpServerNames: string[] = [],
  snippetMcpServerNames: string[] = []
): k8s.V1NetworkPolicy[] {
  // WorkflowRecipe CRDs and these workflow runtime NetworkPolicies live in
  // sandbox-recipes. OwnerRefs are intentionally omitted because cleanup is
  // centralized in reconcileDelete() and some companion policies live in
  // mcp-server for transport children.

  const commonLabels = {
    'clerum.io/recipe': config.recipeName,
    'clerum.io/managed-by': 'wrc',
  }
  const dnsEgressRule: k8s.V1NetworkPolicyEgressRule = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        },
      },
    ],
    ports: [
      { port: 53, protocol: 'UDP' },
      { port: 53, protocol: 'TCP' },
    ],
  }
  const coordinatorPublicHttpEgressRule =
    config.coordinatorPublicHttpEgress === true
      ? buildPublicHttpEgressRule(config.coordinatorPublicHttpEgressCidrs)
      : undefined
  const snippetRunnerPublicHttpEgressRule =
    config.snippetRunnerPublicHttpEgress === true
      ? buildPublicHttpEgressRule(config.snippetRunnerPublicHttpEgressCidrs)
      : undefined
  const broadPublicHttpEgressRule = buildPublicHttpEgressRule()
  const gfsNamespace = config.gfsNamespace ?? 'gfs'
  const gfscPort = config.gfscPort ?? 8087
  const coordinatorPublicHttpEgressLabels: Record<string, string> = coordinatorPublicHttpEgressRule
    ? { 'clerum.io/egress-class': config.coordinatorPublicHttpEgressClass ?? 'exact-host' }
    : {}
  const snippetRunnerPublicHttpEgressLabels: Record<string, string> =
    snippetRunnerPublicHttpEgressRule
      ? { 'clerum.io/egress-class': config.snippetRunnerPublicHttpEgressClass ?? 'exact-host' }
      : {}
  const coordinatorToGfs = buildCoordinatorGfsNetworkPolicy(config)

  const coordinatorToWrc: k8s.V1NetworkPolicy = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${config.recipeName}-coord-to-wrc`,
      namespace: config.sandboxNamespace,
      labels: { ...commonLabels, ...coordinatorPublicHttpEgressLabels },
      // No ownerRef: cleanup is handled explicitly by WRC finalizers.
    },
    spec: {
      podSelector: {
        matchLabels: {
          'clerum.io/recipe': config.recipeName,
          'clerum.io/component': 'workflow-coordinator',
        },
      },
      policyTypes: ['Egress'],
      egress: [
        dnsEgressRule,
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': config.controlPlaneNamespace },
              },
            },
          ],
          ports: [{ port: config.wrcPort, protocol: 'TCP' }],
        },
        ...(coordinatorPublicHttpEgressRule ? [coordinatorPublicHttpEgressRule] : []),
        ...(config.coordinatorWorkloadEgress ?? []).map(binding => ({
          to: [
            {
              podSelector: {
                matchLabels: { app: binding.resourceName },
              },
            },
          ],
          ports: [{ port: binding.port, protocol: 'TCP' as const }],
        })),
      ],
    },
  }

  const coordinatorWorkloadIngressPolicies: k8s.V1NetworkPolicy[] = (
    config.coordinatorWorkloadEgress ?? []
  ).map(
    binding =>
      ({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
          name: truncateRfc1123WithHash(
            `${config.recipeName}-coordinator-to-${binding.resourceName}`
          ),
          namespace: config.sandboxNamespace,
          labels: commonLabels,
        },
        spec: {
          podSelector: {
            matchLabels: { app: binding.resourceName },
          },
          policyTypes: ['Ingress'],
          ingress: [
            {
              // @kubernetes/client-node maps _from to from during JSON serialization.
              _from: [
                {
                  podSelector: {
                    matchLabels: {
                      'clerum.io/recipe': config.recipeName,
                      'clerum.io/component': 'workflow-coordinator',
                    },
                  },
                },
              ],
              ports: [{ port: binding.port, protocol: 'TCP' as const }],
            },
          ],
        },
      }) as k8s.V1NetworkPolicy
  )

  const artifactReaderIngress: k8s.V1NetworkPolicy = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${config.recipeName}-wrc-to-artifact-reader`,
      namespace: config.sandboxNamespace,
      labels: commonLabels,
    },
    spec: {
      podSelector: {
        matchLabels: {
          'clerum.io/recipe': config.recipeName,
          'clerum.io/component': 'workflow-artifact-reader',
        },
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          // @kubernetes/client-node maps _from -> from during JSON serialization
          // because 'from' is a JavaScript reserved word.
          _from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': config.controlPlaneNamespace },
              },
              podSelector: {
                matchLabels: { app: 'workflow-recipes' },
              },
            },
          ],
          ports: [{ port: config.artifactReaderPort ?? config.mcpHostPort, protocol: 'TCP' }],
        },
      ],
    },
  }

  const snippetRunnerPort = config.snippetRunnerPort ?? 8095
  const snippetRunnerPolicies: k8s.V1NetworkPolicy[] =
    config.includeSnippetRunner === true
      ? [
          {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            metadata: {
              name: `${config.recipeName}-coord-to-snippet-runner`,
              namespace: config.sandboxNamespace,
              labels: commonLabels,
            },
            spec: {
              podSelector: {
                matchLabels: {
                  'clerum.io/recipe': config.recipeName,
                  'clerum.io/component': 'workflow-coordinator',
                },
              },
              policyTypes: ['Egress'],
              egress: [
                {
                  to: [
                    {
                      podSelector: {
                        matchLabels: {
                          'clerum.io/recipe': config.recipeName,
                          'clerum.io/component': 'workflow-snippet-runner',
                        },
                      },
                    },
                  ],
                  ports: [{ port: snippetRunnerPort, protocol: 'TCP' }],
                },
              ],
            },
          },
          {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            metadata: {
              name: `${config.recipeName}-coord-to-snippet-runner-ingress`,
              namespace: config.sandboxNamespace,
              labels: commonLabels,
            },
            spec: {
              podSelector: {
                matchLabels: {
                  'clerum.io/recipe': config.recipeName,
                  'clerum.io/component': 'workflow-snippet-runner',
                },
              },
              policyTypes: ['Ingress'],
              ingress: [
                {
                  _from: [
                    {
                      podSelector: {
                        matchLabels: {
                          'clerum.io/recipe': config.recipeName,
                          'clerum.io/component': 'workflow-coordinator',
                        },
                      },
                    },
                  ],
                  ports: [{ port: snippetRunnerPort, protocol: 'TCP' }],
                },
              ],
            },
          },
          {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            metadata: {
              name: `${config.recipeName}-snippet-runner-egress`,
              namespace: config.sandboxNamespace,
              labels: { ...commonLabels, ...snippetRunnerPublicHttpEgressLabels },
            },
            spec: {
              podSelector: {
                matchLabels: {
                  'clerum.io/recipe': config.recipeName,
                  'clerum.io/component': 'workflow-snippet-runner',
                },
              },
              policyTypes: ['Egress'],
              egress: [
                dnsEgressRule,
                ...(config.snippetRunnerWorkloadEgress ?? []).map(binding => ({
                  to: [
                    {
                      podSelector: {
                        matchLabels: { app: binding.resourceName },
                      },
                    },
                  ],
                  ports: [{ port: binding.port, protocol: 'TCP' as const }],
                })),
                ...snippetMcpServerNames.map(name => ({
                  to: [
                    {
                      namespaceSelector: {
                        matchLabels: { 'kubernetes.io/metadata.name': config.mcpServerNamespace },
                      },
                      podSelector: {
                        matchLabels: { 'clerum.io/mcpserver': name },
                      },
                    },
                  ],
                  ports: [{ port: 3000, protocol: 'TCP' as const }],
                })),
                ...(snippetRunnerPublicHttpEgressRule ? [snippetRunnerPublicHttpEgressRule] : []),
              ],
            },
          },
          ...(config.snippetRunnerWorkloadEgress ?? []).map(
            binding =>
              ({
                apiVersion: 'networking.k8s.io/v1',
                kind: 'NetworkPolicy',
                metadata: {
                  name: truncateRfc1123WithHash(
                    `${config.recipeName}-snippet-runner-to-${binding.resourceName}`
                  ),
                  namespace: config.sandboxNamespace,
                  labels: commonLabels,
                },
                spec: {
                  podSelector: {
                    matchLabels: { app: binding.resourceName },
                  },
                  policyTypes: ['Ingress'],
                  ingress: [
                    {
                      _from: [
                        {
                          podSelector: {
                            matchLabels: {
                              'clerum.io/recipe': config.recipeName,
                              'clerum.io/component': 'workflow-snippet-runner',
                            },
                          },
                        },
                      ],
                      ports: [{ port: binding.port, protocol: 'TCP' as const }],
                    },
                  ],
                },
              }) as k8s.V1NetworkPolicy
          ),
          ...snippetMcpServerNames.map(
            name =>
              ({
                apiVersion: 'networking.k8s.io/v1',
                kind: 'NetworkPolicy',
                metadata: {
                  name: truncateRfc1123WithHash(`${config.recipeName}-snippet-mcp-ingress-${name}`),
                  namespace: config.mcpServerNamespace,
                  labels: commonLabels,
                },
                spec: {
                  podSelector: {
                    matchLabels: { 'clerum.io/mcpserver': name },
                  },
                  policyTypes: ['Ingress'],
                  ingress: [
                    {
                      _from: [
                        {
                          namespaceSelector: {
                            matchLabels: {
                              'kubernetes.io/metadata.name': config.sandboxNamespace,
                            },
                          },
                          podSelector: {
                            matchLabels: {
                              'clerum.io/recipe': config.recipeName,
                              'clerum.io/component': 'workflow-snippet-runner',
                            },
                          },
                        },
                      ],
                      ports: [{ port: 3000, protocol: 'TCP' as const }],
                    },
                  ],
                },
              }) as k8s.V1NetworkPolicy
          ),
        ]
      : []

  // Plugin Workload SDK (plan §6.1, OQ-4): two additive policies open the
  // SDK port between same-recipe plugin workloads and this recipe's mcp-host.
  // deny-all-sandbox-recipes blocks BOTH directions intra-namespace, so the
  // lane needs ingress at the mcp-host AND egress at the workloads — the same
  // bidirectional shape as coord-to-mcp-host.
  //
  // L3/L4 scope = same recipe only:
  //   - source pods carry `clerum.io/recipe: <recipe>` AND a `clerum.io/workload`
  //     label (only plugin workloads have it — coordinator/mcp-host/snippet pods
  //     are labelled by `clerum.io/component`), so infra pods are excluded.
  // Per-caller gating (allowedCallers) is enforced at L7 (the SDK token is only
  // injected into allowed workloads; control-api returns caller_not_allowed).
  const workloadPodSelector: k8s.V1LabelSelector = {
    matchLabels: { 'clerum.io/recipe': config.recipeName },
    matchExpressions: [{ key: 'clerum.io/workload', operator: 'Exists' }],
  }
  const mcpHostPodSelector: k8s.V1LabelSelector = {
    matchLabels: {
      'clerum.io/recipe': config.recipeName,
      'clerum.io/component': 'workflow-mcp-host',
    },
  }
  const pluginWorkloadSdkPolicies: k8s.V1NetworkPolicy[] = config.pluginWorkloadSdkSandboxAccess
    ? [
        {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: {
            name: `${config.recipeName}-workload-to-mcp-host-sdk-ingress`,
            namespace: config.sandboxNamespace,
            labels: commonLabels,
          },
          spec: {
            podSelector: mcpHostPodSelector,
            policyTypes: ['Ingress'],
            ingress: [
              {
                // @kubernetes/client-node maps _from -> from on serialization.
                _from: [{ podSelector: workloadPodSelector }],
                ports: [{ port: PLUGIN_WORKLOAD_SDK_PORT, protocol: 'TCP' }],
              },
            ],
          },
        } as k8s.V1NetworkPolicy,
        {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: {
            name: `${config.recipeName}-workload-to-mcp-host-sdk-egress`,
            namespace: config.sandboxNamespace,
            labels: commonLabels,
          },
          spec: {
            podSelector: workloadPodSelector,
            policyTypes: ['Egress'],
            egress: [
              {
                to: [{ podSelector: mcpHostPodSelector }],
                ports: [{ port: PLUGIN_WORKLOAD_SDK_PORT, protocol: 'TCP' }],
              },
            ],
          },
        } as k8s.V1NetworkPolicy,
        {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: {
            name: `${config.recipeName}-mcp-host-to-wrc-sdk-broker`,
            namespace: config.sandboxNamespace,
            labels: commonLabels,
          },
          spec: {
            podSelector: mcpHostPodSelector,
            policyTypes: ['Egress'],
            egress: [
              {
                to: [
                  {
                    namespaceSelector: {
                      matchLabels: {
                        'kubernetes.io/metadata.name': config.controlPlaneNamespace,
                      },
                    },
                    podSelector: { matchLabels: { app: 'workflow-recipes' } },
                  },
                ],
                ports: [{ port: config.wrcPort, protocol: 'TCP' }],
              },
            ],
          },
        } as k8s.V1NetworkPolicy,
      ]
    : []

  if (config.includeMcpHost === false) {
    return config.includeArtifactReader
      ? [
          coordinatorToWrc,
          ...(config.includeCoordinatorGfs ? [coordinatorToGfs] : []),
          artifactReaderIngress,
          ...snippetRunnerPolicies,
          ...coordinatorWorkloadIngressPolicies,
        ]
      : [
          coordinatorToWrc,
          ...(config.includeCoordinatorGfs ? [coordinatorToGfs] : []),
          ...snippetRunnerPolicies,
          ...coordinatorWorkloadIngressPolicies,
        ]
  }

  return [
    // 1. Coordinator → mcp_host (within sandbox-recipes)
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${config.recipeName}-coord-to-mcp-host`,
        namespace: config.sandboxNamespace,
        labels: commonLabels,
        // No ownerRef: cleanup is handled explicitly by WRC finalizers.
      },
      spec: {
        podSelector: {
          matchLabels: {
            'clerum.io/recipe': config.recipeName,
            'clerum.io/component': 'workflow-coordinator',
          },
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                podSelector: {
                  matchLabels: {
                    'clerum.io/recipe': config.recipeName,
                    'clerum.io/component': 'workflow-mcp-host',
                  },
                },
              },
            ],
            ports: [{ port: config.mcpHostPort, protocol: 'TCP' }],
          },
        ],
      },
    },
    // 1b. Coordinator → mcp_host INGRESS (intra-namespace: allow coordinator to reach mcp_host)
    // deny-all-sandbox-recipes blocks all intra-namespace traffic, so we need explicit ingress.
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${config.recipeName}-coord-to-mcp-host-ingress`,
        namespace: config.sandboxNamespace,
        labels: commonLabels,
      },
      spec: {
        podSelector: {
          matchLabels: {
            'clerum.io/recipe': config.recipeName,
            'clerum.io/component': 'workflow-mcp-host',
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            _from: [
              {
                podSelector: {
                  matchLabels: {
                    'clerum.io/recipe': config.recipeName,
                    'clerum.io/component': 'workflow-coordinator',
                  },
                },
              },
            ],
            ports: [{ port: config.mcpHostPort, protocol: 'TCP' }],
          },
        ],
      },
    },
    // 2. Coordinator → WRC (sandbox-recipes egress to control-plane)
    coordinatorToWrc,
    ...(config.includeCoordinatorGfs ? [coordinatorToGfs] : []),
    ...snippetRunnerPolicies,
    ...coordinatorWorkloadIngressPolicies,
    ...(config.includeArtifactReader ? [artifactReaderIngress] : []),
    // NOTE: The control-plane side of these connections (WRC ingress from coordinators,
    // WRC egress to mcp_host) is handled by STATIC NPs in deploy/base/control-plane/
    // networkpolicies.yaml. WRC cannot create NPs in its own namespace (no self-modify RBAC).
    // 3. WRC → mcp_host (control-plane ingress to sandbox-recipes)
    // Applied in sandbox-recipes: allows ingress from control-plane to mcp_host
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${config.recipeName}-wrc-to-mcp-host`,
        namespace: config.sandboxNamespace,
        labels: commonLabels,
        // No ownerRef: cleanup is handled explicitly by WRC finalizers.
      },
      spec: {
        podSelector: {
          matchLabels: {
            'clerum.io/recipe': config.recipeName,
            'clerum.io/component': 'workflow-mcp-host',
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            // @kubernetes/client-node maps _from → from during JSON serialization
            // because 'from' is a JS reserved word. This is NOT a bug — the K8s API
            // receives the correct 'from' field. See: V1NetworkPolicyIngressRule type.
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.controlPlaneNamespace },
                },
              },
            ],
            ports: [{ port: config.mcpHostPort, protocol: 'TCP' }],
          },
        ],
      },
    },
    // 4. mcp_host → mcp-servers (sandbox-recipes egress to mcp-server namespace)
    // Only emitted when mcpServerNames is non-empty; uses per-server pod selectors
    // for least-privilege (no blanket namespace egress).
    ...(mcpServerNames.length > 0
      ? [
          {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            metadata: {
              name: `${config.recipeName}-mcp-host-to-servers`,
              namespace: config.sandboxNamespace,
              labels: commonLabels,
              // No ownerRef: cleanup is handled explicitly by WRC finalizers.
            },
            spec: {
              podSelector: {
                matchLabels: {
                  'clerum.io/recipe': config.recipeName,
                  'clerum.io/component': 'workflow-mcp-host',
                },
              },
              policyTypes: ['Egress'],
              egress: mcpServerNames.map(name => ({
                to: [
                  {
                    namespaceSelector: {
                      matchLabels: { 'kubernetes.io/metadata.name': config.mcpServerNamespace },
                    },
                    podSelector: {
                      matchLabels: { 'clerum.io/mcpserver': name },
                    },
                  },
                ],
                ports: [{ port: 3000, protocol: 'TCP' as const }],
              })),
            },
          } as k8s.V1NetworkPolicy,
        ]
      : []),
    // 5. mcp_host → gfsc (sandbox-recipes egress to gfs namespace)
    // Runtime JWT + gfsc permission checks enforce authority. This policy opens
    // only the transport lane needed for workflow/plugin hosts with GFS grants.
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${config.recipeName}-mcp-host-to-gfs`,
        namespace: config.sandboxNamespace,
        labels: commonLabels,
      },
      spec: {
        podSelector: {
          matchLabels: {
            'clerum.io/recipe': config.recipeName,
            'clerum.io/component': 'workflow-mcp-host',
          },
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': gfsNamespace },
                },
                podSelector: {
                  matchLabels: { app: 'gfs-controller' },
                },
              },
            ],
            ports: [{ port: gfscPort, protocol: 'TCP' as const }],
          },
        ],
      },
    },
    // 6. mcp_host → external LLM APIs (sandbox-recipes egress to public HTTP/S only)
    // Required so the workflow mcp_host can reach external LLM providers (ZAI, OpenAI, Claude).
    // Reuse the public HTTP egress rule so compromised tools cannot use this lane
    // to probe private, link-local, metadata, or control-plane addresses.
    // Without this, the deny-all-sandbox-recipes NP silently blocks all HTTPS egress,
    // causing LLM API calls to hang until the step timeout fires.
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${config.recipeName}-mcp-host-to-llm-api`,
        namespace: config.sandboxNamespace,
        labels: { ...commonLabels, 'clerum.io/egress-class': 'public-web' },
      },
      spec: {
        podSelector: {
          matchLabels: {
            'clerum.io/recipe': config.recipeName,
            'clerum.io/component': 'workflow-mcp-host',
          },
        },
        policyTypes: ['Egress'],
        egress: [broadPublicHttpEgressRule],
      },
    },
    // 5. Ingress NP in mcp-server — allows workflow mcp_host to reach MCP servers.
    // NP-02 fix: HCC-created ingress NPs only allow access from the static mcp-host namespace.
    // The workflow mcp_host lives in sandbox-recipes, so WRC must create this supplemental NP.
    //
    // Emits ONE policy per mcpServer ID: uses the ID as-is to match the pod label
    // `clerum.io/mcpserver`. Works for BOTH:
    //   - Recipe workloads (label value = `{recipeName}-{workloadId}`) — full name passed in
    //   - External McpServer CRDs (label value = `{mcpServerId}`) — raw ID passed in
    // The caller (workflowReconciler) resolves the correct label value based on whether
    // the mcpServer has `endpoint` set (external) or not (recipe workload).
    ...mcpServerNames.map(
      mcpServerName =>
        ({
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: {
            name: truncateRfc1123WithHash(`${config.recipeName}-wf-mcp-ingress-${mcpServerName}`),
            namespace: config.mcpServerNamespace,
            labels: commonLabels,
          },
          spec: {
            podSelector: {
              matchLabels: {
                'clerum.io/mcpserver': mcpServerName,
              },
            },
            policyTypes: ['Ingress'],
            ingress: [
              {
                _from: [
                  {
                    namespaceSelector: {
                      matchLabels: { 'kubernetes.io/metadata.name': config.sandboxNamespace },
                    },
                    podSelector: {
                      matchLabels: {
                        'clerum.io/recipe': config.recipeName,
                        'clerum.io/component': 'workflow-mcp-host',
                      },
                    },
                  },
                ],
                ports: [{ port: 3000, protocol: 'TCP' as const }],
              },
            ],
          },
        }) as k8s.V1NetworkPolicy
    ),
    // 7. mcp_host → approval gateway (sandbox-recipes egress to control-plane)
    // Allows the workflow mcp-host to reach the nginx-workflow-approval-gateway
    // for user approval requests. Follows the pattern of NP #4 (mcp-host-to-servers).
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${config.recipeName}-mcp-host-to-approval-gateway`,
        namespace: config.sandboxNamespace,
        labels: commonLabels,
      },
      spec: {
        podSelector: {
          matchLabels: {
            'clerum.io/recipe': config.recipeName,
            'clerum.io/component': 'workflow-mcp-host',
          },
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.controlPlaneNamespace },
                },
                podSelector: {
                  matchLabels: { app: 'nginx-workflow-approval-gateway' },
                },
              },
            ],
            ports: [{ port: 8092, protocol: 'TCP' as const }],
          },
        ],
      },
    },
    // 8. Plugin Workload SDK: same-recipe workloads <-> mcp-host on the SDK
    // port plus mcp-host -> WRC for per-attempt credential ticket redemption.
    // Empty unless the capability and feature flag are both enabled.
    ...pluginWorkloadSdkPolicies,
  ]
}
