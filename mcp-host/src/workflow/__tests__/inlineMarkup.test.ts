import { describe, expect, it } from 'vitest'
import {
  decodeEntities,
  htmlToMarkdownInline,
  htmlToPlainText,
  imageTarget,
  inlineSpans,
  quoteParagraphs,
  withoutClosingHashes,
} from '../inlineMarkup'

describe('inline HTML', () => {
  it('maps emphasis tags onto markdown and <br> onto a line break', () => {
    expect(
      htmlToMarkdownInline('<b>a</b> <strong>b</strong> <i>c</i> <em>d</em> <del>e</del>')
    ).toBe('**a** **b** *c* *d* ~~e~~')
    expect(htmlToMarkdownInline('one<br>two<BR/>three')).toBe('one\ntwo\nthree')
  })

  it('keeps links, turns img into an image reference and drops scripts and comments', () => {
    expect(htmlToMarkdownInline('<a href="https://x.test/a">site</a>')).toBe(
      '[site](https://x.test/a)'
    )
    expect(htmlToMarkdownInline('<img src="chart.png" alt="c">')).toBe('![](chart.png)')
    expect(htmlToMarkdownInline('a<script>alert(1)</script>b<!-- note -->')).toBe('ab')
  })

  it('leaves text that only looks like a tag, and HTML quoted in code', () => {
    expect(htmlToMarkdownInline('Vec<String> and a < b')).toBe('Vec<String> and a < b')
    expect(htmlToMarkdownInline('use `<br>` here')).toBe('use `<br>` here')
    expect(htmlToPlainText('if a<b and c>d or x<i then y>z')).toBe('if a<b and c>d or x<i then y>z')
  })

  it('reads a tag whose attributes have values, or are HTML boolean attributes', () => {
    expect(htmlToMarkdownInline('<b class="x">a</b> <span data-n=1 title=\'t\'>b</span>')).toBe(
      '**a** b'
    )
    expect(htmlToMarkdownInline('<table><tr><td nowrap>1</td><td>2</td></tr></table>')).toBe('1 2')
    expect(htmlToMarkdownInline('<b >a</b >')).toBe('**a**')
  })

  it('breaks the line at block elements and drops their tags', () => {
    expect(htmlToMarkdownInline('<h2>Sales</h2><p>One</p><div>Two</div>')).toBe('Sales\nOne\nTwo')
    expect(
      htmlToMarkdownInline('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>')
    ).toBe('A B\n1')
    expect(htmlToMarkdownInline('<details><summary>S</summary>D</details>')).toBe('S\nD')
  })

  it('keeps list items apart, numbered as their list is', () => {
    expect(htmlToMarkdownInline('<ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol>')).toBe(
      '\u2022 a\n\u2022 b\n1. c\n2. d'
    )
  })

  it('reduces a title to its text', () => {
    expect(htmlToPlainText('HTML <b>mixed</b> &amp; <i>title</i>')).toBe('HTML mixed & title')
    expect(htmlToPlainText('<h1>A</h1><p>B</p> <img src="x.png">')).toBe('A B')
  })
})

describe('entities', () => {
  it('decodes named and numeric references', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42; &nbsp;')).toBe('a & b <c> AB \u00A0')
  })

  it('leaves unknown and unrepresentable references as written', () => {
    expect(decodeEntities('&bogus; &#0; &#xD800;')).toBe('&bogus; &#0; &#xD800;')
  })

  it('prints an encoded marker instead of reading it as markup', () => {
    expect(inlineSpans('&#42;&#42;not bold&#42;&#42; &lt;b&gt;')).toEqual([
      { text: '**not bold** <b>' },
    ])
  })
})

