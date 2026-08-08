'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const core = require('./index.cjs')

const CFG = { overlapMs: 300_000, maxEntries: 128 }
const TTL = 15_000

const obsOk = (fqdn, ips, ttlMs = TTL, port = 443, protocol = 'TCP') => ({
  fqdn,
  port,
  protocol,
  kind: 'ok',
  ips,
  ttlMs,
})
const obsTransient = (fqdn, port = 443, protocol = 'TCP') => ({ fqdn, port, protocol, kind: 'transient' })
const obsPermanent = (fqdn, port = 443, protocol = 'TCP') => ({ fqdn, port, protocol, kind: 'permanent' })

const ipsOf = out => out.entries.map(e => e.ip).sort()

test('runtime exports stay aligned with the declaration file', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declared = Array.from(
    declarations.matchAll(/export declare (?:const|function)\s+([A-Za-z0-9_]+)/g),
    m => m[1]
  ).sort()
  assert.deepEqual(Object.keys(core).sort(), declared)
})

test('bootstrap: empty state has no entries', () => {
  assert.deepEqual(core.emptyState().entries, [])
})

test('accumulation: an ok observation adds each IP with expiresAt = now + ttl + overlap', () => {
  const out = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.1.1.1'])], 1000, CFG)
  assert.deepEqual(ipsOf(out), ['1.1.1.1'])
  assert.equal(out.entries[0].expiresAt, 1000 + TTL + CFG.overlapMs)
  assert.equal(out.changed, true)
})

test('sliding window: a rotated-away IP is kept until it expires (overlap), new IP added', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['A'])], 1000, CFG).state
  // t within overlap: gh now serves B; A must remain, B added
  const out = core.reconcileEgressState(s, [obsOk('gh', ['B'])], 20_000, CFG)
  assert.deepEqual(ipsOf(out), ['A', 'B'])
})

test('sliding window: re-observing an IP RENEWS its expiry (stable host stays forever)', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('st', ['S'], 60_000)], 1000, CFG).state
  const firstExpiry = s.entries[0].expiresAt
  // long after the first expiry would have been, but re-observed every round
  let now = firstExpiry + 1
  const out = core.reconcileEgressState(s, [obsOk('st', ['S'], 60_000)], now, CFG)
  assert.deepEqual(ipsOf(out), ['S'])
  assert.equal(out.entries[0].expiresAt, now + 60_000 + CFG.overlapMs)
})

// Audit M1: the write gate skips timestamp-only refreshes (H4), so the caller
// needs a signal to RE-PERSIST the renewed window before it goes stale —
// otherwise a stable-then-rotated IP is pruned with zero overlap grace. renewalDue
// fires when a surviving entry's PERSISTED window is within overlap/2 of lapsing.
test('M1 renewalDue: false right after a write (persisted window still fresh)', () => {
  const s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.1.1.1'])], 1000, CFG).state
  const out = core.reconcileEgressState(s, [obsOk('gh', ['1.1.1.1'])], 2000, CFG)
  assert.equal(out.changed, false, 'set unchanged')
  assert.equal(out.renewalDue, false, 'window is fresh — no write needed')
})

test('M1 renewalDue: true when the persisted window is within overlap/2 of lapsing (set unchanged)', () => {
  // expiresAt = 1000 + 15000 + 300000 = 316000; overlap/2 = 150000.
  const s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.1.1.1'])], 1000, CFG).state
  // now = 200000 → 316000 - 200000 = 116000 < 150000 → renewal due.
  const out = core.reconcileEgressState(s, [obsOk('gh', ['1.1.1.1'])], 200_000, CFG)
  assert.equal(out.changed, false, 'the IP set did not change — this is the M1 case')
  assert.equal(out.renewalDue, true, 'persist the renewed window to preserve overlap grace')
})

test('M1 renewalDue: false on bootstrap (no previous entries to renew)', () => {
  const out = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.1.1.1'])], 1000, CFG)
  assert.equal(out.changed, true)
  assert.equal(out.renewalDue, false)
})

// Audit R2-2: renewalDue must fire ONLY when a write would actually ADVANCE the
// entry's expiry. A FROZEN entry (transient DNS, H1) has a fixed expiresAt — a
// write cannot extend it, so forcing one every tick during a DNS outage is pure
// churn exactly when the control plane should be quiet.
test('R2-2 renewalDue: NOT due for a FROZEN entry whose expiry cannot advance', () => {
  const s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.1.1.1'])], 1000, CFG).state
  // sustained transient at a time within overlap/2 of the (frozen) expiry
  const out = core.reconcileEgressState(s, [obsTransient('gh')], 200_000, CFG)
  assert.deepEqual(out.frozenFqdns, ['gh'], 'entry is frozen (H1)')
  assert.equal(out.changed, false)
  assert.equal(out.renewalDue, false, 'a write cannot advance a frozen entry — no forced churn')
})

