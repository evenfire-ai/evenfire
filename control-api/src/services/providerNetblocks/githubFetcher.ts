/**
 * issue #299 Phase 2 — GitHub provider-netblocks fetcher plugin.
 *
 * This is a per-provider PLUGIN: provider names are ALLOWED here (and only in
 * files like this + the registry data + the seed). It fetches api.github.com/meta
 * and returns the published category netblocks. The `actions` category (thousands
 * of Azure CIDRs) is EXCLUDED structurally by the include-list below — not by a
 * blocklist filter. All validation/bounds/guards are applied by the shared
 * service, never here.
 */
import type { FetchContext, FetchResult, LkgState, ProviderFetcher } from './fetcherTypes.js'

const META_URL = 'https://api.github.com/meta'
// Include-list = the `actions`/`actions_macos`/`codespaces`/`copilot`/`hooks`
// exclusion, expressed structurally rather than as a blocklist.
const CATEGORIES = ['api', 'web', 'git', 'packages', 'pages'] as const

export const githubFetcher: ProviderFetcher = {
  source: 'github',
  async fetch(ctx: FetchContext, lkg: LkgState | null): Promise<FetchResult> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'clerum-control-api',
    }
    // 304s don't burn the 60 req/hr/IP unauthenticated limit.
    if (lkg?.etag) headers['If-None-Match'] = lkg.etag

    const res = await ctx.http.get(META_URL, headers)
    if (res.status === 304) return { kind: 'unchanged' }
    if (res.status !== 200) return { kind: 'error', reason: `github /meta HTTP ${res.status}` }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(res.bodyText) as Record<string, unknown>
    } catch {
      return { kind: 'error', reason: 'github /meta returned invalid JSON' }
    }

    const categories: Record<string, string[]> = {}
    for (const key of CATEGORIES) {
      const arr = body[key]
      if (!Array.isArray(arr) || arr.some(v => typeof v !== 'string')) {
        return { kind: 'error', reason: `github /meta missing category "${key}"` }
      }
      categories[key] = arr as string[]
    }

    const etag = res.headers['etag'] ?? res.headers['ETag']
    return { kind: 'ok', categories, meta: { sourceUrl: META_URL, etag } }
  },
}
