/**
 * Table rows in the shapes models send them, including `{Header: value}`
 * records, as arrays of cells in header order.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Header text as it is displayed: a year sent as 2026 is still a header. */
export function headerText(header: unknown): string {
  return header === null || header === undefined ? '' : String(header)
}

/**
 * `rows` as arrays of cells. A record is read by header name, exactly or
 * ignoring case and surrounding space; without headers its values are taken in
 * key order. Anything else is dropped. Each kind of repair is reported once in
 * `warnings`, prefixed with `label`.
 */
export function normalizeTableRows(
  rows: unknown,
  headers: unknown[] | undefined,
  label: string,
  warnings: string[]
): unknown[][] {
  if (rows === undefined || rows === null) return []
  if (!Array.isArray(rows)) {
    warnings.push(`${label}: rows must be an array of rows; they were left out.`)
    return []
  }
  const names = (headers ?? []).map(h => headerText(h).trim().toLowerCase())
  let fromRecords = 0
  let dropped = 0
  const unmatched = new Set<string>()
  const out: unknown[][] = []
  for (const row of rows) {
    if (Array.isArray(row)) {
      out.push(row)
    } else if (isRecord(row)) {
      fromRecords++
      if (names.length === 0) {
        out.push(Object.values(row))
        continue
      }
      const byName = new Map(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]))
      for (const key of Object.keys(row)) {
        if (!names.includes(key.trim().toLowerCase())) unmatched.add(key)
      }
      out.push(
        (headers ?? []).map((h, i) =>
          Object.prototype.hasOwnProperty.call(row, headerText(h))
            ? row[headerText(h)]
            : byName.get(names[i])
        )
      )
    } else {
      dropped++
    }
  }
  if (fromRecords > 0) {
    warnings.push(
      `${label}: ${fromRecords} row(s) were objects and were read by header name; send each row as an array of cells in header order.`
    )
  }
  if (unmatched.size > 0) {
    warnings.push(
      `${label}: the key(s) ${[...unmatched].map(k => `'${k}'`).join(', ')} match no header, so ` +
        'those values were left out.'
    )
  }
  if (dropped > 0) {
    warnings.push(
      `${label}: ${dropped} row(s) were neither an array nor an object and were left out.`
    )
  }
  return out
}
