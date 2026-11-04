import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServerCondition } from '@lib/api'

/**
 * The `SecretResolved` and `EgressProxyValuesValid` contracts, READ OFF THE
 * PRODUCER (R1-H2).
 *
 * Every `SecretResolved` condition the credential screen can ever observe is
 * written by `host-context-controller/src/reconciler.ts`, and by nothing else.
 * This module extracts that contract — the condition type, the success triple,
 * the failure status, and each failure reason with its message template — from
 * the producer's own source text, so the fixture builders in
 * `./secretResolvedConditions.ts` can DERIVE their values instead of restating
 * them.
 *
 * That derivation is the whole point. A handwritten mirror of the producer is
 * exactly as stale as the author who wrote it, and a UI suite cannot tell the
 * difference: if HCC renamed a reason, both the mocked producer output and the
 * assertion would keep encoding the old triple and stay green. With the
 * fixtures derived, the rename travels into every suite that renders a
 * connector — `getMcpServer` → page → resolver → component — and the ones whose
 * expectations no longer hold go red.
 *
 * ── Nothing here may fail SILENTLY ────────────────────────────────────────
 *
 * A silently-empty extraction would let every consuming suite pass while
 * proving nothing, which is strictly worse than the handwritten mirror it
 * replaces. So every step throws — at IMPORT time, before a single test body
 * runs — when it cannot find what it is looking for: a missing or implausibly
 * small producer file, a condition write it cannot parse, a failure branch it
 * cannot classify, a declared reason with no matching return, a message
 * placeholder no builder argument feeds. There is no code path that returns an
 * empty or partial contract.
 *
 * ── Independence from `../secretResolvedProducerContract.test.ts` ──────────
 *
 * That suite reads the same producer and asserts the fixture builders reproduce
 * what IT extracted. It deliberately does not import this module: the two
 * extractions are written differently on purpose — this one anchors on the
 * `writeStatusCondition` CALL and classifies failures by the BRANCH GUARD they
 * sit under, that one anchors on the `type: 'SecretResolved',` literal and keys
 * failures by their reason string. Neither can vacuously agree with itself, and
 * a disagreement between them is a red test rather than a shared blind spot.
 *
 * This module reads source TEXT only. It does not import the controller:
 * making control-ui depend on an HCC package at runtime would be heavier
 * coupling than the drift it prevents.
 */

const RECONCILER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../host-context-controller/src/reconciler.ts'
)

/** Smallest size the real reconciler has ever been, by a wide margin. A stub, a
 *  truncated read or an empty file must not be mistaken for "no producer". */
const MIN_PRODUCER_BYTES = 20_000

function fail(detail: string): never {
  throw new Error(
    `SecretResolved producer contract [${path.basename(RECONCILER_PATH)}]: ${detail} ` +
      `This module is the only thing tying the control-ui credential fixtures to the real ` +
      `host-context-controller conditions — repair the extraction, do not delete it.`
  )
}

function readProducerSource(): string {
  let text: string
  try {
    text = readFileSync(RECONCILER_PATH, 'utf8')
  } catch (error) {
    fail(
      `cannot read the producer at ${RECONCILER_PATH}. If the host-context-controller moved, ` +
        `update RECONCILER_PATH. (${error instanceof Error ? error.message : String(error)})`
    )
  }
  if (text.length < MIN_PRODUCER_BYTES) {
    fail(
      `${RECONCILER_PATH} is only ${text.length} bytes, below the ${MIN_PRODUCER_BYTES}-byte ` +
        `floor. Refusing to derive a contract from what is almost certainly not the real reconciler.`
    )
  }
  return text
}

const source = readProducerSource()
const lines = source.split('\n')

// ─── Small source-text helpers ─────────────────────────────────────────────

const indentOf = (line: string): number => line.length - line.trimStart().length
const isBlank = (line: string): boolean => line.trim() === ''
const isStringLiteral = (expression: string): boolean => /^'[^']*'$/.test(expression)
const unquote = (expression: string): string => expression.slice(1, -1)
const stripTrailingComma = (text: string): string => text.replace(/,$/, '')

/** Index of the line closing the brace opened on `startIndex`. */
function blockEnd(startIndex: number, what: string): number {
  let depth = 0
  for (let index = startIndex; index < lines.length; index++) {
    for (const character of lines[index]) {
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) return index
      }
    }
  }
  return fail(`the ${what} opened at line ${startIndex + 1} is never closed.`)
}

/**
 * Properties of an object literal whose opening brace is on `startIndex`,
 * keyed by name with the RAW value expression (whitespace collapsed, trailing
 * comma removed). Multi-line values — ternaries, concatenated templates — are
 * joined; ES shorthand (`message,`) yields the identifier as its own value.
 */
