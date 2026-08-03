import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

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

function assertReducedMotionAnimationDisabled(selector: string) {
  const reducedMotionCss = extractBlocks(css, '(prefers-reduced-motion: reduce)').join('\n')
  const rule = parseRules(reducedMotionCss).find(candidate =>
    candidate.selectors.includes(selector)
  )
  assert.ok(rule, `${selector} should be in the reduced-motion media block`)
  assert.match(rule.body, /animation:\s*none/)
}

test('profile loading animations are disabled for reduced-motion users', () => {
  assert.notEqual(extractBlocks(css, '(prefers-reduced-motion: reduce)').length, 0)
  assertReducedMotionAnimationDisabled('.profile-skeleton__line')
  assertReducedMotionAnimationDisabled('.cu-skeleton')
  assertReducedMotionAnimationDisabled('.cu-btn__spinner')
})

test('profile sidebar loading placeholders have visible stable skeleton styling', () => {
  const skeletonRule = selectorRule('.cu-skeleton')
  assert.match(skeletonRule, /background:/)
  assert.match(skeletonRule, /background-size:/)
  assert.match(skeletonRule, /animation:/)

  const iconRule = selectorRule('.cu-sidebar__item--loading .cu-sidebar__icon')
  const labelRule = selectorRule('.cu-sidebar__item--loading .cu-sidebar__label')
  assert.match(iconRule, /width:\s*1\.1rem/)
  assert.match(iconRule, /height:\s*1\.1rem/)
  assert.match(labelRule, /height:\s*0\.75rem/)
  assert.match(labelRule, /max-width:\s*7\.5rem/)
})
