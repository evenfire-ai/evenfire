import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { listGrokModels } from '../src/grokTransport.js'

const lookup = async () => [{ address: '1.2.3.4', family: 4 }]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A recorded upstream catalog row, sanitized (see its `_provenance`). */
const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/grokModelsCatalog.sanitized.json', import.meta.url), 'utf-8')
) as { data: Array<{ id: string; context_window: number }> }

describe('Grok catalog context window (#731 R3-4)', () => {
  it('T-R3-4a-grok keeps the recorded context_window as contextWindowTokens', async () => {
    const listed = await listGrokModels({
      accessToken: 'tok',
      fetchFn: (async () => jsonResponse(recorded)) as typeof fetch,
      lookup,
    })
    expect(listed.outcome).toBe('ready')
    expect(listed.models.map(row => [row.model, row.contextWindowTokens])).toEqual([
      ['grok-4.6', 500_000],
    ])
  })

  it('T-R3-4b-grok omits a window that is not a positive integer within the stored column', async () => {
    // control-api stores the window in a Postgres INTEGER column; a larger
    // value would fail the whole catalog sync, not just this row.
    const invalid = [0, -1, 1.5, '500000', null, 2_147_483_648]
    const listed = await listGrokModels({
      accessToken: 'tok',
      fetchFn: (async () =>
        jsonResponse({
          data: [
            ...invalid.map((contextWindow, index) => ({
              id: `model-${index}`,
              context_window: contextWindow,
            })),
            { id: 'model-max', context_window: 2_147_483_647 },
          ],
        })) as typeof fetch,
      lookup,
    })
    // Witness: every row was listed, so the omission is per field, not per row.
    expect(listed.models).toHaveLength(invalid.length + 1)
    expect(listed.models.filter(row => 'contextWindowTokens' in row)).toEqual([
      { model: 'model-max', contextWindowTokens: 2_147_483_647 },
    ])
  })
})
