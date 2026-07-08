/**
 * E7.11–E7.15: Resource cleanup and sample validation E2E tests (Phase 7).
 *
 * Validates:
 * - OwnerRef GC cascades Deployment deletion
 * - DaemonSet with strict isolation deploys correctly
 * - All sample recipes can be applied successfully
 * - Security context is properly set for strict isolation
 *
 * Prerequisites: Run scripts/minikube-setup.sh before these tests.
 * These tests run AFTER mcp-tools.test.ts (sequential mode).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RECIPE_NAMESPACE,
  SANDBOX_NAMESPACE,
  kubectl,
  kubectlJson,
  sleep,
  waitForResource,
} from './helpers'

const HEALTH_MONITOR = 'mcp-health-monitor'
const HEALTH_MONITOR_FILE = `${__dirname}/../../samples/mcp-health-monitor.yaml`

const BATCH_PROCESSOR = 'mcp-batch-processor'
const BATCH_FILE = `${__dirname}/../../samples/mcp-batch-processor.yaml`

const SIMPLE_NGINX = 'simple-nginx'
const SIMPLE_FILE = `${__dirname}/../../samples/simple-nginx.yaml`

const ALL_RECIPES = [HEALTH_MONITOR, BATCH_PROCESSOR, SIMPLE_NGINX]

beforeAll(async () => {
  for (const name of ALL_RECIPES) {
    try {
      kubectl(
        `delete workflowrecipe ${name} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`
      )
    } catch {
      /* ignore */
    }
  }
  await sleep(3_000)
})

afterAll(() => {
  for (const name of ALL_RECIPES) {
    try {
      kubectl(`delete workflowrecipe ${name} -n ${RECIPE_NAMESPACE} --ignore-not-found`)
    } catch {
      /* ignore */
    }
  }
})

describe('Resource Cleanup and Samples E2E', () => {
  // E7.11: OwnerRef GC cascades Deployment deletion (non-MCP → sandbox-recipes)
  it('E7.11 — OwnerRef GC deletes Deployment when recipe is deleted', async () => {
    kubectl(`apply -f ${SIMPLE_FILE}`)
    await waitForResource(`deploy -l clerum.io/recipe=${SIMPLE_NGINX}`, SANDBOX_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 30_000,
    })

    // Delete recipe
    kubectl(`delete workflowrecipe ${SIMPLE_NGINX} -n ${RECIPE_NAMESPACE}`)

    // Verify Deployment is removed by K8s GC
    await waitForResource(`deploy -l clerum.io/recipe=${SIMPLE_NGINX}`, SANDBOX_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    })
  })

  // E7.12: DaemonSet with strict isolation (non-MCP → sandbox-recipes)
  it('E7.12 — DaemonSet deploys with strict security context', async () => {
    kubectl(`apply -f ${HEALTH_MONITOR_FILE}`)

    await waitForResource(`daemonset -l clerum.io/recipe=${HEALTH_MONITOR}`, SANDBOX_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 30_000,
    })

    const ds = kubectlJson<{
      items: Array<{
        metadata: { name: string; labels: Record<string, string> }
        spec: {
          template: {
            spec: {
              securityContext?: Record<string, unknown>
              containers: Array<{ securityContext?: Record<string, unknown> }>
            }
          }
        }
      }>
    }>(`get daemonset -l clerum.io/recipe=${HEALTH_MONITOR} -n ${SANDBOX_NAMESPACE}`)

    expect(ds.items.length).toBe(1)
    expect(ds.items[0].metadata.name).toBe('health-monitor')

    // Verify strict security context
    const podSpec = ds.items[0].spec.template.spec

    // Pod-level: strict adds runAsUser/runAsGroup/fsGroup
    expect(podSpec.securityContext?.runAsUser).toBe(65534)
    expect(podSpec.securityContext?.runAsGroup).toBe(65534)
    expect(podSpec.securityContext?.fsGroup).toBe(65534)

    // Container-level: runAsNonRoot, readOnlyRootFilesystem, allowPrivilegeEscalation
    const containerSec = podSpec.containers[0]?.securityContext
    expect(containerSec?.runAsNonRoot).toBe(true)
    expect(containerSec?.readOnlyRootFilesystem).toBe(true)
    expect(containerSec?.allowPrivilegeEscalation).toBe(false)
  })

  // E7.13: Job sample creates K8s Job (non-MCP → sandbox-recipes)
  it('E7.13 — Batch processor Job is created with correct spec', async () => {
    kubectl(`apply -f ${BATCH_FILE}`)

    await waitForResource(`job -l clerum.io/recipe=${BATCH_PROCESSOR}`, SANDBOX_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 30_000,
    })

    const job = kubectlJson<{
      items: Array<{
        metadata: { name: string }
        spec: {
          backoffLimit: number
          template: {
            spec: {
              containers: Array<{
                command?: string[]
                env?: Array<{ name: string; value: string }>
              }>
              restartPolicy: string
            }
          }
        }
      }>
    }>(`get job -l clerum.io/recipe=${BATCH_PROCESSOR} -n ${SANDBOX_NAMESPACE}`)

    expect(job.items.length).toBe(1)
    expect(job.items[0].spec.backoffLimit).toBe(2)
    expect(job.items[0].spec.template.spec.restartPolicy).toBe('Never')
    expect(job.items[0].spec.template.spec.containers[0].command).toEqual(['node', 'process.js'])
  })

  // E7.14: Labels are correctly applied (non-MCP DaemonSet in sandbox-recipes)
  it('E7.14 — Recipe labels applied to all workload resources', async () => {
    const ds = kubectlJson<{
      items: Array<{ metadata: { labels: Record<string, string> } }>
    }>(`get daemonset -l clerum.io/recipe=${HEALTH_MONITOR} -n ${SANDBOX_NAMESPACE}`)

    expect(ds.items.length).toBe(1)
    const labels = ds.items[0].metadata.labels
    expect(labels['clerum.io/managed-by']).toBe('workflow-recipes')
    expect(labels['clerum.io/recipe']).toBe(HEALTH_MONITOR)
    expect(labels['clerum.io/workload']).toBe('health-monitor')
  })

  // E7.15: Delete recipe removes DaemonSet + Job (non-MCP in sandbox-recipes)
  it('E7.15 — Delete recipes removes DaemonSet and Job', async () => {
    kubectl(`delete workflowrecipe ${HEALTH_MONITOR} -n ${RECIPE_NAMESPACE}`)
    kubectl(`delete workflowrecipe ${BATCH_PROCESSOR} -n ${RECIPE_NAMESPACE}`)

    await waitForResource(`daemonset -l clerum.io/recipe=${HEALTH_MONITOR}`, SANDBOX_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    })
    await waitForResource(`job -l clerum.io/recipe=${BATCH_PROCESSOR}`, SANDBOX_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    })
  })
})
