/**
 * issue #299 Phase 2 — provider-netblocks fetcher plugin interfaces.
 *
 * Provider names appear ONLY in the concrete plugins (e.g. githubFetcher.ts),
 * never in this file or the shared service — the generality invariant. A plugin
 * fetches and shapes a provider's published netblocks into
 * `{ categories, meta }`; the SHARED service then applies family-split,
 * validation, bounds, regression guards, hashing, and the ConfigMap write
 * UNIFORMLY, so adding a provider is a plugin + registry/seed data, nothing else.
 */

/** Bounded HTTP surface. The CALLER constructs the implementation with the hard
 * timeout + max-response-size cap (via AbortController + a body-length check) so
 * a plugin can never issue an unbounded request. */
export interface FetchHttp {
  get(
    url: string,
    headers: Record<string, string>
  ): Promise<{ status: number; headers: Record<string, string>; bodyText: string }>
}

export interface FetchContext {
  http: FetchHttp
  log: (msg: string) => void
}

/** Last-known-good state (from the live ConfigMap) for conditional GETs + guards. */
export interface LkgState {
  etag?: string
  syncToken?: string
  /** category → IPv4 count from the live CM (for the >50%-shrink guard). */
  categoryCounts: Record<string, number>
}

export type FetchResult =
  | { kind: 'unchanged' }
  | {
      kind: 'ok'
      /** category → raw CIDRs, BOTH families (the service family-splits). */
      categories: Record<string, string[]>
      meta: { sourceUrl: string; etag?: string; syncToken?: string }
    }
  | { kind: 'error'; reason: string }

export interface ProviderFetcher {
  /** The provider key — becomes the CM key prefix `<source>.<category>.<family>`. */
  readonly source: string
  fetch(ctx: FetchContext, lkg: LkgState | null): Promise<FetchResult>
}
