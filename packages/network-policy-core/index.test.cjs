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

// Audit M2: a hostile/misconfigured authoritative TTL must be clamped so an
// entry cannot be pinned for years.
test('M2 TTL clamp: an absurd TTL is bounded to 24h + overlap', () => {
  const day = 24 * 60 * 60 * 1000
  const out = core.reconcileEgressState(
    core.emptyState(),
    [{ fqdn: 'gh', port: 443, protocol: 'TCP', kind: 'ok', ips: ['1.2.3.4'], ttlMs: 2 ** 31 * 1000 }],
    1000,
    CFG
  )
  assert.equal(out.entries[0].expiresAt, 1000 + day + CFG.overlapMs, 'TTL clamped to 24h')
})

// Audit L1: F3 hardening extended to port/expiresAt — a tampered annotation with
// an out-of-range port or non-finite expiry must be dropped, not rendered as an
// invalid ipBlock (apiserver 422 loop).
test('L1 rehydration hardening: entries with an out-of-range port or bad expiry are dropped', () => {
  const raw = JSON.stringify([
    { ip: '1.1.1.1', port: 443, protocol: 'TCP', fqdn: 'ok', expiresAt: 9e12, lastObservedAt: 1000 },
    { ip: '2.2.2.2', port: 1000000000, protocol: 'TCP', fqdn: 'bigport', expiresAt: 9e12, lastObservedAt: 1000 },
    { ip: '3.3.3.3', port: 0, protocol: 'TCP', fqdn: 'zeroport', expiresAt: 9e12, lastObservedAt: 1000 },
    { ip: '4.4.4.4', port: 443, protocol: 'TCP', fqdn: 'nanexp', expiresAt: NaN, lastObservedAt: 1000 },
  ])
  const back = core.parseState({ [core.STATE_ANNOTATION]: raw }, 2000, CFG)
  assert.deepEqual(back.entries.map(e => e.ip), ['1.1.1.1'], 'only the valid entry survives')
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

// ─── H-A: revocation/freeze keyed by (fqdn,port,protocol), not fqdn alone ──────
// The state map is keyed by (fqdn,ip,port,protocol) but classification used to be
// keyed by fqdn only, so an entry whose declared PORT was removed survived under
// the still-declared fqdn's `ok` branch (and was frozen forever under a transient
// failure). Revocation must track the full declared identity.
test('H-A: changing a declared port REVOKES the old-port entry immediately', () => {
  let s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.2.3.4'], TTL, 443)], 1000, CFG)
    .state
  assert.deepEqual(
    s.entries.map(e => `${e.ip}:${e.port}`),
    ['1.2.3.4:443']
  )
  // gh is re-declared on 8443 ONLY (443 removed); same IP resolves.
  const out = core.reconcileEgressState(s, [obsOk('gh', ['1.2.3.4'], TTL, 8443)], 2000, CFG)
  assert.deepEqual(
    out.entries.map(e => `${e.ip}:${e.port}`).sort(),
    ['1.2.3.4:8443'],
    'the removed port 443 must be revoked; only the still-declared 8443 remains'
  )
})

test('H-A: a removed port is revoked even while the still-declared port DNS-fails', () => {
  const s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.2.3.4'], TTL, 443)], 1000, CFG)
    .state
  // 443 removed from the spec; 8443 declared but DNS transiently failing.
  const out = core.reconcileEgressState(s, [obsTransient('gh', 8443)], 2000, CFG)
  assert.deepEqual(
    out.entries.map(e => `${e.ip}:${e.port}`),
    [],
    'the removed 443 identity is revoked; the transient freeze only protects the declared 8443'
  )
})

test('H-A: a transient failure still freezes the SAME declared identity', () => {
  const s = core.reconcileEgressState(core.emptyState(), [obsOk('gh', ['1.2.3.4'], TTL, 443)], 1000, CFG)
    .state
  // gh:443 is still declared; DNS transiently fails → freeze, do not prune.
  const out = core.reconcileEgressState(s, [obsTransient('gh', 443)], 2000, CFG)
  assert.deepEqual(
    out.entries.map(e => `${e.ip}:${e.port}`),
    ['1.2.3.4:443'],
    'the declared identity is frozen (H1) while its own DNS fails'
  )
  assert.deepEqual(out.frozenFqdns, ['gh'])
})

// ─── H-B: legacy migration derives port/protocol from the declaration ─────────
// The portless `egress-fqdn-targets` legacy annotation must migrate to the port
// the target is CURRENTLY declared on, not a guessed 443/TCP, and must drop pairs
// for FQDNs that are no longer declared.
test('H-B: legacy targets migrate to the DECLARED port, not a guessed 443', () => {
  const legacy = { [core.TARGETS_ANNOTATION]: 'db.example.com=10.0.0.5/32' }
  const declarations = [{ fqdn: 'db.example.com', port: 5432 }]
  const back = core.parseState(legacy, 1000, CFG, declarations)
  assert.deepEqual(
    back.entries.map(e => `${e.ip}:${e.port}`),
    ['10.0.0.5:5432'],
    'migrated at the declared 5432, NOT widened to 443'
  )
})

test('H-B: legacy targets for an UNDECLARED fqdn are dropped', () => {
  const legacy = {
    [core.TARGETS_ANNOTATION]: 'gone.example.com=10.0.0.9/32,db.example.com=10.0.0.5/32',
  }
  const declarations = [{ fqdn: 'db.example.com', port: 5432 }]
  const back = core.parseState(legacy, 1000, CFG, declarations)
  assert.deepEqual(
    back.entries.map(e => `${e.fqdn}:${e.port}`),
    ['db.example.com:5432'],
    'the undeclared gone.example.com is dropped; only the declared db survives'
  )
})

test('H-B: without declarations, legacy falls back to the historical 443 grace', () => {
  const legacy = { [core.TARGETS_ANNOTATION]: 'gh=140.82.112.3/32' }
  const back = core.parseState(legacy, 1000, CFG)
  assert.deepEqual(back.entries.map(e => `${e.ip}:${e.port}`), ['140.82.112.3:443'])
})

// M-C prong 2: the serialized state annotation must stay under the byte budget
// regardless of FQDN length. A fixed entry-count cap cannot bound bytes (a
// 253-char FQDN serializes ~5× a short one); an oversized annotation 422s at the
// apiserver and loops the reconcile.
// R1-M1 (zach88): the eviction must budget STATE **and** TARGETS together — the
// 256KB apiserver cap is on the SUM of all annotations, and serializeState emits
// both `egress-fqdn-state` and `egress-fqdn-targets` from the same entries. A
// long-FQDN set that fits under a STATE-only budget can still blow the combined
// limit and trigger the exact 422 reconcile loop the guard exists to prevent.
test('R1-M1 byte cap: STATE + TARGETS together never exceed the 256KB apiserver limit', () => {
  const longFqdn = `${'a'.repeat(240)}.example.com` // ~252 chars
  const bigCfg = { overlapMs: 300_000, maxEntries: 4096 } // count cap won't bite first
  const ips = Array.from({ length: 900 }, (_, i) => `10.${Math.floor(i / 256)}.${i % 256}.1`)
  const out = core.reconcileEgressState(core.emptyState(), [obsOk(longFqdn, ips, TTL, 443)], 1000, bigCfg)
  const ann = core.serializeState(out.state)
  // The apiserver caps total annotation size by UTF-8 BYTES (Go len()), so the
  // budget and this assertion must both measure bytes, never UTF-16 .length.
  const total =
    Buffer.byteLength(ann[core.STATE_ANNOTATION], 'utf8') +
    Buffer.byteLength(ann[core.TARGETS_ANNOTATION], 'utf8')
  assert.ok(total <= 262144, `STATE+TARGETS = ${total} bytes, must be <= 262144 (256KB)`)
  assert.ok(out.entries.length > 0, 'not everything was evicted')
  assert.ok(out.entries.length < 900, 'byte-budget eviction dropped the overflow')
  assert.equal(out.overCap, true, 'overCap flags the eviction for the alarm/metric')
})

// R2-M1 (zach88 round-2): the byte budget must charge UTF-8 bytes, not UTF-16
// code units. A multi-byte FQDN ('ü' = 1 code unit but 2 UTF-8 bytes) makes a
// .length-based meter under-count, so serializeState can emit an annotation that
// clears the flawed budget yet exceeds the apiserver's real 256KB byte cap —
// the exact 422 reconcile loop the guard exists to prevent. Fails red on a
// .length meter; green once sizeOf measures Buffer.byteLength(...,'utf8').
test('R2-M1 byte cap: multi-byte FQDN is bounded by UTF-8 bytes, not UTF-16 length', () => {
  const longFqdn = `${'ü'.repeat(120)}.example.com` // .length ~132, utf8 ~252 bytes
  const bigCfg = { overlapMs: 300_000, maxEntries: 4096 } // count cap won't bite first
  const ips = Array.from({ length: 900 }, (_, i) => `10.${Math.floor(i / 256)}.${i % 256}.1`)
  const out = core.reconcileEgressState(core.emptyState(), [obsOk(longFqdn, ips, TTL, 443)], 1000, bigCfg)
  const ann = core.serializeState(out.state)
  const total =
    Buffer.byteLength(ann[core.STATE_ANNOTATION], 'utf8') +
    Buffer.byteLength(ann[core.TARGETS_ANNOTATION], 'utf8')
  assert.ok(total <= 262144, `STATE+TARGETS = ${total} utf8 bytes, must be <= 262144 (256KB)`)
  assert.ok(out.entries.length > 0, 'not everything was evicted')
  assert.ok(out.entries.length < 900, 'byte-budget eviction dropped the overflow')
  assert.equal(out.overCap, true, 'overCap flags the eviction for the alarm/metric')
})

// ───────────────────────────────────────────────────────────────────────────
// issue #299 Phase 2 — provider-CIDR core (Part A). RED-first: CORE-1..17.
// These functions are provider-BLIND; provider data is injected by the caller.
// ───────────────────────────────────────────────────────────────────────────

const registry = require('./providerRegistry.cjs')

// Real GitHub /meta `api` IPv4 set (Part 0.3; fetched live 2026-08-12). All 24
// entries are already canonical network addresses and mutually disjoint.
const API_24 = [
  '192.30.252.0/22', '185.199.108.0/22', '140.82.112.0/20', '143.55.64.0/20',
  '20.201.28.148/32', '20.205.243.168/32', '20.87.245.6/32', '4.237.22.34/32',
  '4.228.31.149/32', '20.207.73.85/32', '20.27.177.116/32', '20.200.245.245/32',
  '20.175.192.149/32', '20.233.83.146/32', '20.29.134.17/32', '20.199.39.228/32',
  '20.217.135.0/32', '4.225.11.201/32', '4.208.26.200/32', '20.26.156.210/32',
  '172.182.252.137/32', '4.249.131.166/32', '48.202.248.39/32', '48.204.201.2/32',
]

const ipToNum = ip => ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0)
const startOf = cidr => {
  const [ip, p] = cidr.split('/')
  const prefix = Number(p)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipToNum(ip) & mask) >>> 0
}
const isSortedByStart = ranges => ranges.every((r, i) => i === 0 || startOf(ranges[i - 1]) <= startOf(r))

