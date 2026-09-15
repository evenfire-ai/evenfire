'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { assertPolicy, validatePolicy } = require('../e2e/_lib/wrc-egress-proof.cjs')

const STATE = 'clerum.io/egress-fqdn-state'
const TARGETS = 'clerum.io/egress-fqdn-targets'
const RESOLVED_AT = 'clerum.io/egress-fqdn-resolved-at'
function fixture(lane = 'ui') {
  const tuples = [{ fqdn: 'fixture.example.com', ip: '93.184.216.34', port: 443, protocol: 'TCP' }]
  const owner = {
    'clerum.io/managed-by': 'workflow-recipes',
    'clerum.io/recipe': 'recipe',
    'clerum.io/recipe-name': 'recipe',
    'clerum.io/recipe-namespace': 'sandbox-recipes',
  }
  const podLabels = {
    ...owner,
    'clerum.io/workload': lane === 'ui' ? 'frontend' : 'worker',
    'clerum.io/sandbox-ui': 'true',
  }
  const expected = {
    name: 'policy',
    namespace: lane === 'ui' ? 'sandbox-ui' : 'sandbox-recipes',
    recipe: 'recipe',
    recipeNamespace: 'sandbox-recipes',
    lane,
    workload: podLabels['clerum.io/workload'],
    podLabels,
    tuples,
    uid: 'policy-uid',
  }
  const policy = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: expected.name,
      namespace: expected.namespace,
      uid: expected.uid,
      resourceVersion: '1',
      labels: { ...owner, 'clerum.io/workload': expected.workload },
      annotations: {
        [STATE]: JSON.stringify(
          tuples.map(tuple => ({ ...tuple, expiresAt: 2000, lastObservedAt: 1000 }))
        ),
        [TARGETS]: 'fixture.example.com=93.184.216.34/32',
        [RESOLVED_AT]: new Date(1000).toISOString(),
      },
    },
    spec: {
      podSelector: {
        matchLabels:
          lane === 'ui'
            ? {
                'clerum.io/sandbox-ui': 'true',
                'clerum.io/recipe-name': 'recipe',
                'clerum.io/recipe-namespace': 'sandbox-recipes',
              }
            : { 'clerum.io/recipe': 'recipe', 'clerum.io/workload': 'worker' },
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ ipBlock: { cidr: '93.184.216.34/32' } }],
          ports: [{ port: 443, protocol: 'TCP' }],
        },
      ],
    },
  }
  return { expected, policy }
}

for (const lane of ['ui', 'workload']) {
  test(`accepts a complete ${lane} policy without treating expired fail-static state as invalid`, () => {
    const { policy, expected } = fixture(lane)
    assert.deepEqual(assertPolicy(policy, expected), { ok: true })
    expected.internal = []
    delete expected.uid
    assert.deepEqual(validatePolicy(policy, expected), { ok: true })
  })
}

