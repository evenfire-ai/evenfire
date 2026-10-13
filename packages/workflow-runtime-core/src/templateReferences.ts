export interface TemplateReference {
  start: number
  end: number
  body: string
}

/**
 * Scan the legacy {{nonempty-body-without-}} syntax without backtracking.
 * Backslashes are literal; nested opening braces remain part of the body.
 * Each search advances past the region it inspected, including malformed closes.
 * Thus even unmatched opening delimiters take O(input length) work.
 */
export function* scanTemplateReferences(value: string): Generator<TemplateReference> {
  let cursor = 0
  while (cursor < value.length) {
    const start = value.indexOf('{{', cursor)
    if (start === -1) return
    const close = value.indexOf('}', start + 2)
    if (close === -1) return
    if (close === start + 2 || value[close + 1] !== '}') {
      cursor = close + 1
      continue
    }
    const end = close + 2
    yield { start, end, body: value.slice(start + 2, close) }
    cursor = end
  }
}

/** Replace references once, preserving literal text and callback results verbatim. */
export function replaceTemplateReferences(
  value: string,
  resolve: (body: string) => string
): string {
  const parts: string[] = []
  let cursor = 0
  for (const ref of scanTemplateReferences(value)) {
    parts.push(value.slice(cursor, ref.start), resolve(ref.body))
    cursor = ref.end
  }
  parts.push(value.slice(cursor))
  return parts.join('')
}
