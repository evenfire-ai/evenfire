import { describe, expect, it } from 'vitest'
import { buildContextUpdatePayload, contextMutationError } from '../contextMutation'

const spec = {
  contextId: 'research',
  description: 'Research tools',
  mcpServers: ['search'],
  sharedFileSystems: [],
}

describe('Context optimistic concurrency payloads', () => {
  it('carries the resourceVersion from the read into the complete replacement', () => {
    expect(buildContextUpdatePayload('rv-read', spec)).toEqual({
      metadata: { resourceVersion: 'rv-read' },
      spec,
    })
  })

  it('fails closed when a read has no resourceVersion', () => {
    expect(() => buildContextUpdatePayload(undefined, spec)).toThrow(/version is unavailable/i)
  })

  it('surfaces a stale-writer conflict instead of reporting a successful mutation', () => {
    const staleWrite = Object.assign(new Error('409 conflict'), { status: 409 })
    expect(contextMutationError(staleWrite, 'Failed to update connectors')).toMatch(
      /changed since it was loaded/i
    )
  })
})
