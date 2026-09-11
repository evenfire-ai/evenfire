/**
 * Guardrail hook resolution (spec §8.2) — turns the admin-authored
 * `Host.spec.guardrails.hooks` references (`{id, digest}` grouped by phase) into
 * runtime `HookDescriptor`s the LLM-lane engine can call.
 *
 * For each unique referenced hook id we read its LlmHook CR (llm-hooks
 * namespace) and derive:
 *   - endpoint  — image target: the digest-dedup Service DNS the controller
 *                 deploys (`llmhook-<podKey>.<ns>.svc`); service target: the
 *                 referenced Service DNS; remote target: the external baseUrl.
 *   - path / lifecyclePoints / capabilities / failMode / order from the CR spec.
 *
 * The pod-key derivation MUST byte-match host-context-controller's
 * `computePodKey` (llmHookReconciler.ts) or the Service DNS won't resolve.
 *
 * `getLlmHook` is injected so this is unit-testable without a cluster.
 */
import { createHash } from 'crypto'
import type { GuardrailsConfig } from './core/guardrails/config'
import type { HookDescriptor, LifecyclePoint } from './core/guardrails/hooks/types'
import type { Capability } from './core/guardrails/types'
import type { LlmHookCR } from './k8sClient'

/** Host phase key (CRD/Host naming) → engine lifecycle point. */
const PHASE_TO_POINT: Record<string, LifecyclePoint> = {
  preCall: 'pre_call',
  moderate: 'moderate',
  postCallSuccess: 'post_call',
  onError: 'on_error',
  preToolUse: 'pre_tool_use',
  postToolUse: 'post_tool_use',
}

const KNOWN_CAPABILITIES: readonly string[] = [
  'may_deny',
  'may_rewrite',
  'may_substitute_result',
  'may_add_context',
]

interface HookRef {
  id?: string
  digest?: string
}

type ImageTarget = NonNullable<NonNullable<LlmHookCR['spec']>['target']>['image']

export interface ResolveHookDeps {
  getLlmHook: (name: string) => Promise<LlmHookCR | null>
  llmHooksNamespace: string
}

/** Unique referenced hook ids (across all phases) → the first digest seen for each. */
function collectRefs(guardrails: GuardrailsConfig | undefined): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  const hooks = guardrails?.hooks as Record<string, unknown> | undefined
  if (!hooks) return out
  for (const phase of Object.keys(hooks)) {
    const refs = hooks[phase]
    if (!Array.isArray(refs)) continue
    for (const r of refs as HookRef[]) {
      if (r && typeof r.id === 'string' && !out.has(r.id)) out.set(r.id, r.digest)
    }
  }
  return out
}

/** Order-independent egress canonicalization — mirrors HCC `normalizeEgressBindings`. */
function normalizeEgressBindings(
  bindings: NonNullable<ImageTarget>['egressBindings']
): Array<{ cidr: string | null; toFQDN: string | null; ports: number[] }> {
  return (bindings ?? [])
    .map(b => ({
      cidr: b.cidr ?? null,
      toFQDN: b.toFQDN ?? null,
      ports: [...(b.ports ?? [])].sort((a, z) => a - z),
    }))
    .sort((a, z) => JSON.stringify(a).localeCompare(JSON.stringify(z)))
}