function propertiesOf(startIndex: number, endIndex: number): Map<string, string> {
  const propertyIndent = indentOf(lines[startIndex]) + 2
  const properties = new Map<string, string>()
  let name: string | null = null
  let parts: string[] = []

  const flush = (): void => {
    // Lines are joined with a single space and NOT whitespace-collapsed: a
    // producer message is compared byte for byte, so squeezing runs of spaces
    // inside one would invent a message no controller ever wrote.
    if (name !== null) {
      properties.set(name, stripTrailingComma(parts.join(' ').trim()))
    }
    name = null
    parts = []
  }

  for (let index = startIndex + 1; index < endIndex; index++) {
    const line = lines[index]
    if (isBlank(line)) continue
    const declaration =
      indentOf(line) === propertyIndent
        ? /^([A-Za-z_$][\w$]*)(?::\s*(.*))?$/.exec(stripTrailingComma(line.trim()))
        : null
    if (declaration) {
      flush()
      name = declaration[1]
      // `message,` shorthand: the value IS the identifier.
      parts = [declaration[2] === undefined ? declaration[1] : declaration[2]]
      continue
    }
    if (name === null) continue // leading comment, before the first property
    parts.push(line.trim())
  }
  flush()
  return properties
}

function requiredProperty(properties: Map<string, string>, name: string, what: string): string {
  const value = properties.get(name)
  if (value === undefined) {
    fail(`the ${what} has no \`${name}\` property. Its literal changed shape; re-derive this.`)
  }
  return value
}

// ─── Extraction 1: the condition writes ────────────────────────────────────
//
// Anchored on the CALL — not on any condition type literal, so the condition
// type itself is derived rather than assumed. The HCC writes are deliberately
// formatted across arguments (`writeStatusCondition(\n server,\n { ... })`) to
// make the cancellation callback explicit, while older producer revisions
// used `writeStatusCondition(server, { ... })`; both are accepted here.

type ConditionWrite = {
  /** 1-based line of the call, for failure messages. */
  line: number
  /** The condition type, unquoted. Always a literal (enforced below). */
  type: string
  /** RAW source expressions, e.g. `'True'` or `secretResult.reason`. */
  status: string
  reason: string
  message: string
}

