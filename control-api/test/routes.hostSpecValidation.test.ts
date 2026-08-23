import { describe, expect, it, vi } from 'vitest'
import { validateHostSpec } from '../src/routes/admin/hostSpecValidation.js'

describe('validateHostSpec', () => {
  it('returns null for a spec with no approval and no model (untouched)', async () => {
    const isModelAllowed = vi.fn()
    expect(await validateHostSpec({ contextRef: 'ctx' }, { isModelAllowed })).toBeNull()
    // No model → allowlist is never consulted (deployed Hosts are not disrupted).
    expect(isModelAllowed).not.toHaveBeenCalled()
  })

  it('leaves a spec without spec.model.name untouched even if approval present', async () => {
    const isModelAllowed = vi.fn()
    const res = await validateHostSpec(
      { approval: { defaultPolicy: 'auto' }, model: { provider: 'claude' } },
      { isModelAllowed }
    )
    expect(res).toBeNull()
    expect(isModelAllowed).not.toHaveBeenCalled()
  })

  it('accepts a model that is enabled in the allowlist', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { model: { provider: 'claude', name: 'claude-haiku-4-5' } },
      { isModelAllowed }
    )
    expect(res).toBeNull()
    expect(isModelAllowed).toHaveBeenCalledWith('claude', 'claude-haiku-4-5', undefined)
  })

  it('accepts a newly added provider (groq) as spec.model.provider', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { model: { provider: 'groq', name: 'llama-3.3-70b-versatile' } },
      { isModelAllowed }
    )
    expect(res).toBeNull()
    expect(isModelAllowed).toHaveBeenCalledWith('groq', 'llama-3.3-70b-versatile', undefined)
  })

  it('accepts azure as a Host provider (host.yaml enum carries azure)', async () => {
    // azure is valid on a Host (it can deliver AZURE_OPENAI_ENDPOINT via
    // host-<ref>-env); it is only excluded from the WRC/workflowrecipe path.
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { model: { provider: 'azure', name: 'my-gpt-4o-deployment' } },
      { isModelAllowed }
    )
    expect(res).toBeNull()
    expect(isModelAllowed).toHaveBeenCalledWith('azure', 'my-gpt-4o-deployment', undefined)
  })

  it('rejects a present-but-non-string spec.model.name (fail-closed, no lookup)', async () => {
    const isModelAllowed = vi.fn()
    const res = await validateHostSpec(
      { model: { provider: 'claude', name: 12345 } },
      { isModelAllowed }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].field).toBe('spec.model.name')
    expect(isModelAllowed).not.toHaveBeenCalled()
  })

  it('requires spec.model.provider when spec.model.name is set', async () => {
    const isModelAllowed = vi.fn()
    const res = await validateHostSpec({ model: { name: 'claude-haiku-4-5' } }, { isModelAllowed })
    expect(res).not.toBeNull()
    expect(res!.errors[0].field).toBe('spec.model.provider')
    expect(isModelAllowed).not.toHaveBeenCalled()
  })

  it('rejects a model that is not enabled in the allowlist (model_not_allowed)', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(false)
    const res = await validateHostSpec(
      { model: { provider: 'claude', name: 'claude-sonnet-banned' } },
      { isModelAllowed }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].field).toBe('spec.model.name')
    expect(res!.errors[0].message).toContain('model_not_allowed')
  })

  it('still enforces the approval shape check before the model check', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { approval: { tools: { search: 'yes' } } },
      { isModelAllowed }
    )
    expect(res).not.toBeNull()
    expect(res!.errors[0].field).toContain('spec.approval')
    // Approval failed first → model check short-circuited.
    expect(isModelAllowed).not.toHaveBeenCalled()
  })

  // ── R5 provider-fallback policy (spec.llmPolicy) ──────────────────────────
  describe('spec.llmPolicy (R5)', () => {
    it('leaves a spec with no llmPolicy untouched (regression, opt-in)', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'claude-haiku-4-5' } },
        { isModelAllowed }
      )
      expect(res).toBeNull()
      // Only the primary model is checked; no fallback lookups.
      expect(isModelAllowed).toHaveBeenCalledTimes(1)
    })

    it('accepts a valid llmPolicy (allowlisted fallbacks, well-formed slot)', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          llmPolicy: {
            cooldownSeconds: 300,
            triggerOn: ['auth', 'rate_limited'],
            fallbacks: [
              {
                provider: 'claude',
                model: 'claude-haiku-4-5',
                credentialSlot: 'claude-api-key-fb1',
              },
              { provider: 'openai', model: 'gpt-5.4' },
            ],
          },
        },
        { isModelAllowed }
      )
      expect(res).toBeNull()
      expect(isModelAllowed).toHaveBeenCalledWith('claude', 'claude-haiku-4-5')
      expect(isModelAllowed).toHaveBeenCalledWith('openai', 'gpt-5.4')
    })

    it('rejects a fallback model not in the allowlist (model_not_allowed, with index path)', async () => {
      const isModelAllowed = vi
        .fn()
        .mockResolvedValueOnce(true) // fallbacks[0] ok
        .mockResolvedValueOnce(false) // fallbacks[1] banned
      const res = await validateHostSpec(
        {
          llmPolicy: {
            fallbacks: [
              { provider: 'claude', model: 'claude-haiku-4-5' },
              { provider: 'openai', model: 'gpt-banned' },
            ],
          },
        },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[1].model')
      expect(res!.errors[0].message).toContain('model_not_allowed')
    })

    it('accepts a newly added provider (groq) as an llmPolicy fallback', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          llmPolicy: {
            fallbacks: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
          },
        },
        { isModelAllowed }
      )
      expect(res).toBeNull()
      expect(isModelAllowed).toHaveBeenCalledWith('groq', 'llama-3.3-70b-versatile')
    })

    it('rejects an unknown fallback provider (fail-closed, no allowlist lookup)', async () => {
      const isModelAllowed = vi.fn()
      const res = await validateHostSpec(
        { llmPolicy: { fallbacks: [{ provider: 'bogus', model: 'x' }] } },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[0].provider')
      expect(isModelAllowed).not.toHaveBeenCalled()
    })

    it('rejects a malformed credentialSlot (bad Secret data key)', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          llmPolicy: {
            fallbacks: [
              { provider: 'claude', model: 'claude-haiku-4-5', credentialSlot: 'bad slot!' },
            ],
          },
        },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[0].credentialSlot')
      // Structural rejection short-circuits before the DB lookup.
      expect(isModelAllowed).not.toHaveBeenCalled()
    })

    it('rejects a missing fallback model', async () => {
      const isModelAllowed = vi.fn()
      const res = await validateHostSpec(
        { llmPolicy: { fallbacks: [{ provider: 'claude' }] } },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[0].model')
      expect(isModelAllowed).not.toHaveBeenCalled()
    })

    it('rejects a non-object llmPolicy', async () => {
      const isModelAllowed = vi.fn()
      const res = await validateHostSpec({ llmPolicy: 'nope' }, { isModelAllowed })
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy')
      expect(isModelAllowed).not.toHaveBeenCalled()
    })

    it('rejects a fallbacks that is not an array', async () => {
      const isModelAllowed = vi.fn()
      const res = await validateHostSpec({ llmPolicy: { fallbacks: 'nope' } }, { isModelAllowed })
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks')
      expect(isModelAllowed).not.toHaveBeenCalled()
    })

    it('leaves llmPolicy with no fallbacks key to the CRD schema (write gate is a no-op)', async () => {
      // `fallbacks` presence/min-length is the CRD schema's authority (required +
      // minItems:1). The write gate only validates entries when present, so a
      // policy object with no `fallbacks` passes here without any allowlist call.
      const isModelAllowed = vi.fn()
      const res = await validateHostSpec({ llmPolicy: { cooldownSeconds: 60 } }, { isModelAllowed })
      expect(res).toBeNull()
      expect(isModelAllowed).not.toHaveBeenCalled()
    })

    // ── Fallback credentialSlot capability (residual 1b, decision 3) ──────────
    it('accepts a fallback credentialSlot for a single single-line-key provider (claude)', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          llmPolicy: {
            fallbacks: [
              {
                provider: 'claude',
                model: 'claude-haiku-4-5',
                credentialSlot: 'claude-api-key-fb1',
              },
            ],
          },
        },
        { isModelAllowed }
      )
      expect(res).toBeNull()
    })

    it('rejects a fallback credentialSlot for a multi-slot provider (bedrock)', async () => {
      // Bedrock has two required slots (access-key-id + secret-access-key); a
      // single extra key cannot express that pair — must reuse primary creds.
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          llmPolicy: {
            fallbacks: [
              {
                provider: 'bedrock',
                model: 'anthropic.claude-3-5-sonnet',
                credentialSlot: 'bedrock-fb1',
              },
            ],
          },
        },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[0].credentialSlot')
      expect(res!.errors[0].message).toContain('not supported for provider "bedrock"')
      // Structural capability rejection short-circuits before the DB lookup.
      expect(isModelAllowed).not.toHaveBeenCalled()
    })

    it('rejects a fallback credentialSlot for the multiline JSON provider (vertex)', async () => {
      // Vertex's sole slot is the multiline service-account JSON; it cannot be a
      // per-fallback single-line extra key.
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          llmPolicy: {
            fallbacks: [
              {
                provider: 'vertex',
                model: 'gemini-2.5-pro',
                credentialSlot: 'vertex-fb1',
              },
            ],
          },
        },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[0].credentialSlot')
      expect(res!.errors[0].message).toContain('not supported for provider "vertex"')
      expect(isModelAllowed).not.toHaveBeenCalled()
    })

    it('allows bedrock/vertex fallbacks WITHOUT a credentialSlot (reuse primary creds)', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          llmPolicy: {
            fallbacks: [
              { provider: 'bedrock', model: 'anthropic.claude-3-5-sonnet' },
              { provider: 'vertex', model: 'gemini-2.5-pro' },
            ],
          },
        },
        { isModelAllowed }
      )
      expect(res).toBeNull()
    })
  })

  // ── Topic 3a per-host allowlist (spec.allowedModels) ────────────────────────
  describe('spec.allowedModels (Topic 3a)', () => {
    it('leaves a spec with no allowedModels untouched (regression, additive)', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'claude-haiku-4-5' } },
        { isModelAllowed }
      )
      expect(res).toBeNull()
      // Only the primary model is checked; allowedModels never consulted.
      expect(isModelAllowed).toHaveBeenCalledTimes(1)
    })

    it('treats an empty allowedModels array as full global allowlist (no coherence gate)', async () => {
      // A primary NOT listed in the (empty) subset must still pass — empty == full.
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'claude-haiku-4-5' }, allowedModels: [] },
        { isModelAllowed }
      )
      expect(res).toBeNull()
    })

    it('rejects a non-array allowedModels', async () => {
      const isModelAllowed = vi.fn()
      const res = await validateHostSpec({ allowedModels: 'nope' }, { isModelAllowed })
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.allowedModels')
    })

    it('rejects an allowedModels entry whose pair is not in the global allowlist', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(false)
      const res = await validateHostSpec(
        { allowedModels: [{ provider: 'claude', model: 'claude-not-real' }] },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.allowedModels[0].model')
      expect(res!.errors[0].message).toContain('model_not_allowed')
    })

    it('rejects an allowedModels entry with an unknown provider (fail-closed, no lookup)', async () => {
      const isModelAllowed = vi.fn()
      const res = await validateHostSpec(
        { allowedModels: [{ provider: 'bogus', model: 'x' }] },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.allowedModels[0].provider')
      expect(res!.errors[0].message).toContain('not a known provider')
      expect(isModelAllowed).not.toHaveBeenCalled()
    })

    it('accepts a coherent spec: primary + fallback both within a non-empty allowedModels', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'claude-haiku-4-5' },
          llmPolicy: { fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }] },
          allowedModels: [
            { provider: 'claude', model: 'claude-haiku-4-5' },
            { provider: 'openai', model: 'gpt-5.4' },
          ],
        },
        { isModelAllowed }
      )
      expect(res).toBeNull()
    })

    it('rejects a primary model outside a non-empty allowedModels (model_not_offered)', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'claude-opus-4-7' },
          allowedModels: [{ provider: 'claude', model: 'claude-haiku-4-5' }],
        },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.model.name')
      expect(res!.errors[0].message).toContain('model_not_offered')
    })

    it('rejects a fallback model outside a non-empty allowedModels (with index path)', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'claude-haiku-4-5' },
          llmPolicy: {
            fallbacks: [
              { provider: 'claude', model: 'claude-haiku-4-5' },
              { provider: 'openai', model: 'gpt-5.4' },
            ],
          },
          allowedModels: [{ provider: 'claude', model: 'claude-haiku-4-5' }],
        },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[1].model')
      expect(res!.errors[0].message).toContain('model_not_offered')
    })

    it('matches provider-scoped: same model name under a different provider is not offered', async () => {
      const isModelAllowed = vi.fn().mockResolvedValue(true)
      const res = await validateHostSpec(
        {
          model: { provider: 'openai', name: 'shared-name' },
          allowedModels: [{ provider: 'claude', model: 'shared-name' }],
        },
        { isModelAllowed }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.model.name')
      expect(res!.errors[0].message).toContain('model_not_offered')
    })
  })

  // ── Pieza D: role-scoped no-worsening tolerance (editability trap G3) ────────
  // Once a Host's default (or a referenced model) falls out of the allowlist, the
  // global `model_not_allowed` gate rejected EVERY future edit — including the
  // fix. Tolerance lets a write through iff it does not worsen a pre-existing
  // incoherence AND the pair keeps its ROLE (primary/fallback/subset). The
  // validator no longer emits: it appends the granted tolerations to
  // `context.tolerations`; the route emits them only after the CR persists.
  describe('no-worsening tolerance (Pieza D, role-scoped)', () => {
    // isModelAllowed keyed on `${provider}:${model}`; anything not listed is disabled.
    const allowlist = (...enabled: string[]) => {
      const set = new Set(enabled)
      return vi.fn((p: string, m: string) => Promise.resolve(set.has(`${p}:${m}`)))
    }
    const hostRef = { namespace: 'mcp-host', name: 'h1' }

    it('re-saving a disabled PRIMARY in the same role, coverage not reduced → 200 + tolerated', async () => {
      const isModelAllowed = allowlist() // M disabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = { model: { provider: 'claude', name: 'M' } }
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'M' } },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).toBeNull() // → 200
      expect(tolerations).toEqual([
        expect.objectContaining({
          resourceKind: 'host',
          namespace: 'mcp-host',
          name: 'h1',
          provider: 'claude',
          model: 'M',
          gate: 'primary',
          offeredBefore: 'UNIVERSAL',
          offeredAfter: 'UNIVERSAL',
        }),
      ])
    })

    it('widening coverage while re-saving a disabled primary is still tolerated (G3 not broken)', async () => {
      const isModelAllowed = allowlist('claude:A') // M disabled, A enabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = {
        model: { provider: 'claude', name: 'M' },
        allowedModels: [{ provider: 'claude', model: 'M' }],
      }
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'M' },
          allowedModels: [
            { provider: 'claude', model: 'M' },
            { provider: 'claude', model: 'A' },
          ],
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).toBeNull()
      // M tolerated at BOTH the primary gate and the subset gate (same role each).
      expect(tolerations.map(t => t.gate).sort()).toEqual(['primary', 'subset'])
    })

    it('keeps a disabled FALLBACK as a fallback → 200 + tolerated (gate=fallback)', async () => {
      const isModelAllowed = allowlist('claude:A') // F disabled, A enabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = {
        model: { provider: 'claude', name: 'A' },
        llmPolicy: { fallbacks: [{ provider: 'claude', model: 'F' }] },
      }
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'A' },
          llmPolicy: { fallbacks: [{ provider: 'claude', model: 'F' }] },
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).toBeNull()
      expect(tolerations).toEqual([expect.objectContaining({ gate: 'fallback', model: 'F' })])
    })

    it('ROLE ELEVATION fallback→primary is NOT tolerated → 422 (mini-spec repro #1)', async () => {
      // Stored: primary A (enabled), fallback M (disabled). The write promotes the
      // disabled fallback M to the active primary default without shrinking
      // coverage. Per-par tolerance let this through (200); role-scoped rejects it.
      const isModelAllowed = allowlist('claude:A') // M disabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = {
        model: { provider: 'claude', name: 'A' },
        llmPolicy: { fallbacks: [{ provider: 'claude', model: 'M' }] },
      }
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'M' },
          llmPolicy: { fallbacks: [{ provider: 'claude', model: 'M' }] },
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).not.toBeNull() // → 422
      expect(res!.errors[0].field).toBe('spec.model.name')
      expect(res!.errors[0].message).toContain('model_not_allowed')
      expect(tolerations).toEqual([]) // nothing emitted for a rejected write
    })

    it('ROLE ELEVATION allowedModels→primary is NOT tolerated → 422 (mini-spec repro #2)', async () => {
      // Stored: primary A (enabled), allowedModels [A, M(disabled)]. The write makes
      // the disabled subset-only M the primary default.
      const isModelAllowed = allowlist('claude:A') // M disabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = {
        model: { provider: 'claude', name: 'A' },
        allowedModels: [
          { provider: 'claude', model: 'A' },
          { provider: 'claude', model: 'M' },
        ],
      }
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'M' },
          allowedModels: [
            { provider: 'claude', model: 'A' },
            { provider: 'claude', model: 'M' },
          ],
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).not.toBeNull() // → 422 at the primary gate
      expect(res!.errors[0].field).toBe('spec.model.name')
      expect(tolerations).toEqual([])
    })

    it('a NEW disabled fallback (never stored) is NOT tolerated → 422 (condition c)', async () => {
      const isModelAllowed = allowlist('claude:A') // X disabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = {
        model: { provider: 'claude', name: 'A' },
        llmPolicy: { fallbacks: [{ provider: 'claude', model: 'A' }] },
      }
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'A' },
          llmPolicy: { fallbacks: [{ provider: 'claude', model: 'X' }] },
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[0].model')
      expect(tolerations).toEqual([])
    })

    it('BYPASS BLOCKED: reducing the subset around a disabled model → 422 (condition b)', async () => {
      // Same role (subset), but coverage shrinks (drops N) → still rejected.
      const isModelAllowed = allowlist('claude:A') // M, N disabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = {
        model: { provider: 'claude', name: 'A' },
        allowedModels: [
          { provider: 'claude', model: 'A' },
          { provider: 'claude', model: 'M' },
          { provider: 'claude', model: 'N' },
        ],
      }
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'A' },
          allowedModels: [
            { provider: 'claude', model: 'A' },
            { provider: 'claude', model: 'M' },
          ],
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.allowedModels[1].model')
      expect(tolerations).toEqual([])
    })

    it('narrowing a previously-UNIVERSAL offering around a disabled primary → 422 (condition b)', async () => {
      const isModelAllowed = allowlist() // M disabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = { model: { provider: 'claude', name: 'M' } } // allowedModels absent → UNIVERSAL
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'M' },
          allowedModels: [{ provider: 'claude', model: 'M' }],
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).not.toBeNull()
      expect(tolerations).toEqual([])
    })

    it('DEMOTION primary→fallback is tolerated → 200 + tolerated (mini-spec v2)', async () => {
      // Stored: primary M (disabled). The write moves M OUT of the active slot to
      // a fallback and installs an enabled primary A. M loses activeness — pure
      // non-worsening — so it is tolerated at the (non-active) fallback gate. v1's
      // exact-same-role rule wrongly rejected this with 422.
      const isModelAllowed = allowlist('claude:A') // M disabled, A enabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = { model: { provider: 'claude', name: 'M' } }
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'A' },
          llmPolicy: { fallbacks: [{ provider: 'claude', model: 'M' }] },
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).toBeNull() // → 200
      expect(tolerations).toEqual([expect.objectContaining({ gate: 'fallback', model: 'M' })])
    })

    it('DEMOTION away from the primary slot into the subset is tolerated → 200 (mini-spec v2)', async () => {
      // Stored: primary M (disabled), coverage [M]. The write installs enabled A as
      // primary and keeps M as a (non-active) subset entry, widening coverage. M is
      // no longer the active default → non-worsening → tolerated at the subset gate.
      const isModelAllowed = allowlist('claude:A') // M disabled, A enabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = {
        model: { provider: 'claude', name: 'M' },
        allowedModels: [{ provider: 'claude', model: 'M' }],
      }
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'A' },
          allowedModels: [
            { provider: 'claude', model: 'A' },
            { provider: 'claude', model: 'M' },
          ],
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).toBeNull()
      expect(tolerations).toEqual([expect.objectContaining({ gate: 'subset', model: 'M' })])
    })

    it('throws when `stored` is provided without a `tolerations` sink (never-silent contract guard)', async () => {
      const isModelAllowed = allowlist()
      await expect(
        validateHostSpec(
          { model: { provider: 'claude', name: 'M' } },
          { isModelAllowed },
          { stored: { model: { provider: 'claude', name: 'M' } }, hostRef } // no `tolerations`
        )
      ).rejects.toThrow(/tolerations sink is required/)
    })

    it('never tolerates on CREATE (no stored CR) → 422', async () => {
      const isModelAllowed = allowlist() // M disabled
      const tolerations: Array<Record<string, unknown>> = []
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'M' } },
        { isModelAllowed },
        { hostRef, tolerations } // no `stored`
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].message).toContain('model_not_allowed')
      expect(tolerations).toEqual([])
    })

    it('does NOT record a toleration when a LATER gate hard-rejects the write (persist-safe)', async () => {
      // Primary M is a tolerable same-role incoherence, but a NEW disabled fallback
      // X hard-rejects the write. Because validation fails, the queued M toleration
      // is NOT handed to context.tolerations → the route emits nothing.
      const isModelAllowed = allowlist() // M and X disabled
      const tolerations: Array<Record<string, unknown>> = []
      const stored = { model: { provider: 'claude', name: 'M' } }
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'M' },
          llmPolicy: { fallbacks: [{ provider: 'claude', model: 'X' }] },
        },
        { isModelAllowed },
        { stored, hostRef, tolerations }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].field).toBe('spec.llmPolicy.fallbacks[0].model')
      expect(tolerations).toEqual([])
    })
  })

  // Fase 6 — soft quarantine of `stale` models on the operator path. An ENABLED
  // but `stale` model assigned to something NEW passes the gate (never 422) and
  // yields a NON-BLOCKING warning; a live reference (already in the stored CR) is
  // never revalidated. Orthogonal to Fase 2 (`enabled=false`).
  describe('stale soft-quarantine warnings (Fase 6)', () => {
    // Everything enabled; `stale` keyed on `${provider}:${model}`.
    const enabledAll = () => vi.fn(() => Promise.resolve(true))
    const stateFn = (...staleKeys: string[]) => {
      const stale = new Set(staleKeys)
      return vi.fn((p: string, m: string) =>
        Promise.resolve({ enabled: true, stale: stale.has(`${p}:${m}`) })
      )
    }

    it('NEW assignment of an enabled+stale primary → null (no error) + warning, never 422', async () => {
      const isModelAllowed = enabledAll()
      const getModelAllowlistState = stateFn('claude:M')
      const warnings: Array<Record<string, unknown>> = []
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'M' } },
        { isModelAllowed, getModelAllowlistState },
        { warnings } // no stored → create → assignment is new
      )
      // Never a rejection for stale alone.
      expect(res).toBeNull()
      expect(warnings).toEqual([
        { code: 'stale_model_assigned', provider: 'claude', model: 'M', field: 'spec.model.name' },
      ])
    })

    it('EXISTING reference to a stale model (already in stored) → no warning (not revalidated)', async () => {
      const isModelAllowed = enabledAll()
      const getModelAllowlistState = stateFn('claude:M')
      const warnings: Array<Record<string, unknown>> = []
      const stored = { model: { provider: 'claude', name: 'M' } }
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'M' } },
        { isModelAllowed, getModelAllowlistState },
        { stored, tolerations: [], warnings }
      )
      expect(res).toBeNull()
      expect(warnings).toEqual([])
      // A live reference is never revalidated — the state lookup is skipped.
      expect(getModelAllowlistState).not.toHaveBeenCalled()
    })

    it('NEW assignment of an enabled but NON-stale model → no warning', async () => {
      const isModelAllowed = enabledAll()
      const getModelAllowlistState = stateFn() // nothing stale
      const warnings: Array<Record<string, unknown>> = []
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'M' } },
        { isModelAllowed, getModelAllowlistState },
        { warnings }
      )
      expect(res).toBeNull()
      expect(warnings).toEqual([])
    })

    it('warns for a NEW stale fallback and a NEW stale subset entry (all 3 gates)', async () => {
      const isModelAllowed = enabledAll()
      const getModelAllowlistState = stateFn('claude:P', 'claude:F', 'claude:S')
      const warnings: Array<{ field: string; model: string }> = []
      const res = await validateHostSpec(
        {
          model: { provider: 'claude', name: 'P' },
          llmPolicy: { fallbacks: [{ provider: 'claude', model: 'F' }] },
          allowedModels: [
            { provider: 'claude', model: 'P' },
            { provider: 'claude', model: 'F' },
            { provider: 'claude', model: 'S' },
          ],
        },
        { isModelAllowed, getModelAllowlistState },
        { warnings }
      )
      expect(res).toBeNull()
      // One warning per distinct pair (deduped), across primary/fallback/subset.
      const byModel = Object.fromEntries(warnings.map(w => [w.model, w.field]))
      expect(byModel).toEqual({
        P: 'spec.model.name',
        F: 'spec.llmPolicy.fallbacks[0].model',
        S: 'spec.allowedModels[2].model',
      })
    })

    it('a DISABLED model (Fase 2) is not turned into a Fase 6 warning — it rejects', async () => {
      // enabled=false → the R3 gate 422s (create, no tolerance). Fase 6 never runs
      // for a rejected pair, and the state lookup is not even consulted.
      const isModelAllowed = vi.fn(() => Promise.resolve(false))
      const getModelAllowlistState = stateFn('claude:M') // would-be stale, but disabled
      const warnings: Array<Record<string, unknown>> = []
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'M' } },
        { isModelAllowed, getModelAllowlistState },
        { warnings }
      )
      expect(res).not.toBeNull()
      expect(res!.errors[0].message).toContain('model_not_allowed')
      expect(warnings).toEqual([])
      expect(getModelAllowlistState).not.toHaveBeenCalled()
    })

    it('does not consult the state lookup at all when no warnings sink is provided', async () => {
      const isModelAllowed = enabledAll()
      const getModelAllowlistState = stateFn('claude:M')
      const res = await validateHostSpec(
        { model: { provider: 'claude', name: 'M' } },
        { isModelAllowed, getModelAllowlistState }
        // no context.warnings → opt-out, zero extra queries
      )
      expect(res).toBeNull()
      expect(getModelAllowlistState).not.toHaveBeenCalled()
    })
  })
})
