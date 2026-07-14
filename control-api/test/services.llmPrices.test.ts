import { describe, expect, it, vi } from 'vitest'
import {
  LlmPriceConflictError,
  createLlmPrice,
  createLlmPriceSchema,
  listUnpricedModels,
  updateLlmPrice,
} from '../src/services/llmPrices.js'

function fakeDb(query: ReturnType<typeof vi.fn>) {
  return { query } as unknown as Parameters<typeof createLlmPrice>[1]
}

const ROW = {
  id: 'a',
  provider: 'openai',
  model: 'gpt-4o',
  input_token_price: '2.5',
  output_token_price: '10',
  cache_read_token_price: '1.25',
  cache_write_token_price: '0',
  currency: 'USD',
  effective_from: new Date('2026-06-01T00:00:00Z'),
  enabled: true,
  created_at: new Date('2026-06-01T00:00:00Z'),
  updated_at: new Date('2026-06-01T00:00:00Z'),
}

describe('llmPrices service', () => {
  describe('createLlmPriceSchema', () => {
    it('rejects a negative price', () => {
      const res = createLlmPriceSchema.safeParse({
        provider: 'openai',
        model: 'gpt-4o',
        input_token_price: -0.01,
        output_token_price: 1,
      })
      expect(res.success).toBe(false)
    })

    it('defaults cache prices, currency and enabled', () => {
      const res = createLlmPriceSchema.safeParse({
        provider: 'openai',
        model: 'gpt-4o',
        input_token_price: 1,
        output_token_price: 2,
      })
      expect(res.success).toBe(true)
      if (res.success) {
        expect(res.data).toMatchObject({
          cache_read_token_price: 0,
          cache_write_token_price: 0,
          currency: 'USD',
          enabled: true,
        })
      }
    })
  })

  describe('createLlmPrice', () => {
    it('coerces NUMERIC strings to numbers', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [ROW], rowCount: 1 })
      const price = await createLlmPrice(
        createLlmPriceSchema.parse({
          provider: 'openai',
          model: 'gpt-4o',
          input_token_price: 2.5,
          output_token_price: 10,
          cache_read_token_price: 1.25,
        }),
        fakeDb(query)
      )
      expect(price.input_token_price).toBe(2.5)
      expect(price.cache_read_token_price).toBe(1.25)
    })

    it('maps a pg unique violation (23505) to LlmPriceConflictError', async () => {
      const query = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }))
      await expect(
        createLlmPrice(
          createLlmPriceSchema.parse({
            provider: 'openai',
            model: 'gpt-4o',
            input_token_price: 1,
            output_token_price: 2,
          }),
          fakeDb(query)
        )
      ).rejects.toBeInstanceOf(LlmPriceConflictError)
    })

    it('rethrows non-unique db errors untouched', async () => {
      const query = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: '08006' }))
      await expect(
        createLlmPrice(
          createLlmPriceSchema.parse({
            provider: 'openai',
            model: 'gpt-4o',
            input_token_price: 1,
            output_token_price: 2,
          }),
          fakeDb(query)
        )
      ).rejects.toThrow('boom')
    })
  })

  describe('updateLlmPrice', () => {
    it('only sets provided columns and maps unique violations to a conflict', async () => {
      const query = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }))
      await expect(
        updateLlmPrice('a', { provider: 'openai', model: 'gpt-4o' }, fakeDb(query))
      ).rejects.toBeInstanceOf(LlmPriceConflictError)
      const [sql, params] = query.mock.calls[0]
      expect(String(sql)).toMatch(/provider = \$1/)
      expect(String(sql)).toMatch(/model = \$2/)
      expect(params).toEqual(['openai', 'gpt-4o', 'a'])
    })
  })

  describe('listUnpricedModels', () => {
    it('anti-joins usage rollups against enabled prices and maps rows', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          { provider: 'zai', model: 'glm-4.5' },
          { provider: 'bailian', model: 'qwen-max' },
        ],
        rowCount: 2,
      })
      const rows = await listUnpricedModels(fakeDb(query))
      expect(rows).toEqual([
        { provider: 'zai', model: 'glm-4.5' },
        { provider: 'bailian', model: 'qwen-max' },
      ])
      const [sql] = query.mock.calls[0]
      expect(String(sql)).toMatch(/NOT EXISTS/)
      expect(String(sql)).toMatch(/p\.enabled/)
    })
  })
})