const WRITE_CALL = /^\s*await this\.writeStatusCondition\($/
const LEGACY_WRITE_CALL = /^\s*await this\.writeStatusCondition\(server, \{$/

function conditionObjectStart(callIndex: number): number | null {
  if (LEGACY_WRITE_CALL.test(lines[callIndex])) return callIndex
  const serverArgument = lines[callIndex + 1]?.trim()
  // This contract models reconcile's McpServer SecretResolved writes. Other
  // controller paths write conditions for `state.server`; they are not part of
  // the validateSecret producer contract and must not make this extractor
  // reject a source file that legitimately contains them.
  if (serverArgument !== 'server,') return null
  const conditionObject = lines[callIndex + 2]?.trim()
  if (conditionObject !== '{') {
    fail(
      `the writeStatusCondition call at line ${callIndex + 1} no longer passes ` +
        '`server` followed by a condition object. Re-derive the producer contract.'
    )
  }
  return callIndex + 2
}

function extractConditionWrites(): ConditionWrite[] {
  const writes: ConditionWrite[] = []
  lines.forEach((line, index) => {
    if (!WRITE_CALL.test(line) && !LEGACY_WRITE_CALL.test(line)) return
    const objectStart = conditionObjectStart(index)
    if (objectStart === null) return
    const what = `condition write at line ${index + 1}`
    const properties = propertiesOf(objectStart, blockEnd(objectStart, what))
    const typeExpression = requiredProperty(properties, 'type', what)
    if (!isStringLiteral(typeExpression)) {
      fail(
        `the ${what} names its type with the expression \`${typeExpression}\` rather than a ` +
          `string literal. A computed condition type is invisible to this contract, which would ` +
          `let a SecretResolved write go unmodelled.`
      )
    }
    writes.push({
      line: index + 1,
      type: unquote(typeExpression),
      status: requiredProperty(properties, 'status', what),
      reason: requiredProperty(properties, 'reason', what),
      message: requiredProperty(properties, 'message', what),
    })
  })
  if (writes.length === 0) {
    fail(
      'found NO writeStatusCondition calls with a server and condition object. Either the producer stopped ' +
        `writing status conditions altogether, or this extractor no longer matches the call.`
    )
  }
  return writes
}

const conditionWrites = extractConditionWrites()

/**
 * The FORWARDING writes: the ones whose reason and message come straight from a
 * `validateSecret` failure result. They are what identifies the SecretResolved
 * condition type and its failure status without either being restated here.
 */
const forwardingWrites = conditionWrites.filter(write => write.reason === 'secretResult.reason')

if (forwardingWrites.length === 0) {
  fail(
    `no condition write forwards \`secretResult.reason\`. Every False SecretResolved condition ` +
      `the credential screen reads is one of those forwards, so an empty set means the extractor ` +
      `is broken or the producer stopped surfacing secret validation failures as conditions.`
  )
}

function onlyValue(values: string[], what: string): string {
  const distinct = new Set(values)
  if (distinct.size !== 1) {
    fail(`expected ONE ${what} across the producer's forwarding writes, found ${[...distinct]}.`)
  }
  return [...distinct][0]
}

for (const write of forwardingWrites) {
  if (write.message !== 'secretResult.message') {
    fail(
      `the condition write at line ${write.line} forwards \`secretResult.reason\` but writes ` +
        `\`${write.message}\` as its message. The fixtures derive the condition message from the ` +
        `validateSecret result, which that write no longer does.`
    )
  }
}

/**
 * The condition type the credential screen resolves on, taken from the
 * producer's own forwarding writes.
 */
export const PRODUCER_CONDITION_TYPE: string = onlyValue(
  forwardingWrites.map(write => write.type),
  'condition type'
)

/**
 * The K8s tri-state the UI's own `McpServerCondition` admits. This is a
 * CONSUMER-side constraint, not a copy of the producer: a producer value
 * outside it could not be typed as a condition at all, and silently widening
 * the UI type is exactly the drift this module exists to refuse.
 */
const CONDITION_STATUSES: McpServerCondition['status'][] = ['True', 'False', 'Unknown']

function asConditionStatus(expression: string, what: string): McpServerCondition['status'] {
  if (!isStringLiteral(expression)) {
    fail(`the ${what} is the expression \`${expression}\`, not a string literal status.`)
  }
  const value = unquote(expression) as McpServerCondition['status']
  if (!CONDITION_STATUSES.includes(value)) {
    fail(
      `the ${what} is '${value}', which is not one of the tri-state values the UI's ` +
        `McpServerCondition admits (${CONDITION_STATUSES.join(', ')}).`
    )
  }
  return value
}

/** The status every forwarded `validateSecret` failure is written at. */
export const PRODUCER_FAILURE_STATUS: McpServerCondition['status'] = asConditionStatus(
  onlyValue(
    forwardingWrites.map(write => write.status),
    'failure status'
  ),
  'forwarded failure status'
)

/**
 * The success triple. Derived as "every fully-literal write on the
 * SecretResolved type", which is the complement of the forwarding writes — so a
 * THIRD write shape on that type is a hard error rather than something this
 * contract quietly ignores.
 */
function extractSuccess(): {
  status: McpServerCondition['status']
  reason: string
  message: string
} {
  const onType = conditionWrites.filter(write => write.type === PRODUCER_CONDITION_TYPE)
  const literal = onType.filter(
    write =>
      isStringLiteral(write.status) &&
      isStringLiteral(write.reason) &&
      isStringLiteral(write.message)
  )
  if (literal.length + forwardingWrites.length !== onType.length) {
    fail(
      `the producer writes '${PRODUCER_CONDITION_TYPE}' in a shape that is neither a forwarded ` +
        `validateSecret failure nor a fully-literal triple (lines ` +
        `${onType.map(write => write.line).join(', ')}). The UI can observe a condition this ` +
        `contract says nothing about.`
    )
  }
  if (literal.length === 0) {
    fail(`the producer never writes a literal '${PRODUCER_CONDITION_TYPE}' triple any more.`)
  }
  const distinct = new Set(literal.map(write => `${write.status}|${write.reason}|${write.message}`))
  if (distinct.size !== 1) {
    fail(
      `the producer's literal '${PRODUCER_CONDITION_TYPE}' writes no longer agree: ${[...distinct]}. ` +
        `One fixture builder cannot stand for all of them; it needs a discriminator.`
    )
  }
  const success = literal[0]
  const status = asConditionStatus(success.status, `literal write at line ${success.line}`)
  if (status === PRODUCER_FAILURE_STATUS) {
    fail(
      `the producer's literal '${PRODUCER_CONDITION_TYPE}' write at line ${success.line} carries ` +
        `the FAILURE status '${status}', so there is no success triple to derive.`
    )
  }
  return { status, reason: unquote(success.reason), message: unquote(success.message) }
}

/** The triple both success sites — managed and WRC-owned — write. */
export const PRODUCER_SUCCESS: {
  status: McpServerCondition['status']
  reason: string
  message: string
} = extractSuccess()

// ─── Extraction 2: validateSecret's failure results ────────────────────────
//
// Scoped to the `validateSecret` method body, and each result is classified by
// the BRANCH GUARD it sits under — the k8s 404, the 401/403, the missing-key
// check — never by the reason string it returns. That is what makes a reason
// RENAME propagate instead of throwing: the role survives, the value moves.

function findMethodBody(name: string): { start: number; end: number } {
  const start = lines.findIndex(line => new RegExp(`^\\s*async ${name}\\(`).test(line))
  if (start < 0) {
    fail(`could not find the \`async ${name}(\` method. Every False condition forwards its result.`)
  }
  const methodIndent = indentOf(lines[start])
  for (let index = start + 1; index < lines.length; index++) {
    if (indentOf(lines[index]) === methodIndent && lines[index].trim() === '}') {
      return { start, end: index }
    }
  }
  return fail(`the \`async ${name}(\` method starting at line ${start + 1} is never closed.`)
}

const validateSecret = findMethodBody('validateSecret')

/**
 * The block openers enclosing a statement, innermost first, up to the method
 * signature. Derived from indentation: the first PRECEDING line indented less
 * than the statement is the opener of the block containing it, and the walk
 * repeats from there.
 */
function enclosingBlockOpeners(statementIndex: number): string[] {
  const openers: string[] = []
  let indent = indentOf(lines[statementIndex])
  for (let index = statementIndex - 1; index >= validateSecret.start; index--) {
    if (isBlank(lines[index])) continue
    const candidate = indentOf(lines[index])
    if (candidate < indent) {
      openers.push(lines[index].trim())
      indent = candidate
    }
  }
  if (openers.length === 0) {
    fail(
      `the failure return at line ${statementIndex + 1} has no enclosing block, which is not a ` +
        `shape TypeScript can produce. The indentation this extractor reads nesting from changed.`
    )
  }
  return openers
}

/**
 * Collapses a possibly multi-line, possibly `+`-concatenated template literal
 * into the single template it evaluates to. A plain quoted string is accepted
 * as a template with no placeholders.
 */
function normalizeTemplate(raw: string, what: string): string {
  const joined = raw.trim().replace(/`\s*\+\s*`/g, '')
  if (isStringLiteral(joined)) return unquote(joined)
  if (!joined.startsWith('`') || !joined.endsWith('`') || joined.length < 2) {
    fail(
      `could not read the message template for ${what}. Expected one or more concatenated ` +
        `template literals, got ${JSON.stringify(raw)}.`
    )
  }
  return joined.slice(1, -1)
}

/** Walks BACK from a failure return to the `const message =` that fed it. */
function templateFromPrecedingAssignment(returnIndex: number, what: string): string {
  for (let index = returnIndex; index >= validateSecret.start; index--) {
    const assignment = /^\s*const message =(.*)$/.exec(lines[index])
    if (!assignment) continue
    const baseIndent = indentOf(lines[index])
    const parts = [assignment[1].trim()]
    for (let cursor = index + 1; cursor < validateSecret.end; cursor++) {
      if (isBlank(lines[cursor]) || indentOf(lines[cursor]) <= baseIndent) break
      parts.push(lines[cursor].trim())
    }
    return normalizeTemplate(parts.join(' '), what)
  }
  return fail(
    `the ${what} references a \`message\` with no preceding \`const message =\` assignment. ` +
      `The producer's failure construction changed.`
  )
}

type FailureReturn = { line: number; reason: string; template: string }

const INLINE_FAILURE = /^return \{ ok: false, reason: ('[A-Za-z]+'), message \},?$/

function extractFailureReturns(): FailureReturn[] {
  const results: FailureReturn[] = []
  for (let index = validateSecret.start + 1; index < validateSecret.end; index++) {
    const trimmed = lines[index].trim()
    if (!trimmed.startsWith('return {')) continue
    const what = `validateSecret failure return at line ${index + 1}`

    // Single-line form: `return { ok: false, reason: 'X', message }`.
    if (trimmed.includes('ok: false') && !trimmed.endsWith('{')) {
      const inline = INLINE_FAILURE.exec(trimmed)
      if (!inline) {
        fail(`the ${what} is an \`ok: false\` result this extractor cannot parse: ${trimmed}`)
      }
      results.push({
        line: index + 1,
        reason: unquote(inline[1]),
        template: templateFromPrecedingAssignment(index, what),
      })
      continue
    }
    if (!trimmed.endsWith('{')) continue

    // Multi-line object form.
    const properties = propertiesOf(index, blockEnd(index, what))
    if (properties.get('ok') !== 'false') continue
    const reason = requiredProperty(properties, 'reason', what)
    if (!isStringLiteral(reason)) {
      fail(`the ${what} names its reason with \`${reason}\` rather than a string literal.`)
    }
    const message = requiredProperty(properties, 'message', what)
    results.push({
      line: index + 1,
      reason: unquote(reason),
      template:
        message === 'message'
          ? templateFromPrecedingAssignment(index, what)
          : normalizeTemplate(message, what),
    })
  }
  if (results.length === 0) {
    fail(
      `found NO \`ok: false\` results inside validateSecret. Every False ${PRODUCER_CONDITION_TYPE} ` +
        `condition forwards one of them, so an empty set means the extractor is broken, not that ` +
        `the failures are gone.`
    )
  }
  return results
}

const failureReturns = extractFailureReturns()

/**
 * What each failure MEANS, keyed by the branch the producer takes to reach it.
 *
 *  - `absent`       the API server said the Secret is not there (k8s 404). The
 *                   ONLY failure that may send a managed connector to the
 *                   create form.
 *  - `missingKey`   the Secret EXISTS and lacks a declared key. The rotate
 *                   merge-patch adds it.
 *  - `accessDenied` HCC was not allowed to look (k8s 401/403), so this is no
 *                   evidence about the Secret at all.
 *  - `readError`    any other read failure — the branch with no guard.
 */
export type ProducerFailureRole = 'absent' | 'missingKey' | 'accessDenied' | 'readError'

/** Branch guards, NOT reason strings: a reason RENAME must move the value this
 *  role carries, not make the role unfindable. */
const ROLE_GUARDS: { role: Exclude<ProducerFailureRole, 'readError'>; guard: RegExp }[] = [
  { role: 'absent', guard: /\bcode === 404\b/ },
  { role: 'accessDenied', guard: /\bcode === 401\b|\bcode === 403\b/ },
  { role: 'missingKey', guard: /keyMapping\.secretKey in data/ },
]

function classifyFailureReturns(): Record<ProducerFailureRole, FailureReturn> {
  const byRole = new Map<ProducerFailureRole, FailureReturn[]>()
  const record = (role: ProducerFailureRole, result: FailureReturn): void => {
    byRole.set(role, [...(byRole.get(role) ?? []), result])
  }

  for (const result of failureReturns) {
    const openers = enclosingBlockOpeners(result.line - 1)
    const matched = ROLE_GUARDS.filter(({ guard }) => openers.some(opener => guard.test(opener)))
    if (matched.length > 1) {
      fail(
        `the failure return at line ${result.line} sits under more than one branch guard ` +
          `(${matched.map(entry => entry.role).join(', ')}), so its meaning is ambiguous.`
      )
    }
    record(matched.length === 1 ? matched[0].role : 'readError', result)
  }

  const roles: ProducerFailureRole[] = [...ROLE_GUARDS.map(entry => entry.role), 'readError']
  const classified = {} as Record<ProducerFailureRole, FailureReturn>
  for (const role of roles) {
    const found = byRole.get(role) ?? []
    if (found.length !== 1) {
      fail(
        `expected EXACTLY ONE validateSecret failure for the '${role}' branch, found ` +
          `${found.length}${found.length ? ` (lines ${found.map(r => r.line).join(', ')})` : ''}. ` +
          `${
            role === 'readError'
              ? 'The unguarded branch is how a NEW failure mode shows up; triage it against the ' +
                'create path before re-deriving this.'
              : 'The branch that decides which credential surface an operator gets moved or forked.'
          }`
      )
    }
    classified[role] = found[0]
  }
  return classified
}

const failureByRole = classifyFailureReturns()

// ─── Extraction 3: the producer's own enumeration of its failure reasons ───
//
// A cross-check on the two above: the reasons the branches return must be
// exactly the reasons the type declares. A fifth reason, or a declared reason
// no branch returns, means the classification above is incomplete.

function extractFailureReasonUnion(): string[] {
  const start = lines.findIndex(line => /^export type SecretValidationResult\b/.test(line))
  if (start < 0) {
    fail(
      `could not find \`export type SecretValidationResult\`. It is the producer's own ` +
        `enumeration of what a False ${PRODUCER_CONDITION_TYPE} can say.`
    )
  }
  for (let index = start + 1; index < lines.length; index++) {
    // The declaration ends at the next top-level statement.
    if (/^\S/.test(lines[index]) && !isBlank(lines[index])) break
    const declaration = /^\s*reason: ((?:'[A-Za-z]+'(?:\s*\|\s*)?)+)$/.exec(lines[index])
    if (!declaration) continue
    const reasons = (declaration[1].match(/'([A-Za-z]+)'/g) ?? []).map(unquote)
    if (reasons.length === 0) {
      fail(`the SecretValidationResult failure-reason union at line ${index + 1} is empty.`)
    }
    return reasons
  }
  return fail(
    `SecretValidationResult declares no failure-reason union. Without it this contract cannot ` +
      `detect a new reason appearing.`
  )
}

/** Every failure reason the producer declares it can return. */
export const PRODUCER_FAILURE_REASONS: string[] = extractFailureReasonUnion()

{
  const declared = new Set(PRODUCER_FAILURE_REASONS)
  const returned = new Set(failureReturns.map(result => result.reason))
  const missing = [...declared].filter(reason => !returned.has(reason))
  const extra = [...returned].filter(reason => !declared.has(reason))
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `the declared failure reasons and the ones validateSecret actually returns disagree — ` +
        `declared-but-never-returned: [${missing}], returned-but-undeclared: [${extra}]. ` +
        `One of the two extractions is incomplete, so the role classification cannot be trusted.`
    )
  }
}

// ─── Rendering a producer message template ─────────────────────────────────

/** The values a fixture feeds into the producer's message templates. */
export type ProducerMessageValues = {
  secretName?: string
  namespace?: string
  secretKey?: string
  envVar?: string
  code?: number | string
  readErrorMessage?: string
}

/**
 * Producer interpolation expression -> the fixture argument that fills it.
 *
 * An unmapped expression throws: a NEW interpolation in a producer message is
 * exactly the drift this module exists to catch, and rendering it as the empty
 * string would quietly produce a message no controller ever writes.
 */
const PLACEHOLDER_ARGUMENTS: Record<string, keyof ProducerMessageValues> = {
  secretName: 'secretName',
  'server.namespace': 'namespace',
  'keyMapping.secretKey': 'secretKey',
  'keyMapping.envVar': 'envVar',
  code: 'code',
  errMsg: 'readErrorMessage',
}

/**
 * The reason and message the producer emits for one failure ROLE, with the
 * caller's values interpolated into the producer's own template.
 */
export function producerFailure(
  role: ProducerFailureRole,
  values: ProducerMessageValues = {}
): { reason: string; message: string } {
  const result = failureByRole[role]
  const message = result.template.replace(/\$\{([^}]+)\}/g, (_whole, expression: string) => {
    const argument = PLACEHOLDER_ARGUMENTS[expression]
    if (argument === undefined) {
      fail(
        `the message for the '${role}' branch (line ${result.line}) interpolates ` +
          `\${${expression}}, which no fixture argument maps to. Add it to PLACEHOLDER_ARGUMENTS ` +
          `and thread the value through the matching builder in ./secretResolvedConditions.ts.`
      )
    }
    const value = values[argument]
    if (value === undefined) {
      fail(
        `the message for the '${role}' branch (line ${result.line}) interpolates ` +
          `\${${expression}}, but the fixture passed no \`${argument}\`. A producer message must ` +
          `never be built with a hole in it.`
      )
    }
    return String(value)
  })
  if (message.includes('${')) {
    fail(`the rendered '${role}' message still contains an interpolation: ${message}`)
  }
  return { reason: result.reason, message }
}

