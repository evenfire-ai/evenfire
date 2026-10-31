/**
 * Parity contract (#1043/#1044, Q5): the model-step retry lane exercises the
 * Host's own default and nothing in the lane pins a different count.
 *
 * The Host default lives in `mcp-host/src/core/orchestration/modelStepRetrySchedule.ts`.
 * The deterministic fixture, the Playwright spec and the runner totals each
 * restate part of it; until this test, nothing failed when one of them drifted.
 * Every value below is extracted from the real source (an anchored regex that
 * must match exactly once per file) or imported from the module that consumes
 * it, and every comparison is printed: a run that compared nothing fails on
 * "matched 0 times" instead of passing.
 *
 * Vacuity mutation: delete the Host constant line → this file fails with
 * "matched 0 times" and never passes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ADMISSION_PACE_MS,
  SOURCE_ATTEMPTS_PER_MINUTE,
} from '../../tests/e2e/playwright/helpers/login-ledger.mjs'
import { applyHostConfig, captureHostConfig } from './prepare-codex-approved-tools.mjs'
import {
  grokModelStepRetryExpectedDelta,
  grokModelStepRetryTitles,
  modelStepRetryExpectedDelta,
  modelStepRetryTitles,
} from './run-codex-approved-tools.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sources = Object.freeze({
  host: 'mcp-host/src/core/orchestration/modelStepRetrySchedule.ts',
  fixture: 'codex-llm-proxy/test/approvedToolsUpstream.ts',
  spec: 'tests/e2e/playwright/desktop/model-step-retry-codex.spec.ts',
  admission: 'control-api/src/services/auth/passwordAdmissionState.ts',
  configmap: 'deploy/overlays/minikube/configmaps/mcp-host-config.yaml',
})

function readSource(key) {
  const file = sources[key]
  return { file, text: fs.readFileSync(path.join(repo, file), 'utf8') }
}

function escapeName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Evaluates the integer expression of a declaration: literals with `_`
 * separators, unary signs, parentheses, `+ - *` and exact `/`, plus the
 * identifiers already read from the same file. No `eval`, and an unknown
 * identifier or character is a hard failure rather than a silently skipped
 * value.
 */
function integerExpression(expression, values, context) {
  const tokens = []
  let index = 0
  while (index < expression.length) {
    const rest = expression.slice(index)
    const whitespace = /^\s+/.exec(rest)
    if (whitespace) {
      index += whitespace[0].length
      continue
    }
    const token = /^(?:\d[\d_]*|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/])/.exec(rest)
    if (!token) throw new Error(`${context}: unsupported character in "${expression}"`)
    tokens.push(token[0])
    index += token[0].length
  }
  let position = 0
  function primary() {
    const token = tokens[position]
    if (token === '(') {
      position += 1
      const value = sum()
      if (tokens[position] !== ')') throw new Error(`${context}: missing ")" in "${expression}"`)
      position += 1
      return value
    }
    if (token === '-') {
      position += 1
      return -primary()
    }
    if (token === '+') {
      position += 1
      return primary()
    }
    if (token !== undefined && /^\d/.test(token)) {
      position += 1
      const value = Number(token.replaceAll('_', ''))
      if (!Number.isSafeInteger(value)) throw new Error(`${context}: "${token}" is not an integer`)
      return value
    }
    if (token !== undefined && /^[A-Za-z_]/.test(token)) {
      if (!values.has(token))
        throw new Error(`${context}: unknown identifier ${token} in "${expression}"`)
      position += 1
      return values.get(token)
    }
    throw new Error(`${context}: unexpected "${token}" in "${expression}"`)
  }
  function product() {
    let value = primary()
    while (tokens[position] === '*' || tokens[position] === '/') {
      const operator = tokens[position]
      position += 1
      const right = primary()
      if (operator === '*') {
        value *= right
        continue
      }
      if (right === 0 || value % right !== 0)
        throw new Error(`${context}: "${expression}" is not an exact integer division`)
      value /= right
    }
    return value
  }
  function sum() {
    let value = product()
    while (tokens[position] === '+' || tokens[position] === '-') {
      const operator = tokens[position]
      position += 1
      const right = product()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }
  const value = sum()
  if (position !== tokens.length) throw new Error(`${context}: trailing tokens in "${expression}"`)
  if (!Number.isSafeInteger(value)) throw new Error(`${context}: "${expression}" is not an integer`)
  return value
}

/**
 * Reads integer constants from one source file by name. A declaration must
 * match exactly once: a renamed, duplicated or deleted constant fails with
 * "matched 0 times"/"matched 2 times" instead of yielding `undefined`.
 */
