/**
 * Host↔LlmHook referential-integrity helpers (spec §8.2).
 *
 * A hook is referenced from `Host.spec.guardrails.hooks[phase]` as `{ id, digest }`.
 * These keep those references consistent with the hook's lifecycle so mcp-host
 * never sees an inconsistent state:
 *   - uninstall  → strip the ref from every referencing Host (no dangling ref,
 *     which mcp-host can't fail-closed on — N11).
 *   - upgrade    → move the CR image bump and the admin-pinned Host-ref digests
 *     together (an uncoordinated bump trips the digest pin and quarantines the
 *     hook).
 */
import { K8sGateway } from '../k8s.js'

type HookRef = { id: string; digest?: string }
type HostGuardrails = { hooks?: Record<string, HookRef[]>; [k: string]: unknown }
interface HostResource {
  metadata?: { name?: string }
  spec?: { guardrails?: HostGuardrails; [k: string]: unknown }
}

function referencesHook(host: HostResource, hookId: string): boolean {
  const hooks = host.spec?.guardrails?.hooks
  return (
    !!hooks &&
    Object.values(hooks).some(arr => Array.isArray(arr) && arr.some(r => r?.id === hookId))
  )
}

/** Hosts (in `hostsNamespace`) whose `guardrails.hooks` reference the LlmHook id. */
export async function listHostsReferencingHook(
  gateway: K8sGateway,
  hookId: string,
  hostsNamespace: string
): Promise<HostResource[]> {
  const items = (await gateway.listResource('hosts', hostsNamespace)) as HostResource[]
  return (items ?? []).filter(h => referencesHook(h, hookId))
}

/**
 * Atomic read→derive→write of one Host's `guardrails.hooks` map.
 *
 * `mutateResource` re-reads the Host, runs `derive` against THAT read, and uses
 * its `resourceVersion` as the replace precondition (re-deriving on a 409).
 * Deriving INSIDE the callback is the whole point: the Hosts here come from a
 * single list read, so a map computed out here would be replayed against a Host
 * that a concurrent install/uninstall has since changed — a full-spec replace
 * with no precondition, i.e. a silent lost update. That leaves an LlmHook CR
 * installed but unreferenced, which reads as an active guardrail that never
 * runs (fail-OPEN).
 */
async function mutateHostHooks(
  gateway: K8sGateway,
  name: string,
  hostsNamespace: string,
  derive: (hooks: Record<string, HookRef[]>) => Record<string, HookRef[]>
): Promise<void> {
  await gateway.mutateResource(
    'hosts',
    name,
    current => {
      const spec = (current.spec ?? {}) as NonNullable<HostResource['spec']>
      const guardrails: HostGuardrails = { ...(spec.guardrails ?? {}) }
      guardrails.hooks = derive(guardrails.hooks ?? {})
      return { spec: { ...spec, guardrails } }
    },
    hostsNamespace
  )
}

/** Drop `hookId` from every phase (removing now-empty phases). */
function withoutHook(hooks: Record<string, HookRef[]>, hookId: string): Record<string, HookRef[]> {
  const next: Record<string, HookRef[]> = { ...hooks }
  for (const phase of Object.keys(next)) {
    const filtered = next[phase].filter(r => r.id !== hookId)
    if (filtered.length > 0) next[phase] = filtered
    else delete next[phase]
  }
  return next
}

/**
 * Referential integrity on install: reference `hookId` from every phase in
 * `lifecyclePoints` on ONE Host. Idempotent per phase (an existing ref is left
 * alone), and atomic — refs another operation added after this request started
 * are preserved rather than clobbered (see mutateHostHooks).
 */
export async function addHookRefToHost(
  gateway: K8sGateway,
  hostName: string,
  hookId: string,
  lifecyclePoints: string[],
  digest: string | undefined,
  hostsNamespace: string
): Promise<void> {
  await mutateHostHooks(gateway, hostName, hostsNamespace, current => {
    const hooks: Record<string, HookRef[]> = { ...current }
    for (const phase of lifecyclePoints) {
      const arr = hooks[phase] ? [...hooks[phase]] : []
      if (!arr.some(r => r.id === hookId)) {
        arr.push({ id: hookId, ...(digest ? { digest } : {}) })
      }
      hooks[phase] = arr
    }
    return hooks
  })
}

/**
 * Referential integrity on uninstall: remove every `{ id: hookId }` reference
 * from all referencing Hosts. Call this BEFORE deleting the LlmHook CR so a
 * dangling ref never exists. Returns the Host names touched.
 */
export async function stripHookRefFromHosts(
  gateway: K8sGateway,
  hookId: string,
  hostsNamespace: string
): Promise<string[]> {
  const hosts = await listHostsReferencingHook(gateway, hookId, hostsNamespace)
  const touched: string[] = []
  for (const host of hosts) {
    const name = host.metadata?.name
    if (!name) continue
    await mutateHostHooks(gateway, name, hostsNamespace, hooks => withoutHook(hooks, hookId))
    touched.push(name)
  }
  return touched
}

/**
 * Coordinated upgrade: set the hook's reference on every referencing Host to
 * EXACTLY `lifecyclePoints` with the new `digest`, so the CR image bump and the
 * admin-pinned Host-ref digests move together. Returns the Host names touched.
 */
export async function syncHookRefsInHosts(
  gateway: K8sGateway,
  hookId: string,
  lifecyclePoints: string[],
  digest: string | undefined,
  hostsNamespace: string
): Promise<string[]> {
  const hosts = await listHostsReferencingHook(gateway, hookId, hostsNamespace)
  const touched: string[] = []
  for (const host of hosts) {
    const name = host.metadata?.name
    if (!name) continue
    await mutateHostHooks(gateway, name, hostsNamespace, current => {
      const hooks = withoutHook(current, hookId)
      for (const phase of lifecyclePoints) {
        const arr = hooks[phase] ? [...hooks[phase]] : []
        arr.push({ id: hookId, ...(digest ? { digest } : {}) })
        hooks[phase] = arr
      }
      return hooks
    })
    touched.push(name)
  }
  return touched
}
