'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const policy = require('./index.cjs')

test('runtime exports stay aligned with the declaration file', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declared = Array.from(
    declarations.matchAll(/export declare (?:const|function)\s+([A-Za-z0-9_]+)/g),
    m => m[1]
  ).sort()
  assert.deepEqual(Object.keys(policy).sort(), declared)
})

test('NON_PUBLIC_EGRESS_CIDRS has exactly 18 entries', () => {
  assert.equal(policy.NON_PUBLIC_EGRESS_CIDRS.length, 18)
})

test('PRIVATE_LAN_CIDRS is the RFC1918 triple and a subset of NON_PUBLIC_EGRESS_CIDRS', () => {
  assert.deepEqual(
    [...policy.PRIVATE_LAN_CIDRS],
    ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']
  )
  for (const cidr of policy.PRIVATE_LAN_CIDRS) {
    assert.ok(
      policy.NON_PUBLIC_EGRESS_CIDRS.includes(cidr),
      `${cidr} must appear in NON_PUBLIC_EGRESS_CIDRS`
    )
  }
})

test('LAN / link-local / CGNAT categories do not overlap each other', () => {
  const categories = [
    ...policy.PRIVATE_LAN_CIDRS,
    '169.254.0.0/16', // link-local
    '100.64.0.0/10', // CGNAT
  ]
  for (let i = 0; i < categories.length; i++) {
    for (let j = i + 1; j < categories.length; j++) {
      assert.equal(
        policy.cidrOverlaps(categories[i], categories[j]),
        false,
        `${categories[i]} must not overlap ${categories[j]}`
      )
    }
  }
})

test('parseCidr preserves the canonical flag', () => {
  assert.equal(policy.parseCidr('10.0.0.0/8').canonical, true)
  assert.equal(policy.parseCidr('10.0.0.1/8').canonical, false)
  assert.equal(policy.parseCidr('not-a-cidr'), null)
})

test('classifyLanBaseURL: RFC1918 literals are accepted', () => {
  for (const ip of ['10.0.0.5', '172.16.9.9', '192.168.1.10']) {
    assert.deepEqual(policy.classifyLanBaseURL(`http://${ip}:8000/v1`), { ok: true, ip })
  }
})

test('classifyLanBaseURL: metadata, cgnat, link-local, reserved, DNS names are rejected', () => {
  assert.deepEqual(policy.classifyLanBaseURL('http://169.254.169.254/latest'), {
    ok: false,
    reason: 'link_local',
  })
  assert.deepEqual(policy.classifyLanBaseURL('http://100.64.0.1/v1'), {
    ok: false,
    reason: 'cgnat',
  })
  assert.deepEqual(policy.classifyLanBaseURL('http://8.8.8.8/v1'), {
    ok: false,
    reason: 'not_private_lan',
  })
  assert.deepEqual(policy.classifyLanBaseURL('http://127.0.0.1/v1'), {
    ok: false,
    reason: 'not_private_lan',
  })
  assert.deepEqual(policy.classifyLanBaseURL('http://metadata.goog/v1'), {
    ok: false,
    reason: 'not_ip',
  })
  assert.deepEqual(policy.classifyLanBaseURL('http://ollama.mcp-host.svc.cluster.local:11434/v1'), {
    ok: false,
    reason: 'not_ip',
  })
  assert.deepEqual(policy.classifyLanBaseURL('http://localhost:8000/v1'), {
    ok: false,
    reason: 'not_ip',
  })
  assert.deepEqual(policy.classifyLanBaseURL('not a url'), { ok: false, reason: 'invalid_url' })
  assert.deepEqual(policy.classifyLanBaseURL(undefined), { ok: false, reason: 'invalid_url' })
})

test('classifyLanBaseURL: clusterInternalCidrs shadows a LAN IP when provided', () => {
  assert.deepEqual(
    policy.classifyLanBaseURL('http://10.42.0.7:8000/v1', {
      clusterInternalCidrs: ['10.42.0.0/16'],
    }),
    { ok: false, reason: 'cluster_internal' }
  )
})

test('classifyLanBaseURL: a malformed clusterInternalCidrs entry fails closed (cluster_cidr_invalid)', () => {
  // A CIDR missing its prefix cannot be checked for overlap; without the guard
  // this baseURL would slip through as a plain RFC1918 address (ok:true).
  assert.deepEqual(
    policy.classifyLanBaseURL('http://10.96.0.1/', { clusterInternalCidrs: ['10.96.0.0'] }),
    { ok: false, reason: 'cluster_cidr_invalid' }
  )
})

