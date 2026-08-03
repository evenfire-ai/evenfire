import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

function selectorRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

test('profile loading animations are disabled for reduced-motion users', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
  assert.match(
    css,
    /@media[\s\S]*prefers-reduced-motion[\s\S]*\.profile-skeleton__line[\s\S]*animation:\s*none/
  )
  assert.match(
    css,
    /@media[\s\S]*prefers-reduced-motion[\s\S]*\.cu-skeleton[\s\S]*animation:\s*none/
  )
  assert.match(
    css,
    /@media[\s\S]*prefers-reduced-motion[\s\S]*\.cu-btn__spinner[\s\S]*animation:\s*none/
  )
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
