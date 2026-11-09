import { createHash } from 'node:crypto'
import type { ToolDefinition } from '../core/types'

/**
 * Wire-format rules an LLM provider applies to function/tool names. A name
 * outside the rule makes the provider reject the whole request, so every
 * tool of the context fails, not just the offending one.
 */
export interface ToolNameRule {
  /** Maximum name length the provider accepts. */
  maxLength: number
  /** True when the provider accepts the name byte-for-byte. */
  accepts: (name: string) => boolean
}

const NAME_BODY = /^[A-Za-z0-9_-]+$/

/** OpenAI, Azure OpenAI and OpenAI-compatible providers: ^[A-Za-z0-9_-]{1,64}$. */
export const OPENAI_TOOL_NAME_RULE: ToolNameRule = {
  maxLength: 64,
  accepts: name => name.length <= 64 && NAME_BODY.test(name),
}

/** Bedrock Converse ToolSpecification: [a-zA-Z0-9_-]+, 1-64. */
export const BEDROCK_TOOL_NAME_RULE: ToolNameRule = {
  maxLength: 64,
  accepts: name => name.length <= 64 && NAME_BODY.test(name),
}

/** Anthropic direct tool-use: ^[a-zA-Z0-9_-]{1,128}$. */
export const ANTHROPIC_TOOL_NAME_RULE: ToolNameRule = {
  maxLength: 128,
  accepts: name => name.length <= 128 && NAME_BODY.test(name),
}

/** Vertex / Gemini function declarations: up to 128, must start with a letter or underscore. */
export const VERTEX_TOOL_NAME_RULE: ToolNameRule = {
  maxLength: 128,
  accepts: name => name.length <= 128 && NAME_BODY.test(name) && /^[A-Za-z_]/.test(name),
}

const ALIAS_HASH_LENGTH = 12
const ALIAS_SEPARATOR = '-'
const FALLBACK_HEAD = 'tool'

function aliasHash(canonical: string, salt: number): string {
  const value = salt > 0 ? `${canonical}#${salt}` : canonical
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, ALIAS_HASH_LENGTH)
}

/**
 * Builds the readable head of an alias: the longest prefix of `canonical`
 * made only of characters every provider accepts, capped to the room left
 * after the separator and hash. Empty after stripping → the generic head.
 */
function aliasHead(canonical: string, maxLength: number): string {
  const room = maxLength - ALIAS_SEPARATOR.length - ALIAS_HASH_LENGTH
  let head = ''
  for (const ch of canonical) {
    if (head.length >= room) break
    head += NAME_BODY.test(ch) ? ch : '_'
  }
  head = head.replace(/^[^A-Za-z0-9_]+/, '').replace(/_+$/g, '')
  // Families that restrict the leading character (Vertex wants a letter or
  // underscore) reject a head starting with a digit; prefixing an underscore
  // keeps every rule happy without touching the identifying hash.
  if (head.length > 0 && /^[0-9]/.test(head)) head = `_${head}`
  return head.length > 0 ? head.slice(0, room) : FALLBACK_HEAD.slice(0, room)
}

/**
 * Per-request reversible map between the canonical tool names this host uses
 * internally and the (possibly aliased) names sent on the wire. Names that
 * already fit the provider rule pass through byte-for-byte; anything else is
 * sent as a readable head plus a 12-hex hash of the canonical name, so the
 * mapping is deterministic (stable across requests) and the description can
 * carry the canonical name for the model to read.
 */
export class ToolNameAliaser {
  private readonly aliasToCanonical = new Map<string, string>()
  private readonly canonicalToAlias = new Map<string, string>()

  constructor(private readonly rule: ToolNameRule) {}

  /** The wire name for a canonical tool name, registering the mapping. */
  alias(canonical: string): string {
    const known = this.canonicalToAlias.get(canonical)
    if (known !== undefined) return known
    if (this.rule.accepts(canonical)) {
      this.canonicalToAlias.set(canonical, canonical)
      return canonical
    }
    const head = aliasHead(canonical, this.rule.maxLength)
    // Hash collisions are practically impossible, but a per-request alias
    // must stay injective, so re-hash with a salt until the name is free.
    let wire = ''
    for (let salt = 0; ; salt++) {
      wire = `${head}${ALIAS_SEPARATOR}${aliasHash(canonical, salt)}`
      const owner = this.aliasToCanonical.get(wire)
      if (owner === undefined) break
      if (owner === canonical) break
    }
    this.aliasToCanonical.set(wire, canonical)
    this.canonicalToAlias.set(canonical, wire)
    return wire
  }

  /** The canonical name behind a wire name coming back from the provider. */
  resolve(wire: string): string {
    return this.aliasToCanonical.get(wire) ?? wire
  }

  /** The description sent on the wire: aliased tools carry the canonical name. */
  describe(canonical: string, description: string): string {
    const wire = this.alias(canonical)
    if (wire === canonical) return description
    return `${description}\n\nSent to the model as "${wire}"; the canonical tool name is "${canonical}".`
  }
}

/** Convenience wrapper for adapters that map a whole tool list at once. */
export function createToolNameAliaser(
  rule: ToolNameRule,
  tools: ToolDefinition[]
): ToolNameAliaser {
  const aliaser = new ToolNameAliaser(rule)
  for (const tool of tools) aliaser.alias(tool.name)
  return aliaser
}