function constantReader(key) {
  const { file, text } = readSource(key)
  const values = new Map()
  function record(name, expression) {
    const context = `${file}: ${name}`
    const value = integerExpression(expression, values, context)
    values.set(name, value)
    return { file, name, expression, value }
  }
  return {
    file,
    /** `const NAME = <expression>` with an optional `export` and type annotation. */
    read(name) {
      const pattern = new RegExp(
        `^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${escapeName(name)}[ \\t]*(?::[^=\\n]+)?=[ \\t]*([^\\n]*?)[ \\t]*$`,
        'gm'
      )
      const found = [...text.matchAll(pattern)]
      assert.equal(
        found.length,
        1,
        `${file}: ${name} must be declared exactly once, matched ${found.length} times`
      )
      return record(name, found[0][1].replace(/[ \t]*\/\/.*$/, '').trim())
    },
    /** `name: <expression>` of an object literal, such as a policy value. */
    readProperty(name) {
      const pattern = new RegExp(`^[ \\t]*${escapeName(name)}:[ \\t]*([^\\n]*)$`, 'gm')
      const found = [...text.matchAll(pattern)]
      assert.equal(
        found.length,
        1,
        `${file}: ${name} must be declared exactly once, matched ${found.length} times`
      )
      return record(name, found[0][1].replace(/,[ \t]*$/, '').trim())
    },
  }
}

function diagnose(t, entries) {
  for (const entry of entries)
    t.diagnostic(`${entry.file}: ${entry.name} = ${entry.expression} (${entry.value})`)
}

/** The `C<n>` label of every declared model-step retry case title. */
function caseLabels(titles) {
  return titles.map(title => {
    const label = /^model step retry (C\d+): /.exec(title)
    assert.ok(label, `unexpected model-step retry case title: ${title}`)
    return label[1]
  })
}

/**
 * The twelve Codex cases in the order the runner declares them, with the
 * deterministic upstream kind their prompt selects and what the journey does
 * after the resumable notice: `completed` continuations finish the turn,
 * `failedRetries` Retry clicks meet another notice, `approvals` ask the user,
 * `resends` and `followUps` are the other two ways out.
 */
const codexCases = Object.freeze([
  { id: 'C1', kind: 'receipt', completed: 1 },
  { id: 'C2', kind: 'zero', resends: 1 },
  { id: 'C3', kind: 'probe', followUps: 1 },
  { id: 'C4', kind: 'probe', completed: 1 },
  { id: 'C5', kind: 'twice', failedRetries: 1, completed: 1 },
  { id: 'C6', kind: 'probe', resends: 1 },
  {
    id: 'C7',
    kind: 'approval',
    completed: 1,
    approvals: 1,
    approvalFinals: 1,
  },
  { id: 'C9', kind: 'approval', approvals: 1, followUps: 1 },
  { id: 'C10', kind: 'approval', approvals: 1, followUps: 1 },
  { id: 'C8', kind: 'probe', completed: 1 },
  { id: 'C11', kind: 'absorbed' },
  { id: 'C12', kind: 'capped', completed: 1 },
])

/**
 * Upstream `provider_unavailable` responses one case injects. A step left on
 * the resumable notice after a confirmed tool fails `retries + 1` times: the
 * Host's own `retries` automatic retries absorb the first 503s and the last one
 * stands. `zero` fails once before any tool (nothing to resume, so the Host
 * never retries it), `absorbed` fails exactly `retries` times (all absorbed),
 * `twice` ends on the notice twice, and `capped` adds its immediate 503 and the
 * held call its 60 s cap cancels.
 */
function unavailableResponses(entry, retries) {
  switch (entry.kind) {
    case 'probe':
    case 'receipt':
    case 'approval':
      return retries + 1
    case 'twice':
      return 2 * (retries + 1)
    case 'zero':
      return 1
    case 'absorbed':
      return retries
    case 'capped':
      return 2
    default:
      throw new Error(`Unknown model-step retry case kind: ${entry.kind}`)
  }
}

/** The evidence delta the runner must observe for these cases. */
function expectedDelta(cases, retries) {
  const sum = field => cases.reduce((total, entry) => total + (entry[field] ?? 0), 0)
  const continuations = sum('completed')
  return {
    turns: cases.length,
    markerSearches: cases.filter(entry => entry.kind !== 'zero').length,
    unavailableResponses: cases.reduce(
      (total, entry) => total + unavailableResponses(entry, retries),
      0
    ),
    zeroToolUnavailable: cases.filter(entry => entry.kind === 'zero').length,
    continuationUnavailable: sum('failedRetries') * (retries + 1),
    continuations,
    toolResults: continuations,
    resends: sum('resends'),
    followUps: sum('followUps'),
    unexpectedRetries: 0,
    approvalRequests: sum('approvals'),
    approvalFinals: sum('approvalFinals'),
    absorbed: cases.filter(entry => entry.kind === 'absorbed').length,
    cappedHeld: cases.filter(entry => entry.kind === 'capped').length,
  }
}

