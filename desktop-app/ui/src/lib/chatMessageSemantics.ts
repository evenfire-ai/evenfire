import type { Element, Root, RootContent, Text } from 'hast'
import type { RootContent as MdastContent, Root as MdastRoot } from 'mdast'
import { defaultUrlTransform } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import {
  CHAT_GFS_IMAGE_MAX_PER_MESSAGE,
  CHAT_LINKED_FILE_PREVIEW_LIMIT,
  CHAT_MATH_MAX_CONTENT_DEPTH,
  CHAT_MATH_MAX_PER_MESSAGE,
  CHAT_MATH_MAX_SOURCE_PER_MESSAGE,
  CHAT_TABLE_MAX_CELLS,
} from '@constants/chatRendering'
import { externalUrlToOpen } from '../../../src/externalUrl'
import type { AgentChatMessage } from '../uiTypes'
import { rehypeChatCode } from './chatCodeHighlight'
import { chatFilePreviewKind } from './chatFilePreview'
import {
  chatImageNode,
  codeBlockLanguage,
  isMathCode,
  markStandaloneMath,
  pairInlineHtml,
} from './chatMarkdownTransforms'
import { mathBlockClose } from './chatMathBlocks'
import { type ChatMathSource, remarkChatMath } from './chatMathSyntax'
import { parseChatMessageDisplay } from './chatMessageAttachments'
import { looksLikeJson } from './format'
import { EXTERNAL_LINK_SCHEMES, urlScheme } from './urlScheme'

type SemanticText = Text & { searchFragmentId?: string }

export type ChatSemanticFragment = Readonly<{
  id: string
  flowId: number
  start: number
  end: number
  text: string
}>

export type ChatMessageSemanticModel = Readonly<{
  messageId: string
  contentRevision: string
  representation: 'markdown' | 'plain'
  /** The Markdown holds a fenced `mermaid` block the chat draws as a diagram. */
  hasMermaidDiagram: boolean
  /** EvenDrive files linked by the reply that the chat can preview. */
  linkedFiles: readonly Readonly<{ uri: string; name: string }>[]
  renderTree: Root
  searchText: string
  fragments: readonly ChatSemanticFragment[]
  flows: readonly Readonly<{ id: number; text: string }>[]
}>

export type ChatSemanticMatch = Readonly<{
  id: string
  messageId: string
  occurrence: number
  ranges: readonly Readonly<{ fragmentId: string; start: number; end: number }>[]
}>

const FLOW_BOUNDARIES = new Set([
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
  'pre',
  'td',
  'th',
])
const URL_PROPERTIES = new Set(['href', 'src'])
const MERMAID_LANGUAGE_CLASS = 'language-mermaid'

function textOf(node: RootContent | Root): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

/**
 * The code of a fenced `mermaid` block, which Markdown renders as
 * `pre > code.language-mermaid`, or null for any other element and an empty
 * block. Search highlights wrap the text in spans but leave it unchanged.
 */
export function mermaidSourceOf(node: Element): string | null {
  if (node.tagName !== 'pre') return null
  const elements = node.children.filter((child): child is Element => child.type === 'element')
  const code = elements.length === 1 ? elements[0] : undefined
  if (!code || code.tagName !== 'code') return null
  const className = code.properties.className
  const classes = Array.isArray(className) ? className.map(String) : []
  if (!classes.some(name => name.toLowerCase() === MERMAID_LANGUAGE_CLASS)) return null
  const source = textOf(code).replace(/\n$/, '')
  return source.trim() ? source : null
}

/** The LaTeX of a formula block, or null for any other element. */
export function mathSourceOf(node: Element): string | null {
  if (node.tagName !== 'pre') return null
  const elements = node.children.filter((child): child is Element => child.type === 'element')
  const code = elements.length === 1 ? elements[0] : undefined
  if (!code || !isMathCode(code)) return null
  const source = textOf(code).trim()
  return source ? source : null
}

export function elementText(node: Element): string {
  return textOf(node)
}

/** Whether a search highlight (`<mark>`) sits anywhere inside the element. */
export function containsSearchMark(node: Element): boolean {
  return node.children.some(
    child => child.type === 'element' && (child.tagName === 'mark' || containsSearchMark(child))
  )
}

