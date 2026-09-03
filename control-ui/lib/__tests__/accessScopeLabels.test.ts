import { describe, expect, it } from 'vitest'
import { accessScopeLabeler } from '../accessScopeLabels'

describe('accessScopeLabeler Context aliases', () => {
  const contexts = [
    {
      metadata: { name: 'ctx-resource' },
      spec: {
        contextId: 'ctx-wire',
        displayName: 'Stored scope name',
        mcpServers: [],
      },
    },
  ]
  const hosts = [
    {
      metadata: { name: 'agent-alpha' },
      spec: { contextRef: 'ctx-wire', host: 'Agent Alpha' },
    },
  ]

  it.each(['ctx-resource', 'ctx-wire'])('labels the %s alias with its owning Agent', alias => {
    expect(accessScopeLabeler(contexts, hosts)(alias)).toEqual({
      label: 'Agent Alpha',
      resolved: true,
    })
  })
})