test('classifyLanBaseURL: control-plane / node-agent ports are denied on a clean LAN IP', () => {
  // kubelet, apiserver, etcd — rejected even though the host is RFC1918.
  assert.deepEqual(policy.classifyLanBaseURL('http://192.168.1.50:10250/'), {
    ok: false,
    reason: 'port_denied',
  })
  assert.deepEqual(policy.classifyLanBaseURL('http://192.168.1.50:6443/'), {
    ok: false,
    reason: 'port_denied',
  })
  assert.deepEqual(policy.classifyLanBaseURL('http://192.168.1.50:2379/'), {
    ok: false,
    reason: 'port_denied',
  })
  // A non-control-plane port (and the https default 443) stays accepted.
  assert.deepEqual(policy.classifyLanBaseURL('http://192.168.1.50:8000/v1'), {
    ok: true,
    ip: '192.168.1.50',
  })
  assert.deepEqual(policy.classifyLanBaseURL('https://192.168.1.50/v1'), {
    ok: true,
    ip: '192.168.1.50',
  })
})

test('CONTROL_PLANE_DENIED_PORTS covers the documented ports', () => {
  for (const p of [2379, 2380, 4194, 6443, 8443, 10250, 10259]) {
    assert.ok(policy.CONTROL_PLANE_DENIED_PORTS.includes(p), `port ${p} must be denied`)
  }
})

test('brokerNameFor: deterministic, DNS-safe, per-(host,slot)', () => {
  const name = policy.brokerNameFor('h1', 'primary')
  // Stable across calls (deterministic hash).
  assert.equal(name, policy.brokerNameFor('h1', 'primary'))
  // Shape: oai-egress- + 16 hex chars.
  assert.match(name, /^oai-egress-[0-9a-f]{16}$/)
  // DNS-1123 label (<= 63 chars, lowercase alnum/-).
  assert.ok(name.length <= 63)
  // Distinct host, slot, and the (host,slot) separator all change the name.
  assert.notEqual(name, policy.brokerNameFor('h2', 'primary'))
  assert.notEqual(name, policy.brokerNameFor('h1', 'fallback-0'))
  // Separator is unambiguous: ('h1','x') must not collide with ('h1x','') etc.
  assert.notEqual(policy.brokerNameFor('a', 'bc'), policy.brokerNameFor('ab', 'c'))
})

test('fallbackSlotId / PRIMARY_SLOT_ID match the HCC scheme', () => {
  assert.equal(policy.PRIMARY_SLOT_ID, 'primary')
  assert.equal(policy.fallbackSlotId(0), 'fallback-0')
  assert.equal(policy.fallbackSlotId(3), 'fallback-3')
})

test('brokerServiceHost builds the in-cluster FQDN from a caller-supplied namespace', () => {
  assert.equal(
    policy.brokerServiceHost('oai-egress-abc', 'llm-egress'),
    'oai-egress-abc.llm-egress.svc.cluster.local'
  )
})

test('brokerInternalUrl composes the full dial URL and defaults an empty path to /', () => {
  const name = policy.brokerNameFor('h1', 'primary')
  assert.equal(
    policy.brokerInternalUrl('h1', 'primary', {
      namespace: 'llm-egress',
      port: 3000,
      pathname: '/v1',
    }),
    `http://${name}.llm-egress.svc.cluster.local:3000/v1`
  )
  // Missing/empty pathname → '/'
  assert.equal(
    policy.brokerInternalUrl('h1', 'primary', { namespace: 'llm-egress', port: 3000 }),
    `http://${name}.llm-egress.svc.cluster.local:3000/`
  )
})

test('broker-name contract vectors: slotId + brokerName match the shared scheme', () => {
  const { vectors } = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../../tests/contracts/oai-egress-broker-name-vectors.json'),
      'utf8'
    )
  )
  assert.ok(Array.isArray(vectors) && vectors.length >= 3)
  for (const v of vectors) {
    const slotId =
      v.slot.kind === 'primary' ? policy.PRIMARY_SLOT_ID : policy.fallbackSlotId(v.slot.index)
    assert.equal(slotId, v.slotId, `slotId for ${v.label}`)
    assert.equal(
      policy.brokerNameFor(v.hostName, slotId),
      v.brokerName,
      `brokerName for ${v.label}`
    )
  }
})
