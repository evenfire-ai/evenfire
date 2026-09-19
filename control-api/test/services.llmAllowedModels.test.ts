import { describe, expect, it, vi } from 'vitest'
import {
  LlmAllowedModelConflictError,
  createAllowedModel,
  createLlmAllowedModelSchema,
  deleteAllowedModel,
  getModelAllowlistState,
  isModelAllowed,
  listAllowedModels,
  listEnabledGroupedByProvider,
  listEnabledModelNamesForProvider,
  listEnabledModelsWithStaleForProvider,
  updateAllowedModel,
  updateLlmAllowedModelSchema,
} from '../src/services/llmAllowedModels.js'

function fakeDb(query: ReturnType<typeof vi.fn>) {
  return { query } as unknown as Parameters<typeof createAllowedModel>[2]
}

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'claude',
  model: 'claude-haiku-4-5',
  vendor: 'Anthropic',
  display_name: null,
  context_window_tokens: null,
  enabled: true,
  created_at: new Date('2026-07-01T00:00:00Z'),
  updated_at: new Date('2026-07-01T00:00:00Z'),
}

// Curated evidence for an exact (provider, model) pair, as an operator would
// enter it from the provider's own documentation.
const CURATED_SUPPORTED = {
  state: 'supported',
  evidence: {
    source: 'curated',
    reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
    checkedAt: '2026-09-16T00:00:00.000Z',
  },
}

const DISCOVERY_UNKNOWN = {
  state: 'unknown',
  evidence: {
    source: 'discovery',
    reference: 'https://models.dev/api.json',
    checkedAt: '2026-08-19T16:16:10.000Z',
  },
}

