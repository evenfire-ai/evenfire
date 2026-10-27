import type { Element, Root, RootContent, Text } from 'hast'
import { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import type { AgentChatMessage } from '../uiTypes'
import { parseChatMessageDisplay } from './chatMessageAttachments'
import { looksLikeJson } from './format'
import { parseGfsResourceLink } from './gfsResourceLinks'

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

type PositionedNode = RootContent & { position?: RootContent['position'] }

function relativePosition(
  start: NonNullable<PositionedNode['position']>['start'],
  text: string,
  offset: number
): NonNullable<PositionedNode['position']>['start'] {
  const before = text.slice(0, offset)
  const lineBreaks = before.match(/\n/g)?.length ?? 0
  const lastLineBreak = before.lastIndexOf('\n')
  return {
    line: start.line + lineBreaks,
    column: lineBreaks === 0 ? start.column + offset : before.length - lastLineBreak,
    offset: (start.offset ?? 0) + offset,
  }
}

const RAW_RESOURCE_LINK =
  /(?:gfs:\/\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?\/[0-9a-f]{32}|evenfire:\/\/files\?[^\s<>"'`]+)/gi
const TRAILING_LINK_PUNCTUATION = /[.,!?;:]+$/

function linkifyBareGfsLinks(node: RootContent, source: string): RootContent[] {
  if (node.type !== 'text' || !node.position || node.position.start.offset === undefined) {
    return [node]
  }
  const matches = [...node.value.matchAll(RAW_RESOURCE_LINK)]
  if (!matches.length) return [node]

  const result: RootContent[] = []
  let cursor = 0
  for (const match of matches) {
    const rawMatch = match[0]
    const matchIndex = match.index
    const token = rawMatch.replace(TRAILING_LINK_PUNCTUATION, '')
    const trailing = rawMatch.slice(token.length)
    const canonicalUri = parseGfsResourceLink(token)
    if (!canonicalUri || !token || matchIndex === undefined) continue

    const startOffset = node.position.start.offset + matchIndex
    const endOffset = startOffset + token.length
    if (source.slice(startOffset, endOffset) !== token) continue

    if (matchIndex > cursor) {
      result.push({
        type: 'text',
        value: node.value.slice(cursor, matchIndex),
        position: {
          start: relativePosition(node.position.start, node.value, cursor),
          end: relativePosition(node.position.start, node.value, matchIndex),
        },
      })
    }

    const start = relativePosition(node.position.start, node.value, matchIndex)
    const end = relativePosition(node.position.start, node.value, matchIndex + token.length)
    result.push({
      type: 'element',
      tagName: 'a',
      properties: {},
      data: { originalHref: token, canonicalGfsUri: canonicalUri } as Element['data'],
      children: [{ type: 'text', value: token, position: { start, end } }],
      position: { start, end },
    })
    cursor = matchIndex + token.length + trailing.length
    if (trailing) {
      const punctuationStart = relativePosition(
        node.position.start,
        node.value,
        matchIndex + token.length
      )
      const punctuationEnd = relativePosition(
        node.position.start,
        node.value,
        matchIndex + rawMatch.length
      )
      result.push({
        type: 'text',
        value: trailing,
        position: { start: punctuationStart, end: punctuationEnd },
      })
    }
  }

  if (!result.length) return [node]
  if (cursor < node.value.length) {
    result.push({
      type: 'text',
      value: node.value.slice(cursor),
      position: {
        start: relativePosition(node.position.start, node.value, cursor),
        end: node.position.end,
      },
    })
  }
  return result
}

function normalizeTree(node: RootContent | Root, source: string, insideCode = false): void {
  if ('children' in node) {
    const codeContext =
      insideCode || (node.type === 'element' && ['code', 'pre'].includes(node.tagName))
    node.children = node.children.flatMap(child => {
      if (child.type === 'raw') return { type: 'text', value: child.value }
      const normalizedChildren =
        !codeContext && node.type === 'element' && node.tagName !== 'a'
          ? linkifyBareGfsLinks(child, source)
          : [child]
      normalizedChildren.forEach(normalizedChild =>
        normalizeTree(normalizedChild, source, codeContext)
      )
      return normalizedChildren
    }) as typeof node.children
  }
  if (node.type === 'element') {
    if (Object.hasOwn(node.properties, 'href')) {
      const rawHref = String(node.properties.href || '')
      const originalHref = (node.data as Record<string, unknown> | undefined)?.originalHref
      node.data = {
        ...(node.data ?? {}),
        originalHref: typeof originalHref === 'string' ? originalHref : rawHref,
      } as Element['data']
      const transformed = defaultUrlTransform(rawHref)
      let safeExternalHref = ''
      try {
        const url = new URL(transformed)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
          safeExternalHref = url.toString()
        }
      } catch {
        safeExternalHref = ''
      }
      node.properties.href = safeExternalHref || undefined
    }
    for (const property of URL_PROPERTIES) {
      if (property !== 'href' && Object.hasOwn(node.properties, property)) {
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
  if (node.data) Object.freeze(node.data)
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

function buildSemanticModel(
  displayed: string,
  messageId: string,
  representation: 'markdown' | 'plain'
): ChatMessageSemanticModel {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
  const tree =
    representation === 'markdown'
      ? (processor.runSync(processor.parse(displayed)) as Root)
      : plainTree(displayed)
  normalizeTree(tree, displayed)
  const { fragments, flows } = indexTree(tree)
  freezeTree(tree)
  return Object.freeze({
    messageId,
    contentRevision: displayed,
    representation,
    renderTree: tree,
    searchText: flows.map(flow => flow.text).join('\u0000'),
    fragments: Object.freeze(fragments.map(fragment => Object.freeze(fragment))),
    flows: Object.freeze(flows.map(flow => Object.freeze(flow))),
  })
}

export function buildChatMessageSemanticModel(message: AgentChatMessage): ChatMessageSemanticModel {
  const representation =
    !message.isError && !(message.role === 'assistant' && looksLikeJson(message.content))
      ? 'markdown'
      : 'plain'
  const displayed =
    message.role === 'user' ? parseChatMessageDisplay(message.content).content : message.content
  return buildSemanticModel(displayed, message.id, representation)
}

export function buildComposerMarkdownSemanticModel(content: string): ChatMessageSemanticModel {
  return buildSemanticModel(content, 'composer-preview', 'markdown')
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

/**
 * Reapply the semantic index to the Markdown library's sanitized HAST tree.
 * Source positions keep search marks and bare GFS links aligned without
 * replacing the library's renderer or its safety pipeline.
 */
export function createChatSemanticRehypePlugin(
  model: ChatMessageSemanticModel,
  query: string,
  activeOccurrence: number | null
): () => (tree: Root) => void {
  const fragmentBySourceRange = new Map<string, string>()
  const unpositionedFragmentsByText = new Map<string, string[]>()
  const bareLinks: Array<{ start: number; end: number; uri: string }> = []
  const indexModel = (node: RootContent | Root) => {
    if (node.type === 'text') {
      const fragmentId = (node as SemanticText).searchFragmentId
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (fragmentId && start !== undefined && end !== undefined) {
        fragmentBySourceRange.set(`${start}:${end}:${node.value}`, fragmentId)
      } else if (fragmentId) {
        const fragments = unpositionedFragmentsByText.get(node.value) ?? []
        fragments.push(fragmentId)
        unpositionedFragmentsByText.set(node.value, fragments)
      }
      return
    }
    if (node.type === 'element' && node.tagName === 'a') {
      const data = node.data as Record<string, unknown> | undefined
      const uri = data?.canonicalGfsUri
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (typeof uri === 'string' && start !== undefined && end !== undefined) {
        bareLinks.push({ start, end, uri })
      }
    }
    if ('children' in node) node.children.forEach(indexModel)
  }
  indexModel(model.renderTree)

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

  const insertBareLinks = (node: RootContent | Root, insideAnchor = false): void => {
    if (!('children' in node)) return
    const isAnchor = insideAnchor || (node.type === 'element' && node.tagName === 'a')
    const nextChildren: RootContent[] = []
    for (const child of node.children) {
      const start = child.position?.start.offset
      const end = child.position?.end.offset
      const matches =
        !isAnchor && child.type === 'text' && start !== undefined && end !== undefined
          ? bareLinks
              .filter(link => link.start >= start && link.end <= end)
              .sort((left, right) => left.start - right.start)
          : []
      if (!matches.length || child.type !== 'text' || start === undefined || end === undefined) {
        insertBareLinks(child, isAnchor)
        nextChildren.push(child)
        continue
      }

      let offset = 0
      for (const link of matches) {
        const localStart = link.start - start
        const localEnd = link.end - start
        const rawTarget = child.value.slice(localStart, localEnd)
        if (localStart < offset || !rawTarget || parseGfsResourceLink(rawTarget) !== link.uri) {
          continue
        }
        if (localStart > offset) {
          nextChildren.push({
            type: 'text',
            value: child.value.slice(offset, localStart),
            position: {
              start: relativePosition(child.position!.start, child.value, offset),
              end: relativePosition(child.position!.start, child.value, localStart),
            },
          })
        }
        const linkStart = relativePosition(child.position!.start, child.value, localStart)
        const linkEnd = relativePosition(child.position!.start, child.value, localEnd)
        nextChildren.push({
          type: 'element',
          tagName: 'a',
          properties: { href: rawTarget },
          data: { originalHref: rawTarget, canonicalGfsUri: link.uri } as Element['data'],
          children: [
            { type: 'text', value: rawTarget, position: { start: linkStart, end: linkEnd } },
          ],
          position: { start: linkStart, end: linkEnd },
        })
        offset = localEnd
      }
      if (offset < child.value.length) {
        nextChildren.push({
          type: 'text',
          value: child.value.slice(offset),
          position: {
            start: relativePosition(child.position!.start, child.value, offset),
            end: child.position!.end,
          },
        })
      }
    }
    node.children = nextChildren as typeof node.children
  }

  const annotateSearch = (
    node: RootContent | Root,
    fallbackFragmentIndexesByText: Map<string, number>
  ): void => {
    if (!('children' in node)) return
    const nextChildren: RootContent[] = []
    for (const child of node.children) {
      if (child.type === 'text') {
        const start = child.position?.start.offset
        const end = child.position?.end.offset
        const fragmentId =
          start !== undefined && end !== undefined
            ? fragmentBySourceRange.get(`${start}:${end}:${child.value}`)
            : undefined
        const fallbackFragments = unpositionedFragmentsByText.get(child.value)
        const fallbackIndex = fallbackFragmentIndexesByText.get(child.value) ?? 0
        const fallbackFragmentId = fragmentId ?? fallbackFragments?.[fallbackIndex]
        if (!fragmentId && fallbackFragmentId) {
          fallbackFragmentIndexesByText.set(child.value, fallbackIndex + 1)
        }
        const ranges = fallbackFragmentId ? rangesByFragment.get(fallbackFragmentId) : undefined
        if (ranges?.length) {
          let offset = 0
          const markedChildren: Element['children'] = []
          for (const range of ranges) {
            if (range.start > offset) {
              markedChildren.push({
                type: 'text',
                value: child.value.slice(offset, range.start),
              })
            }
            markedChildren.push({
              type: 'element',
              tagName: 'mark',
              properties: markProperties(range.match, activeOccurrence),
              children: [{ type: 'text', value: child.value.slice(range.start, range.end) }],
            })
            offset = range.end
          }
          if (offset < child.value.length) {
            markedChildren.push({ type: 'text', value: child.value.slice(offset) })
          }
          nextChildren.push({
            type: 'element',
            tagName: 'span',
            properties: {},
            children: markedChildren,
          })
          continue
        }
      }
      annotateSearch(child, fallbackFragmentIndexesByText)
      nextChildren.push(child)
    }
    node.children = nextChildren as typeof node.children
  }

  return () => tree => {
    insertBareLinks(tree)
    annotateSearch(tree, new Map())
  }
}
