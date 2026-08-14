'use strict'
/**
 * @clerum/network-policy-core/providerRegistry — FQDN → provider → categories
 * registry for issue #299 Phase 2. DATA ONLY.
 *
 * This is the ONE module in the core package allowed to contain provider names.
 * The provider-blind pipeline (index.cjs), the adapters, the reconcilers, the
 * render/write path, and the admission validators must NEVER name a provider —
 * they consume this data (and the ConfigMap) instead. The generality grep-gate
 * (scripts/ci/check-provider-generality.sh) DERIVES the forbidden name set from
 * `providerNames` below, so adding a provider is a data row here and nothing
 * else — the gate adapts automatically, with zero edit to any general layer.
 *
 * Lookup precedence (LOCKED): exact host > explicit off-pool exact row >
 * wildcard suffix (longest wins) > unmapped (undefined). Hostname suffix NEVER
 * classifies on its own — the off-pool and unmapped exacts are the enforced
 * counterexamples (Fable-P1).
 */

const EXACT = Object.freeze({
  // On-pool GitHub hosts (M1). codeload union is MANDATORY: its geo-answers
  // live in /meta `git`, outside api∪web (Fable-P2).
  'api.github.com': { kind: 'mapped', row: { provider: 'github', categories: ['api'] } },
  'github.com': { kind: 'mapped', row: { provider: 'github', categories: ['web', 'api'] } },
  'gist.github.com': { kind: 'mapped', row: { provider: 'github', categories: ['web', 'api'] } },
  'codeload.github.com': { kind: 'mapped', row: { provider: 'github', categories: ['web', 'api', 'git'] } },
  // ghcr is NOT `packages` alone (28×/32+1×/31 — barely wider than the /32
  // window; ghcr answers live in the api/web /20s — Fable-P1).
  'ghcr.io': { kind: 'mapped', row: { provider: 'github', categories: ['api', 'web'] } },
  // Off-pool counterexamples (hostname suffix NEVER classifies — Fable-P1):
  // git-LFS/archives are AWS S3 (0/64 observed IPs in GitHub /meta).
  'github-cloud.s3.amazonaws.com': { kind: 'mapped', row: { provider: 'aws', categories: ['S3'] } },
  // Azure Front Door: covered by NEITHER github nor aws → /32 window + canary.
  'pipelines.actions.githubusercontent.com': {
    kind: 'unmapped',
    note: 'Azure Front Door endpoint; stays on the /32 window with drift canary',
  },
})

const WILDCARD = Object.freeze([
  // *.githubusercontent.com is GitHub-owned anycast 185.199.108.0/22 (NOT
  // Fastly); union web∪api∪git covers raw/objects/avatars (Fable-P1).
  { suffix: '.githubusercontent.com', kind: 'mapped', row: { provider: 'github', categories: ['web', 'api', 'git'] } },
  { suffix: '.s3.amazonaws.com', kind: 'mapped', row: { provider: 'aws', categories: ['S3'] } },
])

const DEFAULT_BOUNDS = Object.freeze({ minPrefixLength: 16, maxRanges: 256, maxSpanAddresses: 2 ** 22 })
const PROVIDER_BOUNDS = Object.freeze({
  github: { minPrefixLength: 16, maxRanges: 256, maxSpanAddresses: 2 ** 22 },
  google: { minPrefixLength: 12, maxRanges: 256, maxSpanAddresses: 2 ** 22 }, // M2 (post-subtraction blocks are wide)
  aws: { minPrefixLength: 16, maxRanges: 256, maxSpanAddresses: 2 ** 22 }, // M3
  cloudfront: { minPrefixLength: 15, maxRanges: 256, maxSpanAddresses: 2 ** 22 }, // M3 (/15 chunks exist)
  microsoft: { minPrefixLength: 16, maxRanges: 256, maxSpanAddresses: 2 ** 22 }, // M4
})

function lookupFqdnProvider(fqdn) {
  if (typeof fqdn !== 'string' || !fqdn) return undefined
  const host = fqdn.trim().toLowerCase()
  // hasOwnProperty guard: EXACT is a plain object, so a host equal to a
  // prototype key ("__proto__", "constructor", "hasOwnProperty", …) would
  // otherwise resolve up the chain to a truthy non-row value and be treated as a
  // curated mapping, bypassing the REG-6 unknown-host and F1 subset checks
  // downstream. Consistent with the Object.create(null)/hasOwnProperty defenses
  // in parseProviderNetblocks and resolveProviderRanges (issue #299 review).
  if (Object.prototype.hasOwnProperty.call(EXACT, host)) return EXACT[host] // 1. exact (incl. explicit off-pool + unmapped rows)
  let best
  for (const w of WILDCARD) {
    // 2. wildcard suffix — LONGEST suffix wins
    if (host.length > w.suffix.length && host.endsWith(w.suffix)) {
      if (!best || w.suffix.length > best.suffix.length) best = w
    }
  }
  if (best) return { kind: best.kind, row: best.row }
  return undefined // 3. unmapped-by-absence
}

function providerBounds(name) {
  return PROVIDER_BOUNDS[name] ?? DEFAULT_BOUNDS
}

// Single source of truth for the generality grep-gate: every provider named in
// the data above. Derived, sorted, deduped — the gate reads this so it never
// hardcodes a per-provider list (generality invariant applied to the gate).
const providerNames = Object.freeze(
  [
    ...new Set([
      ...Object.values(EXACT)
        .filter(e => e.kind === 'mapped')
        .map(e => e.row.provider),
      ...WILDCARD.map(w => w.row.provider),
      ...Object.keys(PROVIDER_BOUNDS),
    ]),
  ].sort()
)

module.exports = { lookupFqdnProvider, providerBounds, providerNames }