test('the Host default, the fixture and the spec restate one retry count', t => {
  const host = constantReader('host')
  const defaultRetries = host.read('MODEL_STEP_AUTO_RETRIES_DEFAULT')
  const deadline = host.read('MODEL_STEP_RETRY_DEADLINE_MS')
  const fixture = constantReader('fixture')
  const fixtureRetries = fixture.read('HOST_MODEL_STEP_AUTO_RETRIES')
  const fixtureOutages = fixture.read('MODEL_STEP_OUTAGES')
  const fixtureHold = fixture.read('MODEL_STEP_CAPPED_HOLD_MS')
  const spec = constantReader('spec')
  const noticeOutages = spec.read('NOTICE_OUTAGES')
  const absorbedOutages = spec.read('ABSORBED_OUTAGES')
  const capNoticeMin = spec.read('CAP_NOTICE_MIN_MS')
  const capNoticeMax = spec.read('CAP_NOTICE_MAX_MS')
  diagnose(t, [
    defaultRetries,
    deadline,
    fixtureRetries,
    fixtureOutages,
    fixtureHold,
    noticeOutages,
    absorbedOutages,
    capNoticeMin,
    capNoticeMax,
  ])
  assert.equal(
    fixtureRetries.value,
    defaultRetries.value,
    `${fixtureRetries.file}: HOST_MODEL_STEP_AUTO_RETRIES (${fixtureRetries.value}) must equal MODEL_STEP_AUTO_RETRIES_DEFAULT in ${defaultRetries.file} (${defaultRetries.value})`
  )
  assert.equal(
    fixtureOutages.value,
    defaultRetries.value + 1,
    `${fixtureOutages.file}: MODEL_STEP_OUTAGES (${fixtureOutages.value}) must be MODEL_STEP_AUTO_RETRIES_DEFAULT + 1 (${defaultRetries.value + 1})`
  )
  assert.equal(
    noticeOutages.value,
    defaultRetries.value + 1,
    `${noticeOutages.file}: NOTICE_OUTAGES (${noticeOutages.value}) must be MODEL_STEP_AUTO_RETRIES_DEFAULT + 1 (${defaultRetries.value + 1})`
  )
  assert.equal(
    absorbedOutages.value,
    defaultRetries.value,
    `${absorbedOutages.file}: ABSORBED_OUTAGES (${absorbedOutages.value}) must be MODEL_STEP_AUTO_RETRIES_DEFAULT (${defaultRetries.value})`
  )
  assert.ok(
    capNoticeMin.value < deadline.value && deadline.value < capNoticeMax.value,
    `${spec.file}: CAP_NOTICE_MIN_MS (${capNoticeMin.value}) < MODEL_STEP_RETRY_DEADLINE_MS (${deadline.value}) < CAP_NOTICE_MAX_MS (${capNoticeMax.value}) must hold: the notice window measures the Host cap`
  )
  assert.ok(
    fixtureHold.value > deadline.value,
    `${fixtureHold.file}: MODEL_STEP_CAPPED_HOLD_MS (${fixtureHold.value}) must exceed MODEL_STEP_RETRY_DEADLINE_MS in ${deadline.file} (${deadline.value}): only a hold past the cap proves the cap ends the step`
  )
})

test('the runner totals are the per-case outage formula applied to the Host default', t => {
  const defaultRetries = constantReader('host').read('MODEL_STEP_AUTO_RETRIES_DEFAULT')
  const codexLabels = caseLabels(modelStepRetryTitles)
  assert.deepEqual(
    codexCases.map(entry => entry.id),
    codexLabels,
    'the Codex case table must declare exactly the cases run-codex-approved-tools.mjs runs'
  )
  const codexDelta = expectedDelta(codexCases, defaultRetries.value)
  for (const [field, value] of Object.entries(codexDelta)) t.diagnostic(`Codex ${field} = ${value}`)
  assert.deepEqual(
    codexDelta,
    modelStepRetryExpectedDelta,
    `run-codex-approved-tools.mjs: modelStepRetryExpectedDelta must be the per-case outage formula for CLERUM_MODEL_STEP_AUTO_RETRIES=${defaultRetries.value} in ${defaultRetries.file}`
  )
  const grokCases = caseLabels(grokModelStepRetryTitles).map(id => {
    const entry = codexCases.find(candidate => candidate.id === id)
    assert.ok(
      entry,
      `run-codex-approved-tools.mjs: the Grok lane runs ${id}, which the Codex case table does not declare`
    )
    return entry
  })
  const grokDelta = expectedDelta(grokCases, defaultRetries.value)
  for (const [field, value] of Object.entries(grokDelta)) t.diagnostic(`Grok ${field} = ${value}`)
  assert.deepEqual(
    grokDelta,
    grokModelStepRetryExpectedDelta,
    `run-codex-approved-tools.mjs: grokModelStepRetryExpectedDelta must be the per-case outage formula for the Grok cases (${caseLabels(grokModelStepRetryTitles).join(', ')})`
  )
})