const regressions = [
  [
    'wrong selector',
    p => {
      p.spec.podSelector = { matchLabels: { app: 'nonexistent' } }
    },
  ],
  [
    'UDP instead of TCP',
    p => {
      p.spec.egress[0].ports[0].protocol = 'UDP'
    },
  ],
  [
    'extra allow-all rule',
    p => {
      p.spec.egress.push({})
    },
  ],
  [
    'different provenance FQDN/IP/protocol',
    p => {
      p.metadata.annotations[STATE] = JSON.stringify([
        { fqdn: 'other.example.com', ip: '8.8.8.8', port: 443, protocol: 'UDP' },
      ])
    },
  ],
  [
    'wrong recipe owner',
    p => {
      p.metadata.labels['clerum.io/recipe'] = 'foreign'
    },
  ],
  [
    'extra peer',
    p => {
      p.spec.egress[0].to.push({ namespaceSelector: {} })
    },
  ],
  [
    'no peers',
    p => {
      delete p.spec.egress[0].to
    },
  ],
  [
    'empty peers',
    p => {
      p.spec.egress[0].to = []
    },
  ],
  [
    'no ports',
    p => {
      delete p.spec.egress[0].ports
    },
  ],
  [
    'empty ports',
    p => {
      p.spec.egress[0].ports = []
    },
  ],
  [
    'port range',
    p => {
      p.spec.egress[0].ports[0].endPort = 444
    },
  ],
  [
    'named port',
    p => {
      p.spec.egress[0].ports[0].port = 'https'
    },
  ],
  [
    'out of range port',
    p => {
      p.spec.egress[0].ports[0].port = 65536
    },
  ],
  [
    'null protocol',
    p => {
      p.spec.egress[0].ports[0].protocol = null
    },
  ],
  [
    'CIDR wider than host',
    p => {
      p.spec.egress[0].to[0].ipBlock.cidr = '93.184.216.0/24'
    },
  ],
  [
    'CIDR exception',
    p => {
      p.spec.egress[0].to[0].ipBlock.except = ['93.184.216.34/32']
    },
  ],
  [
    'mixed peer selectors',
    p => {
      p.spec.egress[0].to[0].podSelector = {}
    },
  ],
  [
    'unknown rule field',
    p => {
      p.spec.egress[0].unexpected = true
    },
  ],
  [
    'unknown spec field',
    p => {
      p.spec.futureAllow = true
    },
  ],
  [
    'ingress policy type',
    p => {
      p.spec.policyTypes.push('Ingress')
    },
  ],
  [
    'omitted policy types',
    p => {
      delete p.spec.policyTypes
    },
  ],
  [
    'selector expression',
    p => {
      p.spec.podSelector.matchExpressions = []
    },
  ],
  [
    'wrong namespace',
    p => {
      p.metadata.namespace = 'other'
    },
  ],
  [
    'wrong UID',
    p => {
      p.metadata.uid = 'replacement-uid'
    },
  ],
  [
    'missing resource version',
    p => {
      delete p.metadata.resourceVersion
    },
  ],
  [
    'deleting policy',
    p => {
      p.metadata.deletionTimestamp = new Date().toISOString()
    },
  ],
  [
    'annotation-only IP',
    p => {
      const state = JSON.parse(p.metadata.annotations[STATE])
      state[0].ip = '8.8.8.8'
      p.metadata.annotations[STATE] = JSON.stringify(state)
    },
  ],
  [
    'annotation-only FQDN',
    p => {
      const state = JSON.parse(p.metadata.annotations[STATE])
      state[0].fqdn = 'other.example.com'
      p.metadata.annotations[STATE] = JSON.stringify(state)
    },
  ],
  [
    'duplicate provenance',
    p => {
      const state = JSON.parse(p.metadata.annotations[STATE])
      p.metadata.annotations[STATE] = JSON.stringify([...state, ...state])
    },
  ],
  [
    'missing timestamp',
    p => {
      const state = JSON.parse(p.metadata.annotations[STATE])
      delete state[0].lastObservedAt
      p.metadata.annotations[STATE] = JSON.stringify(state)
    },
  ],
  [
    'corrupt state JSON',
    p => {
      p.metadata.annotations[STATE] = '{'
    },
  ],
  [
    'missing structured state',
    p => {
      delete p.metadata.annotations[STATE]
    },
  ],
  [
    'wrong target summary',
    p => {
      p.metadata.annotations[TARGETS] = 'other.example.com=8.8.8.8/32'
    },
  ],
  [
    'invalid resolution date',
    p => {
      p.metadata.annotations[RESOLVED_AT] = 'not-a-date'
    },
  ],
]
for (const [description, mutate] of regressions) {
  test(`rejects ${description}`, () => {
    const { policy, expected } = fixture()
    mutate(policy)
    assert.equal(validatePolicy(policy, expected).ok, false)
  })
}

test('accepts Kubernetes TCP default, reordered/grouped permissions, and harmless duplicate network rules', () => {
  const { policy, expected } = fixture()
  const extra = { ...expected.tuples[0], port: 80 }
  expected.tuples.push(extra)
  policy.spec.egress[0].ports.unshift({ port: 80 })
  delete policy.spec.egress[0].ports[1].protocol
  policy.spec.egress.push(structuredClone(policy.spec.egress[0]))
  policy.metadata.annotations[STATE] = JSON.stringify(
    expected.tuples.map(entry => ({ ...entry, expiresAt: 2000, lastObservedAt: 1000 }))
  )
  policy.metadata.annotations[TARGETS] += ',' + policy.metadata.annotations[TARGETS]
  assert.equal(validatePolicy(policy, expected).ok, true)
})

test('rejects unintended peer/port Cartesian product', () => {
  const { policy, expected } = fixture()
  expected.tuples.push({ fqdn: 'second.example.com', ip: '8.8.8.8', port: 80, protocol: 'TCP' })
  policy.spec.egress[0].to.push({ ipBlock: { cidr: '8.8.8.8/32' } })
  policy.spec.egress[0].ports.push({ port: 80 })
  assert.equal(validatePolicy(policy, expected).code, 'EXTERNAL_TUPLES_MISMATCH')
})

