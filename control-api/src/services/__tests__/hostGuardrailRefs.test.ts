import { describe, expect, it } from 'vitest'
import type { K8sGateway } from '../../k8s.js'
import {
  addHookRefToHost,
  listHostsReferencingHook,
  stripHookRefFromHosts,
  syncHookRefsInHosts,
} from '../hostGuardrailRefs.js'

type HookRef = { id: string; digest?: string }
type Host = {
  metadata: { name: string }
  spec: { guardrails?: { hooks?: Record<string, HookRef[]> } }
}

/**
 * `onBeforeMutate` fires inside `mutateResource`, i.e. AFTER the caller's list
 * read and BEFORE the derive+write — the window a concurrent install/uninstall
 * commits in. `listResource` hands out clones so the caller cannot observe that
 * later write through its own snapshot, exactly like a real list.
 */
function gatewayWith(
  hosts: Host[],
  onBeforeMutate?: (store: Map<string, Host>, name: string) => void
) {
  const store = new Map<string, Host>(hosts.map(h => [h.metadata.name, structuredClone(h)]))
  const gateway = {
    listResource: async (plural: string) =>
      plural === 'hosts' ? structuredClone([...store.values()]) : [],
    mutateResource: async (
      _p: string,
      name: string,
      mutate: (current: {
        spec?: Record<string, unknown>
      }) => { spec: Record<string, unknown> } | null
    ) => {
      onBeforeMutate?.(store, name)
      const current = structuredClone(store.get(name)!)
      const next = await mutate(current)
      if (!next) return current
      store.set(name, { ...store.get(name)!, spec: next.spec as Host['spec'] })
      return store.get(name)
    },
  } as unknown as K8sGateway
  return { gateway, store }
}

const host = (name: string, hooks: Record<string, HookRef[]>): Host => ({
  metadata: { name },
  spec: { guardrails: { hooks } },
})

