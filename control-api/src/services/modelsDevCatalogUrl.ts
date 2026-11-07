/**
 * Where the models.dev catalog is fetched from, and the egress rule that URL
 * must satisfy. Its own module, free of the client's dependencies, so the
 * config can refuse an unsafe URL at boot with the same rule the loader applies
 * before every fetch.
 */
import { isIP } from 'node:net'

/**
 * The catalog URL. Defaults to the fixed, trusted public endpoint. It is NOT
 * an operator/tenant-input surface (no SSRF vector — see the module header), but
 * `MODELS_DEV_API_URL` may override it via env so a non-prod plane (e.g. a test
 * cluster with the periodic sync enabled) can be pointed at a local stub instead
 * of hammering the real models.dev host. Trimmed; a blank env falls back to the
 * default. The `fetchImpl`/`loadCatalog` DI seam remains the mechanism tests use.
 */
const DEFAULT_MODELS_DEV_API_URL = 'https://models.dev/api.json'

export function resolveModelsDevApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MODELS_DEV_API_URL?.trim() || DEFAULT_MODELS_DEV_API_URL
}

/**
 * Hostname suffixes that only ever resolve inside a cluster / private network.
 * `.svc.cluster.local` ends with `.local` (and `.svc`), so the shorter suffixes
 * already cover it — it is listed for documentation, not because it is needed.
 */
const INTERNAL_HOST_SUFFIXES = ['.internal', '.local', '.svc', '.svc.cluster.local'] as const

/**
 * Classify an IPv4 literal as a private / loopback / link-local / "this host"
 * target that egress must never reach. Ranges (not a single address each):
 *   - 127.0.0.0/8   loopback (all of it, not just 127.0.0.1)
 *   - 0.0.0.0/8     "this host" / unspecified
 *   - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16   RFC1918 private
 *   - 169.254.0.0/16   link-local (incl. 169.254.169.254 cloud metadata)
 */
function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map(p => Number(p))
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
    // isIP() said v4, so this should not happen; fail closed (treat as blocked).
    return true
  }
  const [a, b] = parts
  if (a === 127 || a === 0) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/**
 * Classify an IPv6 literal (brackets already stripped) as loopback / unspecified
 * / IPv4-mapped-private / link-local / unique-local. `URL.hostname` yields IPv6
 * *with* brackets (e.g. `[::1]`), so callers strip them before this. The
 * IPv4-mapped case is re-classified through isBlockedV4 so every private v4
 * tunneled as v6 is caught too — in BOTH the dotted-quad tail (`::ffff:127.0.0.1`)
 * and the hex form the WHATWG `URL` parser normalizes it to (`::ffff:7f00:1`).
 */
function isBlockedV6(ip: string): boolean {
  const h = ip.toLowerCase()
  if (h === '::1' || h === '::') return true
  // IPv4-mapped tail written in dotted-quad form (`::ffff:127.0.0.1`).
  const dotted = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(h)
  if (dotted && isBlockedV4(dotted[1])) return true
  // IPv4-mapped tail in the hex form `URL` normalizes to (`::ffff:7f00:1`): the
  // last two 16-bit groups carry the v4 (high octets, low octets).
  const hex = /:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
    if (isBlockedV4(v4)) return true
  }
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local
  if (/^f[cd]/.test(h)) return true // fc00::/7 unique-local
  return false
}

/** Classify a (non-IP) hostname as an internal / bare cluster egress target. */
function isBlockedHostname(host: string): boolean {
  if (host === 'localhost') return true
  // A bare, dot-less name only resolves inside a cluster's search domain
  // (`kubernetes`, `myservice`), never on the public internet.
  if (!host.includes('.')) return true
  return INTERNAL_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))
}

/**
 * Assert the resolved catalog URL is a safe egress target BEFORE any fetch. The
 * module header promises an https-only guard; with the `MODELS_DEV_API_URL` env
 * override in play, a misconfigured deploy could otherwise resolve to `http://`
 * or an internal host — cloud metadata (169.254.169.254), loopback (127.0.0.1,
 * [::1]), an RFC1918 address (10/8, 172.16/12, 192.168/16), or a cluster Service
 * (`.internal`, `.svc`, a bare `kubernetes`). This is a deploy-time input, not
 * operator/tenant-facing, but the boundary is real — so a bad URL is a hard
 * error, not a silent vendored-fallback that would hide the misconfiguration
 * forever.
 *
 * Approach: RANGE/suffix CLASSIFICATION, not a `models.dev`-only allowlist. The
 * documented purpose of the override is to point a non-prod plane at a local
 * stub (a host that is by definition NOT models.dev); a strict allowlist would
 * nullify the override entirely, so classification is used and every block is
 * driven by the target being internal, not by it not being models.dev.
 */
export function assertSafeCatalogUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    // The raw value may carry credentials, so it is never echoed.
    throw new Error('models.dev catalog URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`models.dev catalog URL must be https:// (got "${parsed.protocol}//")`)
  }
  // fetch refuses a URL with userinfo and its error would log the whole URL.
  if (parsed.username || parsed.password) {
    throw new Error('models.dev catalog URL must not contain credentials')
  }
  // `URL.hostname` keeps IPv6 literals wrapped in brackets ("[::1]"); strip them
  // so both the bracketed form and net.isIP() see the bare address.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const ipVersion = isIP(host)
  const blocked =
    ipVersion === 4
      ? isBlockedV4(host)
      : ipVersion === 6
        ? isBlockedV6(host)
        : isBlockedHostname(host)
  if (blocked) {
    throw new Error(`models.dev catalog URL host is not an allowed egress target: ${host}`)
  }
}
