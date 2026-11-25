import type { Element, ElementContent, RootContent, Text } from 'hast'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import {
  CHAT_CODE_PLAIN_LANGUAGES,
  CHAT_DATA_IMAGE_SRC,
  CHAT_INLINE_HTML_MAX_DEPTH,
  CHAT_INLINE_HTML_TAGS,
} from '@constants/chatRendering'
import { urlScheme } from './urlScheme'

const BARE_TAG = /^<(\/?)([a-z]+)\s*(\/?)>$/i

function classesOf(node: Element): string[] {
  const className = node.properties.className
  return Array.isArray(className) ? className.map(String) : []
}

function bareTag(value: string): { name: string; closing: boolean } | null {
  const match = BARE_TAG.exec(value.trim())
  const name = match?.[2]
  if (!name) return null
  return { name: name.toLowerCase(), closing: match[1] === '/' }
}

/** Allows a bare `<br>` and bare pairs of a few inline tags; any other raw HTML stays text. */
export function pairInlineHtml(children: RootContent[]): RootContent[] {
  const closeOf = new Map<number, number>()
  const opened = new Map<string, number[]>()
  children.forEach((child, index) => {
    if (child.type !== 'raw') return
    const tag = bareTag(child.value)
    if (!tag || !CHAT_INLINE_HTML_TAGS.has(tag.name)) return
    const stack = opened.get(tag.name) ?? []
    opened.set(tag.name, stack)
    if (!tag.closing) stack.push(index)
    else {
      const open = stack.pop()
      if (open !== undefined) closeOf.set(open, index)
    }
  })

  const result: RootContent[] = []
  const frames: Array<{ children: ElementContent[]; close: number }> = []
  const into = (node: RootContent) => {
    const frame = frames[frames.length - 1]
    if (frame) frame.children.push(node as ElementContent)
    else result.push(node)
  }
  children.forEach((child, index) => {
    const frame = frames[frames.length - 1]
    if (frame && index === frame.close) {
      frames.pop()
      return
    }
    if (child.type !== 'raw') {
      into(child)
      return
    }
    const tag = bareTag(child.value)
    if (tag?.name === 'br' && !tag.closing) {
      into({ type: 'element', tagName: 'br', properties: {}, children: [] })
      return
    }
    const close = closeOf.get(index)
    if (
      tag &&
      !tag.closing &&
      close !== undefined &&
      close < (frame?.close ?? Infinity) &&
      frames.length < CHAT_INLINE_HTML_MAX_DEPTH
    ) {
      const element: Element = {
        type: 'element',
        tagName: tag.name,
        // `<mark>` is also the search highlight.
        properties: tag.name === 'mark' ? { className: ['chat-md-mark'] } : {},
        children: [],
      }
      into(element)
      frames.push({ children: element.children, close })
      return
    }
    into({ type: 'text', value: child.value })
  })
  return result
}

export function isMathCode(node: Element): boolean {
  return node.tagName === 'code' && classesOf(node).includes('language-math')
}

export function isDisplayMathCode(node: Element): boolean {
  return classesOf(node).includes('math-display')
}

function isBreak(node: ElementContent | undefined): boolean {
  return node?.type === 'element' && node.tagName === 'br'
}

function lineEndsBefore(children: ElementContent[], index: number): boolean {
  for (let at = index - 1; at >= 0; at--) {
    const node = children[at]
    if (isBreak(node)) return true
    if (node?.type !== 'text') return false
    if (/\n[ \t]*$/.test(node.value)) return true
    if (node.value.trim()) return false
  }
  return true
}

function lineEndsAfter(children: ElementContent[], index: number): boolean {
  for (let at = index + 1; at < children.length; at++) {
    const node = children[at]
    if (isBreak(node)) return true
    if (node?.type !== 'text') return false
    if (/^[ \t]*\r?\n/.test(node.value)) return true
    if (node.value.trim()) return false
  }
  return true
}

/** A formula alone on its line renders as display math. */
export function markStandaloneMath(paragraph: Element): void {
  paragraph.children.forEach((child, index) => {
    if (child.type !== 'element' || !isMathCode(child) || isDisplayMathCode(child)) return
    if (!lineEndsBefore(paragraph.children, index) || !lineEndsAfter(paragraph.children, index))
      return
    child.properties.className = ['language-math', 'math-display']
  })
}

export function codeBlockLanguage(pre: Element): string | null {
  const code = pre.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code'
  )
  if (!code) return null
  const language = classesOf(code)
    .find(name => name.startsWith('language-'))
    ?.slice('language-'.length)
    .toLowerCase()
  if (!language || CHAT_CODE_PLAIN_LANGUAGES.includes(language)) return null
  return language.slice(0, 24)
}

/** Keeps `data:` and EvenDrive images; web images become links so they are never fetched. */
export function chatImageNode(image: Element, canonicalLink: (href: string) => string | null) {
  const src = String(image.properties.src ?? '').trim()
  const alt = String(image.properties.alt ?? '').trim()
  if (CHAT_DATA_IMAGE_SRC.test(src)) {
    image.properties.src = src.replace(/\s+/g, '')
    image.properties.className = ['chat-md-image']
    return [image]
  }
  const scheme = urlScheme(src)
  if (scheme === 'gfs') {
    const uri = normalizeGfsResourceUri(src)
    if (uri) {
      image.properties = { dataGfsSrc: uri, alt, className: ['chat-md-image'] }
      return [image]
    }
  }
  if (scheme === 'http' || scheme === 'https') {
    const href = canonicalLink(src)
    if (href) {
      const link: Element = {
        type: 'element',
        tagName: 'a',
        properties: { href, title: href },
        children: [{ type: 'text', value: alt || 'Image' }],
      }
      return [link]
    }
  }
  return alt ? [{ type: 'text', value: alt } as Text] : []
}
