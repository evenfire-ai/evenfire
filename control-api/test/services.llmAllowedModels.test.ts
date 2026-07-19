import { describe, expect, it, vi } from 'vitest'
import {
  LlmAllowedModelConflictError,
  createAllowedModel,
  createLlmAllowedModelSchema,
  deleteAllowedModel,
  isModelAllowed,
  listAllowedModels,
  listEnabledGroupedByProvider,
  listEnabledModelNamesForProvider,
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
      // The materializer query filters `WHERE enabled` and never references
      // `stale`, so an enabled model discovery flagged stale still reaches the CM.
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
      expect(String(sql)).not.toMatch(/stale/)
      expect(grouped.openai).toEqual([{ model: 'gpt-legacy' }])
    })
  })
})
