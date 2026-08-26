import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const tokens = readFileSync(path.join(process.cwd(), 'ui/src/styles/tokens.css'), 'utf8')
const styles = readFileSync(path.join(process.cwd(), 'ui/src/styles.css'), 'utf8')

describe('chat search highlight styling', () => {
  it('uses Chromium-compatible semantic colors in both themes', () => {
    expect(tokens.match(/--search-match-bg:\s*#ffff00/g)).toHaveLength(2)
    expect(tokens.match(/--search-match-current-bg:\s*#ff9632/g)).toHaveLength(2)
    expect(tokens.match(/--search-match-text:\s*#000000/g)).toHaveLength(2)
    expect(styles).toMatch(/\.chat-search-match\s*{[^}]*background:\s*var\(--search-match-bg\)/s)
    expect(styles).toMatch(
      /\.chat-search-match--active\s*{[^}]*background:\s*var\(--search-match-current-bg\)/s
    )
    expect(styles).not.toMatch(/\.chat-search-match--active\s*{[^}]*box-shadow:/s)
  })

  it('preserves system highlight colors in forced-colors mode', () => {
    expect(styles).toMatch(
      /@media \(forced-colors: active\)[\s\S]*background:\s*Highlight;[\s\S]*color:\s*HighlightText;/
    )
  })
})
