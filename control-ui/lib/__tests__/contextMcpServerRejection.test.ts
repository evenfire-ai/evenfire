import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TOO_MANY_MCP_SERVERS_BODY,
  contextRejectionResponse,
  okJsonResponse,
  unknownMcpServerBody,
} from '../../test/fixtures/contextMcpServerRejection'
import type { ContextResource } from '../api'
import { updateContext } from '../api'
import {
  addConnectorToAgentContexts,
  connectorAccessMutationError,
} from '../connectorAccessManagement'
import {
  contextMcpServerRejection,
  contextMutationError,
  unknownMcpServerNames,
} from '../contextMutation'
import { createPrivateContext } from '../privateContext'

// Errors come from the real fetch client parsing the producer's body, never from
// hand-built error objects.
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function contextWriteError(body: unknown): Promise<unknown> {
  fetchMock.mockResolvedValueOnce(contextRejectionResponse(body))
  return updateContext('agent-ctx', {
    metadata: { resourceVersion: '7' },
    spec: { contextId: 'agent-ctx', mcpServers: ['gone'] },
  }).then(
    () => {
      throw new Error('expected the write to fail')
    },
    (error: unknown) => error
  )
}

function context(name: string, mcpServers: string[] = []): ContextResource {
  return {
    metadata: { name, namespace: 'default', resourceVersion: `rv-${name}` },
    spec: { contextId: name, mcpServers },
  } as ContextResource
}

describe('context writes refused for the connectors they add', () => {
  it('names the vanished connector and asks for a reload', async () => {
    const error = await contextWriteError(unknownMcpServerBody(['mcp-linear-u-1']))
    expect(unknownMcpServerNames(error)).toEqual(['mcp-linear-u-1'])
    expect(contextMutationError(error, 'fallback')).toBe(
      'The connector mcp-linear-u-1 no longer exists; reload the page and try again.'
    )
    expect(connectorAccessMutationError(error, 'fallback')).toBe(
      'The connector mcp-linear-u-1 no longer exists; reload the page and try again.'
    )
  })

  it('lists every vanished connector', async () => {
    const error = await contextWriteError(unknownMcpServerBody(['a', 'b']))
    expect(contextMcpServerRejection(error)).toBe(
      'The connectors a, b no longer exist; reload the page and try again.'
    )
  })

  it('gives the per-write cap its own message', async () => {
    const error = await contextWriteError(TOO_MANY_MCP_SERVERS_BODY)
    expect(unknownMcpServerNames(error)).toBeNull()
    expect(contextMutationError(error, 'fallback')).toBe(
      'A single change can add at most 256 connectors; add fewer at once and try again.'
    )
  })

  it('leaves other errors to the existing mapping', async () => {
    fetchMock.mockResolvedValueOnce(
      contextRejectionResponse({ error: 'invalid_context', message: 'bad spec' })
    )
    const error = await updateContext('agent-ctx', {
      metadata: { resourceVersion: '7' },
      spec: { contextId: 'agent-ctx', mcpServers: [] },
    }).catch((caught: unknown) => caught)
    expect(contextMcpServerRejection(error)).toBeNull()
    expect(contextMutationError(error, 'fallback')).toBe((error as Error).message)
  })

  it('maps the refusal of a private context create the same way', async () => {
    fetchMock.mockResolvedValueOnce(contextRejectionResponse(unknownMcpServerBody(['gone'])))
    const error = await createPrivateContext(
      { subject: 'helper', description: 'Connectors', mcpServers: ['gone'] },
      'setup failed'
    ).catch((caught: unknown) => caught)
    expect(contextMcpServerRejection(error)).toBe(
      'The connector gone no longer exists; reload the page and try again.'
    )
  })
})

describe('addConnectorToAgentContexts', () => {
  it('reports a refusal only after every sibling write has settled', async () => {
    let releaseSlowWrite: (response: Response) => void = () => undefined
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/contexts/ctx-slow')) {
        return new Promise<Response>(resolve => {
          releaseSlowWrite = resolve
        })
      }
      return Promise.resolve(contextRejectionResponse(unknownMcpServerBody(['srv'])))
    })

    let settled = false
    const outcome = addConnectorToAgentContexts(
      { name: 'srv', namespace: 'mcp-server' },
      [
        { name: 'slow-agent', contextRef: 'ctx-slow' },
        { name: 'fast-agent', contextRef: 'ctx-fast' },
      ],
      [context('ctx-slow'), context('ctx-fast')]
    ).finally(() => {
      settled = true
    })
    outcome.catch(() => undefined)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    // The caller reloads on failure; reporting now would let that reload race the slow PUT.
    expect(settled).toBe(false)

    releaseSlowWrite(okJsonResponse(context('ctx-slow', ['srv'])))
    const error = await outcome.catch((caught: unknown) => caught)
    expect(unknownMcpServerNames(error)).toEqual(['srv'])
  })

  it('reports a vanished connector ahead of a sibling conflict', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/contexts/ctx-a')
          ? ({
              ok: false,
              status: 409,
              statusText: 'Conflict',
              headers: new Headers(),
              text: async () => JSON.stringify({ error: 'precondition_failed' }),
            } as unknown as Response)
          : contextRejectionResponse(unknownMcpServerBody(['srv']))
      )
    )
    const error = await addConnectorToAgentContexts(
      { name: 'srv', namespace: 'mcp-server' },
      [
        { name: 'a', contextRef: 'ctx-a' },
        { name: 'b', contextRef: 'ctx-b' },
      ],
      [context('ctx-a'), context('ctx-b')]
    ).catch((caught: unknown) => caught)
    expect(connectorAccessMutationError(error, 'fallback')).toBe(
      'The connector srv no longer exists; reload the page and try again.'
    )
  })
})