test('CORE-1 (G1) export surface snapshot: exactly the Phase-1 + provider-CIDR names', () => {
  assert.deepEqual(Object.keys(core).sort(), [
    'BLOCKED_EXTERNAL_EGRESS_CIDRS', 'RESOLVED_AT_ANNOTATION', 'STATE_ANNOTATION',
    'TARGETS_ANNOTATION', 'cidrOverlaps', 'cidrRange', 'classifyDnsError', 'emptyState',
    'isAllowedExternalEgressCidr', 'parseProviderNetblocks', 'parseState',
    'partitionCidrsByFamily', 'partitionIpsByProviderRanges', 'reconcileEgressState',
    'resolveProviderRanges', 'serializeState', 'stateHash', 'validateProviderRanges',
  ])
})

test('CORE-2 (H1) the real 24-CIDR GitHub api set validates and stays 24 (DOA count-cap fix)', () => {
  const r = core.validateProviderRanges(API_24)
  assert.equal(r.kind, 'ok')
  assert.equal(r.ranges.length, 24)
  assert.deepEqual(new Set(r.ranges), new Set(API_24))
  assert.ok(isSortedByStart(r.ranges), 'ranges sorted ascending by numeric start')
  assert.equal(r.ranges[0], '4.208.26.200/32')
  assert.equal(r.ranges[23], '192.30.252.0/22')
})