// ─── Extraction 4: the egress-proxy value-preflight writes ─────────────────
//
// The rollout wait reads a second condition: the egress-proxy preflight's
// verdict. The producer writes it exactly twice — a refusal from the block
// path (message forwarded from the verdict) and a within-class pass from the
// managed reconcile (fully literal) — and the hand-written copy of that pair
// in the rollout tests already drifted once ("1 value" where the producer
// writes "1 value(s)"). So this section derives the pair the same way the
// sections above derive `SecretResolved`: the condition TYPE is never assumed
// here. The block path publishes its own verdict in `setStatus` as
// `TYPE=STATUS: ${verdict.message}`; that template names the type whose two
// `writeStatusCondition` calls this section then extracts from the already
// parsed `conditionWrites`. A renamed type, status or reason therefore moves
// the fixtures (and breaks the suites that assert the old behaviour), while
// `../secretResolvedProducerContract.test.ts` pins the extracted values from
// its own independent reading.

function extractEgressBlockVerdict(): { type: string; status: McpServerCondition['status'] } {
  const verdicts = [...source.matchAll(/`([A-Za-z]+)=([A-Za-z]+): \$\{verdict\.message\}`/g)]
  if (verdicts.length !== 1) {
    fail(
      `expected exactly one \`TYPE=STATUS: \${verdict.message}\` status line naming the ` +
        `egress-proxy block verdict, found ${verdicts.length}. Without it this contract ` +
        `cannot derive which condition type the preflight writes.`
    )
  }
  return {
    type: verdicts[0][1],
    status: asConditionStatus(`'${verdicts[0][2]}'`, 'egress-proxy block status'),
  }
}

