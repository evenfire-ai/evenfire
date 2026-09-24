/**
 * Inline markdown, and the bits of HTML models mix into it, read once for the
 * PDF and DOCX generators so both print the same text the same way.
 *
 * Every pattern here runs on text a model wrote, so none may backtrack across
 * the input: each stops at the next tag, bracket or marker of its own kind.
 */

// The attributes of a one-letter tag. Each takes a value unless it is one of
// HTML's boolean attributes, so text such as "a<b and c>d" is not read as a <b>
// tag. A longer element name is rarely text, so its tag runs to the bracket.
const STRICT_ATTRIBUTES =
  '(?:\\s+(?:(?:allowfullscreen|async|checked|controls|default|defer|disabled|hidden|inert|' +
  'loop|multiple|muted|nowrap|open|readonly|required|reversed|selected)(?![-\\w:.=])|' +
  '[A-Za-z_:][-\\w:.]*\\s*=\\s*(?:"[^"<]*"|\'[^\'<]*\'|[^\\s"\'=<>`]+)))*\\s*'
const ANY_ATTRIBUTES = '(?:\\s(?:[^<>"\']|"[^"<]*"|\'[^\'<]*\')*)?'

/** The element `names`, each followed by the attributes its tag may carry. */
function named(names: string[]): string {
  const short = names.filter(n => n.length === 1)
  const long = names.filter(n => n.length > 1)
  return [
    ...(short.length > 0 ? [`(?:${short.join('|')})${STRICT_ATTRIBUTES}`] : []),
    ...(long.length > 0 ? [`(?:${long.join('|')})${ANY_ATTRIBUTES}`] : []),
  ].join('|')
}

/** Opening and closing tags of the element `names`, with their attributes. */
const tag = (names: string[]) => `</?(?:${named(names)})>`

// Noncharacters, which no text carries, mark where an HTML emphasis tag opened
// or closed its style; any the input holds are removed first.
const STYLE_MARKS: Record<'bold' | 'italics' | 'strike', [open: string, close: string]> = {
  bold: ['\uFDD0', '\uFDD1'],
  italics: ['\uFDD2', '\uFDD3'],
  strike: ['\uFDD4', '\uFDD5'],
}
const NONCHARACTERS = /[\uFDD0-\uFDEF]/g

/** The style mark for an opening or closing emphasis tag. */
function styleMark(style: keyof typeof STYLE_MARKS, tag: string): string {
  return STYLE_MARKS[style][tag[1] === '/' ? 1 : 0]
}