// A rotated-away IP that is being RETAINED (still within its window, not
// re-observed) also cannot be advanced by a write → no renewal churn for it.
test('R2-2 renewalDue: NOT due for a retained rotated-away IP (expiry cannot advance)', () => {
  // gh serves A, then rotates to B; A is retained. At a time where A is within
  // overlap/2 of expiry but B is fresh, renewalDue must be driven only by B, not A.
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.1.1.1'])], 1000, CFG).state
  // rotate to B at t=2000 (A retained, B fresh)
  s = core.reconcileEgressState(s, [obsOk('gh', ['2.2.2.2'])], 2000, CFG).state
  // at t=200000: A (expiresAt 316000) within overlap/2; B re-observed → B advances.
  const out = core.reconcileEgressState(s, [obsOk('gh', ['2.2.2.2'])], 200_000, CFG)
  // B is re-observed (advances) AND within overlap/2 (expiresAt 317000-200000=117000<150000)
  // so renewalDue is legitimately true — but driven by B, not the frozen A.
  assert.equal(out.renewalDue, true)
  // The point: if ONLY A were present (no advancing entry), renewalDue would be false.
  let sA = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.1.1.1'])], 1000, CFG).state
  sA = core.reconcileEgressState(sA, [obsOk('gh', ['2.2.2.2'])], 2000, CFG).state
  // now observe ONLY B-removed: gh still declared but serves nothing new; A & B retained/expire
  const outA = core.reconcileEgressState(sA, [obsTransient('gh')], 200_000, CFG)
  assert.equal(outA.renewalDue, false, 'no advancing entry → no renewal churn')
})

test('expiry: an IP not re-observed, past its expiry, with an OK observation for its fqdn, is removed', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['A'])], 1000, CFG).state
  const past = s.entries[0].expiresAt + 1
  const out = core.reconcileEgressState(s, [obsOk('gh', ['B'])], past, CFG)
  assert.deepEqual(ipsOf(out), ['B'])
})

test('H1 fail-static: a TRANSIENT observation does NOT expire the fqdn entries (freeze + alarm)', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['A'])], 1000, CFG).state
  const past = s.entries[0].expiresAt + 1
  const out = core.reconcileEgressState(s, [obsTransient('gh')], past, CFG)
  assert.deepEqual(ipsOf(out), ['A'], 'entry must survive a sustained resolver failure')
  assert.deepEqual(out.frozenFqdns, ['gh'])
})

// Audit F1 (issue #299): an FQDN with NO observation this round is no longer
// DECLARED (removed from the spec) — it must be REVOKED, not frozen. Freezing is
// reserved for a DECLARED fqdn whose DNS is transiently failing (an explicit
// transient observation). Keeping an undeclared fqdn's IPs forever is a
// regression worse than the original snapshot (egress never shrinks on removal).
test('F1 revoke: an UNOBSERVED (undeclared) fqdn is dropped, not frozen', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['A'])], 1000, CFG).state
  // no observation for gh at all this round (it was removed from the declared set)
  const out = core.reconcileEgressState(s, [], 1500, CFG) // well within the window
  assert.deepEqual(ipsOf(out), [], 'a removed fqdn must be revoked immediately')
  assert.deepEqual(out.frozenFqdns, [], 'an undeclared fqdn is never frozen')
})

test('F1 revoke: removing ONE fqdn keeps the still-declared one and drops the removed one', () => {
  let s = core.reconcileEgressState(
    core.emptyState(),
    [obsOk('gh', ['A']), obsOk('store', ['B'])],
    1000,
    CFG
  ).state
  // Next round declares only `store`; `gh` was removed from the spec.
  const out = core.reconcileEgressState(s, [obsOk('store', ['B'])], 1500, CFG)
  assert.deepEqual(ipsOf(out), ['B'], 'gh revoked, store retained')
})

test('permanent (no records) lets entries expire normally (not frozen)', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['A'])], 1000, CFG).state
  const past = s.entries[0].expiresAt + 1
  const out = core.reconcileEgressState(s, [obsPermanent('gh')], past, CFG)
  assert.deepEqual(ipsOf(out), [])
  assert.deepEqual(out.frozenFqdns, [])
})

