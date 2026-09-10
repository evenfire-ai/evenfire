import { Resolver } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { FetchPageError } from './fetchPageError.js'

// Conservative public-web policy. Deliberately also excludes globally reachable
// special-purpose services: they are not ordinary web destinations. Sources,
// reviewed 2026-09-10 (both registries last updated 2025-10-09):
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family !== 6 || address.includes('%')) return false
  // ISATAP can encode an inner IPv4 destination in a global IPv6 prefix.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const halves = canonical.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const groups =
    halves.length === 1
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  if ([0, 0x200].includes(parseInt(groups[4], 16)) && parseInt(groups[5], 16) === 0x5efe)
    return false
  // Only ordinary global unicast. This excludes mapped/compatible IPv4,
  // NAT64, link/site-local, ULA, multicast and unallocated top-level spaces.
  return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

export function parsePageUrl(input: string): URL {
  if (Buffer.byteLength(input, 'utf8') > 8192 || /[\u0000-\u0020\u007f\\]/.test(input)) {
    throw new FetchPageError('invalid_url')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new FetchPageError('invalid_url')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.port === '0'
  ) {
    throw new FetchPageError('invalid_url')
  }
  url.hash = ''
  return url
}

export async function resolvePageAddress(url: URL, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new FetchPageError('destination_blocked')
    return hostname
  }
  const resolver = new Resolver({ timeout: 15000, tries: 1 })
  const cancel = () => resolver.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const records = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ])
    signal.throwIfAborted()
    const addresses: string[] = []
    for (const result of records) {
      if (result.status === 'fulfilled') addresses.push(...result.value)
      // ENODATA is conclusive absence for this record type. NXDOMAIN paired
      // with an answer is inconsistent, and SERVFAIL/timeouts are not absence.
      else if ((result.reason as NodeJS.ErrnoException)?.code !== 'ENODATA') {
        throw new FetchPageError('upstream_failure')
      }
    }
    if (!addresses.length) throw new FetchPageError('upstream_failure')
    if (addresses.some(address => !isPublicAddress(address)))
      throw new FetchPageError('destination_blocked')
    return addresses[0]
  } finally {
    signal.removeEventListener('abort', cancel)
    resolver.cancel()
  }
}
