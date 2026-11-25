const SAMPLE_LINES = 10

/** Many locales export `;` separated files. Picks the separator present on more of the first lines. */
function delimiterOf(text: string): string {
  const lines = { ',': 0, ';': 0 }
  const first = { ',': 0, ';': 0 }
  const seen = { ',': false, ';': false }
  let quoted = false
  let decimals = true
  let line = 0
  for (let index = 0; index < text.length && line < SAMPLE_LINES; index++) {
    const char = text[index]
    if (char === '"') quoted = !quoted
    else if (quoted) continue
    else if (char === ',' || char === ';') {
      if (char === ',') decimals &&= /\d,\d/.test(text.slice(Math.max(0, index - 1), index + 2))
      if (!seen[char]) lines[char]++
      seen[char] = true
      if (line === 0) first[char]++
    } else if (char === '\n') {
      line++
      seen[','] = seen[';'] = false
    }
  }
  if (lines[';'] !== lines[',']) return lines[';'] > lines[','] ? ';' : ','
  // Commas only between digits are decimal separators.
  return first[';'] > first[','] || (first[';'] > 0 && decimals) ? ';' : ','
}

/** RFC 4180 parsing, except that a quote that never closes is read as text. */
export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows: number
): { rows: string[][]; truncated: boolean } {
  const separator = delimiter === ',' ? delimiterOf(text) : delimiter
  return readRows(text, separator, maxRows, true) ?? readRows(text, separator, maxRows, false)!
}

/** Null when a quoted field never closes. */
function readRows(
  text: string,
  delimiter: string,
  maxRows: number,
  quotes: boolean
): { rows: string[][]; truncated: boolean } | null {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const endRow = () => {
    row.push(field)
    field = ''
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }
  for (; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (quotes && char === '"' && field === '') {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      endRow()
      if (rows.length >= maxRows) return { rows, truncated: index < text.length - 1 }
    } else {
      field += char
    }
  }
  if (quoted) return null
  if (field !== '' || row.length > 0) endRow()
  return { rows, truncated: false }
}
