/**
 * Binding-Scoped NetworkPolicy Reconciler (L3)
 *
 * Generates per-recipe NetworkPolicies based on WorkflowRecipe bindings.
 * For each binding {from, to, port, protocol}, creates:
 *   1. Egress policy in the "from" workload's namespace: allows outbound to the "to" workload
 *   2. Ingress policy in the "to" workload's namespace: allows inbound from the "from" workload
 * Namespace placement is determined dynamically: the MCP workload (with transport)
 * lives in mcp-server, the non-MCP workload lives in sandbox-recipes.
 *
 * This is the fourth layer in Clerum's network security model:
 *   L0: deny-all       — block all ingress to managed MCP server pods
 *   L1: allow-api      — allow ingress to host-context-controller API
 *   L2: context-allow  — per-(context, server) allow from mcp-host namespace
 *   L3: binding-allow  — per-(recipe, workload) allow from sandbox-recipes namespace
 *
 * Follows the same create-or-replace (409 catch) pattern as NetworkPolicyReconciler.
 */
import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  MCPSERVER_LABEL,
  POLICY_TYPE_LABEL,
  RECIPE_LABEL,
} from './constants'
import { applyNetworkPolicy, getErrorCode } from './utils'

const SANDBOX_NAMESPACE = 'sandbox-recipes'

/** Mirrors workflow-recipes/src/types.ts BindingDef — keep in sync. */
export interface BindingDef {
  from: string
  to: string
  port: number
  protocol?: 'TCP' | 'UDP'
}

export class BindingPolicyReconciler {
  private networkingApi: k8s.NetworkingV1Api
  private mcpServerNamespace: string

