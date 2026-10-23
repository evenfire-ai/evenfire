// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Cascade guard for the Files-grid drop-verdict tints (refusal UX matrix §5).
 *
 * The tone rules for `.da-gfs-drive__grid` rows compete inside ONE real
 * stylesheet with several later/equal-specificity backgrounds: the grid's own
 * `.da-grid__row { background: transparent }` (equal specificity to a bare
 * `.da-grid__row--compact[data-drop-state=…]` selector — later wins) and the
 * clickable-hover backgrounds (higher specificity while hovered). The first
 * implementation of the grid tints lost exactly that race: the inset survived
 * (nothing else sets box-shadow) while the tint background was flattened back
 * to transparent.
 *
 * jsdom cannot adjudicate this (it does not resolve `var(--)` in computed
 * styles), and a browser run is not part of this lane, so this test runs a
 * minimal, grammar-bounded cascade over the REAL `src/styles.css`: it parses
 * the sheet, matches every rule that can apply to a Files grid row, and
 * computes the specificity + sheet-order winner for the tone-carrying
 * properties — non-hovered AND hovered.
 */

interface ParsedRule {
  index: number
  selector: string
  specificity: number
  declarations: Map<string, string>
}

interface ElementSignature {
  classes: string[]
  attrs: Record<string, string | true>
}

const ANCESTOR_CHAIN: ElementSignature[] = [{ classes: ['da-gfs-drive__grid'], attrs: {} }]

function parseSheet(css: string): ParsedRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: ParsedRule[] = []
  let index = 0
  let cursor = 0
  while (cursor < withoutComments.length) {
    const open = withoutComments.indexOf('{', cursor)
    if (open === -1) break
    const selector = withoutComments.slice(cursor, open).trim()
    // Find the matching close brace for this block.
    let depth = 1
    let scan = open + 1
    while (scan < withoutComments.length && depth > 0) {
      if (withoutComments[scan] === '{') depth += 1
      else if (withoutComments[scan] === '}') depth -= 1
      scan += 1
    }
    const body = withoutComments.slice(open + 1, scan - 1)
    cursor = scan
    // At-rules (@media, @keyframes, …) are skipped whole: none of the drop
    // tints or their competitors live inside one, and partially parsing
    // nested blocks would misattribute sheet order.
    if (selector.startsWith('@')) continue
    const declarations = new Map<string, string>()
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon === -1) continue
      const property = declaration.slice(0, colon).trim()
      const value = declaration.slice(colon + 1).trim()
      if (property) declarations.set(property, value)
    }
    for (const complex of selector.split(',')) {
      const trimmed = complex.trim()
      if (!trimmed) continue
      const specificity = countSpecificity(trimmed)
      if (specificity === null) continue
      rules.push({ index: index++, selector: trimmed, specificity, declarations })
    }
  }
  return rules
}

/**
 * Specificity (class/attribute/pseudo-class count) for the selector grammar
 * used by this sheet's row rules. Returns null for a selector using syntax
 * outside the grammar, so unsupported rules simply never match.
 */
function countSpecificity(complex: string): number | null {
  // Tokenize explicitly: this sheet uses .class, [attr] and [attr='value'],
  // :pseudo, plus element names only in low-level reset rules we skip.
  const tokens = complex.match(/(\.[-\w]+)|(\[[^\]]+\])|(:[A-Za-z-]+)|(\b[a-z][-\w]*\b)|\*/g) ?? []
  let count = 0
  for (const token of tokens) {
    if (token.startsWith('.')) count += 1
    else if (token.startsWith('[')) count += 1
    else if (token.startsWith(':')) count += 1
    else return null // element name / universal — outside the guarded grammar
  }
  return count
}

function compoundMatches(
  compound: string,
  signature: ElementSignature,
  hoverActive: boolean
): boolean {
  const classTokens = compound.match(/\.[-\w]+/g) ?? []
  for (const classToken of classTokens) {
    if (!signature.classes.includes(classToken.slice(1))) return false
  }
  const attrTokens = compound.match(/\[[^\]]+\]/g) ?? []
  for (const attrToken of attrTokens) {
    const match = /^\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\]$/.exec(attrToken)
    if (!match?.[1]) return false
    const name = match[1]
    const value = match[2]
    const held = signature.attrs[name]
    if (held === undefined) return false
    if (value !== undefined && held !== true && held !== value) return false
  }
  const pseudoTokens = compound.match(/:[A-Za-z-]+/g) ?? []
  for (const pseudo of pseudoTokens) {
    if (pseudo === ':hover') {
      if (!hoverActive) return false
    } else if (pseudo === ':enabled' || pseudo === ':disabled') {
      // Worst case for the tints: treat both as matching a hovered row, so
      // the assertions hold even where a browser evaluates them on the div.
      if (!hoverActive) return false
    } else {
      return false
    }
  }
  return true
}

function selectorMatches(
  complex: string,
  element: ElementSignature,
  ancestors: readonly ElementSignature[],
  hoverActive: boolean
): boolean {
  const compounds = complex.split(/\s+/).filter(Boolean)
  const last = compounds[compounds.length - 1]
  if (last === undefined || !compoundMatches(last, element, hoverActive)) return false
  // Descendant matching against the fixed ancestor chain (nearest-first).
  let ancestorCursor = 0
  for (let i = compounds.length - 2; i >= 0; i -= 1) {
    let matched = false
    const compound = compounds[i]
    if (compound === undefined) return false
    while (ancestorCursor < ancestors.length) {
      const candidate = ancestors[ancestorCursor]
      ancestorCursor += 1
      if (candidate !== undefined && compoundMatches(compound, candidate, hoverActive)) {
        matched = true
        break
      }
    }
    if (!matched) return false
  }
  return true
}

