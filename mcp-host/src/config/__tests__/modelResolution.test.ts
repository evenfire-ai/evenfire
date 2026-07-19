import { describe, expect, it } from 'vitest'
import type { AllowlistView } from '../allowlistCheck'
import type { AllowedModelEntry } from '../configStore'
import {
  contextWindowForModel,
  hostSubsetAllowlistView,
  isModelAllowed,
  projectModels,
  resolveSessionModel,
} from '../modelResolution'

function view(available: boolean, models: Record<string, AllowedModelEntry[]> = {}): AllowlistView {
  return {
    allowlistAvailable: () => available,
    allowedModels: () => new Map(Object.entries(models)),
  }
}

const CLAUDE_ALLOWLIST: Record<string, AllowedModelEntry[]> = {
  claude: [
    { model: 'claude-opus-4-8', displayName: 'Opus 4.8', contextWindowTokens: 200000 },
    { model: 'claude-haiku-4-5' },
  ],
}

describe('isModelAllowed', () => {
  it('allows an enabled model when the allowlist is available', () => {
    expect(
      isModelAllowed(view(true, CLAUDE_ALLOWLIST), 'claude', 'claude-haiku-4-5', 'claude-opus-4-8')
    ).toBe(true)
  })

  it('rejects a model absent from the allowlist (fail-closed)', () => {
    expect(isModelAllowed(view(true, CLAUDE_ALLOWLIST), 'claude', 'gpt-5', 'claude-opus-4-8')).toBe(
      false
    )
  })

  it('degraded: only the Host default is allowed', () => {
    const v = view(false)
    expect(isModelAllowed(v, 'claude', 'claude-opus-4-8', 'claude-opus-4-8')).toBe(true)
    expect(isModelAllowed(v, 'claude', 'claude-haiku-4-5', 'claude-opus-4-8')).toBe(false)
  })
})

describe('resolveSessionModel', () => {
  it('returns the saved model when it is still allowed', () => {
    expect(
      resolveSessionModel(view(true, CLAUDE_ALLOWLIST), 'claude', 'claude-opus-4-8', {
        claude: 'claude-haiku-4-5',
      })
    ).toEqual({ model: 'claude-haiku-4-5' })
  })

  it('falls back to the Host default and flags blocked when the saved model is no longer allowed', () => {
    expect(
      resolveSessionModel(view(true, CLAUDE_ALLOWLIST), 'claude', 'claude-opus-4-8', {
        claude: 'claude-sonnet-legacy',
      })
    ).toEqual({ model: 'claude-opus-4-8', blocked: 'claude-sonnet-legacy' })
  })

  it('returns the Host default when there is no saved selection', () => {
    expect(
      resolveSessionModel(view(true, CLAUDE_ALLOWLIST), 'claude', 'claude-opus-4-8', undefined)
    ).toEqual({
      model: 'claude-opus-4-8',
    })
  })

  it('degraded: a saved non-default model is blocked', () => {
    expect(
      resolveSessionModel(view(false), 'claude', 'claude-opus-4-8', { claude: 'claude-haiku-4-5' })
    ).toEqual({ model: 'claude-opus-4-8', blocked: 'claude-haiku-4-5' })
  })
})

describe('projectModels', () => {
  it('projects enabled entries with optional metadata', () => {
    expect(projectModels(view(true, CLAUDE_ALLOWLIST), 'claude', 'claude-opus-4-8')).toEqual({
      degraded: false,
      models: [
        { name: 'claude-opus-4-8', displayName: 'Opus 4.8', contextWindowTokens: 200000 },
        { name: 'claude-haiku-4-5' },
      ],
    })
  })

  it('degraded: collapses to the Host default only', () => {
    expect(projectModels(view(false), 'claude', 'claude-opus-4-8')).toEqual({
      degraded: true,
      models: [{ name: 'claude-opus-4-8' }],
    })
  })
})

describe('contextWindowForModel', () => {
  it('reads the allowlist context window for the model', () => {
    expect(contextWindowForModel(view(true, CLAUDE_ALLOWLIST), 'claude', 'claude-opus-4-8')).toBe(
      200000
    )
  })

  it('returns undefined when the entry has no context window', () => {
    expect(
      contextWindowForModel(view(true, CLAUDE_ALLOWLIST), 'claude', 'claude-haiku-4-5')
    ).toBeUndefined()
  })

  it('returns undefined for an unknown model', () => {
    expect(contextWindowForModel(view(true, CLAUDE_ALLOWLIST), 'claude', 'gpt-5')).toBeUndefined()
  })
})

