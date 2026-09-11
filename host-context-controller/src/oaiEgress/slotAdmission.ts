import {
  type LanBaseUrlReason,
  PRIMARY_SLOT_ID,
  brokerNameFor,
  classifyLanBaseURL,
  fallbackSlotId,
} from '@clerum/egress-policy'
import { isCredentialSlotOwnedByProvider } from '@clerum/llm-providers'
import { config } from '../config'
import { hccLogger } from '../logger'
import { type SlotOutcome } from '../openaiEgressBrokerStatus'
import { HostCRD } from '../types'
import { type ClusterDenySet } from './clusterDenySet'

const log = hccLogger.child({ module: 'oai-egress-slot-admission' })

export const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible'
// The single credential slot for the openai-compatible provider (canonical key
// inside the Host LLM Secret and inside the mirror Secret). Kept in sync with
// @clerum/llm-providers PROVIDER_CREDENTIAL_SLOTS['openai-compatible'][0].
export const OPENAI_COMPATIBLE_API_KEY_SLOT = 'openai-compatible-api-key'

/** Machine reason a slot was NOT provisioned (admitSlot drops + provision failure). */
export type SlotDropReason =
  | 'cluster_internal_guard_unconfigured'
  | 'cluster_node_guard_unconfigured'
  | 'credential_slot_not_owned'
  | LanBaseUrlReason
  | 'url_unparseable'
  | 'scheme_unsupported'
  | 'port_invalid'
  | 'path_unsafe'
  | 'provision_failed'

/** A validated local slot that must have a broker. */
export type DesiredBroker = {
  slotId: string
  brokerName: string
  ip: string
  lanPort: number
  scheme: 'http:' | 'https:'
  path: string
  /** Data key to read from the Host's own Secret for this slot's credential. */
  credentialDataKey: string
}

/**
 * Every local openai-compatible slot of a Host that survives fail-closed
 * re-validation. A slot whose baseURL is not a clean RFC1918 IP-literal (per
 * classifyLanBaseURL) or whose path/port cannot be parsed safely is DROPPED —
 * no broker is provisioned for it. control-api admission (phase 3) already
 * guarantees the shape; this is defense-in-depth against a direct cluster
 * write that bypassed control-api. `denySet` is the resolved cluster-internal
 * CIDR set + guard-configured flag (see resolveClusterInternalCidrs).
 */
export function deriveDesiredBrokers(
  host: HostCRD,
  denySet: ClusterDenySet
): { desired: DesiredBroker[]; dropped: SlotOutcome[] } {
  const desired: DesiredBroker[] = []
  const dropped: SlotOutcome[] = []
  const seenSlotIds = new Set<string>()

  const consider = (
    slotId: string,
    provider: string | undefined,
    baseURL: string | undefined,
    credentialDataKey: string
  ): void => {
    if (provider?.trim() !== OPENAI_COMPATIBLE_PROVIDER) return
    if (!baseURL) return
    if (seenSlotIds.has(slotId)) return
    seenSlotIds.add(slotId)
    // Ownership gate BEFORE admission: a fallback whose credentialSlot is not a
    // key the openai-compatible provider owns (e.g. 'claude-api-key') would have
    // HCC mirror a FOREIGN key from the Host Secret to a LAN IP the admin chose.
    // Drop it here so the reconciler never reads that key (no mirror Secret, no
    // Deployment). The primary always uses the canonical slot (owned), so this is
    // a no-op for it. Defense-in-depth behind the control-api ownership gate.
    if (!isCredentialSlotOwnedByProvider(OPENAI_COMPATIBLE_PROVIDER, credentialDataKey)) {
      log.warn('credentialSlot not owned by openai-compatible — slot not provisioned', {
        host: host.name,
        slotId,
      })
      dropped.push({ slotId, reason: 'credential_slot_not_owned' })
      return
    }
    const result = admitSlot(host.name, slotId, baseURL, credentialDataKey, denySet)
    if ('reason' in result) {
      dropped.push({ slotId, reason: result.reason })
    } else {
      desired.push(result)
    }
  }

  consider(
    PRIMARY_SLOT_ID,
    host.spec.model?.provider,
    host.spec.model?.baseURL,
    OPENAI_COMPATIBLE_API_KEY_SLOT
  )

  const fallbacks = host.spec.llmPolicy?.fallbacks ?? []
  fallbacks.forEach((fb, i) => {
    // credentialSlot (when set) is the literal Secret data key that feeds this
    // fallback's key — mirroring mcp-host's fallback resolution. Absent ⇒ the
    // provider's canonical slot key.
    const dataKey = fb.credentialSlot?.trim() || OPENAI_COMPATIBLE_API_KEY_SLOT
    consider(fallbackSlotId(i), fb.provider, fb.baseURL, dataKey)
  })

  return { desired, dropped }
}

