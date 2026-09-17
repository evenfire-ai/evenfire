import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  type LanBaseUrlReason,
  NON_PUBLIC_EGRESS_CIDRS,
  classifyLanBaseURL,
} from '@clerum/egress-policy'

const octet = () => fc.integer({ min: 0, max: 255 })
const ip = (a: fc.Arbitrary<number>, b: fc.Arbitrary<number>, c = octet(), d = octet()) =>
  fc.tuple(a, b, c, d).map(([w, x, y, z]) => `${w}.${x}.${y}.${z}`)

// Independent reference classifier: for the no-cluster-CIDR case, every IPv4
// falls into exactly one of these buckets. `reserved` is unreachable in this
// ordering (anything outside RFC1918 is already `not_private_lan`), matching
// the classifier's documented step order.
type Category = LanBaseUrlReason | 'ok'
function inRange(ipStr: string, base: [number, number, number, number], prefix: number): boolean {
  const toInt = (parts: number[]) => parts.reduce((acc, p) => ((acc << 8) + p) >>> 0, 0)
  const ipInt = toInt(ipStr.split('.').map(Number))
  const baseInt = toInt(base)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0
}
function expectedCategory(ipStr: string): Category {
  if (inRange(ipStr, [169, 254, 0, 0], 16)) return 'link_local'
  if (inRange(ipStr, [100, 64, 0, 0], 10)) return 'cgnat'
  if (
    inRange(ipStr, [10, 0, 0, 0], 8) ||
    inRange(ipStr, [172, 16, 0, 0], 12) ||
    inRange(ipStr, [192, 168, 0, 0], 16)
  ) {
    return 'ok'
  }
  return 'not_private_lan'
}

describe('classifyLanBaseURL — properties', () => {
  it('P1 totality: any string never throws and returns a valid union member', () => {
    const reasons = new Set<LanBaseUrlReason>([
      'invalid_url',
      'not_ip',
      'not_private_lan',
      'link_local',
      'cgnat',
      'cluster_internal',
      'reserved',
    ])
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.webUrl()), input => {
        const decision = classifyLanBaseURL(input)
        if (decision.ok) return typeof decision.ip === 'string'
        return reasons.has(decision.reason)
      })
    )
  })

  it('P2 every RFC1918 IPv4 is accepted via http://<ip>:8000/v1', () => {
    const rfc1918 = fc.oneof(
      ip(fc.constant(10), octet()),
      ip(fc.constant(172), fc.integer({ min: 16, max: 31 })),
      ip(fc.constant(192), fc.constant(168))
    )
    fc.assert(
      fc.property(rfc1918, addr => {
        const decision = classifyLanBaseURL(`http://${addr}:8000/v1`)
        return decision.ok && decision.ip === addr
      })
    )
  })

  it('P3 link-local → link_local, cgnat → cgnat, reserved never ok', () => {
    fc.assert(
      fc.property(ip(fc.constant(169), fc.constant(254)), addr => {
        const d = classifyLanBaseURL(`http://${addr}/latest`)
        return !d.ok && d.reason === 'link_local'
      })
    )
    fc.assert(
      fc.property(ip(fc.constant(100), fc.integer({ min: 64, max: 127 })), addr => {
        const d = classifyLanBaseURL(`http://${addr}/v1`)
        return !d.ok && d.reason === 'cgnat'
      })
    )
    // loopback / documentation / multicast / reserved: never accepted.
    const reserved = fc.oneof(
      ip(fc.constant(127), octet()),
      ip(fc.constant(192), fc.constant(0), fc.constant(2)),
      ip(fc.constant(224), octet()),
      ip(fc.constant(240), octet())
    )
    fc.assert(
      fc.property(reserved, addr => {
        const d = classifyLanBaseURL(`http://${addr}/v1`)
        return !d.ok
      })
    )
  })

  it('P4 DNS hostnames (incl. *.svc, *.cluster.local, metadata) → not_ip, never ok', () => {
    const label = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
        minLength: 1,
        maxLength: 8,
      })
      .map(chars => chars.join(''))
    const dnsName = fc
      .tuple(
        label,
        fc.constantFrom('svc', 'cluster.local', 'svc.cluster.local', 'internal', 'goog', 'com')
      )
      .map(([host, suffix]) => `${host}.${suffix}`)
    const withFixtures = fc.oneof(
      dnsName,
      fc.constantFrom(
        'localhost',
        'metadata.goog',
        'ollama.mcp-host.svc.cluster.local',
        'kubernetes.default.svc'
      )
    )
    fc.assert(
      fc.property(withFixtures, host => {
        const d = classifyLanBaseURL(`http://${host}:11434/v1`)
        return !d.ok && d.reason === 'not_ip'
      })
    )
  })

  it('P5 disjoint partitions: every IPv4 lands in exactly the expected category', () => {
    fc.assert(
      fc.property(ip(octet(), octet()), addr => {
        const d = classifyLanBaseURL(`http://${addr}:8000/v1`)
        const expected = expectedCategory(addr)
        if (expected === 'ok') return d.ok && d.ip === addr
        return !d.ok && d.reason === expected
      })
    )
  })
})

describe('NON_PUBLIC_EGRESS_CIDRS — drift guard against the deploy YAML', () => {
  it('matches deploy/base/public-egress-exceptions.yaml spec.ranges exactly (order included)', () => {
    const yamlPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../deploy/base/public-egress-exceptions.yaml'
    )
    const doc = parse(readFileSync(yamlPath, 'utf8')) as { spec?: { ranges?: unknown } }
    const ranges = doc.spec?.ranges
    expect(Array.isArray(ranges)).toBe(true)
    expect(ranges).toEqual([...NON_PUBLIC_EGRESS_CIDRS])
  })
})