describe('inline markdown', () => {
  it('reads ***text*** as bold italic, and nests emphasis', () => {
    expect(inlineSpans('A ***both*** B')).toEqual([
      { text: 'A ' },
      { text: 'both', bold: true, italics: true },
      { text: ' B' },
    ])
    expect(inlineSpans('~~old **bold**~~')).toEqual([
      { text: 'old ', strike: true },
      { text: 'bold', strike: true, bold: true },
    ])
  })

  it('prints an escaped marker as itself', () => {
    expect(
      inlineSpans('\\*not italic\\*')
        .map(s => s.text)
        .join('')
    ).toBe('*not italic*')
    expect(inlineSpans('\\*not italic\\*').some(s => s.italics)).toBe(false)
  })

  it('keeps multiplication signs that have spaces around them', () => {
    expect(inlineSpans('Math 5 * 3 * 2 = 30')).toEqual([{ text: 'Math 5 * 3 * 2 = 30' }])
  })

  it('keeps balanced parentheses in a link target', () => {
    expect(inlineSpans('[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) end')).toEqual([
      { text: 'wiki', link: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { text: ' end' },
    ])
  })

  it('names an image written in the text, with its alt text', () => {
    expect(inlineSpans('see ![Revenue](sales.png "t") now')).toEqual([
      { text: 'see ' },
      { text: 'Revenue', image: 'sales.png' },
      { text: ' now' },
    ])
    expect(inlineSpans('`![x](y.png)`')).toEqual([{ text: '![x](y.png)', code: true }])
  })
})

describe('ATX headings', () => {
  it('drops a closing run of hashes only when a space precedes it', () => {
    expect(withoutClosingHashes('Section title ##')).toBe('Section title')
    expect(withoutClosingHashes('C#')).toBe('C#')
    expect(withoutClosingHashes('Issue #42')).toBe('Issue #42')
    expect(withoutClosingHashes('##')).toBe('')
  })
})

describe('image targets', () => {
  it('reads the file an image names, in each form Markdown allows', () => {
    expect(imageTarget('chart.png')).toBe('chart.png')
    expect(imageTarget(' <my chart.png> ')).toBe('my chart.png')
    expect(imageTarget('<my chart.png> "Sales"')).toBe('my chart.png')
    expect(imageTarget('chart.png "Quarterly sales"')).toBe('chart.png')
    expect(imageTarget("chart.png 'Sales'")).toBe('chart.png')
    expect(imageTarget('chart.png (Sales)')).toBe('chart.png')
    expect(imageTarget('my\\_chart.png')).toBe('my_chart.png')
    expect(imageTarget('a&amp;b.png')).toBe('a&b.png')
  })

  it('reads a name with spaces written without angle brackets whole', () => {
    expect(imageTarget('my chart.png')).toBe('my chart.png')
    expect(imageTarget('image (1).png')).toBe('image (1).png')
    expect(imageTarget('image (1).png "Costs"')).toBe('image (1).png')
    expect(imageTarget('my chart.png (Sales)')).toBe('my chart.png')
  })

  it('finds an image whose name holds a parenthesized part', () => {
    const [span] = inlineSpans('![Sales](image (1).png)')
    expect(span).toEqual({ text: 'Sales', image: 'image (1).png' })
  })
})

describe('block quotes', () => {
  it('ends a paragraph at an empty quoted line and runs the others on', () => {
    expect(quoteParagraphs(['One', 'runs on.', '', '  ', 'Two.', ''])).toEqual([
      'One runs on.',
      'Two.',
    ])
    expect(quoteParagraphs(['', ''])).toEqual([''])
  })
})

describe('hostile input', () => {
  // Each input is about 200 KB on one line: an unclosed construct repeated, so
  // a pattern that rescans the rest of the line from every opening is quadratic.
  const inputs: Record<string, string> = {
    img: "<img src='x".repeat(20000),
    tag: '<b'.repeat(100000),
    tagSpaced: '<b '.repeat(66667),
    tagAttributes: '<b a=1'.repeat(30000),
    tagAttributesOpen: `<b ${'a=1 '.repeat(50000)}`,
    tagBoolean: `<td ${'nowrap '.repeat(28000)}`,
    comment: '<!--'.repeat(50000),
    script: '<script>'.repeat(25000),
    anchor: '<a href="https://x.test">'.repeat(8000),
    list: '<ol><li>'.repeat(25000),
    image: '!['.repeat(100000),
    imageSpaced: '![ '.repeat(66667),
    imageOpen: '![a]('.repeat(40000),
    imageGroups: `![a](${'(x)'.repeat(60000)}`,
    imageGroupsRepeated: `![a](${'(x)'.repeat(5)}`.repeat(10000),
    link: '[a](http://x'.repeat(16000),
    bracket: '['.repeat(200000),
    bold: '**a '.repeat(50000),
    boldItalic: '***a '.repeat(40000),
    italic: '*a '.repeat(66667),
    strike: '~~a '.repeat(50000),
    code: '`a '.repeat(66667),
    escape: '\\*'.repeat(100000),
    entity: '&#x1'.repeat(50000),
  }
  const parsers: Record<string, (text: string) => unknown> = {
    htmlToMarkdownInline,
    htmlToPlainText,
    inlineSpans,
  }

  for (const [name, input] of Object.entries(inputs)) {
    it(`reads ${name} in linear time`, () => {
      for (const [parser, parse] of Object.entries(parsers)) {
        const started = performance.now()
        parse(input)
        expect(performance.now() - started, `${parser} on ${name}`).toBeLessThan(2000)
      }
    })
  }
})
