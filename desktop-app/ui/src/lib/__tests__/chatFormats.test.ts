import { describe, expect, it } from 'vitest'
import type { Root, RootContent } from 'hast'
import type { AgentChatMessage } from '../../uiTypes'
import { chatFilePreviewKind, formattedJson, textBlocks } from '../chatFilePreview'
import { formulasPastBudget, renderChatMath } from '../chatMath'
import { buildChatMessageSemanticModel } from '../chatMessageSemantics'
import { parseDelimited } from '../csv'
import { layoutCost } from '../layoutCost'

const LAYOUT_LIMIT = 15_000

function treeOf(content: string): Root {
  const message = { id: 'reply', role: 'assistant', content } as AgentChatMessage
  return buildChatMessageSemanticModel(message).renderTree
}

/** Visible text, with formulas between brackets and images by their source. */
function read(node: Root | RootContent): string {
  if (node.type === 'text') return node.value
  if (!('children' in node)) return ''
  const inner = node.children.map(child => read(child as RootContent)).join('')
  if (node.type !== 'element') return inner
  const classes = node.properties.className
  if (Array.isArray(classes) && classes.includes('language-math')) return `⟦${inner.trim()}⟧`
  if (node.tagName === 'img') return `<img ${String(node.properties.src)}>`
  return node.tagName === 'br' ? '\n' : inner
}

const shown = (content: string) => read(treeOf(content))

describe('math delimiters', () => {
  it.each([
    'It costs $5 and $10, or $$5 and $$10.',
    'Svelte uses $$props and $$restProps.',
    'Luigi ($$), Nobu ($$$) or Luz ($$).',
    'echo $$ prints the PID; kill $$ kills it.',
    'CREATE FUNCTION f() AS $$ SELECT a = b $$ LANGUAGE sql',
    '$${a} and $${b}',
  ])('keeps %s as text', text => {
    expect(shown(text)).toBe(text)
  })

  it.each([
    ['See \\(section 3\\.2\\)', 'See (section 3.2)'],
    ['user\\(s\\)', 'user(s)'],
    ['\\[1\\] note', '[1] note'],
    ['\\(`-v`\\)', '(-v)'],
  ])('keeps the escaped brackets of %s', (text, expected) => {
    expect(shown(text)).toBe(expected)
  })

  it.each([
    ['Let \\(x^2\\) be', 'Let ⟦x^2⟧ be'],
    ['The value $$E = mc^2$$ holds', 'The value ⟦E = mc^2⟧ holds'],
    ['$$\nx = a\n+ b\n$$', '⟦x = a\n+ b⟧'],
    ['$$\\begin{aligned}\na &= b\n\\end{aligned}$$', '⟦\\begin{aligned}\na &= b\n\\end{aligned}⟧'],
    ['\\[\nx = 1\n\\]', '⟦x = 1⟧'],
    ['> $$\n> x = 1\n> $$', '⟦x = 1⟧'],
  ])('reads %s as a formula', (text, expected) => {
    expect(shown(text).trim()).toBe(expected)
  })

  it('does not let an unclosed block swallow the reply', () => {
    expect(shown('$$ 10\n\n- one\n- two\n\n$$\ny = 2\n$$')).toMatch(/one[\s\S]*two[\s\S]*⟦y = 2⟧/)
    const list = Array.from({ length: 40 }, () => '- $$').join('\n')
    expect(shown(`${list}\n\nthe end`)).not.toContain('⟦')
  })
})

describe('untrusted content', () => {
  it('keeps raw HTML as text except bare inline tags', () => {
    expect(shown('H<sub>2</sub>O')).toBe('H2O')
    for (const html of [
      '<b onclick="x()">a</b>',
      '<sub class="x">a</sub>',
      '<iframe src="x"></iframe>',
    ])
      expect(shown(`x ${html}`)).toBe(`x ${html}`)
  })

  it('never fetches web images and refuses other data types', () => {
    expect(shown('![a](https://example.com/a.png)')).toBe('a')
    expect(shown('![a](data:image/png;base64,AAAA)')).toBe('<img data:image/png;base64,AAAA>')
    expect(shown('![a](data:text/html;base64,AAAA)')).toBe('a')
  })

  it('refuses formulas that define macros, link outside or nest too deep', () => {
    expect(renderChatMath('\\def\\a{x}\\a', true).ok).toBe(false)
    expect(JSON.stringify(renderChatMath('\\href{https://a.com}{x}', true))).not.toContain('"href"')
    expect(renderChatMath(`${'\\sqrt{'.repeat(200)}x${'}'.repeat(200)}`, true).ok).toBe(false)
    expect(shown(`${'- '.repeat(300)}$$x^2$$`)).not.toContain('⟦')
  })

  it('limits what the formulas of one message draw', () => {
    const large = Array.from(
      { length: 13 },
      (_, index) => `$$\n\\begin{gather}${'\\\\'.repeat(700 + index)}\\end{gather}\n$$`
    )
    expect(formulasPastBudget(treeOf(large.join('\n\n'))).size).toBeGreaterThan(8)
    const ordinary = Array.from({ length: 90 }, (_, index) => `$$x_{${index}} = \\frac{a}{b}$$`)
    expect(formulasPastBudget(treeOf(ordinary.join('\n\n'))).size).toBe(0)
  })

  it('tells text that is slow to lay out from ordinary text', () => {
    for (const text of [
      'word '.repeat(20_000),
      '{"a": 1}, '.repeat(9_000),
      'слово '.repeat(15_000),
    ])
      expect(layoutCost(text, LAYOUT_LIMIT)).toBeLessThanOrEqual(LAYOUT_LIMIT)
    for (const unit of ['aا', 'กำ', 'a一', 'a1'])
      expect(layoutCost(unit.repeat(45_000), LAYOUT_LIMIT)).toBeGreaterThan(LAYOUT_LIMIT)
  })
})

describe('file previews', () => {
  it('selects the preview by extension', () => {
    expect(['a.PNG', 'a.csv', 'a.json', 'a.md', 'a.log', 'a.htm'].map(chatFilePreviewKind)).toEqual(
      ['image', 'table', 'code', 'markdown', 'text', 'html']
    )
    expect(['a.docx', 'a.zip', 'constructor', ''].map(chatFilePreviewKind)).toEqual(
      Array(4).fill(null)
    )
  })

  it('indents JSON without changing its values', () => {
    expect(formattedJson('{"id":1790471234567890123,"a":1.10,"a":[]}')).toBe(
      '{\n  "id": 1790471234567890123,\n  "a": 1.10,\n  "a": []\n}'
    )
    expect(formattedJson('{bad')).toBe('{bad')
  })

  it('reads the CSV variants spreadsheets write', () => {
    const rows = (text: string) => parseDelimited(text, ',', 10).rows
    expect(rows('a,"b ""c"", d"\n1,2')).toEqual([
      ['a', 'b "c", d'],
      ['1', '2'],
    ])
    expect(rows('Name;Price\nDesk;1.200,50')[1]).toEqual(['Desk', '1.200,50'])
    expect(rows('a,b\n"x,1\n2,3')[1]).toEqual(['"x', '1'])
  })

  it('splits long text into blocks without losing any of it', () => {
    const lines = Array.from({ length: 900 }, (_, index) => (index % 7 ? `line ${index}` : ''))
    const text = lines.join('\n')
    expect(
      textBlocks(text)
        .map(block => block.replace(/\n$/, ''))
        .join('\n')
    ).toBe(text)
    expect(textBlocks('😀'.repeat(5_001)).join('')).toBe('😀'.repeat(5_001))
  })
})
