import type { Root, RootContent } from 'hast'

// Code unit ranges that share a text run, by run number.
const PLAIN_LETTERS: ReadonlyArray<readonly [first: number, last: number, run: number]> = [
  [0x30, 0x39, 0], // digits
  [0x41, 0x5a, 0],
  [0x61, 0x7a, 0],
  [0xc0, 0x24f, 0],
  [0x1e00, 0x1eff, 0],
  [0x386, 0x3e1, 1], // Greek
  [0x400, 0x481, 2], // Cyrillic
  [0x48a, 0x52f, 2],
  [0x2010, 0x2027, 3], // typographic punctuation
  [0x3001, 0x3002, 4], // punctuation of the writing systems below
  [0x3008, 0x3011, 4],
  [0x3041, 0x3096, 5], // Hiragana
  [0x30a1, 0x30fa, 6], // Katakana
  [0x4e00, 0x9fff, 7], // Han
  [0xac00, 0xd7a3, 8], // Hangul
]
// From this run on, a line can break after any character.
const FIRST_BREAKABLE_RUN = 4

const MAX_UNBROKEN_CHARS = 2_000

const JOINS = -1
const OTHER = -2

function runOf(code: number): number {
  for (const [first, last, run] of PLAIN_LETTERS) if (code >= first && code <= last) return run
  return code < 0x80 ? JOINS : OTHER
}

/**
 * Estimates layout work: script changes, complex scripts and long unbreakable
 * stretches cost orders of magnitude more than plain words.
 */
export function layoutCost(text: string, limit: number): number {
  let cost = 0
  let last = JOINS
  let unbroken = 0
  for (let index = 0; index < text.length && cost <= limit; index += 1) {
    const code = text.charCodeAt(index)
    const run = runOf(code)
    const breaks = code === 0x20 || (code >= 0x09 && code <= 0x0d) || run >= FIRST_BREAKABLE_RUN
    unbroken = breaks ? 0 : unbroken + 1
    if (unbroken > MAX_UNBROKEN_CHARS) return limit + 1
    if (run === JOINS) continue
    if (run === OTHER || run !== last) cost += 1
    last = run
  }
  return cost
}

export function documentLayoutCost(
  document: Readonly<{ renderTree: Root; flows: readonly Readonly<{ text: string }>[] }>,
  limit: number
): number {
  let cost = 0
  const add = (text: string) => {
    if (cost <= limit) cost += layoutCost(text, limit - cost)
  }
  for (const flow of document.flows) add(flow.text)
  const visit = (node: Root | RootContent) => {
    if (node.type === 'element') {
      for (const shown of [node.properties.alt, node.properties.dataLanguage]) {
        if (typeof shown === 'string') add(shown)
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(document.renderTree)
  return cost
}
