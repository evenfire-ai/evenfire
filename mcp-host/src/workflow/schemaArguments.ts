/**
 * A generator's arguments read against its own schema: a null sent for an
 * optional argument counts as unset, and arguments the schema does not declare
 * are reported back to the model instead of being dropped silently.
 */

type SchemaNode = {
  type?: unknown
  properties?: Record<string, SchemaNode>
  required?: string[]
  items?: SchemaNode
  anyOf?: SchemaNode[]
  additionalProperties?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function typesOf(node: SchemaNode | undefined): string[] {
  const t = node?.type
  return Array.isArray(t) ? t : typeof t === 'string' ? [t] : []
}

/** The node to follow for `value`: the node itself, or its anyOf branch of the value's type. */
function nodeFor(node: SchemaNode | undefined, value: unknown): SchemaNode | undefined {
  if (!node?.anyOf) return node
  const type = Array.isArray(value) ? 'array' : isRecord(value) ? 'object' : undefined
  return type ? node.anyOf.find(branch => typesOf(branch).includes(type)) : undefined
}

function allowsNull(node: SchemaNode | undefined): boolean {
  return typesOf(node).includes('null') || !!node?.anyOf?.some(b => typesOf(b).includes('null'))
}

/**
 * `value` without the null properties its schema neither requires nor allows.
 * Many models send null for every optional argument they leave unset, and the
 * runtimes already read null as absent.
 */
export function withoutUnsetNulls(schema: unknown, value: unknown, depth = 0): unknown {
  const node = nodeFor(schema as SchemaNode, value)
  if (!node || depth > 64) return value
  if (Array.isArray(value)) {
    return node.items ? value.map(item => withoutUnsetNulls(node.items, item, depth + 1)) : value
  }
  if (!isRecord(value) || !node.properties) return value
  const required = new Set(node.required ?? [])
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const child = node.properties[key]
    if (item === null && child && !required.has(key) && !allowsNull(child)) continue
    Object.defineProperty(out, key, {
      value: child ? withoutUnsetNulls(child, item, depth + 1) : item,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

function readablePath(parts: Array<string | number>): string {
  return parts
    .map((part, i) => (typeof part === 'number' ? `[${part}]` : i === 0 ? part : `.${part}`))
    .join('')
}

interface UnknownArgument {
  path: string
  holder: Record<string, unknown>
  key: string
}

function unknownEntries(schema: unknown, value: unknown): UnknownArgument[] {
  const found: UnknownArgument[] = []
  const visit = (raw: SchemaNode | undefined, item: unknown, at: Array<string | number>) => {
    const node = nodeFor(raw, item)
    if (!node || at.length > 64) return
    if (Array.isArray(item)) {
      if (node.items) item.forEach((entry, i) => visit(node.items, entry, [...at, i]))
      return
    }
    if (!isRecord(item) || !node.properties || node.additionalProperties !== undefined) return
    for (const [key, entry] of Object.entries(item)) {
      const child = node.properties[key]
      if (child) visit(child, entry, [...at, key])
      else found.push({ path: readablePath([...at, key]), holder: item, key })
    }
  }
  visit(schema as SchemaNode, value, [])
  return found
}

/**
 * Arguments the schema does not declare. An extra key is not a validation
 * error (additionalProperties is not a field every provider accepts), so these
 * are reported back instead. Objects that declare additionalProperties are
 * open maps and are not checked.
 */
export function unknownArguments(schema: unknown, value: unknown): string[] {
  return unknownEntries(schema, value).map(entry => entry.path)
}

/**
 * The undeclared arguments of `value`, each made a getter that records whether
 * it was read, so that after a generator ran `ignored()` names only the ones it
 * never looked at. A generator reads some arguments under names the schema
 * leaves out; those are not ignored. `value` must be the caller's own copy.
 */
export function watchUnknownArguments(schema: unknown, value: unknown): { ignored(): string[] } {
  const entries = unknownEntries(schema, value)
  const read = new Set<number>()
  entries.forEach(({ holder, key }, i) => {
    let current = holder[key]
    Object.defineProperty(holder, key, {
      get() {
        read.add(i)
        return current
      },
      set(next: unknown) {
        current = next
      },
      enumerable: true,
      configurable: true,
    })
  })
  return { ignored: () => entries.filter((_, i) => !read.has(i)).map(entry => entry.path) }
}