/** A one-shot concurrent install: appends `hookId` to `preCall` on first call. */
function concurrentInstall(hookId: string) {
  let fired = false
  return (store: Map<string, Host>, name: string) => {
    if (fired) return
    fired = true
    const cur = store.get(name)!
    const hooks = { ...(cur.spec.guardrails?.hooks ?? {}) }
    hooks.preCall = [...(hooks.preCall ?? []), { id: hookId }]
    store.set(name, {
      ...cur,
      spec: { ...cur.spec, guardrails: { ...cur.spec.guardrails, hooks } },
    })
  }
}

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

  it('addHookRefToHost references the hook in every declared phase', async () => {
    const { gateway, store } = gatewayWith([host('a', { preCall: [{ id: 'keep' }] })])
    await addHookRefToHost(
      gateway,
      'a',
      'hook-x',
      ['preCall', 'postCallSuccess'],
      'sha256:NEW',
      'mcp-host'
    )
    expect(store.get('a')!.spec.guardrails?.hooks).toEqual({
      preCall: [{ id: 'keep' }, { id: 'hook-x', digest: 'sha256:NEW' }],
      postCallSuccess: [{ id: 'hook-x', digest: 'sha256:NEW' }],
    })
  })

  it('addHookRefToHost is idempotent per phase', async () => {
    const { gateway, store } = gatewayWith([host('a', {})])
    await addHookRefToHost(gateway, 'a', 'hook-x', ['preCall'], 'sha256:NEW', 'mcp-host')
    await addHookRefToHost(gateway, 'a', 'hook-x', ['preCall'], 'sha256:NEW', 'mcp-host')
    expect(store.get('a')!.spec.guardrails?.hooks?.preCall).toEqual([
      { id: 'hook-x', digest: 'sha256:NEW' },
    ])
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

  it('syncHookRefsInHosts keeps the Host phases still supported, bumping the digest', async () => {
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
    // moderate dropped (no longer supported); postCallSuccess NOT added (the Host
    // never placed the hook there); new digest on what remains.
    expect(hooks).toEqual({
      preCall: [{ id: 'hook-x', digest: 'sha256:NEW' }],
    })
  })

  it('syncHookRefsInHosts does not re-add a phase the admin removed', async () => {
    const { gateway, store } = gatewayWith([
      // hook-x declares preCall+moderate; the admin removed it from moderate.
      host('a', {
        preCall: [{ id: 'other' }, { id: 'hook-x', digest: 'sha256:OLD' }],
        moderate: [{ id: 'other' }],
      }),
    ])
    await syncHookRefsInHosts(gateway, 'hook-x', ['preCall', 'moderate'], 'sha256:NEW', 'mcp-host')
    expect(store.get('a')!.spec.guardrails?.hooks).toEqual({
      preCall: [{ id: 'other' }, { id: 'hook-x', digest: 'sha256:NEW' }],
      moderate: [{ id: 'other' }],
    })
  })

  it('syncHookRefsInHosts keeps per-Host placements independent', async () => {
    const { gateway, store } = gatewayWith([
      host('a', { preCall: [{ id: 'hook-x', digest: 'sha256:OLD' }] }),
      host('b', { moderate: [{ id: 'hook-x', digest: 'sha256:OLD' }] }),
    ])
    const touched = await syncHookRefsInHosts(
      gateway,
      'hook-x',
      ['preCall', 'moderate'],
      'sha256:NEW',
      'mcp-host'
    )
    expect(touched.sort()).toEqual(['a', 'b'])
    expect(store.get('a')!.spec.guardrails?.hooks).toEqual({
      preCall: [{ id: 'hook-x', digest: 'sha256:NEW' }],
    })
    expect(store.get('b')!.spec.guardrails?.hooks).toEqual({
      moderate: [{ id: 'hook-x', digest: 'sha256:NEW' }],
    })
  })

  it('syncHookRefsInHosts falls back to the new phases when none of the Host phases survive', async () => {
    // Leaving the hook unreferenced would silently stop a guardrail the admin
    // placed on this Host, so re-reference it at the upgraded hook's phases.
    const { gateway, store } = gatewayWith([
      host('a', { moderate: [{ id: 'hook-x', digest: 'sha256:OLD' }] }),
    ])
    await syncHookRefsInHosts(gateway, 'hook-x', ['preToolUse'], 'sha256:NEW', 'mcp-host')
    expect(store.get('a')!.spec.guardrails?.hooks).toEqual({
      preToolUse: [{ id: 'hook-x', digest: 'sha256:NEW' }],
    })
  })

  it('syncHookRefsInHosts drops a digest when the upgrade has none', async () => {
    const { gateway, store } = gatewayWith([
      host('a', { preCall: [{ id: 'hook-x', digest: 'sha256:OLD' }] }),
    ])
    await syncHookRefsInHosts(gateway, 'hook-x', ['preCall'], undefined, 'mcp-host')
    expect(store.get('a')!.spec.guardrails?.hooks).toEqual({ preCall: [{ id: 'hook-x' }] })
  })

  // ── lost-update guards ────────────────────────────────────────────────────
  // Each write derives its map from a re-read taken INSIDE the write, so a ref
  // another operation committed after our read survives. Deriving from the
  // earlier snapshot and replacing the whole spec with no resourceVersion
  // precondition drops it silently — that hook stays installed but unreferenced,
  // i.e. an "active" guardrail that never runs.

  it('addHookRefToHost keeps a ref another install added first', async () => {
    const { gateway, store } = gatewayWith([host('a', {})], concurrentInstall('hook-z'))
    await addHookRefToHost(gateway, 'a', 'hook-x', ['preCall'], undefined, 'mcp-host')
    expect(store.get('a')!.spec.guardrails?.hooks?.preCall).toEqual([
      { id: 'hook-z' },
      { id: 'hook-x' },
    ])
  })

  it('stripHookRefFromHosts keeps a ref installed after the list read', async () => {
    const { gateway, store } = gatewayWith(
      [host('a', { preCall: [{ id: 'hook-x' }] })],
      concurrentInstall('hook-z')
    )
    await stripHookRefFromHosts(gateway, 'hook-x', 'mcp-host')
    expect(store.get('a')!.spec.guardrails?.hooks).toEqual({ preCall: [{ id: 'hook-z' }] })
  })

  it('syncHookRefsInHosts keeps a ref installed after the list read', async () => {
    const { gateway, store } = gatewayWith(
      [host('a', { preCall: [{ id: 'hook-x', digest: 'sha256:OLD' }] })],
      concurrentInstall('hook-z')
    )
    await syncHookRefsInHosts(gateway, 'hook-x', ['preCall'], 'sha256:NEW', 'mcp-host')
    expect(store.get('a')!.spec.guardrails?.hooks).toEqual({
      preCall: [{ id: 'hook-z' }, { id: 'hook-x', digest: 'sha256:NEW' }],
    })
  })
})