const SCRIPT_OPEN = /<(script|style)\b[^<>]*>/gi
const LINE_BREAK = /<br\s*\/?>/gi
// A block or cell boundary ends a word even when no space surrounds the tags.
const BLOCK_EDGE = new RegExp(
  `(?:${tag(
    'article|blockquote|caption|dd|details|div|dt|figcaption|figure|footer|h[1-6]|header|li|ol|p|pre|section|summary|table|tr|ul'.split(
      '|'
    )
  )}\\s*)+`,
  'gi'
)
const CELL_EDGE = new RegExp(`(?:${tag(['t[dh]'])}\\s*)+`, 'gi')
const BOLD_TAG = new RegExp(tag(['b', 'strong']), 'gi')
const ITALIC_TAG = new RegExp(tag(['i', 'em']), 'gi')
const CODE_TAG = new RegExp(tag(['code', 'kbd', 'tt']), 'gi')
const STRIKE_TAG = new RegExp(tag(['del', 's', 'strike']), 'gi')
const LIST_TAG = new RegExp(`<(/?)(ul|ol|li)${ANY_ATTRIBUTES}>`, 'gi')
const IMG_TAG = /<img\b[^<>]*>/gi
const IMG_SRC = /\bsrc\s*=\s*(["'])([^"'<>]+)\1/i
/** A backslash before ASCII punctuation, which CommonMark prints as that character. */
const ESCAPE = /\\[!-/:-@[-`{-~]/
// The opening tag is taken whole and its href read apart, and the label stops at
// the next anchor tag, so neither an unclosed <a> nor a tag of many attributes
// is rescanned from every position.
const ANCHOR = /(<a\s[^<>]*>)((?:[^<]|<(?!\/?a[\s>]))*?)<\/a\s*>/gi
const HREF = /\shref\s*=\s*["']((?:https?:\/\/|mailto:)[^"'\s<>]+)["']/i

// Only real element names are removed, so a placeholder such as <namespace>
// in a command survives as text.
const ELEMENTS = [
  'a',
  'abbr',
  'article',
  'aside',
  'big',
  'blockquote',
  'caption',
  'center',
  'cite',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'font',
  'footer',
  'h[1-6]',
  'header',
  'hr',
  'img',
  'ins',
  'label',
  'li',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  's',
  'script',
  'section',
  'small',
  'span',
  'strike',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
]
const HTML_TAG = new RegExp(`</?(?:${named(ELEMENTS)})/?>`, 'gi')

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  laquo: '\u00AB',
  raquo: '\u00BB',
  middot: '\u00B7',
  bull: '\u2022',
  times: '\u00D7',
  divide: '\u00F7',
  deg: '\u00B0',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  euro: '\u20AC',
  pound: '\u00A3',
  yen: '\u00A5',
  cent: '\u00A2',
}

/** Code points XML 1.0 can carry; a numeric reference to anything else stays literal. */
function xmlAllowed(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  )
}

/** Character references decoded; an unknown or unrepresentable one stays as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const cp =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1))
      return xmlAllowed(cp) ? String.fromCodePoint(cp) : entity
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity
  })
}

/** `text` without HTML comments, found in one pass; an unclosed one is left as written. */
function withoutComments(text: string): string {
  if (!text.includes('<!--')) return text
  let out = ''
  let at = 0
  for (let open = text.indexOf('<!--'); open >= 0; open = text.indexOf('<!--', at)) {
    const close = text.indexOf('-->', open + 4)
    if (close < 0) break
    out += text.slice(at, open)
    at = close + 3
  }
  return out + text.slice(at)
}

/** `text` without <script> and <style> elements, found in one pass. */
function withoutScripts(text: string): string {
  if (!/<(?:script|style)\b/i.test(text)) return text
  const lower = text.toLowerCase()
  let out = ''
  let at = 0
  SCRIPT_OPEN.lastIndex = 0
  for (let open = SCRIPT_OPEN.exec(text); open; open = SCRIPT_OPEN.exec(text)) {
    const close = lower.indexOf(`</${open[1].toLowerCase()}`, SCRIPT_OPEN.lastIndex)
    const end = close < 0 ? -1 : lower.indexOf('>', close)
    if (end < 0) break
    out += text.slice(at, open.index)
    at = end + 1
    SCRIPT_OPEN.lastIndex = at
  }
  return out + text.slice(at)
}

/**
 * Replace `pattern` with `separator` between words, and with nothing at either
 * end of `text` or beside a line break. A match that already spans a line
 * break keeps the break.
 */
function separate(text: string, pattern: RegExp, separator: string): string {
  return text.replace(pattern, (match: string, offset: number) => {
    const end = offset + match.length
    if (offset === 0 || end === text.length) return ''
    if (match.includes('\n')) return '\n'
    return text[offset - 1] === '\n' || text[end] === '\n' ? '' : separator
  })
}

/**
 * Each <li> given the marker its list shows, a bullet or its number, so a list
 * written in HTML keeps its items apart once the tags are gone.
 */
function withListMarkers(text: string): string {
  if (!/<li\b/i.test(text)) return text
  const lists: Array<{ ordered: boolean; count: number }> = []
  return text.replace(LIST_TAG, (tag: string, close: string, name: string) => {
    const kind = name.toLowerCase()
    if (kind !== 'li') {
      if (close) lists.pop()
      else lists.push({ ordered: kind === 'ol', count: 0 })
      return tag
    }
    if (close) return tag
    const list = lists[lists.length - 1]
    return `${tag}${list?.ordered ? `${++list.count}. ` : '\u2022 '}`
  })
}

/** An <img> tag as the markdown image it names, or nothing when it names no source. */
function imageMarkdown(tag: string): string {
  const src = IMG_SRC.exec(tag)?.[2].trim()
  return src ? `![](${src})` : ''
}

const LONG_OPEN_TAG = new RegExp(
  `<(${ELEMENTS.filter(n => n.length > 1).join('|')})(\\s[^<>]*)>`,
  'gi'
)
const CLOSING_TAG = /<\/([a-z][a-z0-9]*)\s*>/gi
const STRICT_ONLY = new RegExp(`^${STRICT_ATTRIBUTES}/?$`)
/** Elements that never close, so no closing tag vouches for them. */
const VOID_ELEMENTS = new Set(['hr', 'img', 'br', 'col', 'wbr'])

/**
 * `text` with a would-be tag of a longer element name kept as text when its
 * attributes are not all values or boolean ones and nothing closes its
 * element: "SELECT * FROM <table name>" is a placeholder, while
 * "<table border>…</table>" is a table. Its "<" is written as a reference,
 * which prints as itself once the spans are read.
 */
function withPlaceholdersKept(text: string): string {
  if (!text.includes('<')) return text
  const closed = new Set<string>()
  for (const m of text.matchAll(CLOSING_TAG)) closed.add(m[1].toLowerCase())
  return text.replace(LONG_OPEN_TAG, (tag: string, name: string, attributes: string) => {
    const element = name.toLowerCase()
    if (closed.has(element) || VOID_ELEMENTS.has(element) || STRICT_ONLY.test(attributes)) {
      return tag
    }
    return `&lt;${tag.slice(1)}`
  })
}

function htmlSegmentToMarkdown(text: string): string {
  const html = withListMarkers(withoutScripts(withoutComments(withPlaceholdersKept(text)))).replace(
    LINE_BREAK,
    '\n'
  )
  return separate(separate(html, BLOCK_EDGE, '\n'), CELL_EDGE, ' ')
    .replace(IMG_TAG, imageMarkdown)
    .replace(ANCHOR, (_whole: string, tag: string, label: string) => {
      const href = HREF.exec(tag)?.[1]
      // Brackets in the label are escaped, so they print instead of ending it.
      return href ? `[${label.replace(/[[\]]/g, '\\$&')}](${href})` : label
    })
    .replace(BOLD_TAG, tag => styleMark('bold', tag))
    .replace(ITALIC_TAG, tag => styleMark('italics', tag))
    .replace(CODE_TAG, '`')
    .replace(STRIKE_TAG, tag => styleMark('strike', tag))
    .replace(HTML_TAG, '')
}

function htmlSegmentToPlainText(text: string): string {
  return decodeEntities(
    withoutScripts(withoutComments(withPlaceholdersKept(text)))
      .replace(LINE_BREAK, ' ')
      .replace(BLOCK_EDGE, ' ')
      .replace(CELL_EDGE, ' ')
      .replace(ANCHOR, (_whole: string, _tag: string, label: string) => label)
      .replace(BOLD_TAG, '')
      .replace(ITALIC_TAG, '')
      .replace(CODE_TAG, '')
      .replace(STRIKE_TAG, '')
      .replace(HTML_TAG, '')
  )
}

function mapOutsideCode(text: string, convert: (segment: string) => string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 === 1 ? part : convert(part)))
    .join('')
}

/**
 * Inline HTML as the markdown the span reader understands: <br> and block
 * edges become line breaks, <code>/<a>/<img> their markdown forms, and other
 * tags are dropped. <b>, <i> and <s> become style marks, which open and close
 * their style wherever they stand; a markdown marker next to punctuation may
 * not. Entities stay encoded until the spans are read, so an encoded asterisk
 * prints instead of starting emphasis. Code spans are left as written.
 */
export function htmlToMarkdownInline(text: string): string {
  const source = text.replace(NONCHARACTERS, '')
  if (!source.includes('<')) return source
  return mapOutsideCode(source, htmlSegmentToMarkdown)
}

/** Inline HTML reduced to its text, for titles and other places that take no formatting. */
export function htmlToPlainText(text: string): string {
  const plain =
    text.includes('<') || text.includes('&') ? mapOutsideCode(text, htmlSegmentToPlainText) : text
  return plain.replace(/[ \t\r\n]+/g, ' ').trim()
}

/** Like htmlToPlainText, line by line: line breaks, <br> included, are kept. */
export function htmlToPlainLines(text: string): string {
  return text
    .replace(LINE_BREAK, '\n')
    .split('\n')
    .map(line => htmlToPlainText(line))
    .join('\n')
}

/** A heading's text without its optional closing run of hashes (`## Title ##`). */
export function withoutClosingHashes(text: string): string {
  const t = text.trimEnd()
  let end = t.length
  while (end > 0 && t[end - 1] === '#') end--
  if (end === t.length) return t
  if (end === 0) return ''
  return /\s/.test(t[end - 1]) ? t.slice(0, end).trimEnd() : t
}

/** The opening of a fenced code block: its run of backticks or tildes and the language after it. */
export function openingFence(line: string): { marker: string; language: string } | undefined {
  const t = line.trim()
  const run = fenceRun(t)
  return run >= 3 ? { marker: t.slice(0, run), language: t.slice(run).trim() } : undefined
}

/** Whether `line` closes the block `marker` opened: a run of its character at least as long. */
export function closesFence(line: string, marker: string): boolean {
  const t = line.trimStart()
  return t[0] === marker[0] && fenceRun(t) >= marker.length
}

/** Length of the run of backticks or tildes that starts `text`. */
function fenceRun(text: string): number {
  const ch = text[0]
  if (ch !== '`' && ch !== '~') return 0
  let n = 1
  while (text[n] === ch) n++
  return n
}

/**
 * The paragraphs of a block quote, from its lines without their `>` marker. A
 * quoted line left empty ends a paragraph; the lines of one paragraph run on,
 * joined by a space. A quote with no text is one empty paragraph.
 */
export function quoteParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of [...lines, '']) {
    if (line.trim()) {
      current.push(line)
    } else if (current.length > 0) {
      paragraphs.push(current.join(' '))
      current = []
    }
  }
  return paragraphs.length > 0 ? paragraphs : ['']
}

