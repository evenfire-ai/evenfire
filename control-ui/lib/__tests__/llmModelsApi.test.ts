import { afterEach, describe, expect, it, vi } from 'vitest'
import { attentionWireBody } from '../../test/fixtures/llmAttention'
import {
  ackAdminAttention,
  createLlmModel,
  deleteLlmModel,
  getAdminAttention,
  getLlmModel,
  getLlmModels,
  getModelInUseImpact,
  isAttentionEpisodeChanged,
  isLlmModelConfigMapDeferred,
  parseAdminAttentionReport,
  unackAdminAttention,
  updateLlmModel,
} from '../api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const SAMPLE = {
  id: '11111111-1111-1111-1111-111111111111',
  provider: 'claude',
  model: 'claude-haiku-4-5',
  vendor: 'Anthropic',
  display_name: 'Claude Haiku 4.5',
  context_window_tokens: 200000,
  enabled: true,
  created_at: '2026-07-09T00:00:00Z',
  updated_at: '2026-07-09T00:00:00Z',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('llm allowed-models api helpers', () => {
  it('getLlmModels GETs the admin list endpoint', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ rows: [SAMPLE] }))
    const res = await getLlmModels()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-models')
    expect(init.credentials).toBe('include')
    expect(res.rows[0].model).toBe('claude-haiku-4-5')
  })

  it('getLlmModel encodes the id in the path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE))
    await getLlmModel(SAMPLE.id)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/api/v1/admin/llm-models/${SAMPLE.id}`)
  })

  it('createLlmModel POSTs the body to the collection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE, 201))
    await createLlmModel({
      provider: 'claude',
      model: 'claude-haiku-4-5',
      vendor: 'Anthropic',
      display_name: 'Claude Haiku 4.5',
      context_window_tokens: 200000,
      enabled: true,
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/llm-models')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body)).model).toBe('claude-haiku-4-5')
  })

  it('updateLlmModel PUTs a partial body with null to clear a column', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE))
    await updateLlmModel(SAMPLE.id, { vendor: null, enabled: false })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/api/v1/admin/llm-models/${SAMPLE.id}`)
    expect(init.method).toBe('PUT')
    const parsed = JSON.parse(String(init.body))
    expect(parsed.vendor).toBeNull()
    expect(parsed.enabled).toBe(false)
  })

  it('deleteLlmModel accepts a 204 empty response', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteLlmModel(SAMPLE.id)).resolves.toBeUndefined()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('DELETE')
  })

  it('flags a 503 configmap_write_failed as a deferred (saved) write', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: 'configmap_write_failed', message: 'delayed' }, 503)
    )
    try {
      await createLlmModel({ provider: 'claude', model: 'claude-haiku-4-5' })
      expect.unreachable('createLlmModel should reject on 503')
    } catch (err) {
      expect(isLlmModelConfigMapDeferred(err)).toBe(true)
    }
  })

  it('does not flag a bodyless infra 503 (gateway, no JSON code) as deferred', async () => {
    // Without the configmap_write_failed code the row may never have been
    // saved — this must surface as a failure, not a "saved, delayed" toast.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 })
    )
    try {
      await createLlmModel({ provider: 'claude', model: 'claude-haiku-4-5' })
      expect.unreachable('createLlmModel should reject on 503')
    } catch (err) {
      expect(isLlmModelConfigMapDeferred(err)).toBe(false)
    }
  })

  it('does not flag an ordinary conflict as deferred', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: 'conflict', message: 'already exists' }, 409)
    )
    try {
      await createLlmModel({ provider: 'claude', model: 'claude-haiku-4-5' })
      expect.unreachable('createLlmModel should reject on 409')
    } catch (err) {
      expect(isLlmModelConfigMapDeferred(err)).toBe(false)
    }
  })
})