test('a caducated IP that reappears enters as NEW (does not revive the old expiry)', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['A'])], 1000, CFG).state
  const past = s.entries[0].expiresAt + 1
  s = core.reconcileEgressState(s, [obsOk('gh', ['B'])], past, CFG).state // A expired
  const out = core.reconcileEgressState(s, [obsOk('gh', ['A'])], past + 10, CFG)
  const a = out.entries.find(e => e.ip === 'A')
  assert.equal(a.expiresAt, past + 10 + TTL + CFG.overlapMs)
})

test('H3 eviction: on overflow, evict soonest-to-expire; NEVER reject; keep the newly observed', () => {
  const cfg3 = { overlapMs: 300_000, maxEntries: 3 }
  // three old entries (short ttl → sooner expiry)
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('h', ['o1', 'o2', 'o3'], 1000)], 1000, cfg3).state
  // one fresh entry (long ttl → later expiry) pushes over the cap
  const out = core.reconcileEgressState(s, [obsOk('h', ['fresh'], 60_000)], 1500, cfg3)
  assert.equal(out.entries.length, 3, 'capped, never rejected/truncated to fewer')
  assert.equal(out.overCap, true)
  assert.equal(out.evicted.length, 1)
  assert.ok(out.entries.some(e => e.ip === 'fresh'), 'newly observed IP must never be evicted')
  assert.ok(['o1', 'o2', 'o3'].includes(out.evicted[0].ip), 'evicted one of the soonest-to-expire')
})

test('H3 eviction: soonest-to-expire, NOT oldest-by-insertion (a re-observed old entry survives)', () => {
  const cfg2 = { overlapMs: 300_000, maxEntries: 2 }
  // 'stable' inserted first but re-observed with long ttl; two younger entries with short ttl
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('h', ['stable'], 60_000)], 1000, cfg2).state
  s = core.reconcileEgressState(s, [obsOk('h', ['stable', 'y1'], 60_000)], 2000, cfg2).state
  const out = core.reconcileEgressState(s, [obsOk('h', ['stable', 'y2'], 1000)], 3000, cfg2)
  assert.ok(
    out.entries.some(e => e.ip === 'stable'),
    'the oldest-by-insertion but re-observed entry must survive'
  )
})

test('H4 no-op: a refresh with the same IPs (only expiry renewed) does not change the hash', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['A', 'B'])], 1000, CFG).state
  const out = core.reconcileEgressState(s, [obsOk('gh', ['A', 'B'])], 5000, CFG)
  assert.equal(out.changed, false, 'renewing timestamps only must be a no-op write')
})

test('changed=true when a new IP is added, and when one is removed', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['A'])], 1000, CFG).state
  assert.equal(core.reconcileEgressState(s, [obsOk('gh', ['A', 'C'])], 2000, CFG).changed, true)
  const past = s.entries[0].expiresAt + 1
  assert.equal(core.reconcileEgressState(s, [obsOk('gh', ['C'])], past, CFG).changed, true)
})

test('stateHash excludes expiresAt (same IPs, different expiry → same hash)', () => {
  const a = [{ ip: '1.1.1.1', port: 443, protocol: 'TCP', fqdn: 'x', expiresAt: 10 }]
  const b = [{ ip: '1.1.1.1', port: 443, protocol: 'TCP', fqdn: 'x', expiresAt: 999999 }]
  assert.equal(core.stateHash(a), core.stateHash(b))
})

test('serializeState is deterministic regardless of entry order', () => {
  const s1 = { entries: [
    { ip: '2.2.2.2', port: 443, protocol: 'TCP', fqdn: 'b', expiresAt: 5 },
    { ip: '1.1.1.1', port: 443, protocol: 'TCP', fqdn: 'a', expiresAt: 9 },
  ] }
  const s2 = { entries: [...s1.entries].reverse() }
  assert.deepEqual(core.serializeState(s1), core.serializeState(s2))
})

test('H5 rehydration: new-format annotations round-trip faithfully', () => {
  const s = core.reconcileEgressState(
    core.emptyState(),
    [obsOk('gh', ['1.1.1.1', '2.2.2.2'])],
    1000,
    CFG
  ).state
  const ann = core.serializeState(s)
  const back = core.parseState(ann, 2000, CFG)
  assert.deepEqual(ipsOf({ entries: back.entries }), ['1.1.1.1', '2.2.2.2'])
})