test('CORE-3 (H1) count cap rejects 257, accepts 256', () => {
  const many = Array.from({ length: 257 }, (_, i) => `5.${Math.floor(i / 256)}.${i % 256}.0/24`)
  const bad = core.validateProviderRanges(many)
  assert.equal(bad.kind, 'invalid')
  assert.deepEqual(bad.reasons, ['257 ranges exceed the cap of 256'])
  const ok = core.validateProviderRanges(many.slice(0, 256))
  assert.equal(ok.kind, 'ok')
  assert.equal(ok.ranges.length, 256)
})

test('CORE-4 a blocked-overlapping range is rejected; its valid sibling does not partially apply', () => {
  const r = core.validateProviderRanges(['140.82.112.0/20', '10.1.0.0/16'])
  assert.equal(r.kind, 'invalid')
  assert.deepEqual(r.reasons, ['"10.1.0.0/16" overlaps blocked range 10.0.0.0/8'])
})

test('CORE-5 prefix floor rejects too-broad; per-provider override accepts', () => {
  assert.deepEqual(core.validateProviderRanges(['140.82.0.0/15']).reasons, [
    '"140.82.0.0/15" is broader than the /16 prefix floor',
  ])
  const ok = core.validateProviderRanges(['140.82.0.0/15'], { minPrefixLength: 12 })
  assert.equal(ok.kind, 'ok')
  assert.deepEqual(ok.ranges, ['140.82.0.0/15'])
})