function winningDeclaration(
  rules: readonly ParsedRule[],
  element: ElementSignature,
  property: string,
  hoverActive: boolean
): { value: string; selector: string } | undefined {
  let winner: ParsedRule | undefined
  for (const rule of rules) {
    if (!rule.declarations.has(property)) continue
    if (!selectorMatches(rule.selector, element, ANCESTOR_CHAIN, hoverActive)) continue
    if (
      !winner ||
      rule.specificity > winner.specificity ||
      (rule.specificity === winner.specificity && rule.index > winner.index)
    ) {
      winner = rule
    }
  }
  if (!winner) return undefined
  return { value: winner.declarations.get(property) ?? '', selector: winner.selector }
}

const sheet = parseSheet(readFileSync(new URL('../../styles.css', import.meta.url), 'utf8'))

const GRID_ROW: ElementSignature = {
  classes: ['da-grid__row', 'da-grid__row--clickable', 'da-grid__row--compact'],
  attrs: {},
}

function rowWith(attrs: Record<string, string | true>): ElementSignature {
  return { classes: GRID_ROW.classes, attrs }
}

function expectWinner(
  element: ElementSignature,
  property: 'background' | 'box-shadow',
  hoverActive: boolean,
  value: string
) {
  const winner = winningDeclaration(sheet, element, property, hoverActive)
  expect(
    winner,
    `no ${property} winner for ${JSON.stringify(element.attrs)} (hover=${hoverActive})`
  ).toBeDefined()
  expect(
    winner!.value,
    `${property} winner for ${JSON.stringify(element.attrs)} (hover=${hoverActive}) via ${winner!.selector}`
  ).toBe(value)
}

describe('Files-grid drop-verdict tint cascade (refusal UX matrix §5)', () => {
  it('parses the sheet: the grid tone rules are actually present', () => {
    const selectors = new Set(sheet.map(rule => rule.selector))
    expect(
      [...selectors].some(
        selector =>
          selector.includes("data-drop-state='denied'") && selector.includes('da-gfs-drive__grid')
      )
    ).toBe(true)
    expect(
      [...selectors].some(
        selector =>
          selector.includes("data-drop-state='checking'") && selector.includes('da-gfs-drive__grid')
      )
    ).toBe(true)
  })

  it('a denied row paints the danger tint over the transparent base AND the hover background', () => {
    const denied = rowWith({ 'data-drop-state': 'denied' })
    expectWinner(denied, 'background', false, 'rgba(var(--danger-rgb), 0.1)')
    expectWinner(denied, 'background', true, 'rgba(var(--danger-rgb), 0.1)')
    expectWinner(denied, 'box-shadow', false, 'inset 2px 0 0 rgba(var(--danger-rgb), 0.72)')
  })

  it('the no-op reason repaints as informational, never error-red', () => {
    const noOp = rowWith({ 'data-drop-state': 'denied', 'data-drop-reason': 'same-parent' })
    expectWinner(noOp, 'background', false, 'rgba(var(--edge-rgb), 0.12)')
    expectWinner(noOp, 'background', true, 'rgba(var(--edge-rgb), 0.12)')
  })

  it.each(['unavailable', 'target-unavailable', 'source-location-unknown'] as const)(
    'the unknown reason %s repaints as a warning',
    reason => {
      const unknown = rowWith({ 'data-drop-state': 'denied', 'data-drop-reason': reason })
      expectWinner(unknown, 'background', false, 'rgba(var(--warning-rgb), 0.1)')
      expectWinner(unknown, 'background', true, 'rgba(var(--warning-rgb), 0.1)')
    }
  )

  it('the unavailable verdict state paints the warning tint', () => {
    const unavailable = rowWith({ 'data-drop-state': 'unavailable' })
    expectWinner(unavailable, 'background', false, 'rgba(var(--warning-rgb), 0.1)')
    expectWinner(unavailable, 'background', true, 'rgba(var(--warning-rgb), 0.1)')
  })

  it('a checking row paints the neutral tint over base and hover', () => {
    const checking = rowWith({ 'data-drop-state': 'checking' })
    expectWinner(checking, 'background', false, 'rgba(var(--edge-rgb), 0.08)')
    expectWinner(checking, 'background', true, 'rgba(var(--edge-rgb), 0.08)')
  })

  it('only allowed stays blue: the data-drop-target highlight owns an allowed row', () => {
    const allowed = rowWith({ 'data-drop-state': 'allowed', 'data-drop-target': 'true' })
    for (const hoverActive of [false, true]) {
      const winner = winningDeclaration(sheet, allowed, 'background', hoverActive)
      expect(winner).toBeDefined()
      // `--grid-card-bg-hover` is itself rgba(var(--accent-rgb), 0.36) in
      // tokens.css: both winners are the accent blue.
      expect(winner!.value).toMatch(/accent-rgb|--grid-card-bg-hover/)
    }
  })

  it('a row with no verdict keeps the plain base/hover background — tints do not leak', () => {
    const plain = rowWith({})
    expectWinner(plain, 'background', false, 'transparent')
    const hovered = winningDeclaration(sheet, plain, 'background', true)
    expect(hovered).toBeDefined()
    expect(hovered!.value).not.toMatch(/danger-rgb|warning-rgb/)
  })
})