// Links, images, code spans and escapes, which emphasis does not reach into.
// No part may run into the next opening bracket or parenthesis: otherwise an
// unclosed image or link is rescanned to the end of the line from every
// opening, which takes minutes on a long line.
const ATOM = new RegExp(
  [
    /!\[[^[\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/.source,
    /\[(?:[^[\]\n\\]|\\.)+\]\((?:https?:\/\/|mailto:)(?:[^\s()]|\([^\s()]*\))+\)/.source,
    /`[^`]+`/.source,
    ESCAPE.source,
  ].join('|'),
  'g'
)
/**
 * The characters that may mark emphasis, and the style marks. An underscore
 * prints as written, as it did before: CommonMark reads __init__ as a bold
 * "init", and names like it are common in the text models write.
 */
const EMPHASIS_CHAR = /[*~\uFDD0-\uFDD5]/g

function unescapeMarkdown(text: string): string {
  return text.replace(new RegExp(ESCAPE.source, 'g'), escaped => escaped.slice(1))
}

/**
 * The file named between the parentheses of `![alt](...)`: `<my chart.png>`,
 * or `chart.png`, either with an optional title after it. The rest is read
 * whole, so a name with spaces written without angle brackets still names its file.
 */
export function imageTarget(inside: string): string {
  const t = inside.trim()
  const angle = /^<([^<>\n]*)>/.exec(t)
  const titled = /^(.*?)\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))$/.exec(t)
  return decodeEntities(unescapeMarkdown(angle ? angle[1] : titled ? titled[1] : t))
}

/** One stretch of inline text and the formatting it carries. */
export interface InlineSpan {
  text: string
  bold?: boolean
  italics?: boolean
  strike?: boolean
  code?: boolean
  /** Target of a link; the span's text is its label. */
  link?: string
  /** An image written inside the text: the span's text is its alt text. */
  image?: string
}

type StyleName = 'bold' | 'italics' | 'strike'
type SpanStyle = Pick<InlineSpan, StyleName>

/** Whether `span` can take on the text of `next`: both plain, formatted alike. */
function joins(span: InlineSpan, next: InlineSpan): boolean {
  return (
    span.link === undefined &&
    next.link === undefined &&
    span.image === undefined &&
    next.image === undefined &&
    !span.code &&
    !next.code &&
    !!span.bold === !!next.bold &&
    !!span.italics === !!next.italics &&
    !!span.strike === !!next.strike
  )
}

/** A run of `*` or `~~` that may open or close emphasis, as CommonMark reads it. */
interface Delimiter {
  char: string
  /** Order among the runs, which bounds the search for an opener. */
  index: number
  /** Length of the run as written. */
  length: number
  /** Characters of the run not used as emphasis, which print as written. */
  left: number
  canOpen: boolean
  canClose: boolean
  /** Styles the run closes before what is left of it prints. */
  closes: StyleName[]
  /** Styles the run opens after what is left of it prints. */
  opens: StyleName[]
  prev?: Delimiter
  next?: Delimiter
}

type Piece =
  | { text: string }
  | { span: InlineSpan }
  | { run: Delimiter }
  | { mark: StyleName; open: boolean }

const MARK_STYLES = new Map(
  Object.entries(STYLE_MARKS).flatMap(([style, [open, close]]) => [
    [open, { mark: style as StyleName, open: true }],
    [close, { mark: style as StyleName, open: false }],
  ])
)

function charBefore(text: string, at: number): string | undefined {
  return at > 0 ? Array.from(text.slice(Math.max(0, at - 2), at)).pop() : undefined
}

function charAfter(text: string, at: number): string | undefined {
  return at < text.length ? String.fromCodePoint(text.codePointAt(at)!) : undefined
}

/** Whitespace for flanking: a line's ends and a style mark count as whitespace. */
function isSpace(ch: string | undefined): boolean {
  return ch === undefined || MARK_STYLES.has(ch) || /\s/u.test(ch)
}

function isPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{P}\p{S}]/u.test(ch)
}

/** The run of `char` at `start` to `end` of `source`, with what CommonMark lets it open or close. */
function delimiter(source: string, char: string, start: number, end: number): Delimiter {
  const before = charBefore(source, start)
  const after = charAfter(source, end)
  const spaceBefore = isSpace(before)
  const spaceAfter = isSpace(after)
  const punctuationBefore = isPunctuation(before)
  const punctuationAfter = isPunctuation(after)
  const leftFlanking = !spaceAfter && (!punctuationAfter || spaceBefore || punctuationBefore)
  const rightFlanking = !spaceBefore && (!punctuationBefore || spaceAfter || punctuationAfter)
  return {
    char,
    index: 0,
    length: end - start,
    left: end - start,
    canOpen: leftFlanking,
    canClose: rightFlanking,
    closes: [],
    opens: [],
  }
}

/**
 * The text of `source` from `from` to `to`, between atoms, split into plain
 * text, emphasis runs and style marks. Only the segment is searched, so text
 * cut by many atoms is still read once.
 */
function scanText(source: string, from: number, to: number, pieces: Piece[]): void {
  const segment = source.slice(from, to)
  const pattern = new RegExp(EMPHASIS_CHAR)
  let at = 0
  for (let m = pattern.exec(segment); m; m = pattern.exec(segment)) {
    const char = m[0]
    const mark = MARK_STYLES.get(char)
    let end = m.index + 1
    if (!mark) while (segment[end] === char) end++
    pattern.lastIndex = end
    // Only a pair of tildes marks strikethrough; a longer or shorter run is text.
    if (!mark && char === '~' && end - m.index !== 2) continue
    if (m.index > at) pieces.push({ text: segment.slice(at, m.index) })
    pieces.push(mark ?? { run: delimiter(source, char, from + m.index, from + end) })
    at = end
  }
  if (segment.length > at) pieces.push({ text: segment.slice(at) })
}

/** Whether `opener` can close with `closer`, by CommonMark's rule of three for `*`. */
function pairs(opener: Delimiter, closer: Delimiter): boolean {
  if (opener.char !== closer.char || !opener.canOpen) return false
  if (closer.char === '~') return true
  const either = opener.canClose || closer.canOpen
  const sum = opener.length + closer.length
  return !(either && sum % 3 === 0 && (opener.length % 3 !== 0 || closer.length % 3 !== 0))
}

function unlink(run: Delimiter): void {
  if (run.prev) run.prev.next = run.next
  if (run.next) run.next.prev = run.prev
}

/**
 * Pair openers with closers as CommonMark's "process emphasis" does. The
 * lowest opener a closer may reach is kept per kind of closer, and runs
 * passed over by a pair are dropped, so each run is looked at a bounded
 * number of times.
 */
function pairRuns(first: Delimiter | undefined): void {
  const bottoms = new Map<string, number>()
  let closer = first
  while (closer) {
    if (!closer.canClose) {
      closer = closer.next
      continue
    }
    const kind = `${closer.char}${closer.canOpen ? 1 : 0}${closer.length % 3}`
    const bottom = bottoms.get(kind) ?? -1
    let opener = closer.prev
    while (opener && opener.index > bottom && !pairs(opener, closer)) opener = opener.prev
    if (opener && opener.index > bottom) {
      const used = closer.char === '~' || (closer.left >= 2 && opener.left >= 2) ? 2 : 1
      const style: StyleName = closer.char === '~' ? 'strike' : used === 2 ? 'bold' : 'italics'
      opener.opens.push(style)
      closer.closes.push(style)
      opener.left -= used
      closer.left -= used
      opener.next = closer
      closer.prev = opener
      if (opener.left === 0) unlink(opener)
      if (closer.left === 0) {
        unlink(closer)
        closer = closer.next
      }
    } else {
      bottoms.set(kind, closer.index - 1)
      if (!closer.canOpen) unlink(closer)
      closer = closer.next
    }
  }
}

function withoutMarks(text: string): string {
  return text.replace(NONCHARACTERS, '')
}

/** The atom `token` as a span, before the emphasis around it is applied. */
function atomSpan(token: string): InlineSpan {
  if (token.startsWith('![')) {
    const split = token.indexOf('](')
    return {
      text: decodeEntities(unescapeMarkdown(withoutMarks(token.slice(2, split)))),
      image: imageTarget(token.slice(split + 2, -1)),
    }
  }
  if (token.startsWith('[')) {
    const split = token.indexOf('](')
    return {
      text: decodeEntities(unescapeMarkdown(withoutMarks(token.slice(1, split)))),
      link: decodeEntities(token.slice(split + 2, -1)),
    }
  }
  if (token.startsWith('`')) return { text: withoutMarks(token.slice(1, -1)), code: true }
  return { text: token.slice(1) }
}

/**
 * The spans of one block of markdown already through htmlToMarkdownInline:
 * **bold**, *italic*, ***both***, ~~strike~~, `code`, [links](https://...),
 * ![images](file.png) and backslash escapes.
 */
export function markdownSpans(markdown: string): InlineSpan[] {
  const pieces: Piece[] = []
  const atoms = new RegExp(ATOM)
  let at = 0
  for (let m = atoms.exec(markdown); m; m = atoms.exec(markdown)) {
    scanText(markdown, at, m.index, pieces)
    pieces.push({ span: atomSpan(m[0]) })
    at = atoms.lastIndex
  }
  scanText(markdown, at, markdown.length, pieces)

  let first: Delimiter | undefined
  let last: Delimiter | undefined
  for (const piece of pieces) {
    if (!('run' in piece)) continue
    const run = piece.run
    run.index = last ? last.index + 1 : 0
    run.prev = last
    if (last) last.next = run
    else first = run
    last = run
  }
  pairRuns(first)

  // Markdown pairs nest, so a count per style tells what applies; a style mark
  // counts apart, so a stray closing tag cannot end a markdown pair.
  const fromRuns: Record<StyleName, number> = { bold: 0, italics: 0, strike: 0 }
  const fromMarks: Record<StyleName, number> = { bold: 0, italics: 0, strike: 0 }
  const style = (): SpanStyle => {
    const on = (name: StyleName) => fromRuns[name] + fromMarks[name] > 0
    return {
      ...(on('bold') ? { bold: true } : {}),
      ...(on('italics') ? { italics: true } : {}),
      ...(on('strike') ? { strike: true } : {}),
    }
  }
  const spans: InlineSpan[] = []
  for (const piece of pieces) {
    if ('text' in piece) {
      spans.push({ ...style(), text: decodeEntities(piece.text) })
    } else if ('span' in piece) {
      spans.push({ ...style(), ...piece.span })
    } else if ('mark' in piece) {
      fromMarks[piece.mark] = Math.max(0, fromMarks[piece.mark] + (piece.open ? 1 : -1))
    } else {
      const run = piece.run
      for (const name of run.closes) fromRuns[name]--
      if (run.left > 0) spans.push({ ...style(), text: run.char.repeat(run.left) })
      for (const name of run.opens) fromRuns[name]++
    }
  }
  // An escape or an empty marker pair splits text that prints as one run.
  const joined: InlineSpan[] = []
  for (const span of spans) {
    const last = joined[joined.length - 1]
    if (last && joins(last, span)) last.text += span.text
    else joined.push(span)
  }
  return joined
}

/** The spans of one block of inline markdown that may carry HTML. */
export function inlineSpans(text: string): InlineSpan[] {
  return markdownSpans(htmlToMarkdownInline(text))
}