const egressBlockVerdict = extractEgressBlockVerdict()

/** The preflight condition type, taken from the producer's own block verdict. */
export const EGRESS_PRODUCER_CONDITION_TYPE: string = egressBlockVerdict.type

function extractEgressWrites(): {
  refusal: { status: McpServerCondition['status']; reason: string }
  withinClass: { status: McpServerCondition['status']; reason: string; message: string }
} {
  const onType = conditionWrites.filter(write => write.type === EGRESS_PRODUCER_CONDITION_TYPE)
  if (onType.length !== 2) {
    fail(
      `expected exactly TWO '${EGRESS_PRODUCER_CONDITION_TYPE}' condition writes (the block ` +
        `refusal and the within-class pass), found ${onType.length}` +
        `${onType.length ? ` at lines ${onType.map(write => write.line).join(', ')}` : ''}. ` +
        `A third way for the UI to observe the preflight verdict has to be modelled here.`
    )
  }
  const refusalWrites = onType.filter(write => write.message === 'verdict.message')
  const literalWritesOnType = onType.filter(
    write =>
      isStringLiteral(write.status) &&
      isStringLiteral(write.reason) &&
      isStringLiteral(write.message)
  )
  if (refusalWrites.length !== 1 || literalWritesOnType.length !== 1) {
    fail(
      `the '${EGRESS_PRODUCER_CONDITION_TYPE}' writes are no longer one verdict-forwarding ` +
        `refusal plus one fully-literal pass (lines ${onType.map(write => write.line).join(', ')}). ` +
        `The UI can observe a preflight condition this contract says nothing about.`
    )
  }
  const refusalWrite = refusalWrites[0]
  if (!isStringLiteral(refusalWrite.status) || !isStringLiteral(refusalWrite.reason)) {
    fail(
      `the refusal write at line ${refusalWrite.line} no longer carries literal status and ` +
        `reason next to \`verdict.message\` (status: ${refusalWrite.status}, reason: ` +
        `${refusalWrite.reason}). The fixtures derive both from that literal pair.`
    )
  }
  const refusalStatus = asConditionStatus(
    refusalWrite.status,
    `refusal write at line ${refusalWrite.line}`
  )
  if (refusalStatus !== egressBlockVerdict.status) {
    fail(
      `the block's status line says '${EGRESS_PRODUCER_CONDITION_TYPE}=${egressBlockVerdict.status}' ` +
        `but the condition write at line ${refusalWrite.line} carries '${refusalStatus}'. The ` +
        `producer disagrees with itself about the refusal, so no fixture can stand for it.`
    )
  }
  const withinWrite = literalWritesOnType[0]
  const withinStatus = asConditionStatus(
    withinWrite.status,
    `within-class write at line ${withinWrite.line}`
  )
  if (withinStatus === refusalStatus) {
    fail(
      `the literal '${EGRESS_PRODUCER_CONDITION_TYPE}' write at line ${withinWrite.line} carries ` +
        `the REFUSAL status '${withinStatus}', so there is no within-class pass to derive.`
    )
  }
  return {
    refusal: { status: refusalStatus, reason: unquote(refusalWrite.reason) },
    withinClass: {
      status: withinStatus,
      reason: unquote(withinWrite.reason),
      message: unquote(withinWrite.message),
    },
  }
}