test('CORE-6 span cap rejects 65 /16s, accepts 64 (boundary inclusive)', () => {
  const mk = n => Array.from({ length: n }, (_, i) => `13.${i * 2}.0.0/16`)
  const bad = core.validateProviderRanges(mk(65))
  assert.equal(bad.kind, 'invalid')
  assert.deepEqual(bad.reasons, ['declared ranges span 4259840 addresses, exceeding the cap of 4194304'])
  assert.equal(core.validateProviderRanges(mk(64)).kind, 'ok')
})

test('CORE-7 canonicalization normalizes host bits, dedups, containment-collapses', () => {
  const r = core.validateProviderRanges(['140.82.112.5/20', '140.82.112.0/20', '140.82.113.0/24'])
  assert.equal(r.kind, 'ok')
  assert.deepEqual(r.ranges, ['140.82.112.0/20'])
})

test('CORE-8 each malformed CIDR yields one reason, in input order', () => {
  const r = core.validateProviderRanges(['not-a-cidr', '1.2.3.4', '1.2.3.4/33', '01.2.3.4/24', '1.2.3.4/24/x'])
  assert.equal(r.kind, 'invalid')
  assert.deepEqual(r.reasons, [
    '"not-a-cidr" is not a valid IPv4 CIDR',
    '"1.2.3.4" is not a valid IPv4 CIDR',
    '"1.2.3.4/33" is not a valid IPv4 CIDR',
    '"01.2.3.4/24" is not a valid IPv4 CIDR',
    '"1.2.3.4/24/x" is not a valid IPv4 CIDR',
  ])
})

test('CORE-9 empty input is rejected', () => {
  assert.deepEqual(core.validateProviderRanges([]), { kind: 'invalid', reasons: ['no ranges declared'] })
})

test('CORE-10 partitionIpsByProviderRanges splits covered vs uncovered', () => {
  const { covered, uncovered } = core.partitionIpsByProviderRanges(
    ['140.82.121.5', '20.26.156.210', '8.8.8.8'],
    API_24
  )
  assert.deepEqual(covered, ['140.82.121.5', '20.26.156.210'])
  assert.deepEqual(uncovered, ['8.8.8.8'])
})

test('CORE-11 partition edge cases (empty ranges, empty ips)', () => {
  assert.deepEqual(core.partitionIpsByProviderRanges(['1.2.3.4', '5.6.7.8'], []), {
    covered: [],
    uncovered: ['1.2.3.4', '5.6.7.8'],
  })
  assert.deepEqual(core.partitionIpsByProviderRanges([], API_24), { covered: [], uncovered: [] })
})

test('CORE-12 (H5) partitionCidrsByFamily splits ipv4/ipv6/invalid', () => {
  assert.deepEqual(
    core.partitionCidrsByFamily(['140.82.112.0/20', '2a0a:a440::/29', '2606:50c0::/32', 'garbage']),
    { ipv4: ['140.82.112.0/20'], ipv6: ['2a0a:a440::/29', '2606:50c0::/32'], invalid: ['garbage'] }
  )
})

test('CORE-13 (H5) resolveProviderRanges family-filters a v6 line and still succeeds', () => {
  const r = core.resolveProviderRanges({
    fqdn: 'api.github.com',
    declaredName: 'github',
    declaredCategories: ['api'],
    registryLookup: registry.lookupFqdnProvider('api.github.com'),
    cmCategories: { 'github.api': [...API_24, '2a0a:a440::/29'] },
    bounds: registry.providerBounds('github'),
  })
  assert.equal(r.kind, 'ok')
  assert.equal(r.ranges.length, 24)
  assert.deepEqual(r.categories, ['api'])
})