function containsMermaidDiagram(node: RootContent | Root): boolean {
  if (node.type === 'element' && mermaidSourceOf(node) !== null) return true
  return 'children' in node && node.children.some(containsMermaidDiagram)
}

export function countElements(node: RootContent | Root): number {
  let count = 0
  const pending: Array<RootContent | Root> = [node]
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (next.type === 'element') count += 1
    if ('children' in next) for (const child of next.children) pending.push(child)
  }
  return count
}

function linkedFilesOf(tree: Root): Array<{ uri: string; name: string }> {
  const files: Array<{ uri: string; name: string }> = []
  const seen = new Set<string>()
  const visit = (node: RootContent | Root) => {
    if (files.length >= CHAT_LINKED_FILE_PREVIEW_LIMIT) return
    if (node.type === 'element' && node.tagName === 'a') {
      const href = String(node.properties.href ?? '')
      const name = textOf(node).trim()
      if (urlScheme(href) === 'gfs' && !seen.has(href) && chatFilePreviewKind(name)) {
        seen.add(href)
        files.push({ uri: href, name })
      }
      return
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(tree)
  return files
}

/**
 * The only link targets a chat message may carry, in the exact form the click
 * handler hands on. Anything else is rendered as plain text instead: relative
 * paths and `href=""` would navigate the app's own document and reload it,
 * dropping every open tab, and `#` fragments (such as GFM footnotes) would
 * scroll the whole app shell rather than the message.
 */
export function canonicalChatLinkHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const scheme = urlScheme(raw)
  if (scheme === 'gfs') return normalizeGfsResourceUri(raw)
  if (scheme === null || !EXTERNAL_LINK_SCHEMES.has(scheme)) return null
  if (scheme === 'http' || scheme === 'https') {
    try {
      const url = new URL(raw)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
    } catch {
      return null
    }
  }
  if (scheme === 'mailto') {
    try {
      return externalUrlToOpen(raw)
    } catch {
      // `app:openUrl` would refuse this target, so it must not render as a link.
      return null
    }
  }
  return null
}

function normalizeChildren<T extends RootContent>(children: T[], inLink: boolean): T[] {
  return (pairInlineHtml(children) as T[]).flatMap(child => {
    if (child.type === 'raw') return [{ type: 'text', value: child.value } as T]
    if (child.type === 'element' && child.tagName === 'img') {
      // Links cannot nest.
      return chatImageNode(child, inLink ? () => null : canonicalChatLinkHref) as T[]
    }
    normalizeTree(child, inLink || (child.type === 'element' && child.tagName === 'a'))
    if (child.type !== 'element' || child.tagName !== 'a') return [child]
    const href = canonicalChatLinkHref(child.properties.href)
    if (href === null) return child.children as T[]
    child.properties.href = href
    // The author-supplied title would otherwise be a tooltip that lies about the target.
    child.properties.title = href
    return [child]
  })
}

function normalizeTree(node: RootContent | Root, inLink = false): void {
  if ('children' in node) {
    node.children = normalizeChildren<RootContent>(node.children, inLink) as typeof node.children
  }
  if (node.type === 'element') {
    for (const property of URL_PROPERTIES) {
      if (node.tagName === 'a' && property === 'href') continue
      if (Object.hasOwn(node.properties, property)) {
        node.properties[property] = defaultUrlTransform(String(node.properties[property] || ''))
      }
    }
    if (node.tagName === 'p') markStandaloneMath(node)
    else if (node.tagName === 'pre') {
      const language = codeBlockLanguage(node)
      if (language) node.properties.dataLanguage = language
    }
  }
}

function freezeTree(node: RootContent | Root): void {
  // Models are retained and positions are only needed while parsing.
  delete node.position
  if ('children' in node) {
    node.children.forEach(freezeTree)
    Object.freeze(node.children)
  }
  if (node.type === 'element') Object.freeze(node.properties)
  Object.freeze(node)
}

function indexTree(tree: Root): {
  fragments: ChatSemanticFragment[]
  flows: Array<{ id: number; text: string }>
} {
  const fragments: ChatSemanticFragment[] = []
  const flows: Array<{ id: number; text: string }> = []
  let currentFlow: { id: number; text: string } | null = null
  let nextFlowId = 0
  const ensureFlow = () => {
    if (!currentFlow) {
      currentFlow = { id: nextFlowId++, text: '' }
      flows.push(currentFlow)
    }
    return currentFlow
  }
  const visit = (node: RootContent | Root, startsFlow: boolean) => {
    if (node.type === 'element' && (FLOW_BOUNDARIES.has(node.tagName) || node.tagName === 'br')) {
      currentFlow = null
      startsFlow = true
    }
    if (node.type === 'text' && node.value) {
      const flow = ensureFlow()
      const id = `${flow.id}:${fragments.length}`
      const start = flow.text.length
      flow.text += node.value
      ;(node as SemanticText).searchFragmentId = id
      fragments.push({ id, flowId: flow.id, start, end: flow.text.length, text: node.value })
    } else if ('children' in node) {
      node.children.forEach(child => visit(child, false))
    }
    if (startsFlow) currentFlow = null
  }
  tree.children.forEach(child => visit(child, true))
  return { fragments, flows }
}

function plainTree(value: string): Root {
  return { type: 'root', children: [{ type: 'text', value }] }
}

function unreadMarkdownTree(value: string): Root {
  const paragraph: Element = {
    type: 'element',
    tagName: 'p',
    properties: { className: ['chat-md-plain'] },
    children: [{ type: 'text', value }],
  }
  return { type: 'root', children: [paragraph] }
}

/** GFM pads every row to the widest, so a short text can expand into millions of cells. */
function remarkTableLimit() {
  return (tree: MdastRoot) => {
    let cells = 0
    const visit = (node: MdastRoot | MdastContent) => {
      if (node.type === 'table') {
        cells += node.children.length * (node.align?.length ?? 0)
        if (cells > CHAT_TABLE_MAX_CELLS) throw new Error('The tables are too large to show')
      } else if ('children' in node) {
        node.children.forEach(visit)
      }
    }
    visit(tree)
  }
}

/** Replies keep single line breaks; Markdown files follow CommonMark. */
function markdownReader(softBreaks: boolean) {
  const math: ChatMathSource = { text: '' }
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkChatMath, math)
  if (softBreaks) processor.use(remarkBreaks)
  return {
    math,
    processor: processor
      .use(remarkTableLimit)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeChatCode)
      .freeze(),
  }
}

