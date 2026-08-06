import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')

type CssRule = {
  body: string
  selectors: string[]
}

function selectorRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

function extractBlocks(cssText: string, atRule: string): string[] {
  const blocks: string[] = []
  let cursor = 0

  while (cursor < cssText.length) {
    const atIndex = cssText.indexOf('@media', cursor)
    if (atIndex === -1) break
    const openIndex = cssText.indexOf('{', atIndex)
    if (openIndex === -1) break
    const prelude = cssText.slice(atIndex, openIndex)
    let depth = 0
    let closeIndex = -1
    for (let index = openIndex; index < cssText.length; index += 1) {
      const char = cssText[index]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          closeIndex = index
          break
        }
      }
    }
    if (closeIndex === -1) break
    if (prelude.includes(atRule)) blocks.push(cssText.slice(openIndex + 1, closeIndex))
    cursor = closeIndex + 1
  }

  return blocks
}

function parseRules(cssText: string): CssRule[] {
  const rules: CssRule[] = []
  let cursor = 0

  while (cursor < cssText.length) {
    const openIndex = cssText.indexOf('{', cursor)
    if (openIndex === -1) break
    const selectorText = cssText.slice(cursor, openIndex).trim()
    let depth = 0
    let closeIndex = -1
    for (let index = openIndex; index < cssText.length; index += 1) {
      const char = cssText[index]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          closeIndex = index
          break
        }
      }
    }
    if (closeIndex === -1) break
    if (selectorText && !selectorText.startsWith('@')) {
      rules.push({
        body: cssText.slice(openIndex + 1, closeIndex),
        selectors: selectorText.split(',').map(selector => selector.trim()),
      })
    }
    cursor = closeIndex + 1
  }

  return rules
}

function expectReducedMotionAnimationDisabled(selector: string) {
  const reducedMotionCss = extractBlocks(css, '(prefers-reduced-motion: reduce)').join('\n')
  const rule = parseRules(reducedMotionCss).find(candidate =>
    candidate.selectors.includes(selector)
  )
  expect(rule, `${selector} should be in the reduced-motion media block`).toBeDefined()
  expect(rule?.body).toMatch(/animation:\s*none/)
}

describe('loading style accessibility', () => {
  it('disables skeleton and spinner animations for reduced-motion users', () => {
    expect(extractBlocks(css, '(prefers-reduced-motion: reduce)')).not.toHaveLength(0)
    expectReducedMotionAnimationDisabled('.cu-skeleton')
    expectReducedMotionAnimationDisabled('.cu-spin')
    expectReducedMotionAnimationDisabled('.cu-btn__spinner')
    expectReducedMotionAnimationDisabled('.cu-identity-skeleton__tabs')
    expectReducedMotionAnimationDisabled('.cu-identity-skeleton__header')
    expectReducedMotionAnimationDisabled('.cu-identity-skeleton__line')
    expectReducedMotionAnimationDisabled('.cu-identity-skeleton__box')
  })

  it('keeps the shared skeleton class visibly styled', () => {
    const rule = selectorRule('.cu-skeleton')
    expect(rule).toMatch(/background:/)
    expect(rule).toMatch(/background-size:/)
  })
})
