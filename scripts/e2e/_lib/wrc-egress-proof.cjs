#!/usr/bin/env node
'use strict'

// Test oracle for the WRC egress fixture. Deliberately independent of
// the production policy builders/comparators: compare complete authorization
// tuples only after rejecting every unsupported/wildcard shape.
const { isIPv4 } = require('node:net')

const STATE = 'clerum.io/egress-fqdn-state'
const TARGETS = 'clerum.io/egress-fqdn-targets'
const RESOLVED_AT = 'clerum.io/egress-fqdn-resolved-at'
const MAX_ENTRIES = 128
const MAX_INPUT_BYTES = 1024 * 1024

/**
 * @typedef {{fqdn:string, ip:string, port:number, protocol:'TCP'}} ExternalTuple
 * @typedef {{namespace:string, workload:string, port:number, protocol:'TCP'}} InternalTuple
 * @typedef {{name:string, namespace:string, recipe:string,
 * recipeNamespace:string, lane:'ui'|'workload', workload:string,
 * podLabels:Record<string,string>, tuples:ExternalTuple[], internal?:InternalTuple[], uid?:string}} Expectation
 */

class ProofError extends Error {
  constructor(code, input = false) {
    super(code)
    this.name = 'ProofError'
    this.code = code
    this.input = input
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasKeys = (value, allowed) =>
  record(value) && Object.keys(value).every(key => allowed.includes(key))
const nonempty = value => typeof value === 'string' && value.length > 0
const validName = value =>
  typeof value === 'string' &&
  value.length <= 253 &&
  value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
const dateNumber = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime())
const sameSet = (left, right) =>
  left.size === right.size && [...left].every(value => right.has(value))
const tupleKey = entry => `${entry.fqdn}\0${entry.ip}\0${entry.port}\0${entry.protocol}`
const networkKey = entry => `${entry.ip}\0${entry.port}\0${entry.protocol}`
const internalKey = (entry, recipe) =>
  `internal\0${entry.namespace}\0${recipe}\0${entry.workload}\0${entry.port}\0${entry.protocol}`

function requireProof(condition, code, input = false) {
  if (!condition) throw new ProofError(code, input)
}

function checkTuple(entry, input) {
  requireProof(
    record(entry) &&
      validName(entry.fqdn) &&
      entry.fqdn.includes('.') &&
      typeof entry.ip === 'string' &&
      isIPv4(entry.ip) &&
      Number.isInteger(entry.port) &&
      entry.port >= 1 &&
      entry.port <= 65535 &&
      entry.protocol === 'TCP',
    'INVALID_EXTERNAL_TUPLE',
    input
  )
}

/** @param {Expectation} expected */
function checkExpectation(expected) {
  requireProof(
    hasKeys(expected, [
      'name',
      'namespace',
      'recipe',
      'recipeNamespace',
      'lane',
      'workload',
      'podLabels',
      'tuples',
      'internal',
      'uid',
    ]),
    'INVALID_EXPECTATION_FIELDS',
    true
  )
  for (const key of ['name', 'namespace', 'recipe', 'recipeNamespace', 'workload']) {
    requireProof(validName(expected[key]), 'INVALID_EXPECTATION_IDENTITY', true)
  }
  requireProof(
    expected.lane === 'ui' || expected.lane === 'workload',
    'INVALID_EXPECTATION_LANE',
    true
  )
  requireProof(
    expected.uid === undefined || nonempty(expected.uid),
    'INVALID_EXPECTATION_UID',
    true
  )
  requireProof(
    record(expected.podLabels) &&
      Object.values(expected.podLabels).every(value => typeof value === 'string'),
    'INVALID_EXPECTATION_POD_LABELS',
    true
  )
  requireProof(
    Array.isArray(expected.tuples) && expected.tuples.length <= MAX_ENTRIES,
    'INVALID_EXPECTATION_TUPLES',
    true
  )
  const identities = new Set()
  for (const entry of expected.tuples) {
    requireProof(
      hasKeys(entry, ['fqdn', 'ip', 'port', 'protocol']),
      'INVALID_EXPECTATION_TUPLE_FIELDS',
      true
    )
    checkTuple(entry, true)
    requireProof(!identities.has(tupleKey(entry)), 'DUPLICATE_EXPECTATION_TUPLE', true)
    identities.add(tupleKey(entry))
  }
  requireProof(
    expected.internal === undefined ||
      (Array.isArray(expected.internal) &&
        expected.internal.length <= 20 &&
        (expected.internal.length === 0 || expected.lane === 'ui')),
    'INVALID_EXPECTATION_INTERNAL',
    true
  )
  const internalIdentities = new Set()
  for (const entry of expected.internal ?? []) {
    requireProof(
      hasKeys(entry, ['namespace', 'workload', 'port', 'protocol']) &&
        validName(entry.namespace) &&
        validName(entry.workload) &&
        Number.isInteger(entry.port) &&
        entry.port >= 1 &&
        entry.port <= 65535 &&
        entry.protocol === 'TCP',
      'INVALID_EXPECTATION_INTERNAL',
      true
    )
    const key = internalKey(entry, expected.recipe)
    requireProof(!internalIdentities.has(key), 'DUPLICATE_EXPECTATION_INTERNAL', true)
    internalIdentities.add(key)
  }
}

/** Throws a sanitized ProofError; never includes the supplied policy body.
 * @param {unknown} policy
 * @param {Expectation} expected
 */
function assertPolicy(policy, expected) {
  checkExpectation(expected)
  requireProof(
    record(policy) &&
      policy.apiVersion === 'networking.k8s.io/v1' &&
      policy.kind === 'NetworkPolicy',
    'INVALID_POLICY_KIND'
  )
  const metadata = policy.metadata
  requireProof(
    record(metadata) &&
      metadata.name === expected.name &&
      metadata.namespace === expected.namespace &&
      nonempty(metadata.uid) &&
      nonempty(metadata.resourceVersion) &&
      !metadata.deletionTimestamp &&
      (expected.uid === undefined || metadata.uid === expected.uid),
    'POLICY_IDENTITY_MISMATCH'
  )

  const labels = metadata.labels
  requireProof(
    record(labels) &&
      labels['clerum.io/managed-by'] === 'workflow-recipes' &&
      labels['clerum.io/recipe'] === expected.recipe &&
      labels['clerum.io/recipe-name'] === expected.recipe &&
      labels['clerum.io/recipe-namespace'] === expected.recipeNamespace &&
      (expected.lane !== 'workload' || labels['clerum.io/workload'] === expected.workload),
    'POLICY_OWNERSHIP_MISMATCH'
  )

  const selector =
    expected.lane === 'ui'
      ? {
          'clerum.io/sandbox-ui': 'true',
          'clerum.io/recipe-namespace': expected.recipeNamespace,
          'clerum.io/recipe-name': expected.recipe,
        }
      : { 'clerum.io/recipe': expected.recipe, 'clerum.io/workload': expected.workload }
  requireProof(
    expected.podLabels['clerum.io/recipe'] === expected.recipe &&
      expected.podLabels['clerum.io/workload'] === expected.workload &&
      Object.entries(selector).every(([key, value]) => expected.podLabels[key] === value),
    'POD_IDENTITY_MISMATCH'
  )
  const spec = policy.spec
  requireProof(hasKeys(spec, ['podSelector', 'policyTypes', 'egress']), 'UNSUPPORTED_POLICY_SPEC')
  requireProof(
    Array.isArray(spec.policyTypes) &&
      spec.policyTypes.length === 1 &&
      spec.policyTypes[0] === 'Egress',
    'POLICY_TYPES_MISMATCH'
  )
  requireProof(
    hasKeys(spec.podSelector, ['matchLabels']) &&
      record(spec.podSelector.matchLabels) &&
      Object.keys(spec.podSelector.matchLabels).length === Object.keys(selector).length &&
      Object.entries(selector).every(([key, value]) => spec.podSelector.matchLabels[key] === value),
    'POLICY_SELECTOR_MISMATCH'
  )

  // Kubernetes may omit the top-level empty list. With explicit Egress isolation
  // this is deny-all; missing to/ports INSIDE a rule is unrestricted and rejected.
  requireProof(spec.egress === undefined || Array.isArray(spec.egress), 'INVALID_EGRESS_LIST')
  const actualNetwork = new Set()
  for (const rule of spec.egress ?? []) {
    requireProof(
      hasKeys(rule, ['to', 'ports']) &&
        Array.isArray(rule.to) &&
        rule.to.length > 0 &&
        Array.isArray(rule.ports) &&
        rule.ports.length > 0,
      'UNRESTRICTED_OR_UNKNOWN_RULE'
    )
    for (const peer of rule.to) {
      let internal
      if (record(peer) && Object.hasOwn(peer, 'ipBlock')) {
        requireProof(
          hasKeys(peer, ['ipBlock']) &&
            hasKeys(peer.ipBlock, ['cidr']) &&
            typeof peer.ipBlock.cidr === 'string' &&
            peer.ipBlock.cidr.endsWith('/32') &&
            isIPv4(peer.ipBlock.cidr.slice(0, -3)),
          'UNSUPPORTED_EXTERNAL_PEER'
        )
      } else {
        requireProof(
          expected.lane === 'ui' &&
            hasKeys(peer, ['namespaceSelector', 'podSelector']) &&
            hasKeys(peer.namespaceSelector, ['matchLabels']) &&
            hasKeys(peer.podSelector, ['matchLabels']) &&
            hasKeys(peer.namespaceSelector.matchLabels, ['kubernetes.io/metadata.name']) &&
            validName(peer.namespaceSelector.matchLabels['kubernetes.io/metadata.name']) &&
            hasKeys(peer.podSelector.matchLabels, ['clerum.io/recipe', 'clerum.io/workload']) &&
            peer.podSelector.matchLabels['clerum.io/recipe'] === expected.recipe &&
            validName(peer.podSelector.matchLabels['clerum.io/workload']),
          'UNSUPPORTED_INTERNAL_PEER'
        )
        internal = {
          namespace: peer.namespaceSelector.matchLabels['kubernetes.io/metadata.name'],
          workload: peer.podSelector.matchLabels['clerum.io/workload'],
        }
      }
      for (const port of rule.ports) {
        requireProof(
          hasKeys(port, ['port', 'protocol']) &&
            Number.isInteger(port.port) &&
            port.port >= 1 &&
            port.port <= 65535 &&
            (port.protocol === undefined || port.protocol === 'TCP'),
          'UNSUPPORTED_EXTERNAL_PORT'
        )
        actualNetwork.add(
          internal
            ? internalKey({ ...internal, port: port.port, protocol: 'TCP' }, expected.recipe)
            : networkKey({ ip: peer.ipBlock.cidr.slice(0, -3), port: port.port, protocol: 'TCP' })
        )
      }
    }
  }
  const expectedNetwork = new Set([
    ...expected.tuples.map(networkKey),
    ...(expected.internal ?? []).map(entry => internalKey(entry, expected.recipe)),
  ])
  requireProof(sameSet(actualNetwork, expectedNetwork), 'EXTERNAL_TUPLES_MISMATCH')

  const annotations = metadata.annotations
  requireProof(record(annotations) && typeof annotations[STATE] === 'string', 'MISSING_PROVENANCE')
  let entries
  try {
    entries = JSON.parse(annotations[STATE])
  } catch {
    throw new ProofError('INVALID_PROVENANCE_JSON')
  }
  requireProof(Array.isArray(entries) && entries.length <= MAX_ENTRIES, 'INVALID_PROVENANCE_LIST')
  const identities = new Set()
  for (const entry of entries) {
    requireProof(
      hasKeys(entry, ['fqdn', 'ip', 'port', 'protocol', 'expiresAt', 'lastObservedAt']),
      'INVALID_PROVENANCE_FIELDS'
    )
    checkTuple(entry, false)
    requireProof(
      dateNumber(entry.expiresAt) &&
        dateNumber(entry.lastObservedAt) &&
        entry.expiresAt >= entry.lastObservedAt,
      'INVALID_PROVENANCE_TIME'
    )
    requireProof(!identities.has(tupleKey(entry)), 'DUPLICATE_PROVENANCE')
    identities.add(tupleKey(entry))
  }
  requireProof(
    sameSet(identities, new Set(expected.tuples.map(tupleKey))),
    'PROVENANCE_TUPLES_MISMATCH'
  )
  const expectedTargets = expected.tuples.map(entry => `${entry.fqdn}=${entry.ip}/32`).sort()
  const targets = annotations[TARGETS]
  requireProof(
    typeof targets === 'string' &&
      JSON.stringify(targets === '' ? [] : targets.split(',').sort()) ===
        JSON.stringify(expectedTargets),
    'PROVENANCE_TARGETS_MISMATCH'
  )
  const resolvedAt = annotations[RESOLVED_AT]
  requireProof(
    (entries.length === 0 && resolvedAt === undefined) ||
      (typeof resolvedAt === 'string' && Number.isFinite(Date.parse(resolvedAt))),
    'INVALID_RESOLVED_AT'
  )
  return { ok: true }
}

function validatePolicy(policy, expected) {
  try {
    return assertPolicy(policy, expected)
  } catch (error) {
    if (!(error instanceof ProofError)) throw error
    return { ok: false, code: error.code, input: error.input }
  }
}

async function main(argv) {
  requireProof(argv.length === 2 && argv[0] === '--expect-json', 'USAGE_EXPECT_JSON_REQUIRED', true)
  let expected
  try {
    expected = JSON.parse(argv[1])
  } catch {
    throw new ProofError('INVALID_EXPECTATION_JSON', true)
  }
  checkExpectation(expected)
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    requireProof(bytes <= MAX_INPUT_BYTES, 'POLICY_INPUT_TOO_LARGE', true)
    chunks.push(chunk)
  }
  let policy
  try {
    policy = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ProofError('INVALID_POLICY_JSON', true)
  }
  process.stdout.write(`${JSON.stringify(assertPolicy(policy, expected))}\n`)
}

module.exports = { assertPolicy, validatePolicy, ProofError }
if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, code: error instanceof ProofError ? error.code : 'PROOF_FAILED' })}\n`
    )
    process.exitCode = error instanceof ProofError && error.input ? 2 : 1
  })
}
