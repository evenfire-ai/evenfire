import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')

function cssRuleBody(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1]
}

// A selector can appear in several rules (alone and inside comma groups);
// assert on the first rule whose body carries the declaration.
function someRuleDeclares(selector: string, declaration: RegExp): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'gm'))].some(match =>
    declaration.test(match[1])
  )
}

// The /cost/usage shell locks scrolling: .cu-main is height:100vh with
// overflow:hidden, .cu-cost-layout is height:100% without overflow, and the
// viewport-fill card clips (.cu-card { overflow: hidden }). The usage body is
// the flexed child of that card (flex:1; min-height:0), so unless it scrolls
// itself, content past the fold is unreachable — the LLM Usage page could not
// scroll (BUG-134). Sibling cost pages scroll through .cu-table-wrap; the
// usage page has no table wrap, so its body owns the overflow.
describe('LLM Usage scroll contract', () => {
  it('makes the flexed usage body the scroll container inside the height-capped shell', () => {
    expect(cssRuleBody('.cu-card--viewport-fill > .cu-card__body.cu-usage-body')).toMatch(
      /overflow:\s*auto/
    )
  })

  it('keeps the body a shrinkable flex child so it can actually overflow', () => {
    expect(someRuleDeclares('.cu-card--viewport-fill > .cu-card__body', /min-height:\s*0/)).toBe(
      true
    )
  })
})