type MarkdownReader = ReturnType<typeof markdownReader>

const chatReplyReader = markdownReader(true)
const markdownDocumentReader = markdownReader(false)

/** Whether a list item or quote ends a math block before its closing delimiter. */
function cutsMathBlock(node: MdastRoot | MdastContent, source: string): boolean {
  if (node.type === 'math' && node.position) {
    const close = mathBlockClose(source, node.position.start.offset ?? 0)
    return !close || (node.position.end.offset ?? 0) < close.end
  }
  return 'children' in node && node.children.some(child => cutsMathBlock(child, source))
}

/** If a container cuts a math block short, parses again without math blocks. */
function parseMarkdown({ math, processor }: MarkdownReader, source: string): Root {
  // The parser drops the BOM, which would shift every offset.
  const text = source.replace(/^\ufeff/, '')
  try {
    math.text = text
    let mdast = processor.parse(text)
    if (cutsMathBlock(mdast, text)) {
      math.text = ''
      mdast = processor.parse(text)
    }
    return processor.runSync(mdast) as Root
  } finally {
    math.text = ''
  }
}

/** Formulas past the budget, or nested too deep to lay out safely, stay as code. */
function limitMath(tree: Root): void {
  let count = 0
  let characters = 0
  const visit = (node: RootContent | Root, depth: number) => {
    if (node.type === 'element' && isMathCode(node)) {
      count += 1
      characters += textOf(node).length
      if (
        count > CHAT_MATH_MAX_PER_MESSAGE ||
        characters > CHAT_MATH_MAX_SOURCE_PER_MESSAGE ||
        depth > CHAT_MATH_MAX_CONTENT_DEPTH
      ) {
        node.properties.className = ['language-math-over-budget']
      }
      return
    }
    if ('children' in node) node.children.forEach(child => visit(child, depth + 1))
  }
  visit(tree, 0)
}

