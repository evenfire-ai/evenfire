import { describe, expect, it } from 'vitest'
import type { K8sGateway } from '../../k8s.js'
import {
  listHostsReferencingHook,
  stripHookRefFromHosts,
  syncHookRefsInHosts,
} from '../hostGuardrailRefs.js'

type Host = {
  metadata: { name: string }
  spec: { guardrails?: { hooks?: Record<string, Array<{ id: string; digest?: string }>> } }
}

function gatewayWith(hosts: Host[]) {
  const store = new Map<string, Host>(hosts.map(h => [h.metadata.name, structuredClone(h)]))
  const gateway = {
    listResource: async (plural: string) => (plural === 'hosts' ? [...store.values()] : []),
    updateResource: async (_p: string, name: string, body: { spec: Host['spec'] }) => {
      const cur = store.get(name)!
      store.set(name, { ...cur, spec: body.spec })
      return store.get(name)
    },
  } as unknown as K8sGateway
  return { gateway, store }
}

const host = (
  name: string,
  hooks: Record<string, Array<{ id: string; digest?: string }>>
): Host => ({
  metadata: { name },
  spec: { guardrails: { hooks } },
})

describe('hostGuardrailRefs', () => {
  it('listHostsReferencingHook returns only Hosts that reference the id', async () => {
    const { gateway } = gatewayWith([
      host('a', { preCall: [{ id: 'hook-x' }] }),
      host('b', { moderate: [{ id: 'hook-y' }] }),
      host('c', {}),
    ])
    const hosts = await listHostsReferencingHook(gateway, 'hook-x', 'mcp-host')
    expect(hosts.map(h => h.metadata?.name)).toEqual(['a'])
  })

  it('stripHookRefFromHosts removes the ref from every phase + host, keeping others', async () => {
    const { gateway, store } = gatewayWith([
      host('a', { preCall: [{ id: 'hook-x' }, { id: 'keep' }], moderate: [{ id: 'hook-x' }] }),
      host('b', { postCallSuccess: [{ id: 'hook-x' }] }),
    ])
    const touched = await stripHookRefFromHosts(gateway, 'hook-x', 'mcp-host')
    expect(touched.sort()).toEqual(['a', 'b'])
    // host a: hook-x gone from both phases; 'keep' stays; empty moderate removed.
    expect(store.get('a')!.spec.guardrails?.hooks).toEqual({ preCall: [{ id: 'keep' }] })
    // host b: the only ref removed → empty hooks map.
    expect(store.get('b')!.spec.guardrails?.hooks).toEqual({})
  })

  it('syncHookRefsInHosts sets the ref to exactly the new phases + digest', async () => {
    const { gateway, store } = gatewayWith([
      // referenced today in preCall+moderate at the old digest.
      host('a', {
        preCall: [{ id: 'hook-x', digest: 'sha256:OLD' }],
        moderate: [{ id: 'hook-x', digest: 'sha256:OLD' }],
      }),
    ])
    await syncHookRefsInHosts(
      gateway,
      'hook-x',
      ['preCall', 'postCallSuccess'],
      'sha256:NEW',
      'mcp-host'
    )
    const hooks = store.get('a')!.spec.guardrails?.hooks
    // moderate dropped, postCallSuccess added, new digest everywhere.
    expect(hooks).toEqual({
      preCall: [{ id: 'hook-x', digest: 'sha256:NEW' }],
      postCallSuccess: [{ id: 'hook-x', digest: 'sha256:NEW' }],
    })
  })
})