const egressWrites = extractEgressWrites()

/** The block path's refusal: status and reason. The message is computed from
 *  the violations; `egressProducerRefusalMessage` renders it below. */
export const EGRESS_PRODUCER_REFUSAL: {
  status: McpServerCondition['status']
  reason: string
} = egressWrites.refusal

/** The managed reconcile's within-class pass: the full literal triple. */
export const EGRESS_PRODUCER_WITHIN_CLASS: {
  status: McpServerCondition['status']
  reason: string
  message: string
} = egressWrites.withinClass

// ─── Rendering the refusal message ─────────────────────────────────────────
//
// The refusal message is `formatEgressProxyValueMessage`'s output: a count, a
// fixed middle, the spelled-out entries and a fixed tail. This renderer
// extracts those templates (plus the query entry and the Secret source) from
// the producer text and evaluates the ONE shape the rollout tests need: a
// single query-position violation sourced from a Secret key, in the plain
// value class (so the dependent-env suffix is empty and nothing is hidden
// behind the "; and N more" cap). Multi-violation ordering and the other two
// entry contexts stay producer-internal until a test needs them; an
// interpolation this renderer does not map throws instead of rendering a
// message no controller ever wrote.

function egressMethodBody(name: string): { start: number; end: number } {
  const start = lines.findIndex(line => new RegExp(`^\\s*private (?:async )?${name}\\(`).test(line))
  if (start < 0) {
    fail(`could not find the producer method \`${name}\`. The refusal message is built there.`)
  }
  const methodIndent = indentOf(lines[start])
  for (let index = start + 1; index < lines.length; index++) {
    if (indentOf(lines[index]) === methodIndent && lines[index].trim() === '}') {
      return { start, end: index }
    }
  }
  return fail(`the producer method \`${name}\` starting at line ${start + 1} is never closed.`)
}

