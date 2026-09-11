import { describe, expect, it } from 'vitest'
import { getAgentDisplayName } from '../agentName'

const directory = [
  { metadata: { name: 'prod-x' }, spec: { host: 'Prod X' } },
  { metadata: { name: 'sales-agent' }, spec: { host: 'Sales Agent' } },
  { metadata: { name: 'no-display' }, spec: {} },
]

describe('getAgentDisplayName', () => {
  it('returns the directory display name (spec.host) when a match exists', () => {
    expect(getAgentDisplayName('prod-x', directory)).toBe('Prod X')
    expect(getAgentDisplayName('sales-agent', directory)).toBe('Sales Agent')
  })

  it('falls back to the slug when the directory entry has no display name', () => {
    expect(getAgentDisplayName('no-display', directory)).toBe('no-display')
  })

  it('falls back to the slug when there is no directory or no match', () => {
    expect(getAgentDisplayName('unknown-agent', directory)).toBe('unknown-agent')
    expect(getAgentDisplayName('mcp-host/prod-x')).toBe('prod-x')
    expect(getAgentDisplayName('')).toBe('')
  })
})
