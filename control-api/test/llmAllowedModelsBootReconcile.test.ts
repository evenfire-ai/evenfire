import { describe, expect, it, vi } from 'vitest'
import { reconcileAllowedModelsConfigMapOnBoot } from '../src/llmAllowedModelsBootReconcile.js'

describe('reconcileAllowedModelsConfigMapOnBoot', () => {
  it('materializes via the injected writer on the happy path', async () => {
    const materialize = vi.fn().mockResolvedValue(undefined)
    await expect(reconcileAllowedModelsConfigMapOnBoot({ materialize })).resolves.toBeUndefined()
    expect(materialize).toHaveBeenCalledTimes(1)
  })

  it('is non-fatal: a write failure is swallowed (logged + metric), never thrown', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const materialize = vi.fn().mockRejectedValue(new Error('apiserver down'))
    // Must resolve — bricking the boot on a transient K8s write is worse than a
    // stale ConfigMap that Postgres remains the source of truth for.
    await expect(reconcileAllowedModelsConfigMapOnBoot({ materialize })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