describe('llmAllowedModels service', () => {
  describe('createLlmAllowedModelSchema', () => {
    it('requires provider and model', () => {
      expect(createLlmAllowedModelSchema.safeParse({ provider: 'claude' }).success).toBe(false)
      expect(createLlmAllowedModelSchema.safeParse({ model: 'x' }).success).toBe(false)
    })

    it('defaults enabled to true and leaves optionals absent', () => {
      const res = createLlmAllowedModelSchema.safeParse({ provider: 'claude', model: 'x' })
      expect(res.success).toBe(true)
      if (res.success) {
        expect(res.data.enabled).toBe(true)
        expect(res.data.vendor).toBeUndefined()
        expect(res.data.context_window_tokens).toBeUndefined()
      }
    })

    it('rejects a provider with invalid ConfigMap-key characters or a reserved name', () => {
      // provider becomes a K8s ConfigMap data key → must be a safe key and never
      // an Object.prototype key that could poison the grouping / jam the write.
      for (const bad of [
        'open ai',
        'azure/openai',
        'foo:bar',
        '__proto__',
        'constructor',
        'prototype',
      ]) {
        expect(createLlmAllowedModelSchema.safeParse({ provider: bad, model: 'x' }).success).toBe(
          false
        )
      }
      // Legitimate provider ids still pass.
      for (const ok of ['openai', 'claude', 'zai', 'bailian', 'azure-openai', 'vertex']) {
        expect(createLlmAllowedModelSchema.safeParse({ provider: ok, model: 'x' }).success).toBe(
          true
        )
      }
    })

    it('rejects a non-integer or out-of-range context window', () => {
      expect(
        createLlmAllowedModelSchema.safeParse({
          provider: 'claude',
          model: 'x',
          context_window_tokens: 1.5,
        }).success
      ).toBe(false)
      expect(
        createLlmAllowedModelSchema.safeParse({
          provider: 'claude',
          model: 'x',
          context_window_tokens: 0,
        }).success
      ).toBe(false)
      expect(
        createLlmAllowedModelSchema.safeParse({
          provider: 'claude',
          model: 'x',
          context_window_tokens: 999_999_999,
        }).success
      ).toBe(false)
    })
  })

  describe('image_input capability field (#654)', () => {
    const withImage = (image_input: unknown) =>
      createLlmAllowedModelSchema.safeParse({ provider: 'zai', model: 'glm-5.3', image_input })

    it('accepts a curated known claim and an explicit unknown', () => {
      expect(withImage(CURATED_SUPPORTED).success).toBe(true)
      expect(withImage({ state: 'unknown' }).success).toBe(true)
      expect(withImage(DISCOVERY_UNKNOWN).success).toBe(true)
      expect(withImage(undefined).success).toBe(true)
    })

    it('rejects a known claim without evidence (invalid never becomes affirmative)', () => {
      expect(withImage({ state: 'supported' }).success).toBe(false)
      expect(withImage({ state: 'unsupported' }).success).toBe(false)
      expect(withImage({ state: 'supported', evidence: {} }).success).toBe(false)
    })

    it('rejects a discovery-sourced known claim without validUntil', () => {
      expect(
        withImage({ state: 'supported', evidence: { ...DISCOVERY_UNKNOWN.evidence } }).success
      ).toBe(false)
      expect(
        withImage({
          state: 'supported',
          evidence: {
            ...DISCOVERY_UNKNOWN.evidence,
            validUntil: '2026-12-01T00:00:00.000Z',
          },
        }).success
      ).toBe(true)
    })

    it('rejects unknown keys, bad states, non-UTC dates and non-public references', () => {
      // A payload with no `state` at all — including the `{}` an empty JSON body
      // would produce — must never reach storage; the column CHECK is only the
      // backstop, the writer rejects it first.
      expect(withImage({}).success).toBe(false)
      expect(withImage({ state: null }).success).toBe(false)
      expect(withImage([]).success).toBe(false)
      expect(withImage('supported').success).toBe(false)
      expect(withImage({ state: 'bogus' }).success).toBe(false)
      expect(withImage({ state: 'supported', extra: 1 }).success).toBe(false)
      expect(withImage({ ...CURATED_SUPPORTED, extra: 1 }).success).toBe(false)
      expect(
        withImage({
          ...CURATED_SUPPORTED,
          evidence: { ...CURATED_SUPPORTED.evidence, checkedAt: '2026-09-16' },
        }).success
      ).toBe(false)
      // A private/intranet reference must never be stored as evidence.
      for (const reference of [
        'http://docs.z.ai/guides/llm/glm-5.3',
        'https://localhost/docs',
        'https://10.0.0.1/docs',
        'https://catalog.internal/docs',
      ]) {
        expect(
          withImage({
            ...CURATED_SUPPORTED,
            evidence: { ...CURATED_SUPPORTED.evidence, reference },
          }).success
        ).toBe(false)
      }
      // A sanitized local evidence id is the non-URL form.
      expect(
        withImage({
          ...CURATED_SUPPORTED,
          evidence: { ...CURATED_SUPPORTED.evidence, reference: 'evidence:glm-eval-2026-09' },
        }).success
      ).toBe(true)
    })

    it('accepts an explicit null only on the UPDATE schema (clear)', () => {
      expect(withImage(null).success).toBe(false)
      expect(updateLlmAllowedModelSchema.safeParse({ image_input: null }).success).toBe(true)
      expect(
        updateLlmAllowedModelSchema.safeParse({ image_input: { state: 'nope' } }).success
      ).toBe(false)
    })

    it('compares the DNS root dot for hostname policy and preserves the exact reference', () => {
      const original = 'https://docs.z.ai./guides/vlm/glm-5.3-flash'
      const dotted = {
        ...CURATED_SUPPORTED,
        evidence: { ...CURATED_SUPPORTED.evidence, reference: original },
      }
      const parsed = withImage(dotted)
      // A public fully qualified hostname with the DNS root dot is still right.
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(JSON.stringify(parsed.data)).toContain(original)
      }
      // The trailing dot cannot make an intranet, private, or single-label
      // hostname pass: the policy compares the normalized hostname, and old
      // evidence stored with such a reference must not produce a known claim.
      for (const reference of [
        'https://localhost./docs',
        'https://10.0.0.1./docs',
        'https://catalog.internal./docs',
        'https://docs.local./docs',
        'https://web./docs',
      ]) {
        expect(
          withImage({ ...CURATED_SUPPORTED, evidence: { ...dotted.evidence, reference } }).success
        ).toBe(false)
      }
    })
  })

  describe('updateLlmAllowedModelSchema', () => {
    it('rejects an empty body', () => {
      expect(updateLlmAllowedModelSchema.safeParse({}).success).toBe(false)
    })

    it('rejects unknown fields', () => {
      expect(updateLlmAllowedModelSchema.safeParse({ enabled: false, bogus: 1 }).success).toBe(
        false
      )
    })
  })

  describe('createAllowedModel', () => {
    it('inserts the row and writes a create audit row', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 }) // INSERT ... RETURNING
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit INSERT
      const created = await createAllowedModel(
        createLlmAllowedModelSchema.parse({ provider: 'claude', model: 'claude-haiku-4-5' }),
        'admin-1',
        fakeDb(query)
      )
      expect(created.provider).toBe('claude')
      expect(query).toHaveBeenCalledTimes(2)
      const [auditSql, auditParams] = query.mock.calls[1]
      expect(String(auditSql)).toMatch(/INSERT INTO llm_allowed_models_audit/)
      expect(auditParams[0]).toBe('admin-1')
      expect(auditParams[1]).toBe('create')
    })

    it('maps a unique violation (23505) to LlmAllowedModelConflictError', async () => {
      const query = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
      await expect(
        createAllowedModel(
          createLlmAllowedModelSchema.parse({ provider: 'claude', model: 'x' }),
          'admin-1',
          fakeDb(query)
        )
      ).rejects.toBeInstanceOf(LlmAllowedModelConflictError)
    })

    it('persists a validated capability and stores the normalized row value', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            { ...ROW, provider: 'zai', model: 'glm-5.3-flash', image_input: CURATED_SUPPORTED },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      const created = await createAllowedModel(
        createLlmAllowedModelSchema.parse({
          provider: 'zai',
          model: 'glm-5.3-flash',
          image_input: CURATED_SUPPORTED,
        }),
        'admin-1',
        fakeDb(query)
      )
      const [insertSql, insertParams] = query.mock.calls[0]
      expect(String(insertSql)).toMatch(/image_input/)
      // Stored as canonical JSON text for the jsonb column.
      expect(insertParams[5]).toBe(JSON.stringify(CURATED_SUPPORTED))
      expect(created.image_input).toEqual(CURATED_SUPPORTED)
    })

    it('stores NULL when no capability is supplied (unknown is the absence of evidence)', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      const created = await createAllowedModel(
        createLlmAllowedModelSchema.parse({
          provider: 'claude',
          model: 'claude-haiku-4-5',
          image_input: { state: 'unknown' },
        }),
        'admin-1',
        fakeDb(query)
      )
      expect(query.mock.calls[0][1][5]).toBeNull()
      expect(created.image_input).toEqual({ state: 'unknown' })
    })
  })

  describe('updateAllowedModel', () => {
    it('writes a disable audit row when enabling→false transition', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 }) // getAllowedModel (enabled)
        .mockResolvedValueOnce({ rows: [{ ...ROW, enabled: false }], rowCount: 1 }) // UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
      await updateAllowedModel('id', { enabled: false }, 'admin-2', fakeDb(query))
      const auditCall = query.mock.calls.find(c =>
        /INSERT INTO llm_allowed_models_audit/.test(String(c[0]))
      )
      expect(auditCall![1][1]).toBe('disable')
    })

    it('returns null (no update) when the row is missing', async () => {
      const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }) // getAllowedModel
      const res = await updateAllowedModel('id', { enabled: false }, 'admin-2', fakeDb(query))
      expect(res).toBeNull()
      expect(query).toHaveBeenCalledTimes(1)
    })

    it('only sets provided columns', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 }) // getAllowedModel
        .mockResolvedValueOnce({ rows: [{ ...ROW, display_name: 'Haiku' }], rowCount: 1 }) // UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
      await updateAllowedModel('id', { display_name: 'Haiku' }, 'admin-2', fakeDb(query))
      const [sql, params] = query.mock.calls[1]
      expect(String(sql)).toMatch(/display_name = \$1/)
      expect(String(sql)).toMatch(/updated_at = NOW\(\)/)
      expect(params).toEqual(['Haiku', 'id'])
    })

    it('invalidates evidence when the (provider, model) pair is renamed', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ...ROW, image_input: CURATED_SUPPORTED }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ ...ROW, model: 'glm-5.2', image_input: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      await updateAllowedModel('id', { model: 'glm-5.2' }, 'admin-2', fakeDb(query))
      const [sql, params] = query.mock.calls[1]
      // Old evidence belonged to the OLD model: it must not carry over.
      expect(String(sql)).toMatch(/image_input = NULL/)
      expect(String(sql)).not.toMatch(/image_input = \$/)
      expect(params).toEqual(['glm-5.2', 'id'])
    })

    it('keeps new evidence supplied in the same rename operation', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ...ROW, image_input: CURATED_SUPPORTED }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      const fresh = {
        state: 'unsupported',
        evidence: {
          source: 'curated',
          reference: 'https://docs.z.ai/guides/llm/glm-5.3',
          checkedAt: '2026-09-16T00:00:00.000Z',
        },
      }
      await updateAllowedModel(
        'id',
        updateLlmAllowedModelSchema.parse({ model: 'glm-5.3', image_input: fresh }),
        'admin-2',
        fakeDb(query)
      )
      const [sql, params] = query.mock.calls[1]
      expect(String(sql)).toMatch(/image_input = \$2/)
      expect(String(sql)).not.toMatch(/image_input = NULL/)
      expect(params).toEqual(['glm-5.3', JSON.stringify(fresh), 'id'])
    })

    it('clears evidence on an explicit null and never touches it on unrelated edits', async () => {
      const clear = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ...ROW, image_input: CURATED_SUPPORTED }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ ...ROW, image_input: null }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      await updateAllowedModel(
        'id',
        updateLlmAllowedModelSchema.parse({ image_input: null }),
        'admin-2',
        fakeDb(clear)
      )
      expect(clear.mock.calls[1][1]).toEqual([null, 'id'])
      expect(String(clear.mock.calls[1][0])).toMatch(/image_input = \$1/)

      const unrelated = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ...ROW, image_input: CURATED_SUPPORTED }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ ...ROW, enabled: false }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      await updateAllowedModel('id', { enabled: false }, 'admin-2', fakeDb(unrelated))
      // Enabling/disabling is not a capability edit: evidence is frozen, so a
      // published row keeps the exact metadata the ConfigMap already carries.
      const setClause = String(unrelated.mock.calls[1][0]).split('WHERE')[0]
      expect(setClause).not.toMatch(/image_input/)
    })
  })

  describe('deleteAllowedModel', () => {
    it('records a delete audit row after a successful delete', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 }) // getAllowedModel
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // DELETE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
      const ok = await deleteAllowedModel('id', 'admin-3', fakeDb(query))
      expect(ok).toBe(true)
      const auditCall = query.mock.calls.find(c =>
        /INSERT INTO llm_allowed_models_audit/.test(String(c[0]))
      )
      expect(auditCall![1][1]).toBe('delete')
    })

    it('returns false and writes no audit when the row is missing', async () => {
      const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 })
      const ok = await deleteAllowedModel('id', 'admin-3', fakeDb(query))
      expect(ok).toBe(false)
      expect(query).toHaveBeenCalledTimes(1)
    })
  })

  describe('isModelAllowed', () => {
    it('is true only when an enabled row exists', async () => {
      const yes = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 })
      expect(await isModelAllowed('claude', 'claude-haiku-4-5', fakeDb(yes))).toBe(true)
      const [sql] = yes.mock.calls[0]
      expect(String(sql)).toMatch(/enabled/)
      const no = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
      expect(await isModelAllowed('claude', 'nope', fakeDb(no))).toBe(false)
    })
  })

  describe('listEnabledModelNamesForProvider', () => {
    it('returns the enabled model names', async () => {
      const query = vi
        .fn()
        .mockResolvedValue({ rows: [{ model: 'glm-4.7' }, { model: 'glm-5' }], rowCount: 2 })
      expect(await listEnabledModelNamesForProvider('zai', fakeDb(query))).toEqual([
        'glm-4.7',
        'glm-5',
      ])
    })
  })

  describe('getModelAllowlistState (Fase 6)', () => {
    it('returns {enabled, stale} for an existing row (enabled+stale)', async () => {
      const query = vi
        .fn()
        .mockResolvedValue({ rows: [{ enabled: true, stale: true }], rowCount: 1 })
      expect(await getModelAllowlistState('claude', 'M', fakeDb(query))).toEqual({
        enabled: true,
        stale: true,
      })
      // The gate MUST NOT filter on `enabled` here — it needs the state of both an
      // enabled AND a disabled row so Fase 2 (disabled) and Fase 6 (stale) can be
      // told apart. It also reads `stale`.
      const [sql] = query.mock.calls[0]
      expect(String(sql)).toMatch(/stale/)
      expect(String(sql)).not.toMatch(/AND enabled\b/)
    })

    it('returns null when no row exists (unknown pair)', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
      expect(await getModelAllowlistState('claude', 'nope', fakeDb(query))).toBeNull()
    })

    it('coerces a disabled non-stale row correctly', async () => {
      const query = vi
        .fn()
        .mockResolvedValue({ rows: [{ enabled: false, stale: false }], rowCount: 1 })
      expect(await getModelAllowlistState('claude', 'D', fakeDb(query))).toEqual({
        enabled: false,
        stale: false,
      })
    })
  })

  describe('listEnabledModelsWithStaleForProvider (Fase 6)', () => {
    it('returns enabled models with their stale flag', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          { model: 'glm-4.7', stale: false },
          { model: 'glm-legacy', stale: true },
        ],
        rowCount: 2,
      })
      expect(await listEnabledModelsWithStaleForProvider('zai', fakeDb(query))).toEqual([
        { model: 'glm-4.7', stale: false },
        { model: 'glm-legacy', stale: true },
      ])
      // Same enabled-only filter as the name variant — a stale model is still
      // enabled and must still appear (quarantine warns, it does not de-list).
      const [sql] = query.mock.calls[0]
      expect(String(sql)).toMatch(/WHERE provider = \$1 AND enabled/)
    })
  })

  describe('listAllowedModels (catalog lifecycle, F1)', () => {
    it('selects and maps the four catalog lifecycle columns', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            ...ROW,
            source: 'discovery',
            discovered_at: new Date('2026-07-10T00:00:00Z'),
            last_seen_at: new Date('2026-07-11T00:00:00Z'),
            stale: true,
          },
        ],
        rowCount: 1,
      })
      const [row] = await listAllowedModels(fakeDb(query))
      // The reader SELECTs the new columns (admin table surface).
      const [sql] = query.mock.calls[0]
      expect(String(sql)).toMatch(/source/)
      expect(String(sql)).toMatch(/discovered_at/)
      expect(String(sql)).toMatch(/last_seen_at/)
      expect(String(sql)).toMatch(/stale/)
      expect(row).toMatchObject({
        source: 'discovery',
        discovered_at: '2026-07-10T00:00:00.000Z',
        last_seen_at: '2026-07-11T00:00:00.000Z',
        stale: true,
      })
    })

    it('defaults a legacy/NULL source row to manual with null timestamps', async () => {
      // Existing rows (pre-migration reads / DEFAULT backfill) present as manual.
      const query = vi.fn().mockResolvedValue({ rows: [ROW], rowCount: 1 })
      const [row] = await listAllowedModels(fakeDb(query))
      expect(row.source).toBe('manual')
      expect(row.discovered_at).toBeNull()
      expect(row.last_seen_at).toBeNull()
      expect(row.stale).toBe(false)
    })

    it('normalizes legacy/malformed capability metadata to unknown and echoes curated evidence', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          { ...ROW, image_input: null },
          { ...ROW, id: '2', image_input: { state: 'bogus' } },
          { ...ROW, id: '3', image_input: CURATED_SUPPORTED },
          {
            ...ROW,
            id: '4',
            image_input: {
              state: 'supported',
              evidence: {
                ...CURATED_SUPPORTED.evidence,
                reference: 'https://catalog.internal./docs',
              },
            },
          },
        ],
        rowCount: 4,
      })
      const rows = await listAllowedModels(fakeDb(query))
      expect(String(query.mock.calls[0][0])).toMatch(/image_input/)
      expect(rows[0].image_input).toEqual({ state: 'unknown' })
      expect(rows[1].image_input).toEqual({ state: 'unknown' })
      expect(rows[2].image_input).toEqual(CURATED_SUPPORTED)
      expect(rows[3].image_input).toEqual({ state: 'unknown' })
    })
  })

  describe('listEnabledGroupedByProvider', () => {
    it('groups rows and omits null optional fields', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            provider: 'claude',
            model: 'claude-haiku-4-5',
            vendor: 'Anthropic',
            display_name: null,
            context_window_tokens: 200000,
          },
          {
            provider: 'zai',
            model: 'glm-4.7',
            vendor: 'Zhipu',
            display_name: 'GLM 4.7',
            context_window_tokens: null,
          },
        ],
        rowCount: 2,
      })
      const grouped = await listEnabledGroupedByProvider(fakeDb(query))
      expect(grouped.claude).toEqual([
        { model: 'claude-haiku-4-5', contextWindowTokens: 200000, vendor: 'Anthropic' },
      ])
      expect(grouped.zai).toEqual([{ model: 'glm-4.7', displayName: 'GLM 4.7', vendor: 'Zhipu' }])
    })

    it('materializes an enabled row even when it is stale (R3.7: stale never de-serves)', async () => {
      // R3.7: enabled non-Codex rows still reach the ConfigMap even if discovery
      // flagged them stale. Codex subscription is the documented exception:
      // a stale row must not be served because the broker catalog is the only
      // live model source.
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            provider: 'openai',
            model: 'gpt-legacy',
            vendor: null,
            display_name: null,
            context_window_tokens: null,
          },
        ],
        rowCount: 1,
      })
      const grouped = await listEnabledGroupedByProvider(fakeDb(query))
      const [sql] = query.mock.calls[0]
      expect(String(sql)).toMatch(/WHERE enabled/)
      expect(String(sql)).toContain("NOT (provider = 'codex-subscription' AND stale)")
      expect(String(sql)).not.toMatch(/AND NOT stale\b/)
      expect(grouped.openai).toEqual([{ model: 'gpt-legacy' }])
    })

    it('projects stored capability metadata and omits it when absent (#654)', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            provider: 'zai',
            model: 'glm-5.3-flash',
            vendor: 'Zhipu',
            display_name: null,
            context_window_tokens: null,
            image_input: CURATED_SUPPORTED,
          },
          {
            provider: 'zai',
            model: 'glm-5.3',
            vendor: 'Zhipu',
            display_name: null,
            context_window_tokens: null,
            image_input: null,
          },
          {
            provider: 'zai',
            model: 'glm-legacy',
            vendor: null,
            display_name: null,
            context_window_tokens: null,
          },
        ],
        rowCount: 3,
      })
      const grouped = await listEnabledGroupedByProvider(fakeDb(query))
      expect(String(query.mock.calls[0][0])).toMatch(/image_input/)
      expect(grouped.zai[0]).toEqual({
        model: 'glm-5.3-flash',
        vendor: 'Zhipu',
        imageInput: CURATED_SUPPORTED,
      })
      // Absent metadata stays absent: consumers normalize it to `unknown`, and
      // the serialized entry keeps the pre-#654 shape for uncurated rows.
      expect(grouped.zai[1]).toEqual({ model: 'glm-5.3', vendor: 'Zhipu' })
      expect(grouped.zai[2]).toEqual({ model: 'glm-legacy' })
    })
  })
})