/** The escaped placeholder opener the producer writes as `\${`, shielded while
 *  real interpolations are substituted so the two are never confused. */
const SHIELDED_PLACEHOLDER = '\u0000'

function renderEgressTemplate(
  template: string,
  values: Record<string, string>,
  what: string
): string {
  const shielded = template.replace(/\\\$\{/g, SHIELDED_PLACEHOLDER)
  const rendered = shielded.replace(/\$\{([^}]+)\}/g, (_whole, expression: string) => {
    const value = values[expression]
    if (value === undefined) {
      fail(
        `the ${what} interpolates \${${expression}}, which this renderer does not map. ` +
          `Thread the value through egressProducerRefusalMessage instead of guessing it.`
      )
    }
    return value
  })
  // No leftover-interpolation check here: every `${...}` the template itself
  // held was substituted above (an unmapped one throws), so a `${` in the
  // result can only be the literal placeholder a substituted value carries.
  return rendered.split(SHIELDED_PLACEHOLDER).join('${')
}

function extractEgressMessageTemplates(): {
  secretSource: string
  queryEntry: string
  summaryHead: string
  summaryMiddle: string
  summaryTail: string
} {
  const describe = egressMethodBody('describeEnvSource')
  let secretSource: string | undefined
  for (let index = describe.start; index <= describe.end; index++) {
    const matched = /if \(secretKeyRef\) return `([^`]*)`/.exec(lines[index])
    if (matched) secretSource = matched[1]
  }
  if (secretSource === undefined) {
    fail(
      `describeEnvSource no longer returns a template literal for its Secret branch. ` +
        `The refusal entry names its source through that template.`
    )
  }

  const entry = egressMethodBody('formatEgressProxyValueEntry')
  let queryEntry: string | undefined
  for (let index = entry.start; index <= entry.end; index++) {
    if (!/^\s*case 'query':$/.test(lines[index])) continue
    const matched = /return `([^`]*)`/.exec(lines[index + 1] ?? '')
    if (!matched) {
      fail(
        `the 'query' case of formatEgressProxyValueEntry (line ${index + 1}) no longer returns ` +
          `a single template literal on the next line. Re-derive the entry extraction.`
      )
    }
    queryEntry = matched[1]
  }
  if (queryEntry === undefined) {
    fail(
      `formatEgressProxyValueEntry has no 'query' case any more. The rollout fixtures model ` +
        `a query-position refusal, which that case spells out.`
    )
  }

  const summary = egressMethodBody('formatEgressProxyValueMessage')
  let returnStart = -1
  for (let index = summary.start; index <= summary.end; index++) {
    if (/^\s*return \($/.test(lines[index])) returnStart = index
  }
  if (returnStart < 0) {
    fail(
      `formatEgressProxyValueMessage no longer returns a parenthesised concatenation. ` +
        `Re-derive the summary extraction.`
    )
  }
  const returnLines: string[] = []
  for (let index = returnStart + 1; index <= summary.end; index++) {
    if (lines[index].trim() === ')') break
    returnLines.push(lines[index].trim())
  }
  const operands = [...returnLines.join(' ').matchAll(/`([^`]*)`|'([^']*)'/g)].map(
    matched => matched[1] ?? matched[2]
  )
  if (operands.length !== 3) {
    fail(
      `expected the refusal summary to concatenate exactly three operands (count template, ` +
        `fixed middle, entries template), found ${operands.length}. Re-derive the summary ` +
        `extraction — a partial summary would invent a message no controller writes.`
    )
  }
  return {
    secretSource,
    queryEntry,
    summaryHead: operands[0],
    summaryMiddle: operands[1],
    summaryTail: operands[2],
  }
}

const egressTemplates = extractEgressMessageTemplates()

/** The names a single-violation refusal message is built from. */
export type EgressRefusalMessageValues = {
  placeholder: string
  secretName: string
  secretKey: string
}

/**
 * The message the producer stamps on the refusal for one query-position
 * Secret value outside its class, rendered from the producer's own templates.
 */
export function egressProducerRefusalMessage(values: EgressRefusalMessageValues): string {
  const sourceText = renderEgressTemplate(
    egressTemplates.secretSource,
    { 'secretKeyRef.name': values.secretName, 'secretKeyRef.key': values.secretKey },
    'describeEnvSource Secret template'
  )
  const entryText = renderEgressTemplate(
    egressTemplates.queryEntry,
    {
      'violation.placeholder': values.placeholder,
      'violation.source': sourceText,
      dependent: '',
    },
    'query entry template'
  )
  const head = renderEgressTemplate(
    egressTemplates.summaryHead,
    { 'entries.length': '1' },
    'refusal summary head'
  )
  const tail = renderEgressTemplate(
    egressTemplates.summaryTail,
    { "shown.join('; ')": entryText, more: '' },
    'refusal summary tail'
  )
  return `${head}${egressTemplates.summaryMiddle}${tail}`
}
