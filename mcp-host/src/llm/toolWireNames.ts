/**
 * Wire names for tool calls at the LLM edge.
 *
 * Canonical tool names (`<server>__<tool>`, natives, internals) are what the
 * rest of mcp-host dispatches, approves and persists. Some providers reject
 * names outside a pattern (length, charset, first character). This module maps
 * each canonical name to a name the provider accepts — identity when it already
 * fits — and resolves the provider's tool calls back, per request.
 *
 * The map is a value local to one completion call: the alias is a pure function
 * of the canonical name, and history is always stored canonical, so nothing
 * needs to survive between requests.
 *
 * Only type imports from mcp-host, so the file can move to a shared package
 * unchanged.
 */
import { createHash } from 'node:crypto'
import type { ChatMessage, ToolCompletionResponse, ToolDefinition } from '../core/types'

export type ToolNameEnvelopeKey = 'W' | 'W_c' | 'W_v' | 'W_g'

// No flags on purpose: a `g`/`y` regex keeps `lastIndex` between `.test` calls.
export const TOOL_NAME_ENVELOPES: Readonly<Record<ToolNameEnvelopeKey, RegExp>> = Object.freeze({
  W: /^[A-Za-z0-9_-]{1,64}$/,
  W_c: /^[A-Za-z0-9_-]{1,128}$/,
  W_v: /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/,
  W_g: /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,
})

/** Invariant assertion: the candidate walk ran out, or `toWire` got a name outside the set. */
export class ToolWireNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolWireNameError'
  }
}

type HashFn = (c: string) => string

// The suffix `_<base36>` can never be confused with the base only because the
// hash is exactly 12 lowercase hex digits.
const HASH_FORMAT = /^[0-9a-f]{12}$/
// Same shape the MCP manager's server names have; `-` at the end is allowed.
const PREFIX_SERVER = /^[a-z][a-z0-9-]*$/
const MAX_PREFIX_SERVER = 50
const HEAD_BUDGET = 51

// UTF-16LE keeps the hash input injective: UTF-8 would fold distinct lone
// surrogates into U+FFFD and give two names the same base alias.
function defaultHash(c: string): string {
  return createHash('sha256').update(Buffer.from(c, 'utf16le')).digest('hex').slice(0, 12)
}

function sanitize(x: string): string {
  // Non-`u` regex: matches per UTF-16 code unit, so a surrogate pair becomes `__`.
  return x.replace(/[^A-Za-z0-9_-]/g, '_')
}

function collapse(x: string): string {
  return x.replace(/_{2,}/g, '_')
}

function splitServer(c: string): { server: string | null; tool: string } {
  const i = c.indexOf('__')
  return i > 0 ? { server: c.slice(0, i), tool: c.slice(i + 2) } : { server: null, tool: c }
}

interface AliasHead {
  head: string
  withPrefix: boolean
}

function aliasHead(c: string): AliasHead {
  const { server, tool } = splitServer(c)
  if (server !== null && PREFIX_SERVER.test(server) && server.length <= MAX_PREFIX_SERVER) {
    return { head: server + '__' + sanitize(tool), withPrefix: true }
  }
  // A server that is not a plain lowercase label (dots, underscores, leading
  // digit, too long) or no `__` at all: never claim a rewritten server, so the
  // alias carries no `__` that `callTool`-style splitting could misread.
  const x = collapse(sanitize(c))
  return { head: /^[A-Za-z_]/.test(x) ? x : '_' + x, withPrefix: false }
}

/** `k === null` is the base candidate; `k >= 0` the collision suffix `_<k in base36>`. */
function candidate(head: AliasHead, hash: string, k: number | null): string {
  const suffix = k === null ? '' : '_' + k.toString(36)
  // Cut the head before appending, so the hash and the suffix are never truncated.
  const raw = head.head.slice(0, HEAD_BUDGET - suffix.length) + '_' + hash + suffix
  return head.withPrefix ? raw : collapse(raw)
}