// Audit F3: a corrupted/tampered annotation with a malformed ip must NOT be
// rehydrated — otherwise it renders as "<junk>/32", which the apiserver rejects
// with 422, bricking the policy in a reconcile-error loop.
test('F3 rehydration hardening: entries with a malformed ip are dropped', () => {
  const raw = JSON.stringify([
    { ip: '140.82.112.3', port: 443, protocol: 'TCP', fqdn: 'gh', expiresAt: 9e12, lastObservedAt: 1000 },
    { ip: 'not-an-ip', port: 443, protocol: 'TCP', fqdn: 'gh', expiresAt: 9e12, lastObservedAt: 1000 },
    { ip: '10.0.0.999', port: 443, protocol: 'TCP', fqdn: 'gh', expiresAt: 9e12, lastObservedAt: 1000 },
    { ip: '1.2.3.4/32', port: 443, protocol: 'TCP', fqdn: 'gh', expiresAt: 9e12, lastObservedAt: 1000 },
  ])
  const back = core.parseState({ [core.STATE_ANNOTATION]: raw }, 2000, CFG)
  assert.deepEqual(back.entries.map(e => e.ip), ['140.82.112.3'], 'only the valid IPv4 survives')
})

test('F3 rehydration hardening: legacy targets with a malformed ip are dropped', () => {
  const legacy = { [core.TARGETS_ANNOTATION]: 'gh=140.82.112.3/32,bad=nonsense/32' }
  const back = core.parseState(legacy, 1000, CFG)
  assert.deepEqual(back.entries.map(e => e.ip), ['140.82.112.3'])
})

test('H5 rehydration: legacy egress-fqdn-targets is NOT blanked (bounded grace)', () => {
  const legacy = { [core.TARGETS_ANNOTATION]: 'gh=140.82.112.3/32,gh=140.82.112.4/32' }
  const back = core.parseState(legacy, 1000, CFG)
  assert.deepEqual(back.entries.map(e => e.ip).sort(), ['140.82.112.3', '140.82.112.4'])
  assert.equal(back.entries[0].expiresAt, 1000 + CFG.overlapMs, 'bounded grace, TTL unknown')
})

test('H5 rehydration: unparseable annotations yield empty state (caller keeps live policy)', () => {
  assert.deepEqual(core.parseState({ 'clerum.io/egress-fqdn-state': '{not json' }, 1000, CFG).entries, [])
  assert.deepEqual(core.parseState({}, 1000, CFG).entries, [])
})

test('ok with empty ips adds nothing and allows expiry of stale entries for that fqdn', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['A'])], 1000, CFG).state
  const past = s.entries[0].expiresAt + 1
  const out = core.reconcileEgressState(s, [obsOk('gh', [])], past, CFG)
  assert.deepEqual(ipsOf(out), [])
})

// ─── classifyDnsError: the shared transient-vs-permanent contract (issue #299) ──
// One source of truth for "is this DNS failure transient?" used by BOTH the WRC
// and HCC resolvers, so fail-static freezing behaves identically platform-wide.
test('classifyDnsError treats resolver/upstream failures as transient', () => {
  for (const code of ['EAI_AGAIN', 'ESERVFAIL', 'ETIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'EREFUSED', 'ECONNRESET', 'ENETUNREACH']) {
    assert.equal(core.classifyDnsError(code), 'transient', `${code} should be transient`)
  }
})

test('classifyDnsError treats genuine no-records answers as permanent', () => {
  assert.equal(core.classifyDnsError('ENODATA'), 'permanent')
  assert.equal(core.classifyDnsError('ENOTFOUND'), 'permanent')
})

test('classifyDnsError reads the code off an Error object', () => {
  const err = Object.assign(new Error('query ESERVFAIL'), { code: 'ESERVFAIL' })
  assert.equal(core.classifyDnsError(err), 'transient')
  const perm = Object.assign(new Error('query ENOTFOUND'), { code: 'ENOTFOUND' })
  assert.equal(core.classifyDnsError(perm), 'permanent')
})

test('classifyDnsError defaults unknown/undefined codes to permanent (matches WRC)', () => {
  assert.equal(core.classifyDnsError(undefined), 'permanent')
  assert.equal(core.classifyDnsError('ESOMETHINGWEIRD'), 'permanent')
  assert.equal(core.classifyDnsError(new Error('no code')), 'permanent')
})