test('CORE-14 parseProviderNetblocks reads ipv4 keys, skips ipv6, parses _meta, reports bad keys', () => {
  const out = core.parseProviderNetblocks({
    'github.api.ipv4': 'a\nb',
    'github.api.ipv6': 'x',
    _meta: '{"k":1}',
    'bad key': 'v',
  })
  assert.deepEqual({ ...out.categories }, { 'github.api': ['a', 'b'] })
  assert.deepEqual(out.meta, { k: 1 })
  assert.deepEqual(out.errors, ['unrecognized data key "bad key"'])
  assert.deepEqual(core.parseProviderNetblocks(undefined).errors, ['configmap has no data'])
})

test('CORE-15 resolveProviderRanges reason matrix (one per exact A.9 string)', () => {
  const R = core.resolveProviderRanges
  // 1. unknown mapping: no registry row + no declared categories
  assert.deepEqual(
    R({ fqdn: 'unknown.example.com', declaredName: 'someco', registryLookup: undefined, cmCategories: {}, bounds: registry.providerBounds('someco') }),
    { kind: 'invalid', reasons: ['provider mapping for "unknown.example.com" is unknown — declare provider.categories explicitly or add a registry row'] }
  )
  // 2. unmapped row
  const lk = registry.lookupFqdnProvider('pipelines.actions.githubusercontent.com')
  assert.deepEqual(
    R({ fqdn: 'pipelines.actions.githubusercontent.com', declaredName: 'github', registryLookup: lk, cmCategories: {}, bounds: registry.providerBounds('github') }),
    { kind: 'invalid', reasons: [`"pipelines.actions.githubusercontent.com" is registry-unmapped for provider mode (${lk.note})`] }
  )
  // 3. provider mismatch: declared github for an aws-mapped host (with declared categories)
  assert.deepEqual(
    R({ fqdn: 'github-cloud.s3.amazonaws.com', declaredName: 'github', declaredCategories: ['api'], registryLookup: registry.lookupFqdnProvider('github-cloud.s3.amazonaws.com'), cmCategories: {}, bounds: registry.providerBounds('github') }),
    { kind: 'invalid', reasons: ['registry maps "github-cloud.s3.amazonaws.com" to provider "aws", not "github"'] }
  )
  // 4. category missing from catalog
  assert.deepEqual(
    R({ fqdn: 'api.github.com', declaredName: 'github', declaredCategories: ['api'], registryLookup: registry.lookupFqdnProvider('api.github.com'), cmCategories: {}, bounds: registry.providerBounds('github') }),
    { kind: 'invalid', reasons: ['category "github.api" is not present in the netblocks catalog'] }
  )
  // 5. zero IPv4 (category present but only v6)
  assert.deepEqual(
    R({ fqdn: 'api.github.com', declaredName: 'github', declaredCategories: ['api'], registryLookup: registry.lookupFqdnProvider('api.github.com'), cmCategories: { 'github.api': ['2a0a:a440::/29'] }, bounds: registry.providerBounds('github') }),
    { kind: 'invalid', reasons: ['provider "github" resolved to zero IPv4 ranges'] }
  )
})

