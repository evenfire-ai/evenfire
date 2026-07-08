import { afterEach, describe, expect, it, vi } from 'vitest'

const KEYS = [
  'CONTROL_API_ADMIN_DEFAULT_AGENT_NAMES',
  'CONTROL_API_ADMIN_DEFAULT_CONTEXT_IDS',
] as const

async function loadConfigWith(overrides: Partial<Record<(typeof KEYS)[number], string>>) {
  const original = new Map<string, string | undefined>()
  for (const key of KEYS) {
    original.set(key, process.env[key])
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    return (await import('../src/config.js')).config
  } finally {
    for (const key of KEYS) {
      const v = original.get(key)
      if (v === undefined) delete process.env[key]
      else process.env[key] = v
    }
  }
}

describe('control-api admin default workspace config', () => {
  afterEach(() => vi.resetModules())

  it('defaults agent=chatllm, context=context1', async () => {
    const config = await loadConfigWith({})
    expect(config.adminDefaultAgentNames).toEqual(['chatllm'])
    expect(config.adminDefaultContextIds).toEqual(['context1'])
  })

  it('parses comma-separated overrides', async () => {
    const config = await loadConfigWith({
      CONTROL_API_ADMIN_DEFAULT_AGENT_NAMES: 'agent2, chatllm',
      CONTROL_API_ADMIN_DEFAULT_CONTEXT_IDS: 'ctxA,ctxB',
    })
    expect(config.adminDefaultAgentNames).toEqual(['agent2', 'chatllm'])
    expect(config.adminDefaultContextIds).toEqual(['ctxA', 'ctxB'])
  })
})
