import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { generateKeyPairSync } from 'node:crypto'
import { loadConfig } from '../config'
import { WorkflowRecipeReconciler } from './workflowRecipeReconciler'

vi.mock('../db', async importOriginal => ({
  ...(await importOriginal<typeof import('../db')>()),
  getPool: () => ({}),
}))

// C-WRC: the eager SDK broker must see the same WRC_GROK_SUBSCRIPTION_ENABLED
// the recipe verdict sees. Mutation caught: constructing the workflow-subsystem
// ModelConfigHandler without `{ grokSubscriptionEnabled: config... }`.
describe('WorkflowRecipeReconciler ModelConfigHandler Grok flag wiring', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  async function handlerFlag(grokSubscriptionEnabled: boolean): Promise<unknown> {
    const kc = new k8s.KubeConfig()
    vi.spyOn(kc, 'makeApiClient').mockImplementation((() => ({})) as typeof kc.makeApiClient)
    const reconciler = new WorkflowRecipeReconciler(kc, {
      ...loadConfig(),
      grokSubscriptionEnabled,
    })
    await reconciler.initializeWorkflow(pem)
    const inner = (
      reconciler as unknown as {
        workflowReconciler: { deps: { modelConfigHandler: Record<string, unknown> } }
      }
    ).workflowReconciler
    return inner.deps.modelConfigHandler.grokSubscriptionEnabled
  }

  it('passes the operator Grok flag through to the broker', async () => {
    await expect(handlerFlag(true)).resolves.toBe(true)
    await expect(handlerFlag(false)).resolves.toBe(false)
  })
})