describe('disable/delete impact gate (?force)', () => {
  it('updateLlmModel appends ?force=true only when force is set', async () => {
    // Fresh Response per call — a single mocked body can only be read once.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(SAMPLE))

    await updateLlmModel(SAMPLE.id, { enabled: false }, { force: true })
    const [forcedUrl, forcedInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(forcedInit.method).toBe('PUT')
    expect(forcedUrl).toContain('force=true')

    await updateLlmModel(SAMPLE.id, { enabled: false })
    const [plainUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(plainUrl).not.toContain('force')
  })

  it('deleteLlmModel appends ?force=true only when force is set', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 204 }))

    await deleteLlmModel(SAMPLE.id, { force: true })
    const [forcedUrl, forcedInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(forcedInit.method).toBe('DELETE')
    expect(forcedUrl).toContain('force=true')

    await deleteLlmModel(SAMPLE.id)
    const [plainUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(plainUrl).not.toContain('force')
  })

  it('getModelInUseImpact extracts the impact from a 409 model_in_use', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          error: 'model_in_use',
          message: 'still referenced',
          impact: {
            provider: 'claude',
            model: 'claude-haiku-4-5',
            hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
            grantsAffected: [
              {
                id: 'g1',
                recipeNamespace: 'sandbox-recipes',
                recipeName: 'nightly-summary',
                capabilityFamily: 'promptBridge',
              },
            ],
          },
        },
        409
      )
    )
    try {
      await deleteLlmModel(SAMPLE.id)
      expect.unreachable('deleteLlmModel should reject on 409')
    } catch (err) {
      const impact = getModelInUseImpact(err)
      expect(impact).not.toBeNull()
      expect(impact?.hostsAffected).toEqual([
        { namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] },
      ])
      expect(impact?.grantsAffected[0].capabilityFamily).toBe('promptBridge')
    }
  })

  it('getModelInUseImpact returns null for an unrelated 409', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: 'conflict', message: 'already exists' }, 409)
    )
    try {
      await deleteLlmModel(SAMPLE.id)
      expect.unreachable('deleteLlmModel should reject on 409')
    } catch (err) {
      expect(getModelInUseImpact(err)).toBeNull()
    }
  })

  it('getModelInUseImpact returns null when the impact carries no references', async () => {
    // A model_in_use 409 whose impact resolves to zero Host/grant references
    // must fall through to the generic error banner, not open a "still in use"
    // confirm with an empty reference list (parity with the sibling helpers).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          error: 'model_in_use',
          message: 'still referenced',
          impact: {
            provider: 'claude',
            model: 'claude-haiku-4-5',
            hostsAffected: [],
            grantsAffected: [],
          },
        },
        409
      )
    )
    try {
      await deleteLlmModel(SAMPLE.id)
      expect.unreachable('deleteLlmModel should reject on 409')
    } catch (err) {
      expect(getModelInUseImpact(err)).toBeNull()
    }
  })
})

describe('getAdminAttention', () => {
  it('GETs the feed and normalizes items, dropping an unknown kind', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        items: [
          {
            kind: 'stale_model_referenced',
            provider: 'claude',
            model: 'claude-haiku-4-5',
            displayName: 'Claude Haiku',
            hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
            grantsAffected: [],
          },
          // A kind the current UI does not know: dropped here, never thrown.
          { kind: 'future_kind', provider: 'openai', model: 'gpt-5' },
          // Malformed item (no model) is dropped rather than tumbling the feed.
          { kind: 'stale_model_referenced', provider: 'openai' },
        ],
        generatedAt: '2026-08-12T00:00:00.000Z',
      })
    )
    const report = await getAdminAttention()
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/attention')
    expect(report.items).toHaveLength(1)
    const [item] = report.items
    expect(item.kind).toBe('stale_model_referenced')
    expect(item.displayName).toBe('Claude Haiku')
    if (item.kind !== 'stale_model_referenced') throw new Error('unreachable')
    expect(item.hostsAffected[0].name).toBe('agent-a')
    expect(report.generatedAt).toBe('2026-08-12T00:00:00.000Z')
  })

  it('parses every kind of the producer-generated body', async () => {
    const wire = attentionWireBody()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(wire))
    const report = await getAdminAttention()
    expect(report.items.map(item => item.kind)).toEqual(wire.items.map(item => item.kind))
    for (const [index, item] of report.items.entries()) {
      const raw = wire.items[index]
      expect(item.provider).toBe(raw.provider)
      expect(item.model).toBe(raw.model)
      expect(item.displayName).toBe(raw.displayName)
      // Both kinds carry their references and the acknowledgement handles.
      if (item.kind === 'stale_discovery_enabled') throw new Error('not emitted by the producer')
      expect(item.hostsAffected).toEqual(raw.hostsAffected)
      expect(item.grantsAffected).toEqual(raw.grantsAffected)
      expect(item.recipesAffected).toEqual(raw.recipesAffected ?? [])
      expect(item.episode).toBe(raw.episode)
      expect(item.consumerKeys).toEqual(raw.consumerKeys)
      expect(item.acknowledged).toBe(false)
    }
    // The all-models Host role survives parsing.
    expect(
      report.items.some(
        item =>
          'hostsAffected' in item &&
          item.hostsAffected.some(host => host.roles.includes('implicit'))
      )
    ).toBe(true)
  })

  it('returns an empty feed when items is missing/empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ generatedAt: 'x' }))
    const report = await getAdminAttention()
    expect(report.items).toEqual([])
  })
})