/** MUST byte-match host-context-controller `computePodKey` (key order matters). */
function computePodKey(img: NonNullable<ImageTarget>): string {
  const canonical = {
    imageRef: img.ref,
    port: img.port,
    envSecret: img.envSecret ?? '',
    egressBindings: normalizeEgressBindings(img.egressBindings),
    addCapabilities: [...(img.security?.addCapabilities ?? [])].sort(),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

type ResolvedEndpoint = { endpoint: string; kind: 'image' | 'service' | 'remote' }

function endpointFor(cr: LlmHookCR, ns: string): ResolvedEndpoint | null {
  const t = cr.spec?.target
  const img = t?.image
  if (img?.ref && img.port) {
    const podKey = computePodKey(img)
    return {
      endpoint: `http://llmhook-${podKey}.${ns}.svc.cluster.local:${img.port}`,
      kind: 'image',
    }
  }
  const svc = t?.service
  if (svc?.name && svc.namespace && svc.port) {
    return {
      endpoint: `http://${svc.name}.${svc.namespace}.svc.cluster.local:${svc.port}`,
      kind: 'service',
    }
  }
  if (t?.remote?.baseUrl) return { endpoint: t.remote.baseUrl, kind: 'remote' }
  return null
}

/**
 * §1.2 path-collision loser: two co-located hooks (same pod key) declaring the
 * same `spec.path` share one handler, so a loser dialed at that path would
 * inherit the winner's admin-granted capabilities. The host-context-controller
 * flags losers with a `Ready=False / reason=DuplicatePath` condition ("fail
 * closed"), but nothing enforced it — the resolver only ever read
 * `observedDigest`. Honor the condition here.
 */
function isDuplicatePathLoser(cr: LlmHookCR): boolean {
  const conditions = (
    cr.status as
      | { conditions?: Array<{ type?: string; status?: string; reason?: string }> }
      | undefined
  )?.conditions
  return (
    Array.isArray(conditions) &&
    conditions.some(
      c => c?.type === 'Ready' && c?.status === 'False' && c?.reason === 'DuplicatePath'
    )
  )
}

/**
 * Resolve every referenced hook into a `HookDescriptor`. Dangling refs, targets
 * with no resolvable endpoint, and (for image hooks) digest mismatches are
 * skipped with a warning rather than failing the whole boot.
 */
export async function resolveGuardrailHookDescriptors(
  guardrails: GuardrailsConfig | undefined,
  deps: ResolveHookDeps
): Promise<HookDescriptor[]> {
  const refs = collectRefs(guardrails)
  const out: HookDescriptor[] = []

  for (const [id, refDigest] of refs) {
    let cr: LlmHookCR | null
    try {
      cr = await deps.getLlmHook(id)
    } catch (err) {
      console.error(`[Guardrails] failed reading LlmHook ${id}:`, err)
      continue
    }
    if (!cr) continue // dangling reference → skip

    const ep = endpointFor(cr, deps.llmHooksNamespace)
    if (!ep) {
      console.warn(`[Guardrails] LlmHook ${id} has no resolvable target; skipping`)
      continue
    }

    const points = (cr.spec?.lifecyclePoints ?? [])
      .map(p => PHASE_TO_POINT[p])
      .filter((p): p is LifecyclePoint => !!p)
    if (points.length === 0) {
      console.warn(`[Guardrails] LlmHook ${id} declares no known lifecycle points; skipping`)
      continue
    }

    const capabilities = (cr.spec?.capabilities ?? []).filter((c): c is Capability =>
      KNOWN_CAPABILITIES.includes(c)
    )
    const path = cr.spec?.path ?? '/'
    const failMode: 'open' | 'closed' = cr.spec?.failMode === 'open' ? 'open' : 'closed'
    // Content projection selector (§8.4/§8.7). Only an explicit `metadata` makes a
    // pre_call hook content-free; anything else (incl. absent) receives content.
    const contentAccess: 'metadata' | 'content' | undefined =
      cr.spec?.contentAccess === 'metadata'
        ? 'metadata'
        : cr.spec?.contentAccess === 'content'
          ? 'content'
          : undefined
    const order = typeof cr.spec?.order === 'number' ? cr.spec.order : 100

    // §8.6 circuit-breaker policy (CRD defaults: strict / 5 / 30000). `strict`
    // preserves the always-dial behavior; `breaker` is honored at runtime only
    // for advisory (non-may_deny) hooks (RemoteLlmHook.breakerEngaged).
    const ou = cr.spec?.onUnavailable
    const onUnavailable = {
      mode: ou?.mode === 'breaker' ? ('breaker' as const) : ('strict' as const),
      failureThreshold:
        typeof ou?.failureThreshold === 'number' && ou.failureThreshold >= 1
          ? ou.failureThreshold
          : 5,
      cooldownMs: typeof ou?.cooldownMs === 'number' && ou.cooldownMs >= 0 ? ou.cooldownMs : 30000,
    }

    // `remote` targets are dialed over the public internet → SSRF-guarded
    // transport (private/metadata-range reject + DNS-pin). image/service targets
    // resolve to cluster-private IPs and must bypass that guard.
    const external = ep.kind === 'remote'

    // Digest binding (§8.2): an image hook whose reconciled digest no longer
    // matches the admin-pinned reference is not the reviewed image. Rather than
    // drop it (fail-OPEN), QUARANTINE it — the descriptor still loads but every
    // /v1 call short-circuits to unavailable, so a `may_deny` (fail-closed) hook
    // DENIES and an advisory hook contributes nothing (§8.6/N11). Never a silent
    // allow for a deny-authoritative hook whose integrity check failed.
    const digestMismatch =
      ep.kind === 'image' &&
      !!refDigest &&
      !!cr.status?.observedDigest &&
      refDigest !== cr.status.observedDigest
    // A path-collision loser is fail-closed the same way: quarantine it so its
    // /v1 calls short-circuit to unavailable (may_deny → deny; advisory →
    // nothing) instead of hitting the co-located winner's handler and inheriting
    // its capabilities.
    const duplicatePathLoser = isDuplicatePathLoser(cr)
    const quarantined = digestMismatch || duplicatePathLoser
    if (digestMismatch) {
      console.warn(
        `[Guardrails] LlmHook ${id} digest mismatch (ref=${refDigest} observed=${cr.status?.observedDigest}); quarantining (fail-closed for may_deny)`
      )
    }
    if (duplicatePathLoser) {
      console.warn(
        `[Guardrails] LlmHook ${id} is a DuplicatePath collision loser (Ready=False); quarantining (fail-closed for may_deny)`
      )
    }

    out.push({
      id,
      endpoint: ep.endpoint,
      path,
      lifecyclePoints: points,
      capabilities,
      failMode,
      onUnavailable,
      order,
      external,
      ...(contentAccess ? { contentAccess } : {}),
      ...(quarantined ? { quarantined: true } : {}),
    })
    console.log(
      `[Guardrails] resolved hook ${id} -> ${ep.endpoint}${path} points=[${points.join(',')}] caps=[${capabilities.join(',')}] failMode=${failMode}${external ? ' external=true(SSRF-guarded)' : ''}${quarantined ? ` quarantined=true(${duplicatePathLoser ? 'duplicate-path' : 'digest-mismatch'})` : ''}`
    )
  }

  return out
}

/**
 * Merge resolved descriptors into a guardrails config for the agent. Preserves
 * any inline `hookDescriptors` (dev/E2E via CLERUM_GUARDRAILS_CONFIG) and the
 * rest of the block; returns undefined only when there is nothing to apply.
 */
export function withResolvedHookDescriptors(
  guardrails: GuardrailsConfig | undefined,
  resolved: HookDescriptor[]
): GuardrailsConfig | undefined {
  if (!guardrails && resolved.length === 0) return undefined
  const inline = guardrails?.hookDescriptors ?? []
  const hookDescriptors = [...inline, ...resolved]
  return { ...(guardrails ?? {}), hookDescriptors }
}