test('CORE-16 (G2) promoted predicate equals the old HCC one on well-formed inputs; stricter on malformed', () => {
  // The OLD HCC implementation, verbatim (networkPolicyReconciler.ts:74-111).
  const OLD_BLOCKED = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.31.196.0/24', '192.52.193.0/24',
    '192.88.99.0/24', '192.168.0.0/16', '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24',
    '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  ]
  const oldIpv4ToNumber = ip => {
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
  const oldCidrRange = cidr => {
    const [ip, prefixText] = cidr.split('/')
    if (!ip || prefixText === undefined) return undefined
    const prefix = Number(prefixText)
    const ipNumber = oldIpv4ToNumber(ip)
    if (ipNumber === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    const start = (ipNumber & mask) >>> 0
    const size = 2 ** (32 - prefix)
    return { start, end: (start + size - 1) >>> 0 }
  }
  const oldCidrOverlaps = (l, r) => {
    const a = oldCidrRange(l)
    const b = oldCidrRange(r)
    if (!a || !b) return false
    return a.start <= b.end && b.start <= a.end
  }
  const oldIsAllowed = cidr => {
    if (!oldCidrRange(cidr)) return false
    return !OLD_BLOCKED.some(b => oldCidrOverlaps(cidr, b))
  }
  const wellFormed = [
    ...OLD_BLOCKED,
    '8.8.8.0/24', '140.82.112.0/20', '1.2.3.4/32', '0.0.0.0/0',
    '9.255.255.255/32', '11.0.0.0/8', '172.15.255.0/24', '172.32.0.0/12',
    '192.167.255.0/24', '223.255.255.0/24',
  ]
  for (const cidr of wellFormed) {
    assert.equal(core.isAllowedExternalEgressCidr(cidr), oldIsAllowed(cidr), `well-formed disagreement on ${cidr}`)
  }
  // Enumerated intentional-strictening deltas: old accepts, promoted rejects.
  for (const cidr of ['01.2.3.4/24', '1.2.3.04/32', '1.2.3.4/24/x', '8.8.8.0/024']) {
    assert.equal(oldIsAllowed(cidr), true, `precondition: old accepts ${cidr}`)
    assert.equal(core.isAllowedExternalEgressCidr(cidr), false, `promoted must reject ${cidr}`)
  }
})

test('CORE-17 (H8 precheck) empty-ips ok observation drains then stops writing', () => {
  const cfg = { overlapMs: 300_000, maxEntries: 128 }
  const prev = {
    entries: [
      { ip: '1.1.1.1', port: 443, protocol: 'TCP', fqdn: 'h', expiresAt: 1000, lastObservedAt: 0 },
      { ip: '2.2.2.2', port: 443, protocol: 'TCP', fqdn: 'h', expiresAt: 2000, lastObservedAt: 0 },
    ],
  }
  const empty = obsOk('h', [], TTL, 443)
  const r1 = core.reconcileEgressState(prev, [empty], 1500, cfg) // 1.1.1.1 expires
  assert.equal(r1.changed, true)
  const r2 = core.reconcileEgressState(r1.state, [empty], 2500, cfg) // 2.2.2.2 expires
  assert.equal(r2.changed, true)
  const r3 = core.reconcileEgressState(r2.state, [empty], 3000, cfg) // empty; nothing to do
  assert.equal(r3.changed, false)
  assert.equal(r3.renewalDue, false)
  assert.equal(r3.entries.length, 0)
})

test('CORE-18 (security): declared categories do NOT override an EXPLICIT unmapped registry row', () => {
  // pipelines.actions.githubusercontent.com is an enforced counterexample (Azure
  // Front Door). Declaring categories must NOT smuggle the GitHub pool onto it.
  const lookup = registry.lookupFqdnProvider('pipelines.actions.githubusercontent.com')
  const r = core.resolveProviderRanges({
    fqdn: 'pipelines.actions.githubusercontent.com',
    declaredName: 'github',
    declaredCategories: ['api'],
    registryLookup: lookup,
    cmCategories: { 'github.api': API_24 },
    bounds: registry.providerBounds('github'),
  })
  assert.equal(r.kind, 'invalid')
  assert.ok(r.reasons[0].includes('registry-unmapped'), `expected registry-unmapped, got ${r.reasons[0]}`)
})

test('CORE-19 (F1) declared categories must be a SUBSET of a mapped registry row', () => {
  const lookup = registry.lookupFqdnProvider('api.github.com') // curated row: ['api']
  const base = {
    fqdn: 'api.github.com',
    declaredName: 'github',
    registryLookup: lookup,
    cmCategories: { 'github.api': API_24, 'github.web': API_24 },
    bounds: registry.providerBounds('github'),
  }
  // Widening the curated row (['api'] → ['api','web']) must be invalid.
  const widened = core.resolveProviderRanges({ ...base, declaredCategories: ['api', 'web'] })
  assert.equal(widened.kind, 'invalid')
  assert.ok(
    widened.reasons[0].includes('exceed registry row categories'),
    `expected a subset violation, got ${widened.reasons?.[0]}`
  )
  // An equal (or narrower) declaration stays valid.
  const exact = core.resolveProviderRanges({ ...base, declaredCategories: ['api'] })
  assert.equal(exact.kind, 'ok')
  assert.deepEqual(exact.categories, ['api'])
  // The unknown-FQDN escape hatch (NO registry row + explicit declaration) is
  // documented, load-bearing design — adding a NEW provider is data (a CM key +
  // declaration), the generality invariant (REG-6). It must remain valid.
  const hatch = core.resolveProviderRanges({
    fqdn: 'ghe.internal.example-corp.com',
    declaredName: 'github',
    declaredCategories: ['api'],
    registryLookup: undefined,
    cmCategories: { 'github.api': API_24 },
    bounds: registry.providerBounds('github'),
  })
  assert.equal(hatch.kind, 'ok')
  assert.deepEqual(hatch.categories, ['api'])
})
