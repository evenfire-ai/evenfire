export declare const NON_PUBLIC_EGRESS_CIDRS: readonly string[]
export declare const PRIVATE_LAN_CIDRS: readonly string[]

export declare function ipv4ToInt(ip: string): number | null
export declare function parseCidr(
  cidr: string
): { start: number; end: number; canonical: boolean } | null
export declare function cidrOverlaps(a: string, b: string): boolean

export type LanBaseUrlReason =
  | 'invalid_url'
  | 'not_ip'
  | 'not_private_lan'
  | 'link_local'
  | 'cgnat'
  | 'cluster_internal'
  | 'cluster_cidr_invalid'
  | 'reserved'
export type LanBaseUrlDecision = { ok: true; ip: string } | { ok: false; reason: LanBaseUrlReason }
export interface ClassifyLanOptions {
  clusterInternalCidrs?: readonly string[]
}
export declare function classifyLanBaseURL(
  baseURL: unknown,
  options?: ClassifyLanOptions
): LanBaseUrlDecision

export declare const PRIMARY_SLOT_ID: string
export declare const OAI_EGRESS_BROKERS_CONDITION_TYPE: string
export declare function fallbackSlotId(index: number): string
export declare function brokerNameFor(hostName: string, slotId: string): string
export declare function brokerServiceHost(brokerName: string, namespace: string): string
export interface BrokerInternalUrlOptions {
  namespace: string
  port: number
  pathname?: string
}
export declare function brokerInternalUrl(
  hostName: string,
  slotId: string,
  options: BrokerInternalUrlOptions
): string
