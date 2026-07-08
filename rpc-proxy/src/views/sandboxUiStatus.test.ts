import { describe, expect, it } from 'vitest'
import { recipeGoneHtml, recipeUpdatingHtml } from './sandboxUiStatus.js'

describe('recipeGoneHtml', () => {
  it('renders the recipe ref into the page', () => {
    const html = recipeGoneHtml('sandbox-recipes', 'my-recipe')
    expect(html).toContain('sandbox-recipes/my-recipe')
    expect(html).toContain('no longer available')
  })

  it('escapes HTML metacharacters in the recipe name', () => {
    const html = recipeGoneHtml('sandbox-recipes', '"><script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;')
  })

  it('does NOT include a meta-refresh tag (recipe is gone — refreshing will not bring it back)', () => {
    const html = recipeGoneHtml('sandbox-recipes', 'my-recipe')
    expect(html).not.toContain('http-equiv="refresh"')
  })
})

describe('recipeUpdatingHtml', () => {
  it('renders the recipe ref and reason', () => {
    const html = recipeUpdatingHtml('sandbox-recipes', 'r1', 'phase=deploying')
    expect(html).toContain('sandbox-recipes/r1')
    expect(html).toContain('updating')
    expect(html).toContain('phase=deploying')
  })

  it('includes a meta-refresh that fires every 5 seconds (auto-recovery)', () => {
    const html = recipeUpdatingHtml('sandbox-recipes', 'r1', 'starting up')
    expect(html).toContain('http-equiv="refresh"')
    expect(html).toContain('content="5"')
  })

  it('escapes HTML metacharacters in the reason', () => {
    const html = recipeUpdatingHtml('sandbox-recipes', 'r1', '<img onerror=alert(1)>')
    expect(html).not.toContain('<img onerror')
    expect(html).toContain('&lt;img onerror=alert(1)&gt;')
  })
})
