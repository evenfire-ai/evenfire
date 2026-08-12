/**
 * @clerum/network-policy-core/providerRegistry — DATA-only FQDN→provider→category
 * registry + per-provider bounds (issue #299 Phase 2). Separate declaration file
 * from index.d.ts: the export-alignment test reads only index.d.ts, so registry
 * exports live here and are never expected in the core surface.
 */
import type { ProviderRangeBounds, ProviderRegistryLookup } from './index'

/** Resolve an FQDN to its provider mapping (exact > off-pool exact > wildcard > undefined). */
export declare function lookupFqdnProvider(fqdn: string): ProviderRegistryLookup

/** Per-provider validation bounds; unknown provider → the default bounds. */
export declare function providerBounds(name: string): Required<ProviderRangeBounds>

/**
 * Every provider named anywhere in the registry data — the single source of
 * truth the generality grep-gate derives its forbidden-name set from. Sorted,
 * deduped, frozen.
 */
export declare const providerNames: readonly string[]
