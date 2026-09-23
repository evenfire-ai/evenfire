import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CATALOG_LIMITS, listCodexModels } from '../src/codexTransport.js'

const lookup = async () => [{ address: '1.2.3.4', family: 4 }]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A recorded upstream catalog response, sanitized (see its `_provenance`). */
const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/codexModelsCatalog.sanitized.json', import.meta.url), 'utf-8')
) as { models: Array<{ slug: string; context_window: number; max_context_window: number }> }

describe('Codex catalog context window (#731 R3-4)', () => {
  it('T-R3-4a keeps the recorded context_window as contextWindowTokens', async () => {
    // The fixture must carry the case that tells the two fields apart.
    const sol = recorded.models.find(row => row.slug === 'gpt-5.6-sol')
    expect(sol?.max_context_window).toBeGreaterThan(sol!.context_window)

    const listed = await listCodexModels({
      accessToken: 'tok',
      fetchFn: (async () => jsonResponse(recorded)) as typeof fetch,
      lookup,
    })
    expect(listed.outcome).toBe('ready')
    expect(listed.models.map(row => [row.model, row.contextWindowTokens])).toEqual([
      ['gpt-5.6-sol', 272_000],
      ['gpt-5.5', 272_000],
    ])
  })

  it('T-R5-1 keeps the recorded display_name as displayName', async () => {
    const listed = await listCodexModels({
      accessToken: 'tok',
      fetchFn: (async () => jsonResponse(recorded)) as typeof fetch,
      lookup,
    })
    // Witness: both recorded rows were listed, so a missing name is a field gap.
    expect(listed.outcome).toBe('ready')
    expect(listed.models.map(row => [row.model, row.displayName])).toEqual([
      ['gpt-5.6-sol', 'GPT-5.6-Sol'],
      ['gpt-5.5', 'GPT-5.5'],
    ])
  })

  it('T-R3-4b omits a window that is not a positive integer within the stored column', async () => {
    // control-api stores the window in a Postgres INTEGER column; a larger
    // value would fail the whole catalog sync, not just this row.
    const invalid = [0, -1, 1.5, '272000', null, 2_147_483_648]
    const listed = await listCodexModels({
      accessToken: 'tok',
      fetchFn: (async () =>
        jsonResponse({
          models: [
            ...invalid.map((contextWindow, index) => ({
              slug: `model-${index}`,
              context_window: contextWindow,
            })),
            { slug: 'model-max', context_window: 2_147_483_647 },
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

describe('Codex catalog display name (#739 R9-8)', () => {
  async function list(rows: unknown[]) {
    return listCodexModels({
      accessToken: 'tok',
      fetchFn: (async () => jsonResponse({ models: rows })) as typeof fetch,
      lookup,
    })
  }

  it('T-R9-8b reads name after displayName, title and display_name', async () => {
    const listed = await list([
      { slug: 'a', displayName: 'Camel', title: 'Title', display_name: 'Snake', name: 'Name' },
      { slug: 'b', title: 'Title', display_name: 'Snake', name: 'Name' },
      { slug: 'c', display_name: 'Snake', name: 'Name' },
      { slug: 'd', name: 'Name' },
    ])
    expect(listed.models.map(row => [row.model, row.displayName])).toEqual([
      ['a', 'Camel'],
      ['b', 'Title'],
      ['c', 'Snake'],
      ['d', 'Name'],
    ])
  })

  it('T-R9-8c omits a display name over the bound instead of truncating it', async () => {
    expect(CATALOG_LIMITS.maxDisplayNameLength).toBe(256)
    const max = CATALOG_LIMITS.maxDisplayNameLength
    const listed = await list([
      { slug: 'at-bound', display_name: 'n'.repeat(max) },
      { slug: 'over-snake', display_name: 'n'.repeat(max + 1) },
      { slug: 'over-name', name: 'n'.repeat(max + 1) },
      { slug: 'over-camel', displayName: 'd'.repeat(max + 1), name: 'Short' },
    ])
    // Witness: every row was listed, so the omission is per field, not per row.
    expect(listed.models.map(row => row.model)).toEqual([
      'at-bound',
      'over-snake',
      'over-name',
      'over-camel',
    ])
    expect(listed.models.map(row => row.displayName)).toEqual([
      'n'.repeat(max),
      undefined,
      undefined,
      undefined,
    ])
  })
})
