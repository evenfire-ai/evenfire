import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { generateKeyPairSync } from 'node:crypto'
import { loadConfig } from '../config'
import { WorkflowRecipeReconciler } from './workflowRecipeReconciler'

vi.mock('../db', async importOriginal => ({
  ...(await importOriginal<typeof import('../db')>()),
  getPool: () => ({}),
}))

// The workflow reconciler sizes new managed output PVCs from the operator config.
// Mutation caught: dropping (or hard-coding) the workflowOutputStorageSize mapping
// where WorkflowRecipeReconciler builds the WorkflowConfig.
describe('WorkflowRecipeReconciler output PVC size wiring', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  async function workflowOutputStorageSize(value: string): Promise<unknown> {
    const kc = new k8s.KubeConfig()
    vi.spyOn(kc, 'makeApiClient').mockImplementation((() => ({})) as typeof kc.makeApiClient)
    const reconciler = new WorkflowRecipeReconciler(kc, {
      ...loadConfig(),
      workflowOutputStorageSize: value,
    })
    await reconciler.initializeWorkflow(pem)
    const inner = (
      reconciler as unknown as {
        workflowReconciler: { deps: { config: Record<string, unknown> } }
      }
    ).workflowReconciler
    return inner.deps.config.workflowOutputStorageSize
  }

  it('passes the operator PVC size through to the workflow reconciler', async () => {
    await expect(workflowOutputStorageSize('3Gi')).resolves.toBe('3Gi')
    await expect(workflowOutputStorageSize('768Mi')).resolves.toBe('768Mi')
  })
})