test('the runner and the spec declare the same model-step retry cases', t => {
  const spec = readSource('spec')
  const declared = [...spec.text.matchAll(/^test\('model step retry (C\d+): /gm)].map(
    match => match[1]
  )
  t.diagnostic(`${spec.file}: ${declared.join(', ')}`)
  assert.ok(declared.length > 0, `${spec.file}: no model-step retry case declared, matched 0 times`)
  assert.deepEqual(
    declared,
    caseLabels(modelStepRetryTitles),
    `${spec.file}: the declared cases must be exactly the cases run-codex-approved-tools.mjs runs, in order`
  )
})

/** The Host ConfigMap patch prepare applies, driven through the real function. */
async function prepareHostConfigPatch() {
  const live = {
    metadata: { uid: 'mcp-host-config', resourceVersion: '1', annotations: {} },
    data: { CODEX_TOOL_PRESENTATION: 'direct' },
  }
  const state = { run: 'approved-tools-a1b2c3d4e5f6', hostConfig: captureHostConfig(live) }
  const patches = []
  let current = live
  await applyHostConfig({
    state,
    get: async () => current,
    patch: async patch => {
      patches.push(patch)
      current = {
        metadata: {
          ...live.metadata,
          annotations: { ...patch.metadata.annotations },
          resourceVersion: '2',
        },
        data: { ...live.data, ...patch.data },
      }
    },
  })
  assert.equal(
    patches.length,
    1,
    'prepare-codex-approved-tools.mjs: expected one Host ConfigMap patch'
  )
  return patches[0]
}

test('nothing pins CLERUM_MODEL_STEP_AUTO_RETRIES: the lane runs the Host default', async t => {
  const configmap = readSource('configmap')
  const keys = [...configmap.text.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map(match => match[1])
  t.diagnostic(`${configmap.file}: ${keys.length} Host configuration keys`)
  assert.ok(
    keys.length > 0,
    `${configmap.file}: no Host configuration key found, so the absence below proves nothing`
  )
  assert.equal(
    keys.includes('CLERUM_MODEL_STEP_AUTO_RETRIES'),
    false,
    `${configmap.file}: the lane must not pin CLERUM_MODEL_STEP_AUTO_RETRIES; the parity assertions above prove the Host default instead`
  )
  const patch = await prepareHostConfigPatch()
  const patched = Object.keys(patch.data)
  t.diagnostic(
    `scripts/e2e/prepare-codex-approved-tools.mjs: Host ConfigMap data keys ${patched.join(', ')}`
  )
  assert.ok(
    patched.length > 0,
    'scripts/e2e/prepare-codex-approved-tools.mjs: the Host ConfigMap patch sets no data key, so the absence below proves nothing'
  )
  assert.equal(
    patch.data.CODEX_TOOL_PRESENTATION,
    'auto',
    'scripts/e2e/prepare-codex-approved-tools.mjs: the Host ConfigMap patch must still switch the tool presentation on'
  )
  assert.equal(
    patched.includes('CLERUM_MODEL_STEP_AUTO_RETRIES'),
    false,
    'scripts/e2e/prepare-codex-approved-tools.mjs: the lane must not pin CLERUM_MODEL_STEP_AUTO_RETRIES; the parity assertions above prove the Host default instead'
  )
})

test('the login ledger helper paces to the password admission policy', t => {
  const admission = constantReader('admission')
  const paceMs = admission.readProperty('paceMs')
  const attempts = admission.readProperty('sourceAttemptsPerMinute')
  diagnose(t, [paceMs, attempts])
  t.diagnostic(
    `tests/e2e/playwright/helpers/login-ledger.mjs: ADMISSION_PACE_MS = ${ADMISSION_PACE_MS}`
  )
  t.diagnostic(
    `tests/e2e/playwright/helpers/login-ledger.mjs: SOURCE_ATTEMPTS_PER_MINUTE = ${SOURCE_ATTEMPTS_PER_MINUTE}`
  )
  assert.equal(
    ADMISSION_PACE_MS,
    paceMs.value,
    `tests/e2e/playwright/helpers/login-ledger.mjs: ADMISSION_PACE_MS (${ADMISSION_PACE_MS}) must equal ${paceMs.file}:paceMs (${paceMs.value})`
  )
  assert.equal(
    SOURCE_ATTEMPTS_PER_MINUTE,
    attempts.value,
    `tests/e2e/playwright/helpers/login-ledger.mjs: SOURCE_ATTEMPTS_PER_MINUTE (${SOURCE_ATTEMPTS_PER_MINUTE}) must equal ${attempts.file}:sourceAttemptsPerMinute (${attempts.value})`
  )
})