describe('LLM model auto_disabled_at', () => {
  it('passes the timestamp through and reads an older control-api without it as null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        rows: [
          { ...SAMPLE, auto_disabled_at: '2026-11-01T00:00:00.000Z' },
          { ...SAMPLE, id: 'legacy' },
        ],
      })
    )
    const { rows } = await getLlmModels()
    expect(rows[0].auto_disabled_at).toBe('2026-11-01T00:00:00.000Z')
    expect(rows[1].auto_disabled_at).toBeNull()
  })

  it('sends pinEnabled with enabled on the PUT', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE))
    await updateLlmModel(SAMPLE.id, { enabled: false, pinEnabled: true })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false, pinEnabled: true })
  })
})

describe('attention acknowledgement api helpers', () => {
  it('asks for the acknowledged items and bypasses the in-flight read dedup with a signal', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse(attentionWireBody()))
    // Two reads in flight at once: with a signal each one reaches the network,
    // so a read issued after a mutation cannot reuse one issued before it.
    await Promise.all([
      getAdminAttention({ includeAcknowledged: true, signal: new AbortController().signal }),
      getAdminAttention({ includeAcknowledged: true, signal: new AbortController().signal }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/attention?includeAcknowledged=1')
  })

  it('reads acknowledged: true from an acknowledged item', () => {
    const body = attentionWireBody()
    body.items[0] = { ...body.items[0], acknowledged: true }
    const report = parseAdminAttentionReport(body)
    expect(report.items.map(item => 'acknowledged' in item && item.acknowledged)).toEqual([
      true,
      false,
      false,
    ])
  })

  it('POSTs the ack with the episode and consumer keys the feed returned', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }))
    const [item] = parseAdminAttentionReport(attentionWireBody()).items
    if (item.kind === 'stale_discovery_enabled' || item.episode === null) throw new Error('fixture')
    await ackAdminAttention({ ...item, episode: item.episode })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/attention/ack')
    expect(init.method).toBe('POST')
    const raw = attentionWireBody().items[0]
    expect(JSON.parse(String(init.body))).toEqual({
      provider: raw.provider,
      model: raw.model,
      kind: raw.kind,
      episode: raw.episode,
      consumerKeys: raw.consumerKeys,
    })
  })

  it('DELETEs the ack by provider, model and kind', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))
    await unackAdminAttention({ provider: 'claude', model: 'm', kind: 'deprecated_model_enabled' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/attention/ack')
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(String(init.body))).toEqual({
      provider: 'claude',
      model: 'm',
      kind: 'deprecated_model_enabled',
    })
  })

  it('recognizes the 409 attention_episode_changed and nothing else', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ error: 'attention_episode_changed', message: 'reload the feed' }, 409)
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'model_in_use', message: 'x' }, 409))
    const [item] = parseAdminAttentionReport(attentionWireBody()).items
    if (item.kind === 'stale_discovery_enabled' || item.episode === null) throw new Error('fixture')
    const changed = await ackAdminAttention({ ...item, episode: item.episode }).catch(e => e)
    const other = await ackAdminAttention({ ...item, episode: item.episode }).catch(e => e)
    expect(isAttentionEpisodeChanged(changed)).toBe(true)
    expect(isAttentionEpisodeChanged(other)).toBe(false)
  })
})
