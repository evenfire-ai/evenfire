import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from '../../../../src/authClient'
import { config } from '../../../../src/config'
import { wrapLikeElectronIpc } from '../../hooks/domain/__tests__/__fixtures__/ipcErrors'
import {
  type AgentCatalogAvailabilityInput,
  resolveAgentCatalogAvailability,
} from '../agentCatalogAvailability'
import { httpErrorStatus, isNetworkError } from '../format'

const selectedAgent = 'agent-x'
const positiveCatalog = {
  selectedAgent,
  loading: false,
  error: null,
  catalogMatchesSession: true,
  agentNames: [selectedAgent, 'agent-y'],
} as const

function resolveWith(error: Error, catalog: AgentCatalogAvailabilityInput = positiveCatalog) {
  return resolveAgentCatalogAvailability({ ...catalog, error: error.message })
}

async function catalogProducerError(
  installFetch: () => typeof fetch,
  timeoutMs?: number
): Promise<Error> {
  const originalFetch = globalThis.fetch
  const originalTimeoutMs = config.requestTimeoutMs
  globalThis.fetch = installFetch()
  if (timeoutMs !== undefined) config.requestTimeoutMs = timeoutMs
  try {
    await new AuthClient().getTeamAgents('catalog-producer-diagnostic')
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`Unexpected producer error: ${String(error)}`)
    return wrapLikeElectronIpc('access:refreshCatalog', error)
  } finally {
    globalThis.fetch = originalFetch
    config.requestTimeoutMs = originalTimeoutMs
  }
  throw new Error('The real AuthClient catalog producer resolved when a rejection was expected')
}

function responseFetch(status: number, body: string, statusText: string): typeof fetch {
  return vi.fn(async () => new Response(body, { status, statusText })) as typeof fetch
}

function fetchFailure(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
}

function timeoutFetch(): typeof fetch {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('requestJson did not pass its timeout signal to fetch'))
          return
        }
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  ) as typeof fetch
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('agent catalog producer error classification', () => {
  it('blocks a parsed HTTP 429 whose real ApiError echoes network wording through IPC', async () => {
    const error = await catalogProducerError(() =>
      responseFetch(
        429,
        JSON.stringify({ message: 'network throttled; retry later' }),
        'Too Many Requests'
      )
    )

    expect(httpErrorStatus(error)).toBe(429)
    expect(isNetworkError(error)).toBe(true)
    expect(resolveWith(error)).toBe('error')
  })

  it.each(['network', 'timeout', 'gateway'])(
    'blocks a malformed HTTP 200 body whose real SyntaxError echoes %s',
    async wording => {
      const error = await catalogProducerError(() =>
        responseFetch(200, `${wording} response text that is not JSON`, 'OK')
      )

      expect(error.message).toContain('Error invoking remote method')
      expect(httpErrorStatus(error)).toBeUndefined()
      expect(isNetworkError(error)).toBe(true)
      expect(resolveWith(error)).toBe('error')
    }
  )

  it.each(['network (500)', 'network HTTP 500'])(
    'does not treat malformed HTTP 200 parser echo %s as an HTTP response status',
    async body => {
      const error = await catalogProducerError(() => responseFetch(200, body, 'OK'))

      expect(error.message).toContain('SyntaxError:')
      expect(httpErrorStatus(error)).toBe(500)
      expect(resolveWith(error)).toBe('error')
    }
  )

  it('keeps a real fetch failure transient with a confirmed same-scope catalog', async () => {
    const error = await catalogProducerError(() => fetchFailure())

    expect(error.message).toBe(
      "Error invoking remote method 'access:refreshCatalog': TypeError: fetch failed"
    )
    expect(httpErrorStatus(error)).toBeUndefined()
    expect(isNetworkError(error)).toBe(true)
    expect(resolveWith(error)).toBe('available')
  })

  it('keeps requestJson timeout aborts transient with a confirmed same-scope catalog', async () => {
    const error = await catalogProducerError(() => timeoutFetch(), 5)

    expect(error.message).toBe(
      "Error invoking remote method 'access:refreshCatalog': TimeoutError: The operation was aborted due to timeout"
    )
    expect(httpErrorStatus(error)).toBeUndefined()
    expect(isNetworkError(error)).toBe(true)
    expect(resolveWith(error)).toBe('available')
  })

  it('keeps parsed HTTP 500 available even when its message is not network-like', async () => {
    const error = await catalogProducerError(() =>
      responseFetch(500, JSON.stringify({ message: 'catalog service failed' }), 'Server Error')
    )

    expect(error.message).toMatch(
      /^Error invoking remote method 'access:refreshCatalog': Error: 500 Server Error:/
    )
    expect(httpErrorStatus(error)).toBe(500)
    expect(isNetworkError(error)).toBe(false)
    expect(resolveWith(error)).toBe('available')
  })

  it.each([401, 403])(
    'keeps parsed HTTP %i blocked despite transport-like body wording',
    async status => {
      const statusText = status === 401 ? 'Unauthorized' : 'Forbidden'
      const error = await catalogProducerError(() =>
        responseFetch(status, JSON.stringify({ message: 'network timeout gateway' }), statusText)
      )

      expect(httpErrorStatus(error)).toBe(status)
      expect(isNetworkError(error)).toBe(true)
      expect(resolveWith(error)).toBe('error')
    }
  )

  it('does not allow transport errors to reuse wrong-scope or missing/reset catalog state', async () => {
    const error = await catalogProducerError(() => fetchFailure())
    const wrongScope = { ...positiveCatalog, catalogMatchesSession: false }
    const resetCache = { ...positiveCatalog, catalogMatchesSession: false, agentNames: [] }

    expect(resolveWith(error, wrongScope)).toBe('error')
    expect(resolveWith(error, resetCache)).toBe('error')
    expect(
      resolveAgentCatalogAvailability({
        ...positiveCatalog,
        loading: false,
        error: null,
        catalogMatchesSession: true,
        agentNames: ['agent-y'],
      })
    ).toBe('unavailable')
  })
})
