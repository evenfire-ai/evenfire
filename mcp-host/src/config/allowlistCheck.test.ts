import { afterEach, describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import { type AllowlistView, signalHostModelAllowlist } from './allowlistCheck'
import type { AllowedModelEntry } from './configStore'

async function notAllowedCount(provider: string, model: string): Promise<number> {
  const metric = register.getSingleMetric('clerum_llm_model_not_allowed_total')
  if (!metric) return 0
  const data = await metric.get()
  const match = data.values.find(v => v.labels.provider === provider && v.labels.model === model)
  return match?.value ?? 0
}

function view(available: boolean, models: Record<string, AllowedModelEntry[]>): AllowlistView {
  return {
    allowlistAvailable: () => available,
    allowedModels: () => new Map(Object.entries(models)),
  }
}

describe('signalHostModelAllowlist (R3.7)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns + increments the metric when the configured model is not allowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = await notAllowedCount('openai', 'gpt-forbidden')

    const signalled = signalHostModelAllowlist(view(true, { openai: [{ model: 'gpt-5.4' }] }), {
      provider: 'openai',
      name: 'gpt-forbidden',
    })

    expect(signalled).toBe(true)
    expect(await notAllowedCount('openai', 'gpt-forbidden')).toBe(before + 1)
    expect(warn).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(warn.mock.calls[0][0] as string)
    expect(payload).toMatchObject({
      event: 'llm_model_not_allowed',
      provider: 'openai',
      model: 'gpt-forbidden',
    })
  })

  it('is silent when the configured model is in the allowlist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = await notAllowedCount('openai', 'gpt-5.4')

    const signalled = signalHostModelAllowlist(view(true, { openai: [{ model: 'gpt-5.4' }] }), {
      provider: 'openai',
      name: 'gpt-5.4',
    })

    expect(signalled).toBe(false)
    expect(await notAllowedCount('openai', 'gpt-5.4')).toBe(before)
    expect(warn).not.toHaveBeenCalled()
  })

  it('is skipped (degraded-explicit) when the allowlist is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const signalled = signalHostModelAllowlist(view(false, {}), {
      provider: 'openai',
      name: 'gpt-forbidden',
    })
    expect(signalled).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('no-ops when the Host has no model configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      signalHostModelAllowlist(view(true, { openai: [{ model: 'gpt-5.4' }] }), undefined)
    ).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })
})