/** Identity if `c` fits the envelope; otherwise the base alias (no collision suffix). */
export function wireToolAlias(c: string, envelope: ToolNameEnvelopeKey): string {
  if (TOOL_NAME_ENVELOPES[envelope].test(c)) return c
  return candidate(aliasHead(c), defaultHash(c), null)
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export class ToolWireNameMap {
  private readonly envelope: RegExp
  private readonly hash: HashFn
  private readonly outbound = new Map<string, string>()
  private readonly inbound = new Map<string, string>()

  constructor(
    names: Iterable<string>,
    envelope: ToolNameEnvelopeKey,
    options?: { hash?: (c: string) => string }
  ) {
    this.envelope = TOOL_NAME_ENVELOPES[envelope]
    this.hash = options?.hash ?? defaultHash
    // Code-unit order, never localeCompare: ICU may call distinct strings equal,
    // which would make the collision order depend on input order.
    const unique = [...new Set(names)].sort(compareCodeUnits)
    const hashes = new Map<string, string>()
    for (const c of unique) {
      const h = this.hash(c)
      if (typeof h !== 'string' || !HASH_FORMAT.test(h)) {
        throw new TypeError(`tool wire-name hash must be 12 lowercase hex digits, got ${String(h)}`)
      }
      hashes.set(c, h)
    }

    // Every name that already fits is reserved first — including ones that
    // look like aliases — so a canonical name is never shadowed by another's alias.
    const taken = new Set<string>()
    for (const c of unique) {
      if (this.envelope.test(c)) {
        taken.add(c)
        this.outbound.set(c, c)
        this.inbound.set(c, c)
      }
    }

    // N is the whole set, not the aliased count: N+1 candidates against at most
    // N-1 names held by others always leaves one free.
    const n = unique.length
    for (const c of unique) {
      if (this.outbound.has(c)) continue
      const head = aliasHead(c)
      const h = hashes.get(c) as string
      let assigned: string | undefined
      for (let k = -1; k < n && assigned === undefined; k++) {
        const cand = candidate(head, h, k < 0 ? null : k)
        if (!taken.has(cand)) assigned = cand
      }
      if (assigned === undefined) {
        throw new ToolWireNameError(`no free wire name for tool ${JSON.stringify(c)}`)
      }
      taken.add(assigned)
      this.outbound.set(c, assigned)
      this.inbound.set(assigned, c)
    }
  }

  /**
   * Only for names of the set. A name outside it has no reserved wire name: its
   * base alias may be the wire name of another canonical, which `fromWire` would
   * then resolve to that other tool.
   */
  toWire(c: string): string {
    const mapped = this.outbound.get(c)
    if (mapped === undefined) {
      throw new ToolWireNameError(`tool ${JSON.stringify(c)} is not in this request's name set`)
    }
    return mapped
  }

  /** Alias → canonical, exact canonical of the set → itself, anything else → undefined. */
  fromWire(name: string): string | undefined {
    const canonical = this.inbound.get(name)
    if (canonical !== undefined) return canonical
    return this.outbound.has(name) ? name : undefined
  }
}

const ANNOTATION_FIELD_CODE_POINTS = 200

/**
 * Cut to code points first, then escape: escaping first could split an escape
 * sequence or a surrogate pair at the cut. Controls become spaces instead of
 * being escaped, because `\uXXXX` would multiply their length by six.
 * `toWellFormed` is not used: the service targets ES2022.
 */
function annotationField(x: string): string {
  let out = ''
  let count = 0
  for (const cp of x) {
    if (count === ANNOTATION_FIELD_CODE_POINTS) break
    count++
    const unit = cp.charCodeAt(0)
    if (cp.length === 1 && unit >= 0xd800 && unit <= 0xdfff) {
      out += '\uFFFD'
    } else if (/^[\u0000-\u001F\u007F-\u009F\u2028\u2029]$/.test(cp)) {
      out += ' '
    } else {
      out += cp
    }
  }
  return JSON.stringify(out)
}

// An alias may lose the server prefix or share a visible head with sibling
// tools; the annotation tells the model which canonical tool it stands for.
function annotate(c: string): string {
  const { server, tool } = splitServer(c)
  return server === null
    ? `(tool: ${annotationField(c)})`
    : `(MCP server: ${annotationField(server)}; tool: ${annotationField(tool)})`
}

/**
 * Project a tool request onto wire names. The set covers everything the request
 * sends: `tools[].name`, assistant `tool_calls[].name` and the string `name` of
 * tool messages (Gemini falls back to it for `functionResponse.name`). Inputs are
 * not mutated; unchanged entries are returned as the same objects.
 *
 * A `tool_choice` naming a specific tool would also have to go through `toWire`;
 * today only modes (`auto`, `none`) are sent.
 */
export function toWireRequest<M extends ChatMessage, T extends ToolDefinition>(
  messages: readonly M[],
  tools: readonly T[],
  envelope: ToolNameEnvelopeKey
): { messages: M[]; tools: T[]; names: ToolWireNameMap } {
  const set: string[] = []
  for (const t of tools) if (typeof t.name === 'string') set.push(t.name)
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (typeof tc.name === 'string') set.push(tc.name)
    } else if (m.role === 'tool' && typeof m.name === 'string') {
      set.push(m.name)
    }
  }
  const names = new ToolWireNameMap(set, envelope)

  const wireTools = tools.map(t => {
    if (typeof t.name !== 'string') return t
    const wire = names.toWire(t.name)
    if (wire === t.name) return t
    return { ...t, name: wire, description: `${annotate(t.name)} ${t.description ?? ''}` }
  })

  const wireMessages = messages.map(m => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      let changed = false
      const calls = m.tool_calls.map(tc => {
        if (typeof tc.name !== 'string') return tc
        const wire = names.toWire(tc.name)
        if (wire === tc.name) return tc
        changed = true
        return { ...tc, name: wire }
      })
      return changed ? { ...m, tool_calls: calls } : m
    }
    if (m.role === 'tool' && typeof m.name === 'string') {
      const wire = names.toWire(m.name)
      return wire === m.name ? m : { ...m, name: wire }
    }
    return m
  })

  return { messages: wireMessages, tools: wireTools, names }
}

/** Resolve the provider's tool calls back to canonical names; unknown names pass unchanged. */
export function fromWireResponse<R extends ToolCompletionResponse>(
  resp: R,
  names: ToolWireNameMap
): R {
  if (!Array.isArray(resp.tool_calls)) return resp
  let changed = false
  const calls = resp.tool_calls.map(tc => {
    const canonical = typeof tc.name === 'string' ? names.fromWire(tc.name) : undefined
    if (canonical === undefined || canonical === tc.name) return tc
    changed = true
    return { ...tc, name: canonical }
  })
  return changed ? { ...resp, tool_calls: calls } : resp
}