// T3a — the per-host subset filter. A Host's `spec.allowedModels` narrows the
// operator's GLOBAL allowlist to the models THIS host offers. These tests drive
// the composed shape the R2 endpoints use: `projectModels`/`isModelAllowed`/
// `resolveSessionModel` over `hostSubsetAllowlistView(global, spec.allowedModels)`.
describe('hostSubsetAllowlistView', () => {
  it('(a) projects only the intersection of the subset and the global', () => {
    const v = hostSubsetAllowlistView(view(true, CLAUDE_ALLOWLIST), [
      { provider: 'claude', model: 'claude-opus-4-8' },
    ])
    // Only opus survives (haiku is global-enabled but not host-offered), and its
    // metadata still comes from the global entry.
    expect(projectModels(v, 'claude', 'claude-opus-4-8')).toEqual({
      degraded: false,
      models: [{ name: 'claude-opus-4-8', displayName: 'Opus 4.8', contextWindowTokens: 200000 }],
    })
  })

  it('(a) rejects a globally-allowed but not host-offered model on the write gate', () => {
    const v = hostSubsetAllowlistView(view(true, CLAUDE_ALLOWLIST), [
      { provider: 'claude', model: 'claude-opus-4-8' },
    ])
    // haiku IS enabled globally, but the host subset excludes it → not allowed.
    expect(isModelAllowed(v, 'claude', 'claude-haiku-4-5', 'claude-opus-4-8')).toBe(false)
    expect(isModelAllowed(v, 'claude', 'claude-opus-4-8', 'claude-opus-4-8')).toBe(true)
  })

  it('(b) absent subset returns the full global view unchanged', () => {
    const global = view(true, CLAUDE_ALLOWLIST)
    expect(hostSubsetAllowlistView(global, undefined)).toBe(global)
    expect(hostSubsetAllowlistView(global, [])).toBe(global)
    // Projection is identical to the raw global.
    const v = hostSubsetAllowlistView(global, undefined)
    expect(projectModels(v, 'claude', 'claude-opus-4-8')).toEqual(
      projectModels(global, 'claude', 'claude-opus-4-8')
    )
  })

  it('(c) a host-offered model dropped from the global disappears (live intersection)', () => {
    // The subset still lists haiku, but the live global no longer enables it.
    const shrunkGlobal = view(true, {
      claude: [{ model: 'claude-opus-4-8', displayName: 'Opus 4.8', contextWindowTokens: 200000 }],
    })
    const v = hostSubsetAllowlistView(shrunkGlobal, [
      { provider: 'claude', model: 'claude-opus-4-8' },
      { provider: 'claude', model: 'claude-haiku-4-5' },
    ])
    expect(projectModels(v, 'claude', 'claude-opus-4-8').models).toEqual([
      { name: 'claude-opus-4-8', displayName: 'Opus 4.8', contextWindowTokens: 200000 },
    ])
    expect(isModelAllowed(v, 'claude', 'claude-haiku-4-5', 'claude-opus-4-8')).toBe(false)
    // A saved selection on the now-unavailable model is surfaced as blocked.
    expect(
      resolveSessionModel(v, 'claude', 'claude-opus-4-8', { claude: 'claude-haiku-4-5' })
    ).toEqual({ model: 'claude-opus-4-8', blocked: 'claude-haiku-4-5' })
  })

  it('filters per provider (a multi-provider global keeps only the offered pairs)', () => {
    const global = view(true, {
      claude: [{ model: 'claude-opus-4-8' }, { model: 'claude-haiku-4-5' }],
      openai: [{ model: 'gpt-5.4' }, { model: 'gpt-6' }],
    })
    const v = hostSubsetAllowlistView(global, [
      { provider: 'claude', model: 'claude-haiku-4-5' },
      { provider: 'openai', model: 'gpt-6' },
    ])
    expect(projectModels(v, 'claude', 'claude-opus-4-8').models).toEqual([
      { name: 'claude-haiku-4-5' },
    ])
    expect(projectModels(v, 'openai', 'gpt-5.4').models).toEqual([{ name: 'gpt-6' }])
  })

  it('delegates allowlistAvailable so the degraded path is preserved (host default only)', () => {
    // Even with a subset, an unavailable global stays degraded: projectModels
    // collapses to the Host default and never consults the (empty) map.
    const v = hostSubsetAllowlistView(view(false), [
      { provider: 'claude', model: 'claude-opus-4-8' },
    ])
    expect(v.allowlistAvailable()).toBe(false)
    expect(projectModels(v, 'claude', 'claude-opus-4-8')).toEqual({
      degraded: true,
      models: [{ name: 'claude-opus-4-8' }],
    })
    // Degraded write gate: still only the Host default is permitted.
    expect(isModelAllowed(v, 'claude', 'claude-opus-4-8', 'claude-opus-4-8')).toBe(true)
    expect(isModelAllowed(v, 'claude', 'claude-haiku-4-5', 'claude-opus-4-8')).toBe(false)
  })

  it('ignores malformed subset entries; an all-malformed subset is a no-op passthrough', () => {
    const global = view(true, CLAUDE_ALLOWLIST)
    const v = hostSubsetAllowlistView(global, [
      { provider: '', model: 'claude-opus-4-8' },
      { provider: 'claude', model: '' },
    ] as never)
    // No well-formed pair → treated as "no subset" → full global.
    expect(v).toBe(global)
  })
})
