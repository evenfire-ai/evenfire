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
  | 'reserved'
export type LanBaseUrlDecision = { ok: true; ip: string } | { ok: false; reason: LanBaseUrlReason }
export interface ClassifyLanOptions {
  clusterInternalCidrs?: readonly string[]
}
export declare function classifyLanBaseURL(
  baseURL: unknown,
  options?: ClassifyLanOptions
): LanBaseUrlDecision
