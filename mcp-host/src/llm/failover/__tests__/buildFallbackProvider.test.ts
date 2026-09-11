import { describe, expect, it, vi } from 'vitest'
import { fallbackSlotId } from '@clerum/egress-policy'
import type { ConfigStore } from '../../../config/configStore'
import type { SingleTurnProvider, createLLMProvider } from '../../index'
import { createFallbackProviderBuilder } from '../buildFallbackProvider'
import type { FallbackEntry } from '../types'

// A minimal ConfigStore double: the builder reads only `fallbackSlotValue`.
function fakeStore(values: Record<string, string>): ConfigStore {
  return { fallbackSlotValue: (dataKey: string) => values[dataKey] } as unknown as ConfigStore
}

// A createProvider spy that returns a sentinel provider so we can tell
// "constructed" from "fail-closed null" and inspect the args it received.
function spyCreateProvider(): ReturnType<typeof vi.fn> & typeof createLLMProvider {
  return vi.fn(() => ({}) as SingleTurnProvider) as unknown as ReturnType<typeof vi.fn> &
    typeof createLLMProvider
}

describe('createFallbackProviderBuilder', () => {
  it('fail-closed: a local openai-compatible fallback WITHOUT slotIndex returns null and never calls createProvider', () => {
    const createProvider = spyCreateProvider()
    const build = createFallbackProviderBuilder({
      getStore: () => fakeStore({}),
      createProvider,
    })
    const entry: FallbackEntry = {
      provider: 'openai-compatible',
      model: 'm',
      baseURL: 'http://192.168.1.50:8000/v1',
    }

    expect(build(entry)).toBeNull()
    expect(createProvider).not.toHaveBeenCalled()
  })

  it('a local openai-compatible fallback WITH slotIndex derives the per-fallback broker slot id', () => {
    const createProvider = spyCreateProvider()
    const build = createFallbackProviderBuilder({
      getStore: () => fakeStore({ 'openai-compatible-api-key': 'k' }),
      createProvider,
    })
    const entry: FallbackEntry = {
      provider: 'openai-compatible',
      model: 'm',
      baseURL: 'http://192.168.1.50:8000/v1',
      slotIndex: 2,
    }

    expect(build(entry)).not.toBeNull()
    expect(createProvider).toHaveBeenCalledTimes(1)
    expect(createProvider).toHaveBeenCalledWith(
      { 'openai-compatible': { 'openai-compatible-api-key': 'k' } },
      { provider: 'openai-compatible', name: 'm', baseURL: 'http://192.168.1.50:8000/v1' },
      { openaiCompatibleSlotId: fallbackSlotId(2) }
    )
    expect(fallbackSlotId(2)).toBe('fallback-2')
  })

  it('a non-openai-compatible fallback WITHOUT slotIndex still constructs (the guard is openai-compatible only)', () => {
    const createProvider = spyCreateProvider()
    const build = createFallbackProviderBuilder({
      getStore: () => fakeStore({ 'openai-api-key': 'sk-test' }),
      createProvider,
    })
    const entry: FallbackEntry = { provider: 'openai', model: 'gpt-5' }

    expect(build(entry)).not.toBeNull()
    expect(createProvider).toHaveBeenCalledTimes(1)
    expect(createProvider).toHaveBeenCalledWith(
      { openai: { 'openai-api-key': 'sk-test' } },
      { provider: 'openai', name: 'gpt-5', baseURL: undefined },
      { openaiCompatibleSlotId: undefined }
    )
  })

  it('returns null when the live store is missing a required credential slot (never constructs half-credentialed)', () => {
    const createProvider = spyCreateProvider()
    const build = createFallbackProviderBuilder({
      // openai requires `openai-api-key`; the store has none.
      getStore: () => fakeStore({}),
      createProvider,
    })
    const entry: FallbackEntry = { provider: 'openai', model: 'gpt-5', slotIndex: 1 }

    expect(build(entry)).toBeNull()
    expect(createProvider).not.toHaveBeenCalled()
  })
})
