import type { Element, Root, RootContent, Text } from 'hast'
import { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { externalUrlToOpen } from '../../../src/externalUrl'
import type { AgentChatMessage } from '../uiTypes'
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

function normalizeChildren<T extends RootContent>(children: T[]): T[] {
  return children.flatMap(child => {
    if (child.type === 'raw') return [{ type: 'text', value: child.value } as T]
    normalizeTree(child)
    if (child.type !== 'element' || child.tagName !== 'a') return [child]
    const href = canonicalChatLinkHref(child.properties.href)
    if (href === null) return child.children as T[]
    child.properties.href = href
    // The author-supplied title would otherwise be a tooltip that lies about the target.
    child.properties.title = href
    return [child]
  })
}

function normalizeTree(node: RootContent | Root): void {
  if ('children' in node) {
    node.children = normalizeChildren<RootContent>(node.children) as typeof node.children
  }
  if (node.type === 'element') {
    for (const property of URL_PROPERTIES) {
      if (node.tagName === 'a' && property === 'href') continue
      if (Object.hasOwn(node.properties, property)) {
        node.properties[property] = defaultUrlTransform(String(node.properties[property] || ''))
      }
    }
  }
}

function freezeTree(node: RootContent | Root): void {
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

export function buildChatMessageSemanticModel(message: AgentChatMessage): ChatMessageSemanticModel {
  const representation =
    message.role === 'assistant' && !message.isError && !looksLikeJson(message.content)
      ? 'markdown'
      : 'plain'
  const displayed =
    representation === 'plain' && message.role === 'user'
      ? parseChatMessageDisplay(message.content).content
      : message.content
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
  const tree =
    representation === 'markdown'
      ? (processor.runSync(processor.parse(displayed)) as Root)
      : plainTree(displayed)
  normalizeTree(tree)
  const { fragments, flows } = indexTree(tree)
  freezeTree(tree)
  return Object.freeze({
    messageId: message.id,
    contentRevision: displayed,
    representation,
    hasMermaidDiagram: representation === 'markdown' && containsMermaidDiagram(tree),
    renderTree: tree,
    searchText: flows.map(flow => flow.text).join('\u0000'),
    fragments: Object.freeze(fragments.map(fragment => Object.freeze(fragment))),
    flows: Object.freeze(flows.map(flow => Object.freeze(flow))),
  })
}

export function buildLoadedChatSemanticModels(
  messages: readonly AgentChatMessage[]
): readonly ChatMessageSemanticModel[] {
  return messages.map(buildChatMessageSemanticModel)
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