/**
 * Fail-closed admission of one declared openai-compatible slot into a broker.
 * Returns the validated DesiredBroker, or the machine reason the slot was
 * dropped. `denySet` carries the resolved cluster-internal CIDRs and whether the
 * operator configured the guard.
 */
export function admitSlot(
  hostName: string,
  slotId: string,
  baseURL: string,
  credentialDataKey: string,
  denySet: ClusterDenySet
): DesiredBroker | { reason: SlotDropReason } {
  const { cidrs: clusterInternalCidrs, internalConfigured, nodeConfigured } = denySet
  // Fail-closed PER CATEGORY: without the operator-declared pod/Service ranges
  // the classifier cannot tell cluster space (apiserver/pod ClusterIPs) from a
  // real private LAN; without the node ranges it cannot tell a node IP
  // (RFC1918, classifies as a plain LAN) from a real LAN endpoint. Refuse to
  // provision any slot until BOTH guards are configured. The single escape hatch
  // is CONTEXT_MAPPER_OAI_EGRESS_REQUIRE_CLUSTER_CIDRS=false (waives both).
  if (config.oaiEgressRequireClusterCidrs) {
    if (!internalConfigured) {
      log.error(
        'cluster-internal CIDR guard unconfigured — refusing to provision broker; set CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS (or opt out with CONTEXT_MAPPER_OAI_EGRESS_REQUIRE_CLUSTER_CIDRS=false)',
        { host: hostName, slotId }
      )
      return { reason: 'cluster_internal_guard_unconfigured' }
    }
    if (!nodeConfigured) {
      log.error(
        'cluster-node CIDR guard unconfigured — refusing to provision broker; set CONTEXT_MAPPER_CLUSTER_NODE_CIDRS (or opt out with CONTEXT_MAPPER_OAI_EGRESS_REQUIRE_CLUSTER_CIDRS=false)',
        { host: hostName, slotId }
      )
      return { reason: 'cluster_node_guard_unconfigured' }
    }
  }
  const decision = classifyLanBaseURL(
    baseURL,
    clusterInternalCidrs.length ? { clusterInternalCidrs } : undefined
  )
  if (!decision.ok) {
    log.warn('baseURL failed fail-closed LAN validation — slot not provisioned', {
      host: hostName,
      slotId,
      reason: decision.reason,
    })
    return { reason: decision.reason }
  }
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    log.warn('baseURL is not a parseable URL — slot not provisioned', { host: hostName, slotId })
    return { reason: 'url_unparseable' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    log.warn('baseURL scheme unsupported — slot not provisioned', {
      host: hostName,
      slotId,
      scheme: parsed.protocol,
    })
    return { reason: 'scheme_unsupported' }
  }
  // Take the LAN address from the classifier (validated RFC1918 IPv4 literal),
  // never from the raw string. Port + path come from the parsed URL components,
  // never from string slicing — anti-injection for the generated nginx config.
  const lanPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(lanPort) || lanPort < 1 || lanPort > 65535) {
    log.warn('baseURL port invalid — slot not provisioned', { host: hostName, slotId })
    return { reason: 'port_invalid' }
  }
  const path = parsed.pathname || '/'
  // Reject anything that could break the nginx quoted/directive context. URL
  // parsing already percent-encodes CR/LF/space, but reject defensively so a
  // path can never carry a newline, quote, backslash, NUL, whitespace — or the
  // metacharacters that survive URL parsing and are meaningful in nginx: `$`
  // (proxy_pass runtime variable interpolation — `.../v1$request_uri` would
  // rewrite the upstream), `#` (starts a comment), and backtick.
  if (/[\r\n\t "'\\;{}$#`\0]/.test(path) || path.length > 1024) {
    log.warn('baseURL path unsafe — slot not provisioned', { host: hostName, slotId })
    return { reason: 'path_unsafe' }
  }
  return {
    slotId,
    brokerName: brokerNameFor(hostName, slotId),
    ip: decision.ip,
    lanPort,
    scheme: parsed.protocol,
    path,
    credentialDataKey,
  }
}
