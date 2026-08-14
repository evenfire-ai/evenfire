import { type ReactNode, createElement } from 'react'
import type { AgentChatMessage } from '../uiTypes'
import { parseChatMessageDisplay } from './chatMessageAttachments'

export type ChatLocalMatch = {
  messageId: string
  occurrence: number
}

export function chatMessageDomId(messageId: string): string {
  return `chat-message-${encodeURIComponent(messageId)}`
}

export function findLoadedChatMessageMatches(
  messages: AgentChatMessage[],
  query: string
): ChatLocalMatch[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const matches: ChatLocalMatch[] = []
  for (const message of messages) {
    const displayed =
      message.role === 'user'
        ? (parseChatMessageDisplay(message.content)?.content ?? message.content)
        : message.content
    const haystack = displayed.toLocaleLowerCase()
    let offset = 0
    let occurrence = 0
    while (offset <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, offset)
      if (index < 0) break
      matches.push({ messageId: message.id, occurrence })
      occurrence += 1
      offset = index + Math.max(1, needle.length)
    }
  }
  return matches
}

export function wrapMatchIndex(index: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return 0
  return (index + delta + total) % total
}

type SearchTextPart = { text: string; occurrence: number | null }

function splitSearchText(value: string, query: string, occurrenceStart = 0): SearchTextPart[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [{ text: value, occurrence: null }]
  const lowerValue = value.toLocaleLowerCase()
  const parts: SearchTextPart[] = []
  let offset = 0
  let occurrence = occurrenceStart
  while (offset <= lowerValue.length - needle.length) {
    const index = lowerValue.indexOf(needle, offset)
    if (index < 0) break
    if (index > offset) parts.push({ text: value.slice(offset, index), occurrence: null })
    parts.push({ text: value.slice(index, index + needle.length), occurrence })
    occurrence += 1
    offset = index + needle.length
  }
  if (offset < value.length) parts.push({ text: value.slice(offset), occurrence: null })
  return parts.length ? parts : [{ text: value, occurrence: null }]
}

function searchMarkProperties(occurrence: number, activeOccurrence: number | null) {
  const active = occurrence === activeOccurrence
  return {
    className: active ? 'chat-search-match chat-search-match--active' : 'chat-search-match',
    'data-testid': active ? 'chat-search-current-match' : 'chat-search-match',
    ...(active ? { 'data-current-search-match': 'true' } : {}),
  }
}

export function highlightChatText(
  value: string,
  query: string,
  activeOccurrence: number | null
): ReactNode {
  return splitSearchText(value, query).map((part, index) =>
    part.occurrence === null
      ? part.text
      : createElement(
          'mark',
          {
            key: `${part.occurrence}-${index}`,
            ...searchMarkProperties(part.occurrence, activeOccurrence),
          },
          part.text
        )
  )
}

type HastNode = {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** Declaratively marks rendered Markdown text nodes without parsing or injecting raw HTML. */
export function createChatSearchRehypePlugin(query: string, activeOccurrence: number | null) {
  return () => (tree: HastNode) => {
    let occurrence = 0
    const visit = (node: HastNode) => {
      if (!node.children) return
      const nextChildren: HastNode[] = []
      for (const child of node.children) {
        if (child.type !== 'text' || typeof child.value !== 'string') {
          visit(child)
          nextChildren.push(child)
          continue
        }
        const parts = splitSearchText(child.value, query, occurrence)
        for (const part of parts) {
          if (part.occurrence === null) {
            if (part.text) nextChildren.push({ type: 'text', value: part.text })
            continue
          }
          occurrence = part.occurrence + 1
          nextChildren.push({
            type: 'element',
            tagName: 'mark',
            properties: searchMarkProperties(part.occurrence, activeOccurrence),
            children: [{ type: 'text', value: part.text }],
          })
        }
      }
      node.children = nextChildren
    }
    visit(tree)
  }
}
