/**
 * Typed argument predicates for permission rules (spec §6.1).
 *
 * Each predicate names a constrained RFC-6901 JSON Pointer into the tool
 * arguments and a typed operator. Predicates are DEFENSE-IN-DEPTH, not a sandbox
 * (spec §6.1/§12.3): a `command` predicate sees only `argv[0]`, and `path`/`url`
 * are lexical (not TOCTOU-safe) — authoritative containment is the hard-validator
 * / sandbox layer, which a guardrail `allow` never bypasses (spec §6.6).
 *
 * Malformed predicates/pointers throw here; the boundary treats a throw as
 * fail-closed. Admission-time validation (compileRules, spec §5) should reject
 * them earlier so this is a backstop, not the primary gate.
 */
import { posix as pathPosix } from 'path'

export type PredicateType = 'path' | 'url' | 'command' | 'json'

export interface ArgumentPredicate {
  type: PredicateType
  /** Constrained RFC-6901 JSON Pointer into the arguments. */
  pointer: string
  /** Operator, per `type` (spec §6.1). */
  op: string
  value?: unknown
}

/** Bounds (spec §6.1: size/depth-bounded, excess depth/count rejected). */
const MAX_POINTER_DEPTH = 16
const MAX_JSON_COMPARE_DEPTH = 32

// ---------------------------------------------------------------------------
// RFC-6901 JSON Pointer (constrained)
// ---------------------------------------------------------------------------

/**
 * Resolve a constrained RFC-6901 JSON Pointer against the tool arguments.
 * Returns `undefined` when the path does not exist; throws on a malformed or
 * over-depth pointer (fail-closed).
 */
export function resolvePointer(args: Record<string, unknown>, pointer: string): unknown {
  if (pointer === '') return args
  if (!pointer.startsWith('/'))
    throw new Error(`invalid JSON Pointer (must start with "/"): ${pointer}`)
  const tokens = pointer
    .slice(1)
    .split('/')
    // RFC-6901 unescape: ~1 → "/", then ~0 → "~" (order matters).
    .map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (tokens.length > MAX_POINTER_DEPTH) throw new Error(`JSON Pointer too deep: ${pointer}`)

  let cur: unknown = args
  for (const tok of tokens) {
    if (cur === null || typeof cur !== 'object') return undefined
    if (Array.isArray(cur)) {
      const idx = Number(tok)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined
      cur = cur[idx]
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return undefined
      cur = (cur as Record<string, unknown>)[tok]
    }
  }
  return cur
}

// ---------------------------------------------------------------------------
// path — equals | under | outside (lexical, boundary-safe; prefixes forbidden)
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  // Resolve "." / ".." and collapse slashes lexically; strip a trailing slash
  // (except root). Symlink/TOCTOU safety is the sandbox's job (§6.6/§12.3).
  let n = pathPosix.normalize(p)
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n
}

/** Boundary-safe containment: `child` is `base` or strictly within it (no prefix trick). */
function isUnder(child: string, base: string): boolean {
  const c = normalizePath(child)
  const b = normalizePath(base)
  if (c === b) return true
  return c.startsWith(b === '/' ? '/' : b + '/')
}

function evalPath(value: unknown, op: string, target: unknown): boolean {
  if (typeof value !== 'string') return false // arg is not a path string ⇒ no match
  if (typeof target !== 'string') throw new Error(`path predicate value must be a string`)
  switch (op) {
    case 'equals':
      return normalizePath(value) === normalizePath(target)
    case 'under':
      return isUnder(value, target)
    case 'outside':
      return !isUnder(value, target)
    default:
      throw new Error(`unknown path op: ${op}`)
  }
}

// ---------------------------------------------------------------------------
// url — scheme_in | host_in | port_in | path_under (parsed + canonicalized)
// ---------------------------------------------------------------------------

const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
  'ws:': 80,
  'wss:': 443,
  'ftp:': 21,
}

function canonicalHost(u: URL): string {
  // WHATWG URL already lowercases + punycodes the host; strip a trailing dot.
  const h = u.hostname
  return h.endsWith('.') ? h.slice(0, -1) : h
}

function effectivePort(u: URL): number | undefined {
  if (u.port) return Number(u.port)
  return DEFAULT_PORTS[u.protocol]
}

