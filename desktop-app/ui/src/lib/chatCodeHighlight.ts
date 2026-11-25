import type { Element, Root } from 'hast'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import rehypeHighlight, { type Options as RehypeHighlightOptions } from 'rehype-highlight'
import {
  CHAT_CODE_HIGHLIGHT_MAX_CHARS,
  CHAT_CODE_HIGHLIGHT_MAX_EMBEDS,
  CHAT_CODE_HIGHLIGHT_MAX_LINE_CHARS,
  CHAT_CODE_HIGHLIGHT_MAX_MESSAGE_CHARS,
  CHAT_CODE_HIGHLIGHT_MAX_SPACE_CHARS,
  CHAT_CODE_PLAIN_LANGUAGES,
} from '@constants/chatRendering'

/** No language detection: only the fence label selects a grammar. */
const HIGHLIGHT_OPTIONS: RehypeHighlightOptions = {
  languages: {
    bash,
    css,
    diff,
    go,
    java,
    javascript,
    json,
    markdown,
    python,
    rust,
    shell,
    sql,
    typescript,
    xml,
    yaml,
  },
  detect: false,
  plainText: CHAT_CODE_PLAIN_LANGUAGES,
}

// Each embedded language is parsed again by its own grammar.
const EMBED = /<(?:script|style)\b/gi

function codeText(node: Element | Root): string {
  let text = ''
  for (const child of node.children) {
    if (child.type === 'text') text += child.value
    else if (child.type === 'element') text += codeText(child)
  }
  return text
}

/** Grammars backtrack over whitespace, which is quadratic on long runs. */
function longestSpace(text: string): number {
  let longest = 0
  let run = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const space = code < 128 ? code === 32 || (code >= 9 && code <= 13) : /\s/.test(text[index]!)
    run = space ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}

function longestLine(text: string): number {
  let longest = 0
  let start = 0
  while (start <= text.length) {
    const end = text.indexOf('\n', start)
    const stop = end === -1 ? text.length : end
    longest = Math.max(longest, stop - start)
    start = stop + 1
  }
  return longest
}

function classNames(code: Element): string[] {
  const className = code.properties.className
  return Array.isArray(className) ? className.map(String) : []
}

function hasColoredLanguage(classes: readonly string[]): boolean {
  return classes.some(name => {
    const language = name.startsWith('language-') ? name.slice('language-'.length) : null
    return language !== null && !CHAT_CODE_PLAIN_LANGUAGES.includes(language)
  })
}

/** Highlighting is superlinear on long tokens, so oversized blocks stay plain. */
function markLargeCode(node: Element | Root, colored: { chars: number }): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (child.tagName === 'pre') {
      for (const code of child.children) {
        if (code.type !== 'element' || code.tagName !== 'code') continue
        const classes = classNames(code)
        if (!hasColoredLanguage(classes)) continue
        const text = codeText(code)
        if (
          (text.match(EMBED)?.length ?? 0) <= CHAT_CODE_HIGHLIGHT_MAX_EMBEDS &&
          text.length <= CHAT_CODE_HIGHLIGHT_MAX_CHARS &&
          colored.chars + text.length <= CHAT_CODE_HIGHLIGHT_MAX_MESSAGE_CHARS &&
          longestLine(text) <= CHAT_CODE_HIGHLIGHT_MAX_LINE_CHARS &&
          longestSpace(text) <= CHAT_CODE_HIGHLIGHT_MAX_SPACE_CHARS
        ) {
          colored.chars += text.length
          continue
        }
        code.properties.className = [...classes, 'no-highlight']
      }
      continue
    }
    markLargeCode(child, colored)
  }
}

function codeBlocksOf(node: Element | Root, found: Element[]): Element[] {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (child.tagName === 'pre') found.push(child)
    else codeBlocksOf(child, found)
  }
  return found
}

/** rehype-highlight looks every element up among its siblings; passing only code blocks keeps that linear. */
export function rehypeChatCode() {
  const highlight = rehypeHighlight(HIGHLIGHT_OPTIONS)
  return (tree: Root, file: Parameters<typeof highlight>[1]) => {
    markLargeCode(tree, { chars: 0 })
    for (const block of codeBlocksOf(tree, [])) highlight({ type: 'root', children: [block] }, file)
  }
}
