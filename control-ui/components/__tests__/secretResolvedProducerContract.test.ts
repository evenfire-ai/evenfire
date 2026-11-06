import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCredentialSurface } from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import { EGRESS_PROXY_VALUES_VALID_CONDITION } from '@constants/connectorCredentials'
import type { McpServerCondition } from '@lib/api'
import {
  EGRESS_PROXY_VALUES_VALID,
  egressValuesRefused,
  egressValuesWithinClass,
} from './fixtures/egressProxyConditions'
import {
  SECRET_RESOLVED,
  secretAccessDenied,
  secretFound,
  secretMissingKey,
  secretNotFound,
  syntheticCondition,
  withoutTimestamp,
} from './fixtures/secretResolvedConditions'

// ─── R1-H2: the fixture builders are checked AGAINST the real producer ─────
//
// `fixtures/secretResolvedConditions.ts` used to be a handwritten mirror of the
// host-context-controller: if HCC changed a SecretResolved status, reason or
// message, the UI suites stayed green because BOTH the mocked producer output
// and the assertion encoded the UI author's stale assumption.
//
// This suite closes that by reading `host-context-controller/src/reconciler.ts`
// off disk, extracting the condition writes and the `validateSecret` failure
// results as DATA, and asserting the fixture builders reproduce exactly those
// triples. A producer contract change turns this file red.
//
// The extraction is deliberately brittle in the safe direction. Every step that
// can no longer find its producer site throws with a message naming what moved,
// because a silently-empty match set would pass trivially and be worse than the
// handwritten mirror it replaced.
//
// This file reads source text only. It does NOT import the controller: making
// control-ui depend on an HCC package at runtime would be heavier coupling than
// the drift it prevents, and this PR is control-ui-scoped.

const RECONCILER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../host-context-controller/src/reconciler.ts'
)

/** Smallest size the real reconciler has ever been, by a wide margin. A stub,
 *  a truncated read or an empty file must not be mistaken for "no producer". */
const MIN_PRODUCER_BYTES = 20_000

function readProducerSource(): string {
  let source: string
  try {
    source = readFileSync(RECONCILER_PATH, 'utf8')
  } catch (error) {
    throw new Error(
      `SecretResolved producer contract: cannot read the producer at ${RECONCILER_PATH}. ` +
        `If the host-context-controller moved, update RECONCILER_PATH — do NOT delete this ` +
        `suite, it is the only thing tying the UI fixtures to the real conditions. ` +
        `(${error instanceof Error ? error.message : String(error)})`
    )
  }
  if (source.length < MIN_PRODUCER_BYTES) {
    throw new Error(
      `SecretResolved producer contract: ${RECONCILER_PATH} is only ${source.length} bytes, ` +
        `below the ${MIN_PRODUCER_BYTES}-byte floor. Refusing to derive a contract from what ` +
        `is almost certainly not the real reconciler.`
    )
  }
  return source
}

const source = readProducerSource()
const lines = source.split('\n')

// ─── Extraction 1: every `SecretResolved` condition write ──────────────────

type ConditionWrite = {
  /** 1-based line of the `type:` property, for failure messages. */
  line: number
  /** The class method that owns this write site, e.g. `performReconcile`. */
  owner: string
  status: string
  /** RAW source expression, e.g. `'SecretFound'` or `secretResult.reason`. */
  reason: string
  /** RAW source expression, e.g. `'Secret resolved and validated'`. */
  message: string
}

/**
 * The class method enclosing a condition-write anchor, so a producer site is
 * identified by WHO writes it, not only by the triple it writes (the egress
 * proxy block writes the same success triple as the two reconcile paths).
 *
 * Class members are the only declarations at two-space indentation in
 * `reconciler.ts`; method bodies are deeper. An anchor with no enclosing member
 * throws rather than guessing, because a guessed owner would let a moved site
 * keep matching this allowlist.
 */