function evalUrl(value: unknown, op: string, target: unknown): boolean {
  if (typeof value !== 'string') return false
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false // unparseable ⇒ no match
  }
  // Credentials-in-URL are rejected outright (spec §6.1).
  if (u.username || u.password) return false

  switch (op) {
    case 'scheme_in': {
      if (!Array.isArray(target)) throw new Error('url scheme_in value must be an array')
      const scheme = u.protocol.replace(/:$/, '')
      return target.some(s => String(s).toLowerCase() === scheme)
    }
    case 'host_in': {
      if (!Array.isArray(target)) throw new Error('url host_in value must be an array')
      const host = canonicalHost(u)
      return target.some(h => String(h).toLowerCase().replace(/\.$/, '') === host)
    }
    case 'port_in': {
      if (!Array.isArray(target)) throw new Error('url port_in value must be an array')
      const port = effectivePort(u)
      return port !== undefined && target.some(p => Number(p) === port)
    }
    case 'path_under': {
      if (typeof target !== 'string') throw new Error('url path_under value must be a string')
      return isUnder(u.pathname, target)
    }
    default:
      throw new Error(`unknown url op: ${op}`)
  }
}

// ---------------------------------------------------------------------------
// command — executable_is | argv_prefix (structured executable + argv)
// ---------------------------------------------------------------------------

interface StructuredCommand {
  executable: string
  args: string[]
}

/** Accept either `[exe, ...args]` or `{ executable, args }`; never a shell string. */
function asStructuredCommand(v: unknown): StructuredCommand | null {
  if (Array.isArray(v) && v.every(x => typeof x === 'string') && v.length > 0) {
    return { executable: v[0] as string, args: (v as string[]).slice(1) }
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (
      typeof o.executable === 'string' &&
      Array.isArray(o.args) &&
      o.args.every(x => typeof x === 'string')
    ) {
      return { executable: o.executable, args: o.args as string[] }
    }
  }
  return null
}

function evalCommand(value: unknown, op: string, target: unknown): boolean {
  const cmd = asStructuredCommand(value)
  if (!cmd) return false // not a structured command ⇒ no match (a shell string never matches)
  switch (op) {
    case 'executable_is': {
      if (typeof target !== 'string')
        throw new Error('command executable_is value must be a string')
      // Match the exact executable or its basename (so `rm` matches `/bin/rm`).
      return cmd.executable === target || pathPosix.basename(cmd.executable) === target
    }
    case 'argv_prefix': {
      if (!Array.isArray(target) || !target.every(x => typeof x === 'string')) {
        throw new Error('command argv_prefix value must be a string[]')
      }
      const prefix = target as string[]
      return prefix.every((tok, i) => cmd.args[i] === tok)
    }
    default:
      throw new Error(`unknown command op: ${op}`)
  }
}

// ---------------------------------------------------------------------------
// json — exists | equals | one_of | contains (bounded, canonical key order)
// ---------------------------------------------------------------------------

/** Stable stringify with sorted object keys, depth-bounded (spec §6.1). */
function canonicalize(v: unknown, depth = 0): string {
  if (depth > MAX_JSON_COMPARE_DEPTH) throw new Error('json value too deep')
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(x => canonicalize(x, depth + 1)).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(o[k], depth + 1)}`).join(',')}}`
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b)
}

function evalJson(value: unknown, op: string, target: unknown): boolean {
  switch (op) {
    case 'exists':
      return value !== undefined
    case 'equals':
      return value !== undefined && jsonEquals(value, target)
    case 'one_of': {
      if (!Array.isArray(target)) throw new Error('json one_of value must be an array')
      return value !== undefined && target.some(t => jsonEquals(value, t))
    }
    case 'contains': {
      if (typeof value === 'string') return typeof target === 'string' && value.includes(target)
      if (Array.isArray(value)) return value.some(el => jsonEquals(el, target))
      return false
    }
    default:
      throw new Error(`unknown json op: ${op}`)
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Evaluate one predicate against the tool arguments. Returns whether it matches.
 * Throws on a malformed predicate/pointer (the boundary treats a throw as
 * fail-closed).
 */
export function evaluatePredicate(
  args: Record<string, unknown>,
  predicate: ArgumentPredicate
): boolean {
  const target = predicate.value
  const resolved = resolvePointer(args, predicate.pointer)
  switch (predicate.type) {
    case 'path':
      return evalPath(resolved, predicate.op, target)
    case 'url':
      return evalUrl(resolved, predicate.op, target)
    case 'command':
      return evalCommand(resolved, predicate.op, target)
    case 'json':
      return evalJson(resolved, predicate.op, target)
    default:
      throw new Error(`unknown predicate type: ${(predicate as ArgumentPredicate).type}`)
  }
}
