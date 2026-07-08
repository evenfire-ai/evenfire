import { describe, expect, it, vi } from 'vitest'
import { McpServerWatcher } from '../src/k8sClient'
import type { CommunicationChannelCRD } from '../src/types'

vi.mock('../src/config', () => ({
  config: { devMode: true },
}))

function cc(name: string, host: string, secretRef?: string): CommunicationChannelCRD {
  return {
    name,
    namespace: 'channels',
    spec: {
      hostRef: host,
      ...(secretRef ? { credentialsSecretRef: { name: secretRef } } : {}),
    },
  }
}

describe('McpServerWatcher CC lookups', () => {
  it('findCommunicationChannelsByCredentialsSecretName returns all CCs that reference it', () => {
    const watcher = Object.create(McpServerWatcher.prototype) as McpServerWatcher
    ;(
      watcher as unknown as { communicationChannels: Map<string, CommunicationChannelCRD> }
    ).communicationChannels = new Map([
      ['a', cc('a', 'h1', 'shared-secret')],
      ['b', cc('b', 'h2', 'shared-secret')],
      ['c', cc('c', 'h3', 'other-secret')],
      ['d', cc('d', 'h4')], // no ref
    ])

    const result = watcher.findCommunicationChannelsByCredentialsSecretName('shared-secret')
    expect(result.map(c => c.name).sort()).toEqual(['a', 'b'])
  })

  it('findCommunicationChannelsByCredentialsSecretName returns [] when no match', () => {
    const watcher = Object.create(McpServerWatcher.prototype) as McpServerWatcher
    ;(
      watcher as unknown as { communicationChannels: Map<string, CommunicationChannelCRD> }
    ).communicationChannels = new Map([['a', cc('a', 'h1', 'foo')]])
    expect(watcher.findCommunicationChannelsByCredentialsSecretName('bar')).toEqual([])
  })

  it('findCommunicationChannelsByHostRef returns all CCs for the host', () => {
    const watcher = Object.create(McpServerWatcher.prototype) as McpServerWatcher
    ;(
      watcher as unknown as { communicationChannels: Map<string, CommunicationChannelCRD> }
    ).communicationChannels = new Map([
      ['a', cc('a', 'h1')],
      ['b', cc('b', 'h2')],
      ['c', cc('c', 'h1')],
    ])
    const result = watcher.findCommunicationChannelsByHostRef('h1')
    expect(result.map(c => c.name).sort()).toEqual(['a', 'c'])
  })
})