  constructor(kc: k8s.KubeConfig, mcpServerNamespace: string) {
    this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api)
    this.mcpServerNamespace = mcpServerNamespace
  }

  /**
   * Reconcile binding-scoped NetworkPolicies for a recipe.
   * Creates egress + ingress policies for each binding.
   *
   * @param mcpWorkloadName - The workload ID of the McpServer that carries the
   *   binding annotation. Used to determine which namespace each workload lives in:
   *   the workload matching mcpWorkloadName is in mcp-server, the other in sandbox-recipes.
   * @param mcpServerName - The McpServer resource name. MCP pod selectors use
   *   the stable McpServer label because app labels differ by renderer.
   */
  async reconcileBindings(
    recipeName: string,
    bindings: BindingDef[],
    mcpWorkloadName: string,
    mcpServerName = mcpWorkloadName
  ): Promise<void> {
    console.log(`[BindingNP] Reconciling ${bindings.length} binding(s) for recipe "${recipeName}"`)

    await Promise.all(
      bindings.map(async binding => {
        const protocol = binding.protocol ?? 'TCP'

        // Determine namespaces based on which workload is the MCP server.
        // The MCP workload (with transport) lives in mcp-server namespace,
        // the other workload lives in sandbox-recipes namespace.
        const fromIsMcp = binding.from === mcpWorkloadName
        const fromNs = fromIsMcp ? this.mcpServerNamespace : SANDBOX_NAMESPACE
        const toNs = fromIsMcp ? SANDBOX_NAMESPACE : this.mcpServerNamespace
        const fromPodSelector: Record<string, string> = fromIsMcp
          ? { [MCPSERVER_LABEL]: mcpServerName }
          : { app: binding.from }
        const toPodSelector: Record<string, string> = fromIsMcp
          ? { app: binding.to }
          : { [MCPSERVER_LABEL]: mcpServerName }

        const egressName = this.policyName(recipeName, binding.from, binding.to, 'egress')
        const egressPolicy = this.buildEgressPolicy(
          egressName,
          recipeName,
          fromPodSelector,
          toPodSelector,
          fromNs,
          toNs,
          binding.port,
          protocol
        )
        const ingressName = this.policyName(recipeName, binding.from, binding.to, 'ingress')
        const ingressPolicy = this.buildIngressPolicy(
          ingressName,
          recipeName,
          fromPodSelector,
          toPodSelector,
          fromNs,
          toNs,
          binding.port,
          protocol
        )

        // Egress and ingress target different namespaces — safe to parallelize
        await Promise.all([
          this.applyPolicy(egressName, egressPolicy, fromNs),
          this.applyPolicy(ingressName, ingressPolicy, toNs),
        ])
      })
    )
  }

  /**
   * Delete all binding-scoped NetworkPolicies for a recipe.
   */
  async cleanupBindings(recipeName: string): Promise<void> {
    console.log(`[BindingNP] Cleaning up binding policies for recipe "${recipeName}"`)

    // Delete from both namespaces in parallel (independent operations)
    await Promise.all([
      this.deletePoliciesForRecipe(recipeName, SANDBOX_NAMESPACE),
      this.deletePoliciesForRecipe(recipeName, this.mcpServerNamespace),
    ])
  }

  // ─── Policy Builders ────────────────────────────────────────────

  private buildEgressPolicy(
    name: string,
    recipeName: string,
    fromPodSelector: Record<string, string>,
    toPodSelector: Record<string, string>,
    fromNs: string,
    toNs: string,
    port: number,
    protocol: string
  ): k8s.V1NetworkPolicy {
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: fromNs,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: 'binding-allow',
          [RECIPE_LABEL]: recipeName,
        },
      },
      spec: {
        podSelector: {
          matchLabels: fromPodSelector,
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: {
                    'kubernetes.io/metadata.name': toNs,
                  },
                },
                podSelector: {
                  matchLabels: toPodSelector,
                },
              },
            ],
            ports: [{ port, protocol }],
          },
        ],
      },
    }
  }

  private buildIngressPolicy(
    name: string,
    recipeName: string,
    fromPodSelector: Record<string, string>,
    toPodSelector: Record<string, string>,
    fromNs: string,
    toNs: string,
    port: number,
    protocol: string
  ): k8s.V1NetworkPolicy {
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: toNs,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: 'binding-allow',
          [RECIPE_LABEL]: recipeName,
        },
      },
      spec: {
        podSelector: {
          matchLabels: toPodSelector,
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    'kubernetes.io/metadata.name': fromNs,
                  },
                },
                podSelector: {
                  matchLabels: fromPodSelector,
                },
              },
            ],
            ports: [{ port, protocol }],
          },
        ],
      },
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private policyName(
    recipeName: string,
    from: string,
    to: string,
    direction: 'egress' | 'ingress'
  ): string {
    const name = `bind-${recipeName}-${from}-${to}-${direction}`
    if (name.length <= 253) return name
    // Truncate + append short hash to stay within K8s 253-char metadata.name limit
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
    return `${name.slice(0, 244)}-${hash}`
  }

  private async applyPolicy(
    name: string,
    policy: k8s.V1NetworkPolicy,
    namespace: string
  ): Promise<void> {
    await applyNetworkPolicy(this.networkingApi, name, namespace, policy, '[BindingNP]')
  }

  private async deletePoliciesForRecipe(recipeName: string, namespace: string): Promise<void> {
    try {
      const response = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=binding-allow,${RECIPE_LABEL}=${recipeName}`,
      })

      await Promise.all(
        (response.items || []).map(async policy => {
          const policyName = policy.metadata?.name
          if (!policyName) {
            console.warn(`[BindingNP] Skipping policy with no name in ${namespace}`)
            return
          }
          try {
            await this.networkingApi.deleteNamespacedNetworkPolicy({
              name: policyName,
              namespace,
            })
            console.log(`[BindingNP] Deleted policy "${policyName}" in ${namespace}`)
          } catch (error: unknown) {
            if (getErrorCode(error) !== 404) {
              console.error(`[BindingNP] Failed to delete policy "${policyName}":`, error)
            }
          }
        })
      )
    } catch (error) {
      console.error(
        `[BindingNP] Failed to list policies for recipe "${recipeName}" in ${namespace}:`,
        error
      )
    }
  }
}