/** Images past the limit become links, so one reply cannot start unbounded downloads. */
function limitGfsImages(tree: Root): void {
  let count = 0
  const visit = (node: RootContent | Root, inLink: boolean) => {
    if (!('children' in node)) return
    const children = node.children as RootContent[]
    children.forEach((child, index) => {
      if (child.type !== 'element') return
      const uri = child.tagName === 'img' ? child.properties.dataGfsSrc : undefined
      if (typeof uri !== 'string') {
        visit(child, inLink || child.tagName === 'a')
        return
      }
      count += 1
      if (count <= CHAT_GFS_IMAGE_MAX_PER_MESSAGE) return
      const text: Text = { type: 'text', value: String(child.properties.alt ?? '') || 'Image' }
      children[index] = inLink
        ? text
        : {
            type: 'element',
            tagName: 'a',
            properties: { href: uri, title: uri },
            children: [text],
          }
    })
  }
  visit(tree, false)
}

function buildSemanticModel(
  id: string,
  displayed: string,
  representation: 'markdown' | 'plain',
  reader: MarkdownReader
): ChatMessageSemanticModel {
  if (representation === 'plain') return buildModelOf(id, displayed, 'plain', plainTree(displayed))
  try {
    return buildModelOf(id, displayed, 'markdown', parseMarkdown(reader, displayed))
  } catch {
    // Nesting deep enough to exhaust the stack must not break the whole chat.
    return buildModelOf(id, displayed, 'plain', unreadMarkdownTree(displayed))
  }
}

function buildModelOf(
  id: string,
  displayed: string,
  representation: 'markdown' | 'plain',
  tree: Root
): ChatMessageSemanticModel {
  const markdown = representation === 'markdown'
  normalizeTree(tree)
  if (markdown) {
    limitMath(tree)
    limitGfsImages(tree)
  }
  const { fragments, flows } = indexTree(tree)
  const linkedFiles = markdown ? linkedFilesOf(tree) : []
  freezeTree(tree)
  return Object.freeze({
    messageId: id,
    contentRevision: displayed,
    representation,
    hasMermaidDiagram: markdown && containsMermaidDiagram(tree),
    linkedFiles: Object.freeze(linkedFiles.map(file => Object.freeze(file))),
    renderTree: tree,
    searchText: flows.map(flow => flow.text).join('\u0000'),
    fragments: Object.freeze(fragments.map(fragment => Object.freeze(fragment))),
    flows: Object.freeze(flows.map(flow => Object.freeze(flow))),
  })
}

export function buildChatMessageSemanticModel(message: AgentChatMessage): ChatMessageSemanticModel {
  const representation =
    message.role === 'assistant' && !message.isError && !looksLikeJson(message.content)
      ? 'markdown'
      : 'plain'
  const displayed =
    representation === 'plain' && message.role === 'user'
      ? parseChatMessageDisplay(message.content).content
      : message.content
  return buildSemanticModel(message.id, displayed, representation, chatReplyReader)
}

export function buildMarkdownDocumentModel(id: string, markdown: string): ChatMessageSemanticModel {
  return buildSemanticModel(id, markdown, 'markdown', markdownDocumentReader)
}

let loadedModels = new Map<string, ChatMessageSemanticModel>()

/** The transcript is rebuilt on every update, so unchanged messages reuse their frozen model. */
export function buildLoadedChatSemanticModels(
  messages: readonly AgentChatMessage[]
): readonly ChatMessageSemanticModel[] {
  const kept = new Map<string, ChatMessageSemanticModel>()
  const models = messages.map(message => {
    const key = `${message.id}\u0000${message.role}\u0000${message.isError ? 1 : 0}\u0000${message.content}`
    const model = kept.get(key) ?? loadedModels.get(key) ?? buildChatMessageSemanticModel(message)
    kept.set(key, model)
    return model
  })
  loadedModels = kept
  return models
}

function foldWithOffsets(value: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of value) {
    const end = offset + character.length
    const lower = character.toLocaleLowerCase()
    folded += lower
    for (let index = 0; index < lower.length; index += 1) {
      starts.push(offset)
      ends.push(end)
    }
    offset = end
  }
  return { folded, starts, ends }
}

