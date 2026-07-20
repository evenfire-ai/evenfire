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
    expect(isModelAllowed).toHaveBeenCalledWith('claude', 'claude-haiku-4-5')
  })

  it('accepts a newly added provider (groq) as spec.model.provider', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { model: { provider: 'groq', name: 'llama-3.3-70b-versatile' } },
      { isModelAllowed }
    )
    expect(res).toBeNull()
    expect(isModelAllowed).toHaveBeenCalledWith('groq', 'llama-3.3-70b-versatile')
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
    expect(isModelAllowed).toHaveBeenCalledWith('azure', 'my-gpt-4o-deployment')
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
})
