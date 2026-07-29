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

export interface BindingPolicyReconcileOptions {
  isCurrent?: () => boolean
}

export interface BindingPolicyCleanupOptions {
  deleteAllowed?: () => Promise<boolean>
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
    mcpServerName = mcpWorkloadName,
    options: BindingPolicyReconcileOptions = {}
  ): Promise<void> {
    const isCurrent = options.isCurrent ?? (() => true)
    if (!isCurrent()) return
    console.log(`[BindingNP] Reconciling ${bindings.length} binding(s) for recipe "${recipeName}"`)

    // Sequence writes so authority can be rechecked between every Kubernetes
    // effect. A retired pass must not start the next binding policy mutation.
    for (const binding of bindings) {
      if (!isCurrent()) return
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

      if (!isCurrent()) return
      await this.applyPolicy(egressName, egressPolicy, fromNs, isCurrent)
      if (!isCurrent()) return
      await this.applyPolicy(ingressName, ingressPolicy, toNs, isCurrent)
    }
  }

  /**
   * Delete all binding-scoped NetworkPolicies for a recipe.
   */
  async cleanupBindings(
    recipeName: string,
    options: BindingPolicyCleanupOptions = {}
  ): Promise<void> {
    console.log(`[BindingNP] Cleaning up binding policies for recipe "${recipeName}"`)

    // LIST operations are read-only and namespace-independent. Each resulting
    // delete is separately authorized after its LIST completes.
    const results = await Promise.allSettled([
      this.deletePoliciesForRecipe(recipeName, SANDBOX_NAMESPACE, options.deleteAllowed),
      this.deletePoliciesForRecipe(recipeName, this.mcpServerNamespace, options.deleteAllowed),
    ])
    const failures = results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to clean up binding policies for recipe "${recipeName}"`
      )
    }
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
    namespace: string,
    isCurrent: () => boolean
  ): Promise<void> {
    await applyNetworkPolicy(this.networkingApi, name, namespace, policy, '[BindingNP]', isCurrent)
  }

  private async deletePoliciesForRecipe(
    recipeName: string,
    namespace: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<void> {
    let response: k8s.V1NetworkPolicyList
    try {
      response = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=binding-allow,${RECIPE_LABEL}=${recipeName}`,
      })
    } catch (error) {
      console.error(
        `[BindingNP] Failed to list policies for recipe "${recipeName}" in ${namespace}:`,
        error
      )
      throw error
    }

    for (const policy of response.items || []) {
      const policyName = policy.metadata?.name
      if (!policyName) {
        console.warn(`[BindingNP] Skipping policy with no name in ${namespace}`)
        continue
      }
      try {
        if (deleteAllowed && !(await deleteAllowed())) return
        await this.networkingApi.deleteNamespacedNetworkPolicy({
          name: policyName,
          namespace,
        })
        console.log(`[BindingNP] Deleted policy "${policyName}" in ${namespace}`)
      } catch (error: unknown) {
        if (getErrorCode(error) === 404) continue
        console.error(`[BindingNP] Failed to delete policy "${policyName}":`, error)
        throw error
      }
    }
  }
}
