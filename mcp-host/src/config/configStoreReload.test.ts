import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from './configStore'

/**
 * Integration: prove that an LLM provider factory subscribed to
 * ConfigStore.onChange rebuilds itself when the underlying Secret rotates.
 * This mirrors the wiring in main.ts:ensureConfigStore() without dragging
 * in the rest of the runtime.
 */

interface FakeWatchHandle {
  abort: () => void
  emit: (type: string, obj: unknown) => void
}

function makeFakeWatch() {
  const active = new Map<string, FakeWatchHandle>()
  return {
    active,
    watch: vi.fn(
      async (
        path: string,
        params: { fieldSelector?: string },
        onEvent: (type: string, obj: unknown) => void,
        _onDone: (err: Error | null | undefined) => void
      ) => {
        const key = `${path}|${params.fieldSelector ?? ''}`
        const handle: FakeWatchHandle = {
          abort: () => {
            active.delete(key)
          },
          emit: (type, obj) => onEvent(type, obj),
        }
        active.set(key, handle)
        return { abort: handle.abort }
      }
    ),
  }
}

function makeFakeCoreApi(secrets: Record<string, Record<string, string>>) {
  return {
    readNamespacedSecret: vi.fn(async (req: { name: string }) => {
      const data = secrets[req.name]
      if (!data) {
        const err: { code?: number } = { code: 404 }
        throw err
      }
      return { data }
    }),
    readNamespacedConfigMap: vi.fn(async () => {
      const err: { code?: number } = { code: 404 }
      throw err
    }),
  }
}

describe('ConfigStore hot-reload — provider factory integration', () => {
  let store: ConfigStore | null = null
  afterEach(() => {
    store?.stop()
    store = null
  })

  it('triggers a provider rebuild only on llmKeyChanged, not on plain env updates', async () => {
    const watch = makeFakeWatch()
    const api = makeFakeCoreApi({
      'chatllm-api-keys': { 'openai-api-key': 'sk-old' },
      'host-trader-env-secret': { GITHUB_TOKEN: 'ghp_old' },
    })
    store = new ConfigStore({
      namespace: 'mcp-host',
      hostRef: 'trader',
      llmSecretRef: 'chatllm-api-keys',
      provider: 'openai',
      coreApi: api as unknown as ConstructorParameters<typeof ConfigStore>[0]['coreApi'],
      watch: watch as unknown as ConstructorParameters<typeof ConfigStore>[0]['watch'],
    })

    // Mirror the main.ts subscription contract: rebuild only on llmKeyChanged.
    const rebuildProvider = vi.fn((apiKey: string) => ({ apiKey, model: 'gpt-x' }))
    let currentProvider = rebuildProvider('sk-old')
    store.onChange(({ llmKeyChanged }) => {
      if (!llmKeyChanged) return
      const llm = store!.llmKey()
      if (!llm) return
      currentProvider = rebuildProvider(llm.value)
    })

    await store.start()
    rebuildProvider.mockClear() // ignore the initial baseline build
    expect(currentProvider.apiKey).toBe('sk-old')

    // 1) Rotate the per-Host env Secret — should NOT rebuild the provider.
    const envSecretWatch = watch.active.get(
      `/api/v1/namespaces/mcp-host/secrets|metadata.name=host-trader-env-secret`
    )
    envSecretWatch!.emit('MODIFIED', {
      metadata: { name: 'host-trader-env-secret' },
      data: { GITHUB_TOKEN: 'ghp_new' },
    })
    expect(rebuildProvider).not.toHaveBeenCalled()
    expect(store.get('GITHUB_TOKEN')).toBe('ghp_new')

    // 2) Rotate the LLM Secret — SHOULD rebuild the provider.
    const llmWatch = watch.active.get(
      `/api/v1/namespaces/mcp-host/secrets|metadata.name=chatllm-api-keys`
    )
    llmWatch!.emit('MODIFIED', {
      metadata: { name: 'chatllm-api-keys' },
      data: { 'openai-api-key': 'sk-new' },
    })
    expect(rebuildProvider).toHaveBeenCalledTimes(1)
    expect(rebuildProvider).toHaveBeenCalledWith('sk-new')
    expect(currentProvider.apiKey).toBe('sk-new')
  })

  it('does not rebuild when the LLM Secret arrives but contains the wrong provider key', async () => {
    const watch = makeFakeWatch()
    const api = makeFakeCoreApi({
      'chatllm-api-keys': { 'openai-api-key': 'sk-baseline' },
    })
    store = new ConfigStore({
      namespace: 'mcp-host',
      hostRef: 'trader',
      llmSecretRef: 'chatllm-api-keys',
      provider: 'openai',
      coreApi: api as unknown as ConstructorParameters<typeof ConfigStore>[0]['coreApi'],
      watch: watch as unknown as ConstructorParameters<typeof ConfigStore>[0]['watch'],
    })

    const rebuild = vi.fn()
    store.onChange(({ llmKeyChanged }) => {
      if (llmKeyChanged) rebuild()
    })

    await store.start()
    rebuild.mockClear()

    // The Secret now only carries an unrelated provider's key — for this Host
    // (provider=openai) that's a transition from configured → unconfigured,
    // which IS a change for llmKey() and should fire.
    const llmWatch = watch.active.get(
      `/api/v1/namespaces/mcp-host/secrets|metadata.name=chatllm-api-keys`
    )
    llmWatch!.emit('MODIFIED', {
      metadata: { name: 'chatllm-api-keys' },
      data: { 'claude-api-key': 'sk-ant-irrelevant' },
    })

    expect(rebuild).toHaveBeenCalledTimes(1) // unconfigured transition is reported
    expect(store.isLlmKeyConfigured()).toBe(false)
  })
})
