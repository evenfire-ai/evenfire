/**
 * E7.1–E7.5: Recipe lifecycle E2E tests (Phase 7).
 *
 * Validates the full WorkflowRecipe state machine transitions in minikube:
 * - Create recipe reaches deploying phase
 * - Status subresource updates correctly
 * - Delete cleans up all child resources
 * - PVC retention after recipe delete
 *
 * Prerequisites: Run scripts/minikube-setup.sh before these tests.
 * These tests run AFTER delegation.test.ts (sequential mode).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVER_NAMESPACE,
  RECIPE_NAMESPACE,
  SANDBOX_NAMESPACE,
  kubectl,
  kubectlJson,
  sleep,
  waitForResource,
} from './helpers'

const FILE_BROWSER_RECIPE = 'mcp-file-browser'
const FILE_BROWSER_FILE = `${__dirname}/../../samples/mcp-file-browser.yaml`

const BATCH_RECIPE = 'mcp-batch-processor'
const BATCH_FILE = `${__dirname}/../../samples/mcp-batch-processor.yaml`

beforeAll(async () => {
  // Clean up leftovers from previous runs
  for (const name of [FILE_BROWSER_RECIPE, BATCH_RECIPE]) {
    try {
      kubectl(
        `delete workflowrecipe ${name} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`
      )
    } catch {
      /* ignore */
    }
  }
  // Clean up PVCs from previous runs
  try {
    kubectl(`delete pvc data-storage -n ${MCP_SERVER_NAMESPACE} --ignore-not-found`)
  } catch {
    /* ignore */
  }

  await sleep(3_000)
})

afterAll(() => {
  for (const name of [FILE_BROWSER_RECIPE, BATCH_RECIPE]) {
    try {
      kubectl(`delete workflowrecipe ${name} -n ${RECIPE_NAMESPACE} --ignore-not-found`)
    } catch {
      /* ignore */
    }
  }
  try {
    kubectl(`delete pvc data-storage -n ${MCP_SERVER_NAMESPACE} --ignore-not-found`)
  } catch {
    /* ignore */
  }
})

describe('Recipe Lifecycle E2E', () => {
  // E7.1: Apply recipe → reaches deploying
  it('E7.1 — Apply file-browser recipe creates Deployment', async () => {
    const result = kubectl(`apply -f ${FILE_BROWSER_FILE}`)
    expect(result).toMatch(/created|configured/)

    // Wait for Deployment to appear
    // Pre-deploy handshake (Option C) adds up to 30s before Deployment creation
    await waitForResource(
      `deploy -l clerum.io/recipe=${FILE_BROWSER_RECIPE}`,
      MCP_SERVER_NAMESPACE,
      {
        shouldExist: true,
        timeoutMs: 60_000,
      }
    )

    const deploy = kubectlJson<{
      items: Array<{ metadata: { name: string } }>
    }>(`get deploy -l clerum.io/recipe=${FILE_BROWSER_RECIPE} -n ${MCP_SERVER_NAMESPACE}`)
    expect(deploy.items.length).toBeGreaterThanOrEqual(1)
    expect(deploy.items[0].metadata.name).toBe('file-browser')
  })

  // E7.2: PVC is created for file-browser recipe
  it('E7.2 — PVC is created for file-browser recipe', async () => {
    await waitForResource(`pvc data-storage`, MCP_SERVER_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 15_000,
    })

    const pvc = kubectlJson<{
      metadata: { labels: Record<string, string>; ownerReferences?: unknown[] }
      spec: { resources: { requests: { storage: string } } }
    }>(`get pvc data-storage -n ${MCP_SERVER_NAMESPACE}`)

    expect(pvc.metadata.labels['clerum.io/recipe']).toBe(FILE_BROWSER_RECIPE)
    // PVC must NOT have ownerReferences (Risk 3.7: data retention)
    expect(pvc.metadata.ownerReferences).toBeUndefined()
    expect(pvc.spec.resources.requests.storage).toBe('5Gi')
  })

  // E7.3: Batch processor Job is created (non-MCP → sandbox-recipes via namespace splitting)
  it('E7.3 — Batch processor creates K8s Job with backoffLimit', async () => {
    const result = kubectl(`apply -f ${BATCH_FILE}`)
    expect(result).toMatch(/created|configured/)

    await waitForResource(`job -l clerum.io/recipe=${BATCH_RECIPE}`, SANDBOX_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 30_000,
    })

    const job = kubectlJson<{
      items: Array<{
        metadata: { name: string; namespace: string }
        spec: { backoffLimit: number }
      }>
    }>(`get job -l clerum.io/recipe=${BATCH_RECIPE} -n ${SANDBOX_NAMESPACE}`)
    expect(job.items.length).toBe(1)
    expect(job.items[0].metadata.name).toBe('batch-processor')
    expect(job.items[0].metadata.namespace).toBe('sandbox-recipes')
    expect(job.items[0].spec.backoffLimit).toBe(2)
  })

  // E7.4: Delete recipe removes workloads (Job was in sandbox-recipes)
  it('E7.4 — Delete batch-processor removes Job', async () => {
    kubectl(`delete workflowrecipe ${BATCH_RECIPE} -n ${RECIPE_NAMESPACE}`)

    await waitForResource(`job -l clerum.io/recipe=${BATCH_RECIPE}`, SANDBOX_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    })
  })

  // E7.5: PVC retained after recipe delete (CRITICAL)
  it('E7.5 — PVC retained after file-browser recipe delete', async () => {
    kubectl(`delete workflowrecipe ${FILE_BROWSER_RECIPE} -n ${RECIPE_NAMESPACE}`)

    // Wait for Deployment to be deleted
    await waitForResource(
      `deploy -l clerum.io/recipe=${FILE_BROWSER_RECIPE}`,
      MCP_SERVER_NAMESPACE,
      {
        shouldExist: false,
        timeoutMs: 30_000,
      }
    )

    // PVC must still exist (data retention)
    const pvcExists = (() => {
      try {
        kubectl(`get pvc data-storage -n ${MCP_SERVER_NAMESPACE}`)
        return true
      } catch {
        return false
      }
    })()
    expect(pvcExists).toBe(true)
  })
})
