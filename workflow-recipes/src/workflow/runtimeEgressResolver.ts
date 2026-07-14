import * as dns from 'node:dns/promises'
import { PUBLIC_HTTP_EGRESS_EXCEPT_CIDRS } from './networkPolicyFactory'

export type RuntimeHttpEgressResolver = (hosts: string[]) => Promise<string[]>
export type DnsResolve4 = (host: string) => Promise<string[]>
const MAX_RUNTIME_HTTP_EGRESS_DNS_CONCURRENCY = 8

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
    value = (value << 8) + octet
  }
  return value >>> 0
}

function cidrToRange(cidr: string): { base: number; mask: number } | undefined {
  const [ip, prefixText] = cidr.split('/')
  const base = ipv4ToNumber(ip)
  const prefix = Number(prefixText)
  if (base === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return undefined
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return { base: base & mask, mask }
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const value = ipv4ToNumber(ip)
  const range = cidrToRange(cidr)
  if (value === undefined || range === undefined) return false
  return (value & range.mask) === range.base
}

function isDisallowedRuntimeEgressIp(ip: string): boolean {
  return PUBLIC_HTTP_EGRESS_EXCEPT_CIDRS.some(cidr => isIpInCidr(ip, cidr))
}

export function isAllowedRuntimeHttpEgressCidr(cidr: string): boolean {
  const [ip, prefixText] = cidr.split('/')
  if (!ip || prefixText !== '32') return false
  if (ipv4ToNumber(ip) === undefined) return false
  return !isDisallowedRuntimeEgressIp(ip)
}

export async function resolveRuntimeHttpEgressCidrs(
  hosts: string[],
  resolve4: DnsResolve4 = dns.resolve4
): Promise<string[]> {
  const uniqueHosts = [...new Set(hosts)].sort()
  const hostCidrs = new Map<string, string[]>()
  const failures: string[] = []
  let index = 0

  async function resolveHost(host: string): Promise<void> {
    let ips: string[]
    try {
      ips = await resolve4(host)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`failed to resolve runtime HTTP egress host "${host}": ${reason}`)
    }

    if (ips.length === 0) {
      throw new Error(`runtime HTTP egress host "${host}" resolved to no IPv4 addresses`)
    }

    const resolvedCidrs = new Set<string>()
    for (const ip of ips) {
      if (ipv4ToNumber(ip) === undefined) {
        throw new Error(`runtime HTTP egress host "${host}" resolved invalid IPv4 "${ip}"`)
      }
      if (isDisallowedRuntimeEgressIp(ip)) {
        throw new Error(`runtime HTTP egress host "${host}" resolved disallowed address "${ip}"`)
      }
      const cidr = `${ip}/32`
      resolvedCidrs.add(cidr)
    }
    hostCidrs.set(host, [...resolvedCidrs].sort())
  }

  const workers = Array.from(
    { length: Math.min(MAX_RUNTIME_HTTP_EGRESS_DNS_CONCURRENCY, uniqueHosts.length) },
    async () => {
      while (index < uniqueHosts.length) {
        const host = uniqueHosts[index++]
        try {
          await resolveHost(host)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
    }
  )
  await Promise.allSettled(workers)

  if (failures.length > 0) {
    throw new Error(failures.sort().join('; '))
  }

  const cidrs = new Set<string>()
  for (const cidrsForHost of [...hostCidrs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const cidr of cidrsForHost[1]) cidrs.add(cidr)
  }
  return [...cidrs].sort()
}
