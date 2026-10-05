import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

function policies(path: string): k8s.V1NetworkPolicy[] {
  return parseAllDocuments(readFileSync(resolve(__dirname, '../../../', path), 'utf8'))
    .map(document => document.toJSON())
    .filter(object => object?.kind === 'NetworkPolicy')
}

describe('private execution network lane', () => {
  it('excludes execution Pods from every inherited static Host egress grant', () => {
    const list = policies('deploy/base/mcp-host/networkpolicies.yaml')
    const names = ['mcp-host', 'allow-dns-egress-mcp-host', 'allow-k8s-api-egress-mcp-host']
    for (const name of names) {
      const policy = list.find(item => item.metadata?.name === name)
      expect(policy?.spec?.podSelector).toEqual({
        matchLabels: { 'clerum.io/managed-by': 'host-context-controller' },
        matchExpressions: [
          { key: 'clerum.io/role', operator: 'NotIn', values: ['host-execution'] },
        ],
      })
      expect(policy?.spec?.egress?.length).toBeGreaterThan(0)
    }
    expect(list.find(p => p.metadata?.name === 'deny-all-mcp-host')?.spec?.podSelector).toEqual({})
  })

  it('admits only HCC on the private result port and grants no execution egress', () => {
    const policy = policies('deploy/base/mcp-host/networkpolicies.yaml').find(
      item => item.metadata?.name === 'host-execution-private'
    )
    expect(policy?.spec).toEqual({
      podSelector: {
        matchLabels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/role': 'host-execution',
        },
      },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'control-plane' },
              },
              podSelector: { matchLabels: { app: 'host-context-controller' } },
            },
          ],
          ports: [
            { port: 9300, protocol: 'TCP' },
            { port: 9301, protocol: 'TCP' },
          ],
        },
      ],
      egress: [],
    })
    const reverse = policies('deploy/base/control-plane/networkpolicies.yaml').find(
      item => item.metadata?.name === 'hcc-to-private-execution-results'
    )
    expect(reverse?.spec?.podSelector).toEqual({ matchLabels: { app: 'host-context-controller' } })
    expect(reverse?.spec?.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'mcp-host' } },
            podSelector: {
              matchLabels: {
                'clerum.io/managed-by': 'host-context-controller',
                'clerum.io/role': 'host-execution',
              },
            },
          },
        ],
        ports: [
          { port: 9300, protocol: 'TCP' },
          { port: 9301, protocol: 'TCP' },
        ],
      },
    ])
  })
})
