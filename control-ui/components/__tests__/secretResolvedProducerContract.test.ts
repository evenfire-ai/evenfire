import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCredentialSurface } from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import type { McpServerCondition } from '@lib/api'
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
  status: string
  /** RAW source expression, e.g. `'SecretFound'` or `secretResult.reason`. */
  reason: string
  /** RAW source expression, e.g. `'Secret resolved and validated'`. */
  message: string
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
    status: matchProperty(lines[index + 1], /^\s*status: '([A-Za-z]+)',$/, index + 2, 'status'),
    reason: matchProperty(lines[index + 2], /^\s*reason: (.+),$/, index + 3, 'reason'),
    message: matchProperty(lines[index + 3], /^\s*message: (.+),$/, index + 4, 'message'),
  }))
}

const conditionWrites = extractConditionWrites()

/**
 * The producer sites known when this contract was written: two `True` writes
 * (managed at ~:1981, WRC-owned at ~:2063) and two `False` writes that forward
 * `validateSecret`'s result (~:1872 and ~:2041).
 *
 * A change to this count is not automatically wrong, but it means a NEW way for
 * the UI to observe `SecretResolved` appeared, and the fixture contract below
 * has to be re-derived rather than assumed to still cover it.
 */
const KNOWN_PRODUCER_WRITE_SITES = 4

const isStringLiteral = (expression: string) => /^'[^']*'$/.test(expression)
const unquote = (expression: string) => expression.slice(1, -1)

const literalWrites = conditionWrites.filter(
  write => isStringLiteral(write.reason) && isStringLiteral(write.message)
)
const derivedWrites = conditionWrites.filter(
  write => write.reason === 'secretResult.reason' && write.message === 'secretResult.message'
)

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
  it('finds the producer condition writes it expects to find', () => {
    expect(conditionWrites.length).toBe(KNOWN_PRODUCER_WRITE_SITES)
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

  it('secretFound() reproduces the producer’s success triple, and both sites agree', () => {
    const successWrites = literalWrites.filter(write => write.status === 'True')
    expect(successWrites.length).toBeGreaterThan(0)
    // All True sites must write the same triple; otherwise one fixture cannot
    // stand for both and the builder has to grow a discriminator.
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