test('distinct FQDN provenance may legitimately share an enforced IP/port tuple', () => {
  const { policy, expected } = fixture()
  expected.tuples.push({ ...expected.tuples[0], fqdn: 'alias.example.com' })
  policy.metadata.annotations[STATE] = JSON.stringify(
    expected.tuples.map(entry => ({
      ...entry,
      expiresAt: 2000,
      lastObservedAt: 1000,
    }))
  )
  policy.metadata.annotations[TARGETS] += ',alias.example.com=93.184.216.34/32'
  assert.equal(validatePolicy(policy, expected).ok, true)
})

test('accepts only explicitly declared conjunctive UI-to-worker Service permissions', () => {
  const { policy, expected } = fixture()
  expected.internal = [
    { namespace: 'sandbox-recipes', workload: 'worker', port: 3000, protocol: 'TCP' },
  ]
  const rule = {
    to: [
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'sandbox-recipes' } },
        podSelector: {
          matchLabels: { 'clerum.io/recipe': 'recipe', 'clerum.io/workload': 'worker' },
        },
      },
    ],
    ports: [{ port: 3000, protocol: 'TCP' }],
  }
  policy.spec.egress.push(rule)
  assert.equal(validatePolicy(policy, expected).ok, true)
  for (const mutate of [
    p => {
      p.spec.egress[1].to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'] =
        'foreign'
    },
    p => {
      p.spec.egress[1].to[0].podSelector.matchLabels['clerum.io/recipe'] = 'foreign'
    },
    p => {
      p.spec.egress[1].to[0].podSelector.matchLabels['clerum.io/workload'] = 'other-worker'
    },
    p => {
      const peer = p.spec.egress[1].to[0]
      p.spec.egress[1].to = [
        { namespaceSelector: peer.namespaceSelector },
        { podSelector: peer.podSelector },
      ]
    },
    p => {
      p.spec.egress[1].to[0].namespaceSelector = {}
    },
    p => {
      p.spec.egress[1].to[0].podSelector.matchExpressions = []
    },
    p => {
      p.spec.egress[1].ports.push({ port: 3001 })
    },
  ]) {
    const candidate = structuredClone(policy)
    mutate(candidate)
    assert.equal(validatePolicy(candidate, expected).ok, false)
  }
  delete expected.internal
  assert.equal(validatePolicy(policy, expected).ok, false)
})

test('accepts empty or omitted top-level egress under explicit Egress isolation', () => {
  const { policy, expected } = fixture()
  expected.tuples = []
  policy.spec.egress = []
  policy.metadata.annotations = { [STATE]: '[]', [TARGETS]: '' }
  assert.equal(validatePolicy(policy, expected).ok, true)
  delete policy.spec.egress
  assert.equal(validatePolicy(policy, expected).ok, true)
  policy.spec.egress = [{}]
  assert.equal(validatePolicy(policy, expected).ok, false)
})

test('rejects unknown, defaulted, duplicate, and incorrectly bound expectations', () => {
  const { policy, expected } = fixture()
  for (const candidate of [
    undefined,
    {},
    { ...expected, lane: 'unknown' },
    { ...expected, extra: true },
    { ...expected, tuples: [...expected.tuples, ...expected.tuples] },
    { ...expected, tuples: [{ ...expected.tuples[0], protocol: undefined }] },
  ]) {
    assert.equal(validatePolicy(policy, candidate).input, true)
  }
  const wrongPod = {
    ...expected,
    podLabels: { ...expected.podLabels, 'clerum.io/workload': 'other' },
  }
  assert.equal(validatePolicy(policy, wrongPod).code, 'POD_IDENTITY_MISMATCH')
})

test('CLI distinguishes bad input from a failed proof and never echoes policy contents', () => {
  const { policy, expected } = fixture()
  const cli = path.join(__dirname, '../e2e/_lib/wrc-egress-proof.cjs')
  const run = (argv, input) =>
    spawnSync(process.execPath, [cli, ...argv], { input, encoding: 'utf8', timeout: 5000 })
  const args = ['--expect-json', JSON.stringify(expected)]
  assert.equal(run(args, JSON.stringify(policy)).status, 0)
  assert.equal(run([], JSON.stringify(policy)).status, 2)
  assert.equal(run(['--expect-json', '{'], '').status, 2)
  assert.equal(run(args, '{').status, 2)
  policy.spec.egress.push({})
  const failure = run(args, JSON.stringify(policy))
  assert.equal(failure.status, 1)
  assert.equal(failure.stdout, '')
  assert.deepEqual(JSON.parse(failure.stderr), { ok: false, code: 'UNRESTRICTED_OR_UNKNOWN_RULE' })
})