function enclosingMethod(anchor: number): string {
  /** A member declaration: two-space indented, optional modifiers, then the name. */
  const memberDeclaration =
    /^ {2}(?:(?:private|public|protected|static|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\(/
  for (let index = anchor; index >= 0; index--) {
    const matched = memberDeclaration.exec(lines[index])
    if (matched) return matched[1]
  }
  throw new Error(
    `SecretResolved producer contract: the condition write anchored at ` +
      `${path.basename(RECONCILER_PATH)}:${anchor + 1} has no enclosing class method. The ` +
      `producer file's shape changed; re-derive this extractor.`
  )
}

function matchProperty(line: string | undefined, re: RegExp, at: number, what: string): string {
  const matched = line === undefined ? null : re.exec(line)
  if (!matched) {
    throw new Error(
      `SecretResolved producer contract: expected a \`${what}\` property at ` +
        `${path.basename(RECONCILER_PATH)}:${at}, found ${JSON.stringify(line ?? null)}. ` +
        `The producer's condition literal changed shape; re-derive this extractor.`
    )
  }
  return matched[1]
}

function extractConditionWrites(): ConditionWrite[] {
  const anchors: number[] = []
  lines.forEach((line, index) => {
    if (/^\s*type: 'SecretResolved',$/.test(line)) anchors.push(index)
  })
  if (anchors.length === 0) {
    throw new Error(
      `SecretResolved producer contract: found NO \`type: 'SecretResolved',\` condition writes in ` +
        `${RECONCILER_PATH}. Either the producer stopped writing the condition the credential ` +
        `screen depends on, or this extractor no longer matches it. Both are release blockers.`
    )
  }
  return anchors.map(index => ({
    line: index + 1,
    owner: enclosingMethod(index),
    status: matchProperty(lines[index + 1], /^\s*status: '([A-Za-z]+)',$/, index + 2, 'status'),
    reason: matchProperty(lines[index + 2], /^\s*reason: (.+),$/, index + 3, 'reason'),
    message: matchProperty(lines[index + 3], /^\s*message: (.+),$/, index + 4, 'message'),
  }))
}

const conditionWrites = extractConditionWrites()

/**
 * Every `SecretResolved` producer write site this contract knows, keyed by the
 * method that owns it and the SHAPE it writes.
 *
 * This is an ALLOWLIST OF SITES, not a count. A new way for the UI to observe
 * `SecretResolved` has to be named here — with the producer method that writes
 * it — and the fixture contract below then has to account for it. A site that
 * disappears fails just as loudly, which is the property the fixture builders
 * depend on: `secretFound()` stands for EVERY literal success site.
 *
 * The shape is derived from the write (`forward-validateSecret` when it forwards
 * `validateSecret`'s result, `literal-success` for a non-forwarding literal
 * write at the success status) rather than the triple being restated here, so a
 * producer RENAME still propagates into the fixtures instead of merely breaking
 * this allowlist. A literal write that is not the success status is `unknown`
 * and cannot match any site, which is how a novel condition lands red.
 *
 * `blockEgressProxyValues` (issue #1240) is the site that forced this shape: a
 * rotation whose credential is readable but outside the egress-proxy value class
 * still clears a stale `SecretResolved=False` from an earlier state, writing the
 * same success triple as the two reconcile paths. It is a real producer site,
 * so it is listed here rather than absorbed into a bumped count.
 */
type ProducerSiteShape = 'forward-validateSecret' | 'literal-success'
type ProducerWriteSite = { owner: string; shape: ProducerSiteShape | 'unknown' }

const KNOWN_PRODUCER_WRITE_SITES: readonly ProducerWriteSite[] = [
  // Failed Secret validation in the managed reconcile: forwards validateSecret.
  { owner: 'performReconcile', shape: 'forward-validateSecret' },
  // The managed reconcile's success write.
  { owner: 'performReconcile', shape: 'literal-success' },
  // The WRC-owned paths write the same two shapes for their own branch.
  { owner: 'reconcileWrcOwnedServer', shape: 'literal-success' },
  { owner: 'reconcileWrcOwnedServer', shape: 'forward-validateSecret' },
  // The egress-proxy value preflight's block path (issue #1240).
  { owner: 'blockEgressProxyValues', shape: 'literal-success' },
]

/** Stable, order-independent identity for a site in a failure message. */
const describeWriteSite = (site: ProducerWriteSite): string => `${site.owner} | ${site.shape}`

const isStringLiteral = (expression: string) => /^'[^']*'$/.test(expression)
const unquote = (expression: string) => expression.slice(1, -1)

const literalWrites = conditionWrites.filter(
  write => isStringLiteral(write.reason) && isStringLiteral(write.message)
)
const derivedWrites = conditionWrites.filter(
  write => write.reason === 'secretResult.reason' && write.message === 'secretResult.message'
)

/** Classifies a write by its derived shape; `unknown` never matches a site. */
function producerSiteShape(write: ConditionWrite): ProducerWriteSite['shape'] {
  if (write.reason === 'secretResult.reason' && write.message === 'secretResult.message') {
    return 'forward-validateSecret'
  }
  if (isStringLiteral(write.reason) && isStringLiteral(write.message) && write.status === 'True') {
    return 'literal-success'
  }
  return 'unknown'
}

const extractedWriteSites: ProducerWriteSite[] = conditionWrites.map(write => ({
  owner: write.owner,
  shape: producerSiteShape(write),
}))

// ─── Extraction 2: `validateSecret`'s failure results ──────────────────────

/** reason -> the message TEMPLATE source the producer builds for it. */
type FailureResult = { reason: string; template: string }

/**
 * Collapses a possibly multi-line, possibly `+`-concatenated template literal
 * into the single template it evaluates to. `\`a \` +\n  \`b\`` becomes `a b`.
 */
function normalizeTemplate(raw: string, context: string): string {
  const oneLine = raw.replace(/\s*\n\s*/g, ' ').trim()
  const joined = oneLine.replace(/`\s*\+\s*`/g, '')
  if (!joined.startsWith('`') || !joined.endsWith('`') || joined.length < 2) {
    throw new Error(
      `SecretResolved producer contract: could not read the message template for ${context}. ` +
        `Expected one or more concatenated template literals, got ${JSON.stringify(raw)}.`
    )
  }
  return joined.slice(1, -1)
}

/** Walks BACK from a `return { ok: false, ..., message }` to the `const message =`
 *  assignment that fed it, then forward until the literal is closed. */
function templateFromPrecedingAssignment(returnLine: number, reason: string): string {
  for (let index = returnLine; index >= 0; index--) {
    const assignment = /^\s*const message =(.*)$/.exec(lines[index])
    if (!assignment) continue
    let raw = assignment[1]
    let cursor = index
    // Keep consuming lines while the template literal is still open or the
    // expression continues with a trailing `+`.
    while (
      cursor < lines.length - 1 &&
      ((raw.match(/`/g) ?? []).length % 2 === 1 || raw.trimEnd().endsWith('+') || raw.trim() === '')
    ) {
      cursor += 1
      raw += `\n${lines[cursor]}`
    }
    return normalizeTemplate(
      raw,
      `reason '${reason}' (${path.basename(RECONCILER_PATH)}:${index + 1})`
    )
  }
  throw new Error(
    `SecretResolved producer contract: \`return { ok: false, reason: '${reason}', message }\` at ` +
      `${path.basename(RECONCILER_PATH)}:${returnLine + 1} has no preceding \`const message =\`. ` +
      `The producer's failure construction changed; re-derive this extractor.`
  )
}

function extractFailureResults(): FailureResult[] {
  const results: FailureResult[] = []
  lines.forEach((line, index) => {
    // Inline form: `return { ok: false, reason: 'X', message }`
    const inline = /^\s*return \{ ok: false, reason: '([A-Za-z]+)', message \},?$/.exec(line)
    if (inline) {
      results.push({
        reason: inline[1],
        template: templateFromPrecedingAssignment(index, inline[1]),
      })
      return
    }
    // Object form:
    //   return {
    //     ok: false,
    //     reason: 'X',
    //     message: `...`,
    //   }
    const objectReason = /^\s*reason: '([A-Za-z]+)',$/.exec(line)
    if (objectReason && /^\s*ok: false,$/.test(lines[index - 1] ?? '')) {
      const inlineMessage = /^\s*message: (.+),$/.exec(lines[index + 1] ?? '')
      if (!inlineMessage) {
        throw new Error(
          `SecretResolved producer contract: the \`ok: false\` result at ` +
            `${path.basename(RECONCILER_PATH)}:${index + 1} has no \`message:\` property after its ` +
            `reason. The producer's failure construction changed; re-derive this extractor.`
        )
      }
      results.push({
        reason: objectReason[1],
        template: normalizeTemplate(
          inlineMessage[1],
          `reason '${objectReason[1]}' (${path.basename(RECONCILER_PATH)}:${index + 2})`
        ),
      })
    }
  })
  if (results.length === 0) {
    throw new Error(
      `SecretResolved producer contract: found NO \`ok: false\` validateSecret results in ` +
        `${RECONCILER_PATH}. Every False SecretResolved condition forwards one of them, so an ` +
        `empty set means the extractor is broken, not that the failures are gone.`
    )
  }
  return results
}

const failureResults = extractFailureResults()
const failureByReason = new Map(failureResults.map(result => [result.reason, result]))

/** The declared failure-reason union on `SecretValidationResult`. */
function extractFailureReasonUnion(): string[] {
  const declaration = /^\s*reason: ((?:'[A-Za-z]+'(?:\s*\|\s*)?)+)$/m.exec(source)
  if (!declaration) {
    throw new Error(
      `SecretResolved producer contract: could not find the SecretValidationResult failure-reason ` +
        `union in ${RECONCILER_PATH}. It is the producer's own enumeration of what a False ` +
        `SecretResolved can say; without it this contract cannot detect a new reason.`
    )
  }
  return (declaration[1].match(/'([A-Za-z]+)'/g) ?? []).map(literal => literal.slice(1, -1))
}

const failureReasonUnion = extractFailureReasonUnion()

// ─── Substituting a producer template with sentinel values ─────────────────

const SENTINEL = {
  secretName: 'sentinel-secret-name',
  namespace: 'sentinel-namespace',
  secretKey: 'sentinel-secret-key',
  envVar: 'SENTINEL_ENV_VAR',
  code: 418,
  errMsg: 'sentinel-read-error',
}

/**
 * Producer interpolation expression -> the value the fixture builder puts in
 * that slot. Every value is distinctive, so a builder that fills the right
 * template with the WRONG argument still fails.
 *
 * An unmapped expression throws: a new interpolation in the producer message is
 * exactly the drift this suite exists to catch.
 */
const PLACEHOLDER_VALUES: Record<string, string> = {
  secretName: SENTINEL.secretName,
  'server.namespace': SENTINEL.namespace,
  'keyMapping.secretKey': SENTINEL.secretKey,
  'keyMapping.envVar': SENTINEL.envVar,
  code: String(SENTINEL.code),
  errMsg: SENTINEL.errMsg,
}

function renderProducerTemplate(reason: string): string {
  const result = failureByReason.get(reason)
  if (!result) {
    throw new Error(
      `SecretResolved producer contract: the producer no longer returns reason '${reason}'. ` +
        `It does return: ${failureResults.map(r => r.reason).join(', ')}.`
    )
  }
  return result.template.replace(/\$\{([^}]+)\}/g, (_whole, expression: string) => {
    const value = PLACEHOLDER_VALUES[expression]
    if (value === undefined) {
      throw new Error(
        `SecretResolved producer contract: the message for '${reason}' interpolates ` +
          `\${${expression}}, which no fixture argument maps to. Add it to PLACEHOLDER_VALUES and ` +
          `thread the value through the matching builder in fixtures/secretResolvedConditions.ts.`
      )
    }
    return value
  })
}

const AT = '2026-08-06T04:00:00.000Z'

describe('SecretResolved producer contract — extraction guards', () => {
  it('finds exactly the producer condition write sites the contract knows', () => {
    // Site-for-site, not a count: a new SecretResolved producer must be named
    // here with its owning method, and a site that disappears fails too.
    expect(extractedWriteSites.map(describeWriteSite).sort()).toEqual(
      KNOWN_PRODUCER_WRITE_SITES.map(describeWriteSite).sort()
    )
    // Every write must be one of the two known shapes. A third shape means the
    // UI can observe a condition this contract says nothing about.
    expect(literalWrites.length + derivedWrites.length).toBe(conditionWrites.length)
    expect(literalWrites.length).toBeGreaterThan(0)
    expect(derivedWrites.length).toBeGreaterThan(0)
  })

  it('finds a validateSecret failure result for every declared failure reason', () => {
    expect(failureReasonUnion.length).toBeGreaterThan(0)
    expect(new Set(failureResults.map(result => result.reason))).toEqual(
      new Set(failureReasonUnion)
    )
  })

  it('resolves every producer message template to a concrete string', () => {
    for (const reason of failureReasonUnion) {
      const rendered = renderProducerTemplate(reason)
      expect(rendered).not.toContain('${')
      expect(rendered.length).toBeGreaterThan(0)
    }
  })
})

describe('SecretResolved producer contract — fixture builders match the producer', () => {
  it('builds conditions under the producer’s own condition type', () => {
    // Extracted from the anchor the writes were found on, not restated here.
    expect(SECRET_RESOLVED).toBe('SecretResolved')
    for (const write of conditionWrites) {
      expect(lines[write.line - 1].trim()).toBe(`type: '${SECRET_RESOLVED}',`)
    }
  })

  it('secretFound() reproduces the producer’s success triple, and every site agrees', () => {
    const successWrites = literalWrites.filter(write => write.status === 'True')
    expect(successWrites.length).toBeGreaterThan(0)
    // All True sites must write the same triple — including the egress-proxy
    // block path; otherwise one fixture cannot stand for all of them and the
    // builder has to grow a discriminator.
    const distinct = new Set(successWrites.map(write => `${write.reason}|${write.message}`))
    expect(distinct.size).toBe(1)

    const producer = successWrites[0]
    const fixture = secretFound({ at: AT })
    expect(fixture.status).toBe(producer.status)
    expect(fixture.reason).toBe(unquote(producer.reason))
    expect(fixture.message).toBe(unquote(producer.message))
    expect(fixture.lastTransitionTime).toBe(AT)
  })

  it('the failure builders reproduce the producer’s status', () => {
    const failureStatuses = new Set(derivedWrites.map(write => write.status))
    expect(failureStatuses.size).toBe(1)
    const status = [...failureStatuses][0]
    expect(secretNotFound({ at: AT }).status).toBe(status)
    expect(secretMissingKey({ at: AT }).status).toBe(status)
    expect(secretAccessDenied({ at: AT }).status).toBe(status)
  })

  it('secretNotFound() reproduces the producer’s 404 reason and message', () => {
    const fixture = secretNotFound({
      at: AT,
      secretName: SENTINEL.secretName,
      namespace: SENTINEL.namespace,
    })
    expect(failureReasonUnion).toContain(fixture.reason)
    expect(fixture.message).toBe(renderProducerTemplate(fixture.reason))
  })

  it('secretMissingKey() reproduces the producer’s missing-key reason and message', () => {
    const fixture = secretMissingKey({
      at: AT,
      secretName: SENTINEL.secretName,
      secretKey: SENTINEL.secretKey,
      envVar: SENTINEL.envVar,
    })
    expect(failureReasonUnion).toContain(fixture.reason)
    expect(fixture.message).toBe(renderProducerTemplate(fixture.reason))
  })

  it('secretAccessDenied() reproduces the producer’s 401/403 reason and message', () => {
    const fixture = secretAccessDenied({
      at: AT,
      secretName: SENTINEL.secretName,
      namespace: SENTINEL.namespace,
      code: SENTINEL.code,
    })
    expect(failureReasonUnion).toContain(fixture.reason)
    expect(fixture.message).toBe(renderProducerTemplate(fixture.reason))
  })

  /**
   * `ReadError` is a transient k8s read failure — HCC could not look, so it is
   * no evidence about the Secret and the resolver must keep the rotate form.
   * It gets no builder because no test needs to distinguish it from
   * `SecretAccessDenied`; the surface assertion below covers it by extraction.
   *
   * Any OTHER unmodelled reason fails here: a new producer reason has to be
   * triaged against the create path before this suite goes green again.
   */
  const UNMODELLED_BY_DESIGN = new Set(['ReadError'])

  it('every producer failure reason is modelled by a builder or explicitly waived', () => {
    const modelled = new Set(
      [
        secretNotFound({ at: AT }),
        secretMissingKey({ at: AT }),
        secretAccessDenied({ at: AT }),
      ].map(condition => condition.reason)
    )
    const unaccounted = failureReasonUnion.filter(
      reason => !modelled.has(reason) && !UNMODELLED_BY_DESIGN.has(reason)
    )
    expect(unaccounted).toEqual([])
  })
})

describe('SecretResolved producer contract — the resolver’s reading of it', () => {
  /** A producer-shaped False condition for an arbitrary extracted reason. */
  function producerFailure(reason: string): McpServerCondition {
    const status = derivedWrites[0].status as McpServerCondition['status']
    return {
      type: SECRET_RESOLVED,
      status,
      reason,
      message: renderProducerTemplate(reason),
      lastTransitionTime: AT,
    }
  }

  it('sends the operator to the create form for exactly one producer failure reason', () => {
    const sendsToCreate = failureReasonUnion.filter(
      reason => resolveCredentialSurface([producerFailure(reason)], { managed: true }) === 'set'
    )
    // One reason, and it is the one `secretNotFound()` builds — not a literal
    // restated here. Every other producer failure keeps the rotate form.
    expect(sendsToCreate).toEqual([secretNotFound({ at: AT }).reason])
  })

  it('keeps the rotate form for the producer’s success triple', () => {
    expect(resolveCredentialSurface([secretFound({ at: AT })], { managed: true })).toBe('rotate')
  })
})

describe('SecretResolved producer contract — adversarial fixtures are provably impossible', () => {
  // The synthetic builders exist so an adversarial fixture is never mistaken
  // for producer shape. These assertions prove they are outside it, derived
  // from the extraction rather than asserted by comment.

  it('the producer never writes SecretResolved at a status the synthetic builder can', () => {
    const producerStatuses = new Set(conditionWrites.map(write => write.status))
    const synthetic = syntheticCondition({ status: 'Unknown', lastTransitionTime: AT })
    expect(producerStatuses.has(synthetic.status)).toBe(false)
  })

  it('the producer never writes a SecretResolved reason under another condition type', () => {
    const synthetic = syntheticCondition({ type: 'Ready', lastTransitionTime: AT })
    expect(synthetic.type).not.toBe(SECRET_RESOLVED)
    // No condition write in the producer carries a SecretResolved failure
    // reason on a non-SecretResolved type.
    const anchorLines = new Set(conditionWrites.map(write => write.line - 1))
    lines.forEach((line, index) => {
      const reason = /^\s*reason: '([A-Za-z]+)',$/.exec(line)
      if (!reason || !failureReasonUnion.includes(reason[1])) return
      const typeLine = lines[index - 1] ?? ''
      // Either it is the validateSecret result itself, or it sits directly
      // under a `type: 'SecretResolved',` anchor.
      const isValidationResult = /^\s*ok: false,$/.test(typeLine)
      expect(isValidationResult || anchorLines.has(index - 2)).toBe(true)
    })
  })

  it('the producer always stamps lastTransitionTime, so the missing-stamp fixture is synthetic', () => {
    expect(/^\s*lastTransitionTime,$/m.test(source)).toBe(true)
    expect(withoutTimestamp(secretNotFound({ at: AT })).lastTransitionTime).toBeUndefined()
  })
})

// ─── Extraction 3: every `EgressProxyValuesValid` condition write ──────────
//
// The rollout wait's second condition. `fixtures/producerContract.ts` derives
// the pair from the block's `setStatus` verdict and the parsed
// `writeStatusCondition` calls; this extraction deliberately re-derives it
// differently — anchored on the type literal and keyed by the owning method —
// and then PINS the triples. The pins are the rename tripwire: the hook
// compares only type and status, so a producer rename of a reason would
// otherwise travel through the derived fixtures with every suite green. Here
// it fails by name.

type EgressConditionWrite = {
  line: number
  owner: string
  status: string
  reason: string
  message: string
}

function extractEgressConditionWrites(): EgressConditionWrite[] {
  const anchors: number[] = []
  lines.forEach((line, index) => {
    if (/^\s*type: 'EgressProxyValuesValid',$/.test(line)) anchors.push(index)
  })
  if (anchors.length === 0) {
    throw new Error(
      `EgressProxyValuesValid producer contract: found NO \`type: 'EgressProxyValuesValid',\` ` +
        `condition writes in ${RECONCILER_PATH}. Either the producer renamed the preflight ` +
        `condition the rollout wait polls for, or this extractor no longer matches it.`
    )
  }
  return anchors.map(index => ({
    line: index + 1,
    owner: enclosingMethod(index),
    status: matchProperty(lines[index + 1], /^\s*status: '([A-Za-z]+)',$/, index + 2, 'status'),
    reason: matchProperty(lines[index + 2], /^\s*reason: (.+),$/, index + 3, 'reason'),
    message: matchProperty(lines[index + 3], /^\s*message: (.+),$/, index + 4, 'message'),
  }))
}

const egressWrites = extractEgressConditionWrites()
const egressRefusalWrites = egressWrites.filter(write => write.message === 'verdict.message')
const egressLiteralWrites = egressWrites.filter(
  write => isStringLiteral(write.reason) && isStringLiteral(write.message)
)
if (egressRefusalWrites.length !== 1 || egressLiteralWrites.length !== 1) {
  throw new Error(
    `EgressProxyValuesValid producer contract: expected one verdict-forwarding refusal and one ` +
      `fully-literal pass, found ${egressRefusalWrites.length} and ${egressLiteralWrites.length} ` +
      `(lines ${egressWrites.map(write => write.line).join(', ')}). The rollout fixtures model ` +
      `exactly that pair; re-derive this contract for the new shape.`
  )
}
const egressRefusalWrite = egressRefusalWrites[0]
const egressWithinWrite = egressLiteralWrites[0]

// ─── Rendering the refusal message, independently ──────────────────────────

const EGRESS_SENTINEL = {
  placeholder: 'SENTINEL_PLACEHOLDER',
  secretName: 'sentinel-egress-secret',
  secretKey: 'sentinel-egress-key',
}

function egressProducerLine(from: number, pattern: RegExp, what: string): number {
  for (let index = from; index < lines.length; index++) {
    if (pattern.test(lines[index])) return index
  }
  throw new Error(
    `EgressProxyValuesValid producer contract: could not find ${what} in ${RECONCILER_PATH}. ` +
      `The refusal message is assembled there; re-derive this renderer.`
  )
}

function fillEgressTemplate(
  template: string,
  values: Record<string, string>,
  what: string
): string {
  const shield = '\u0001'
  const rendered = template
    .replace(/\\\$\{/g, shield)
    .replace(/\$\{([^}]+)\}/g, (_whole, expression: string) => {
      const value = values[expression]
      if (value === undefined) {
        throw new Error(
          `EgressProxyValuesValid producer contract: the ${what} interpolates ` +
            `\${${expression}}, which no sentinel maps to. Thread it through this renderer ` +
            `and the matching builder instead of rendering around it.`
        )
      }
      return value
    })
  return rendered.split(shield).join('${')
}

/** The producer's refusal message for one query Secret violation, rebuilt
 *  line by line from `formatEgressProxyValueMessage` and its helpers. */
function renderProducerRefusalMessage(): string {
  const describeAt = egressProducerLine(
    0,
    /private describeEnvSource\(/,
    'the describeEnvSource method'
  )
  const sourceLine = egressProducerLine(
    describeAt,
    /if \(secretKeyRef\) return `/,
    "describeEnvSource's Secret source template"
  )
  const sourceTemplate = /if \(secretKeyRef\) return `([^`]*)`/.exec(lines[sourceLine])![1]
  const sourceText = fillEgressTemplate(
    sourceTemplate,
    {
      'secretKeyRef.name': EGRESS_SENTINEL.secretName,
      'secretKeyRef.key': EGRESS_SENTINEL.secretKey,
    },
    'Secret source template'
  )

  const entryAt = egressProducerLine(
    0,
    /private formatEgressProxyValueEntry\(/,
    'the formatEgressProxyValueEntry method'
  )
  const queryAt = egressProducerLine(entryAt, /case 'query':/, "the entry formatter's query case")
  const entryMatched = /return `([^`]*)`/.exec(lines[queryAt + 1] ?? '')
  if (!entryMatched) {
    throw new Error(
      `EgressProxyValuesValid producer contract: the query case at ` +
        `${path.basename(RECONCILER_PATH)}:${queryAt + 1} no longer returns a template literal ` +
        `on the next line. Re-derive this renderer.`
    )
  }
  const entryText = fillEgressTemplate(
    entryMatched[1],
    {
      'violation.placeholder': EGRESS_SENTINEL.placeholder,
      'violation.source': sourceText,
      dependent: '',
    },
    'query entry template'
  )

  const summaryAt = egressProducerLine(
    0,
    /private formatEgressProxyValueMessage\(/,
    'the formatEgressProxyValueMessage method'
  )
  const returnAt = egressProducerLine(summaryAt, /^\s*return \($/, "the summary's return")
  const head = /^\s*`([^`]*)` \+$/.exec(lines[returnAt + 1] ?? '')
  const middle = /^\s*'([^']*)' \+$/.exec(lines[returnAt + 2] ?? '')
  const tail = /^\s*`([^`]*)`$/.exec(lines[returnAt + 3] ?? '')
  if (!head || !middle || !tail) {
    throw new Error(
      `EgressProxyValuesValid producer contract: the summary return at ` +
        `${path.basename(RECONCILER_PATH)}:${returnAt + 1} is no longer three concatenated ` +
        `operands. Re-derive this renderer.`
    )
  }
  return (
    fillEgressTemplate(head[1], { 'entries.length': '1' }, 'summary head') +
    middle[1] +
    fillEgressTemplate(tail[1], { "shown.join('; ')": entryText, more: '' }, 'summary tail')
  )
}

describe('EgressProxyValuesValid producer contract — extraction guards', () => {
  it('finds exactly the two producer write sites, by owning method', () => {
    expect(egressWrites).toHaveLength(2)
    expect(egressWrites.map(write => write.owner).sort()).toEqual([
      'blockEgressProxyValues',
      'performReconcile',
    ])
    expect(egressRefusalWrite.owner).toBe('blockEgressProxyValues')
    expect(egressWithinWrite.owner).toBe('performReconcile')
  })

  it('pins the refusal triple the rollout wait keys its failure off', () => {
    // Pinned, not merely cross-checked against the builder: the hook compares
    // status alone, so a reason rename must fail HERE by name.
    expect(egressRefusalWrite.status).toBe('False')
    expect(egressRefusalWrite.reason).toBe("'ValueOutsideClass'")
    expect(egressRefusalWrite.message).toBe('verdict.message')
  })

  it('pins the within-class triple', () => {
    expect(egressWithinWrite.status).toBe('True')
    expect(egressWithinWrite.reason).toBe("'ValuesWithinClass'")
    expect(egressWithinWrite.message).toBe(
      "'Every value the egress-proxy template substitutes is within its class'"
    )
  })

  it('the UI and the fixtures name the producer type under one value', () => {
    expect(EGRESS_PROXY_VALUES_VALID_CONDITION).toBe('EgressProxyValuesValid')
    expect(EGRESS_PROXY_VALUES_VALID).toBe(EGRESS_PROXY_VALUES_VALID_CONDITION)
    for (const write of egressWrites) {
      expect(lines[write.line - 1].trim()).toBe(`type: '${EGRESS_PROXY_VALUES_VALID}',`)
    }
  })
})

describe('EgressProxyValuesValid producer contract — fixture builders match the producer', () => {
  it('egressValuesRefused() reproduces the block write and its rendered message', () => {
    const fixture = egressValuesRefused({
      at: AT,
      observedGeneration: 7,
      placeholder: EGRESS_SENTINEL.placeholder,
      secretName: EGRESS_SENTINEL.secretName,
      secretKey: EGRESS_SENTINEL.secretKey,
    })
    expect(fixture.type).toBe(EGRESS_PROXY_VALUES_VALID_CONDITION)
    expect(fixture.status).toBe(egressRefusalWrite.status)
    expect(fixture.reason).toBe(unquote(egressRefusalWrite.reason))
    expect(fixture.message).toBe(renderProducerRefusalMessage())
    // The wording the hand-written fixture drifted on, pinned as text.
    expect(fixture.message).toContain('1 value(s) would be refused by the egress-proxy image')
    expect(fixture.lastTransitionTime).toBe(AT)
    expect(fixture.observedGeneration).toBe(7)
  })

  it('egressValuesWithinClass() reproduces the literal pass', () => {
    const fixture = egressValuesWithinClass({ at: AT, observedGeneration: 7 })
    expect(fixture.type).toBe(EGRESS_PROXY_VALUES_VALID_CONDITION)
    expect(fixture.status).toBe(egressWithinWrite.status)
    expect(fixture.reason).toBe(unquote(egressWithinWrite.reason))
    expect(fixture.message).toBe(unquote(egressWithinWrite.message))
    expect(fixture.lastTransitionTime).toBe(AT)
    expect(fixture.observedGeneration).toBe(7)
  })

  it('the builders leave observedGeneration unstamped when explicitly undefined', () => {
    const refused = egressValuesRefused({ at: AT, observedGeneration: undefined })
    expect(refused.observedGeneration).toBeUndefined()
    // Witness: the same builder still produced the producer-shaped refusal.
    expect(refused.status).toBe(egressRefusalWrite.status)
    expect(refused.lastTransitionTime).toBe(AT)
  })
})
