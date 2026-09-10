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
