import { createHash } from 'node:crypto'

// Conservative standard OpenAI function-name envelope. This is not evidence
// that the Grok /grok/responses endpoint rejects wider canonical MCP names.
const wireNamePattern = /^[A-Za-z0-9_-]{1,64}$/

export class ToolNameMap {
  private readonly outbound = new Map<string, string>()
  private readonly inbound = new Map<string, string>()

  constructor(names: Iterable<string>) {
    const canonicalNames = [...new Set(names)].sort()
    // Reserve compliant canonical names before allocating any aliases, including
    // legitimate tool names that happen to look like our generated aliases.
    const occupied = new Set(canonicalNames.filter(name => wireNamePattern.test(name)))
    for (const name of canonicalNames) {
      let wireName = name
      if (!wireNamePattern.test(name)) {
        const base = `__grok_tool_${createHash('sha256').update(name).digest('hex').slice(0, 40)}`
        wireName = base
        // At most N occupied names exist. N + 1 distinct candidates guarantee
        // allocation without assuming that truncated hashes never collide.
        for (let suffix = 0; occupied.has(wireName) && suffix < canonicalNames.length; suffix++) {
          wireName = `${base}_${suffix.toString(36)}`
        }
        if (occupied.has(wireName) || !wireNamePattern.test(wireName)) {
          throw new Error('Unable to allocate a unique transport tool name')
        }
      }
      occupied.add(wireName)
      this.outbound.set(name, wireName)
      this.inbound.set(wireName, name)
    }
  }

  toWire(name: string): string {
    const mapped = this.outbound.get(name)
    if (mapped === undefined) throw new Error('Unknown canonical tool name')
    return mapped
  }

  fromWire(name: string): string | undefined {
    const canonical = this.inbound.get(name)
    if (canonical !== undefined) return canonical
    // Some providers echo the registered canonical name despite receiving an
    // alias. Accept only an exact known key; do not infer or normalize targets.
    if (this.outbound.has(name)) return name
    // Ordinary unknown names still reach the Host registry for rejection.
    // Never infer a target from an unregistered alias or unsafe name.
    if (wireNamePattern.test(name) && !name.startsWith('__grok_tool_')) return name
    return undefined
  }
}