export function findChatSemanticMatches(
  model: ChatMessageSemanticModel,
  query: string
): readonly ChatSemanticMatch[] {
  const needle = foldWithOffsets(query.trim()).folded
  if (!needle) return []
  const matches: ChatSemanticMatch[] = []
  const fragmentsByFlow = new Map<number, ChatSemanticFragment[]>()
  for (const fragment of model.fragments) {
    const fragments = fragmentsByFlow.get(fragment.flowId) ?? []
    fragments.push(fragment)
    fragmentsByFlow.set(fragment.flowId, fragments)
  }
  let occurrence = 0
  for (const flow of model.flows) {
    const folded = foldWithOffsets(flow.text)
    const flowFragments = fragmentsByFlow.get(flow.id) ?? []
    let fragmentCursor = 0
    let offset = 0
    while (offset <= folded.folded.length - needle.length) {
      const index = folded.folded.indexOf(needle, offset)
      if (index < 0) break
      const start = folded.starts[index]!
      const end = folded.ends[index + needle.length - 1]!
      while (fragmentCursor < flowFragments.length && flowFragments[fragmentCursor]!.end <= start)
        fragmentCursor += 1
      const ranges: Array<{ fragmentId: string; start: number; end: number }> = []
      for (
        let fragmentIndex = fragmentCursor;
        fragmentIndex < flowFragments.length;
        fragmentIndex += 1
      ) {
        const fragment = flowFragments[fragmentIndex]!
        if (fragment.start >= end) break
        const range = {
          fragmentId: fragment.id,
          start: Math.max(0, start - fragment.start),
          end: Math.min(fragment.text.length, end - fragment.start),
        }
        if (range.end > range.start) ranges.push(range)
      }
      if (ranges.length) {
        matches.push(
          Object.freeze({
            id: `${model.messageId}:${flow.id}:${start}:${end}`,
            messageId: model.messageId,
            occurrence,
            ranges: Object.freeze(ranges.map(range => Object.freeze(range))),
          })
        )
        occurrence += 1
      }
      offset = index + Math.max(1, needle.length)
    }
  }
  return Object.freeze(matches)
}

function markProperties(match: ChatSemanticMatch, activeOccurrence: number | null) {
  const active = match.occurrence === activeOccurrence
  return {
    className: active ? ['chat-search-match', 'chat-search-match--active'] : ['chat-search-match'],
    'data-chat-search-match-id': match.id,
    'data-testid': active ? 'chat-search-current-match' : 'chat-search-match',
    ...(active ? { 'data-current-search-match': 'true' } : {}),
  }
}

export function annotateChatSemanticTree(
  model: ChatMessageSemanticModel,
  query: string,
  activeOccurrence: number | null
): Root {
  const rangesByFragment = new Map<
    string,
    Array<{ match: ChatSemanticMatch; start: number; end: number }>
  >()
  for (const match of findChatSemanticMatches(model, query)) {
    for (const range of match.ranges) {
      const ranges = rangesByFragment.get(range.fragmentId) ?? []
      ranges.push({ match, start: range.start, end: range.end })
      rangesByFragment.set(range.fragmentId, ranges)
    }
  }
  const clone = (node: RootContent | Root): RootContent | Root => {
    if (node.type === 'text') {
      const fragmentId = (node as SemanticText).searchFragmentId
      const ranges = fragmentId ? rangesByFragment.get(fragmentId) : undefined
      if (!ranges?.length) return { type: 'text', value: node.value }
      const children: RootContent[] = []
      let offset = 0
      ranges.forEach(range => {
        if (range.start > offset)
          children.push({ type: 'text', value: node.value.slice(offset, range.start) })
        children.push({
          type: 'element',
          tagName: 'mark',
          properties: markProperties(range.match, activeOccurrence),
          children: [{ type: 'text', value: node.value.slice(range.start, range.end) }],
        })
        offset = range.end
      })
      if (offset < node.value.length)
        children.push({ type: 'text', value: node.value.slice(offset) })
      return { type: 'element', tagName: 'span', properties: {}, children } as Element
    }
    if ('children' in node) {
      return {
        ...node,
        ...(node.type === 'element' ? { properties: { ...node.properties } } : {}),
        children: node.children.map(clone),
      } as RootContent | Root
    }
    return { ...node }
  }
  return clone(model.renderTree) as Root
}
