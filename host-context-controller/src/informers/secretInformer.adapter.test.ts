import { afterEach, describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import * as http from 'node:http'
import { makeK8sApiClientWithDeadline } from '../k8s/k8sRequestDeadline'
import { SecretEvent, SecretInformer, secretListFromCoreApi } from './secretInformer'

const NAMESPACE = 'mcp-server'

const servers: http.Server[] = []

/** Serves two list pages from a real HTTP endpoint and rejects a repeated first page. */
async function pagingApiServer(requests: URLSearchParams[]): Promise<k8s.KubeConfig> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1')
    const firstPage = !url.searchParams.has('continue')
    requests.push(url.searchParams)
    res.setHeader('content-type', 'application/json')
    if (firstPage && requests.length > 1) {
      res.statusCode = 500
      res.end(JSON.stringify({ kind: 'Status', code: 500, message: 'the first page repeated' }))
      return
    }
    const name = firstPage ? 'first-secret' : 'second-secret'
    res.end(
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'SecretList',
        metadata: { resourceVersion: '77', ...(firstPage ? { continue: 'next-page' } : {}) },
        items: [{ metadata: { name, uid: `${name}-uid`, resourceVersion: '70' } }],
      })
    )
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no TCP address')
  const kc = new k8s.KubeConfig()
  kc.loadFromOptions({
    clusters: [{ name: 'local', server: `http://127.0.0.1:${address.port}`, skipTLSVerify: true }],
    users: [{ name: 'tester' }],
    contexts: [{ name: 'local', cluster: 'local', user: 'tester' }],
    currentContext: 'local',
  })
  return kc
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('secretListFromCoreApi', () => {
  it('pages a real CoreV1Api with limit and continue', async () => {
    const requests: URLSearchParams[] = []
    const kc = await pagingApiServer(requests)
    const api = makeK8sApiClientWithDeadline(kc, k8s.CoreV1Api, 5000)
    const events: SecretEvent[] = []
    const informer = new SecretInformer(
      kc,
      NAMESPACE,
      evt => events.push(evt),
      { mode: 'resume', list: secretListFromCoreApi(api) },
      {
        watch: {
          watch: async () => ({ abort() {} }) as unknown as AbortController,
        },
      }
    )

    try {
      await expect(informer.start()).resolves.toBe(true)
    } finally {
      informer.stop()
    }

    expect(requests).toHaveLength(2)
    expect(requests[0].get('limit')).toBe('50')
    expect(requests[0].has('continue')).toBe(false)
    expect(requests[1].get('limit')).toBe('50')
    expect(requests[1].get('continue')).toBe('next-page')
    expect(events).toEqual([
      { type: 'ADDED', name: 'first-secret', namespace: NAMESPACE },
      { type: 'ADDED', name: 'second-secret', namespace: NAMESPACE },
    ])
  })
})
