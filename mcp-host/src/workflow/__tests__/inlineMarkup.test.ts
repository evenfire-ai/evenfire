import { describe, expect, it } from 'vitest'
import {
  closesFence,
  decodeEntities,
  htmlToMarkdownInline,
  htmlToPlainText,
  imageTarget,
  inlineSpans,
  openingFence,
  quoteParagraphs,
  withoutClosingHashes,
} from '../inlineMarkup'

describe('inline HTML', () => {
  it('reads emphasis tags as their styles and <br> as a line break', () => {
    expect(inlineSpans('<b>a</b> <strong>b</strong> <i>c</i> <em>d</em> <del>e</del>')).toEqual([
      { text: 'a', bold: true },
      { text: ' ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italics: true },
      { text: ' ' },
      { text: 'd', italics: true },
      { text: ' ' },
      { text: 'e', strike: true },
    ])
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
    expect(inlineSpans('<b class="x">a</b> <span data-n=1 title=\'t\'>b</span>')).toEqual([
      { text: 'a', bold: true },
      { text: ' b' },
    ])
    expect(htmlToMarkdownInline('<table><tr><td nowrap>1</td><td>2</td></tr></table>')).toBe('1 2')
    expect(inlineSpans('<b >a</b >')).toEqual([{ text: 'a', bold: true }])
  })

  it('keeps a placeholder such as <table name> that no closing tag makes a tag', () => {
    const sql = 'SELECT * FROM <table name> WHERE <column name> = 1 at <time of day>'
    expect(inlineSpans(sql)).toEqual([{ text: sql }])
    expect(htmlToPlainText(sql)).toBe(sql)
    expect(inlineSpans('A<table border><tr><td>x</td></tr></table>')).toEqual([{ text: 'A\nx' }])
  })

  it('drops a tag of a longer element name whatever its attributes', () => {
    expect(
      htmlToMarkdownInline(
        '<div data-role>inner</div><span aria-hidden>x</span><hr noshade><ol compact><li>one</li></ol>'
      )
    ).toBe('inner\nx\n1. one')
    expect(htmlToMarkdownInline('<span title="a>b">t</span> <a download>file</a>')).toBe('t file')
    expect(htmlToMarkdownInline('A<table border><tr><td>cell</td></tr></table>B')).toBe(
      'A\ncell\nB'
    )
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

  it('nests emphasis written in HTML, in markdown or in both', () => {
    const noteImportant = [
      { text: 'Note: ', bold: true },
      { text: 'important', bold: true, italics: true },
    ]
    expect(inlineSpans('<b>Note: <i>important</i></b>')).toEqual(noteImportant)
    expect(inlineSpans('**Note: *important***')).toEqual(noteImportant)
    expect(inlineSpans('<b>Note: *important*</b>')).toEqual(noteImportant)
    const boldThenItalic = [
      { text: 'x', bold: true },
      { text: 'y', italics: true },
    ]
    expect(inlineSpans('<b>x</b><i>y</i>')).toEqual(boldThenItalic)
    expect(inlineSpans('**x***y*')).toEqual(boldThenItalic)
    const italicAroundBold = [
      { text: 'a ', italics: true },
      { text: 'b', italics: true, bold: true },
      { text: ' c', italics: true },
    ]
    expect(inlineSpans('<i>a <b>b</b> c</i>')).toEqual(italicAroundBold)
    expect(inlineSpans('*a **b** c*')).toEqual(italicAroundBold)
  })

  it('applies an HTML emphasis tag beside punctuation, where a markdown marker would not open', () => {
    expect(inlineSpans('Price<b>$5</b>, total<i>(est.)</i>')).toEqual([
      { text: 'Price' },
      { text: '$5', bold: true },
      { text: ', total' },
      { text: '(est.)', italics: true },
    ])
    expect(inlineSpans('**a</b> b**')).toEqual([{ text: 'a b', bold: true }])
  })

  it('prints underscores as written, so names such as __init__ keep them', () => {
    const text = 'the __init__ method, _private and snake_case_name'
    expect(inlineSpans(text)).toEqual([{ text }])
  })

  it('prints a noncharacter the input holds as nothing, not as a style', () => {
    expect(inlineSpans('a\uFDD0b\uFDD1c')).toEqual([{ text: 'abc' }])
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

  it('keeps brackets in the label of an HTML link', () => {
    expect(inlineSpans('Source <a href="https://x.com/a">[1]</a> end')).toEqual([
      { text: 'Source ' },
      { text: '[1]', link: 'https://x.com/a' },
      { text: ' end' },
    ])
    expect(inlineSpans('[a \\] b](https://x.com/b)')).toEqual([
      { text: 'a ] b', link: 'https://x.com/b' },
    ])
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

describe('code fences', () => {
  it('takes the whole run of backticks or tildes as the fence', () => {
    expect(openingFence('````markdown')).toEqual({ marker: '````', language: 'markdown' })
    expect(openingFence('  ~~~ js ')).toEqual({ marker: '~~~', language: 'js' })
    expect(openingFence('``x')).toBeUndefined()
  })

  it('closes a fence only on a run of its character at least as long', () => {
    expect(closesFence('```', '````')).toBe(false)
    expect(closesFence('~~~~', '```')).toBe(false)
    expect(closesFence('  `````', '````')).toBe(true)
  })

  it('reads a long run of backticks in linear time', () => {
    const line = `${'`'.repeat(200000)}\r`
    const started = performance.now()
    openingFence(line)
    closesFence(line, '```')
    expect(performance.now() - started).toBeLessThan(2000)
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
    tagLoose: '<div "'.repeat(33000),
    tagLooseQuote: '<div title="a>'.repeat(14000),
    tagLooseOpen: `<div ${'a="1" \'2\' '.repeat(20000)}`,
    placeholders: '<table name '.repeat(20000),
    placeholdersClosed: `${'<table name>'.repeat(15000)}</table>`,
    comment: '<!--'.repeat(50000),
    script: '<script>'.repeat(25000),
    anchor: '<a href="https://x.test">'.repeat(8000),
    anchorAttributes: `<a ${'href="http://x" '.repeat(12000)}>label`,
    list: '<ol><li>'.repeat(25000),
    image: '!['.repeat(100000),
    imageSpaced: '![ '.repeat(66667),
    imageOpen: '![a]('.repeat(40000),
    imageGroups: `![a](${'(x)'.repeat(60000)}`,
    imageGroupsRepeated: `![a](${'(x)'.repeat(5)}`.repeat(10000),
    link: '[a](http://x'.repeat(16000),
    linkEscapes: `[${'\\]'.repeat(100000)}`,
    bracket: '['.repeat(200000),
    bold: '**a '.repeat(50000),
    boldItalic: '***a '.repeat(40000),
    italic: '*a '.repeat(66667),
    strike: '~~a '.repeat(50000),
    nested: '*a **a '.repeat(30000),
    nestedUnderscore: '_a __a '.repeat(30000),
    closers: 'a* '.repeat(66667),
    bothWays: 'a**b*'.repeat(40000),
    mixedRuns: '*_'.repeat(100000),
    atomsThenMarker: `${'`a` '.repeat(50000)}*`,
    tagMarks: '<b><i>x'.repeat(28000),
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
