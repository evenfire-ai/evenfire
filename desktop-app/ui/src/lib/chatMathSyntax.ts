import type { ElementContent } from 'hast'
import type {
  CompileContext,
  Extension as FromMarkdownExtension,
  Token as MdastToken,
} from 'mdast-util-from-markdown'
import type { InlineMath } from 'mdast-util-math'
import type {} from 'micromark-extension-math'
import type {
  Code,
  Construct,
  Effects,
  Event,
  Extension as MicromarkExtension,
  State,
  TokenizeContext,
} from 'micromark-util-types'
import type { Processor } from 'unified'
import { MAX_DOLLAR_RUN, mathBlockClose } from './chatMathBlocks'
import {
  bracketDisplayHoldsMath,
  bracketsHoldMath,
  displayHoldsMath,
  inlineDollarsHoldMath,
} from './chatMathProse'
import './chatMathSyntax.types'

const DOLLAR = 36
const BACKSLASH = 92
const LEFT_PAREN = 40
const RIGHT_PAREN = 41
const LEFT_BRACKET = 91
const RIGHT_BRACKET = 93
const SPACE = 32

// micromark encodes line endings below horizontal tab (-2).
const isLineEnding = (code: Code) => code !== null && code < -2
// . , ; : ! ?
const CLOSING_PUNCTUATION: ReadonlySet<number> = new Set([46, 44, 59, 58, 33, 63])
const WORD_CHARACTER = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}_/]/u
const isLineSpace = (code: Code) => code === SPACE || code === -2 || code === -1

/** At the start of a line, ignoring indentation. */
function atLineStart(context: TokenizeContext): boolean {
  const previous = context.previous
  if (previous === null || isLineEnding(previous)) return true
  if (!isLineSpace(previous)) return false
  for (let index = context.events.length - 1; index >= 0; index--) {
    const [kind, token] = context.events[index] ?? []
    if (kind !== 'exit' || !token) continue
    if (token.type === 'lineEnding') return true
    if (/[^ \t]/.test(context.sliceSerialize(token))) return false
  }
  return true
}

/**
 * Last span known to hold no formula, per document. Openers inside it fail at
 * once, which keeps scanning linear.
 */
const unclosedSpans = new WeakMap<object, Partial<Record<number, readonly [number, number]>>>()

/** `\(…\)` and `\[…\]`, which Markdown would read as escaped brackets. */
function tokenizeBackslashMath(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State
): State {
  const context = this
  let opener = LEFT_PAREN
  let closer = RIGHT_PAREN
  let type: 'mathText' | 'chatMathDisplay' = 'mathText'
  let hasContent = false
  let content = ''
  let openedAt = 0
  const before = this.previous
  const opening: Construct = { tokenize: tokenizeOpening, partial: true }
  const closing: Construct = { tokenize: tokenizeClosing, partial: true }
  const lineRest: Construct = { tokenize: tokenizeLineRest, partial: true }
  return start

  function start(code: Code): State | undefined {
    return effects.check(opening, open, nok)(code)
  }

  function tokenizeOpening(probe: Effects, found: State, missing: State): State {
    return function backslash(code: Code) {
      probe.enter('chatMathProbe')
      probe.consume(code)
      return bracket
    }
    function bracket(code: Code): State | undefined {
      if (code === LEFT_PAREN) {
        opener = LEFT_PAREN
        closer = RIGHT_PAREN
        type = 'mathText'
      } else if (code === LEFT_BRACKET) {
        opener = LEFT_BRACKET
        closer = RIGHT_BRACKET
        type = 'chatMathDisplay'
      } else {
        return missing(code)
      }
      probe.consume(code)
      probe.exit('chatMathProbe')
      return found(code)
    }
  }

  function tokenizeClosing(probe: Effects, found: State, missing: State): State {
    return function backslash(code: Code) {
      probe.enter('chatMathProbe')
      probe.consume(code)
      return bracket
    }
    function bracket(code: Code): State | undefined {
      if (code !== closer) return missing(code)
      probe.consume(code)
      probe.exit('chatMathProbe')
      return found(code)
    }
  }

  // `\]` must end its line; `\].` may end a sentence.
  function tokenizeLineRest(probe: Effects, found: State, missing: State): State {
    let punctuated = false
    return function rest(code: Code): State | undefined {
      if (code === null || isLineEnding(code)) return found(code)
      if (!punctuated && code !== null && CLOSING_PUNCTUATION.has(code)) {
        punctuated = true
      } else if (!isLineSpace(code)) {
        return missing(code)
      }
      probe.enter('chatMathProbe')
      probe.consume(code)
      probe.exit('chatMathProbe')
      return rest
    }
  }

  function open(code: Code): State | undefined {
    // Keeps `- \[x\] done` and `see\[1\]` as text.
    if (type === 'chatMathDisplay' && !atLineStart(context)) return nok(code)
    openedAt = context.now().offset
    const span = unclosedSpans.get(context.parser)?.[closer]
    if (span && openedAt >= span[0] && openedAt <= span[1]) return nok(code)
    effects.enter(type)
    effects.enter('mathTextSequence')
    effects.consume(code)
    return openBracket
  }

  function openBracket(code: Code): State | undefined {
    effects.consume(code)
    effects.exit('mathTextSequence')
    return between
  }

  function between(code: Code): State | undefined {
    if (code === null) {
      rememberNoMath(context.now().offset)
      return nok(code)
    }
    if (code === BACKSLASH) return effects.check(closing, close, escape)(code)
    if (code === SPACE) {
      content += ' '
      effects.enter('space')
      effects.consume(code)
      effects.exit('space')
      return between
    }
    if (isLineEnding(code)) {
      content += '\n'
      effects.enter('lineEnding')
      effects.consume(code)
      effects.exit('lineEnding')
      return between
    }
    effects.enter('mathTextData')
    return data(code)
  }

  function data(code: Code): State | undefined {
    if (code === null || code === SPACE || code === BACKSLASH || isLineEnding(code)) {
      effects.exit('mathTextData')
      return between(code)
    }
    hasContent = true
    if (code > 0) content += String.fromCharCode(code)
    effects.consume(code)
    return data
  }

  function escape(code: Code): State | undefined {
    hasContent = true
    content += '\\'
    effects.enter('mathTextData')
    effects.consume(code)
    return escaped
  }

  function escaped(code: Code): State | undefined {
    if (code === null || isLineEnding(code)) {
      effects.exit('mathTextData')
      return between(code)
    }
    // Nested openers are invalid LaTeX; stopping here also keeps scanning linear.
    if (code === opener) return nok(code)
    if (code > 0) content += String.fromCharCode(code)
    effects.consume(code)
    return data
  }

  function close(code: Code): State | undefined {
    // Parentheses attached to a word, e.g. `user\(s\)`, belong to it.
    if (type === 'mathText' && WORD_CHARACTER.test(charOf(before)) && !/\\[A-Za-z]/.test(content))
      return nok(code)
    const holdsMath = type === 'chatMathDisplay' ? bracketDisplayHoldsMath : bracketsHoldMath
    if (!hasContent || !holdsMath(content)) return nok(code)
    effects.enter('mathTextSequence')
    effects.consume(code)
    return closeBracket
  }

  function closeBracket(code: Code): State | undefined {
    effects.consume(code)
    return type === 'chatMathDisplay' ? effects.check(lineRest, finish, notLineEnd) : finish
  }

  // Any `\[` before this `\]` fails the same way.
  function notLineEnd(code: Code): State | undefined {
    rememberNoMath(context.now().offset)
    return nok(code)
  }

  function rememberNoMath(until: number) {
    const spans = unclosedSpans.get(context.parser) ?? {}
    spans[closer] = [openedAt, until]
    unclosedSpans.set(context.parser, spans)
  }

  function finish(code: Code): State | undefined {
    effects.exit('mathTextSequence')
    effects.exit(type)
    return ok(code)
  }
}

/** Mirrors micromark-extension-math's text resolver. */
function resolveBackslashMath(events: Event[]): Event[] {
  let tailExitIndex = events.length - 4
  let headEnterIndex = 3
  let index: number
  let enter: number | undefined

  const head = events[headEnterIndex]?.[1].type
  const tail = events[tailExitIndex]?.[1].type
  if ((head === 'lineEnding' || head === 'space') && (tail === 'lineEnding' || tail === 'space')) {
    index = headEnterIndex
    while (++index < tailExitIndex) {
      if (events[index]?.[1].type === 'mathTextData') {
        events[tailExitIndex]![1].type = 'mathTextPadding'
        events[headEnterIndex]![1].type = 'mathTextPadding'
        headEnterIndex += 2
        tailExitIndex -= 2
        break
      }
    }
  }

  index = headEnterIndex - 1
  tailExitIndex++
  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex && events[index]?.[1].type !== 'lineEnding') enter = index
    } else if (index === tailExitIndex || events[index]?.[1].type === 'lineEnding') {
      const merged = events[enter]![1]
      merged.type = 'mathTextData'
      if (index !== enter + 2) {
        merged.end = events[index - 1]![1].end
        events.splice(enter + 2, index - enter - 2)
        tailExitIndex -= index - enter - 2
        index = enter + 2
      }
      enter = undefined
    }
  }
  return events
}

const backslashMath: Construct = {
  name: 'chatBackslashMath',
  tokenize: tokenizeBackslashMath,
  resolve: resolveBackslashMath,
}

const syntax: MicromarkExtension = { text: { [BACKSLASH]: backslashMath } }

const fromMarkdown: FromMarkdownExtension = {
  enter: {
    chatDollars(this: CompileContext, token: MdastToken) {
      this.config.enter.data?.call(this, token)
    },
    chatMathDisplay(this: CompileContext, token: MdastToken) {
      this.enter(
        {
          type: 'inlineMath',
          value: '',
          data: {
            hName: 'code',
            hProperties: { className: ['language-math', 'math-display'] },
            hChildren: [],
          },
        },
        token
      )
      this.buffer()
    },
  },
  exit: {
    chatDollars(this: CompileContext, token: MdastToken) {
      this.config.exit.data?.call(this, token)
    },
    chatMathDisplay(this: CompileContext, token: MdastToken) {
      const value = this.resume()
      const node = this.stack[this.stack.length - 1] as InlineMath
      this.exit(token)
      node.value = value
      ;(node.data?.hChildren as ElementContent[] | undefined)?.push({ type: 'text', value })
    },
  },
}

/** Emits `$$` as text when it does not delimit a formula, before remark-math can claim it. */
const dollarProse: Construct = {
  name: 'chatDollarProse',
  previous: code => code !== DOLLAR,
  tokenize(effects, ok, nok) {
    const before = this.previous
    const probe = closedProse(atLineStart(this), before)
    return effects.check(probe, start, nok)

    function start(code: Code): State | undefined {
      // Not `data`: micromark merges adjacent data tokens in quadratic time.
      effects.enter('chatDollars')
      return dollars(code)
    }
    function dollars(code: Code): State | undefined {
      if (code === DOLLAR) {
        effects.consume(code)
        return dollars
      }
      effects.exit('chatDollars')
      return ok(code)
    }
  },
}

/** Succeeds when the run starting here does not open a formula. */
function closedProse(startsLine: boolean, before: Code): Construct {
  return {
    partial: true,
    tokenize(effects, ok, nok) {
      let opening = 0
      let run = 0
      let content = ''
      let after: Code = null
      let closed = false
      return start

      function start(code: Code): State | undefined {
        effects.enter('chatMathProbe')
        return open(code)
      }
      function open(code: Code): State | undefined {
        if (code === DOLLAR) {
          opening += 1
          effects.consume(code)
          return open
        }
        if (opening < 2 || opening > MAX_DOLLAR_RUN) return end(code, true)
        return inside(code)
      }
      function inside(code: Code): State | undefined {
        if (code === DOLLAR) {
          run += 1
          effects.consume(code)
          return inside
        }
        if (run === opening) return rest(code)
        if (code === null) return end(code, true)
        content +=
          '$'.repeat(run) + (code > 0 ? String.fromCharCode(code) : isLineEnding(code) ? '\n' : ' ')
        run = 0
        effects.consume(code)
        return inside
      }
      // Alone on its line, allowing one punctuation mark.
      function rest(code: Code): State | undefined {
        if (!closed) {
          closed = true
          after = code
        }
        if (code === null || isLineEnding(code)) {
          return end(code, !(startsLine ? displayHoldsMath : inlineHoldsMath)(content))
        }
        if (startsLine && (isLineSpace(code) || CLOSING_PUNCTUATION.has(code))) {
          effects.consume(code)
          return rest
        }
        return end(code, !inlineHoldsMath(content))
      }
      // A run attached to a word, number or bracket is not a delimiter.
      function inlineHoldsMath(source: string): boolean {
        const joined = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}{([@<_"`$\\]/u
        return (
          !WORD_CHARACTER.test(charOf(before)) &&
          !joined.test(charOf(after)) &&
          inlineDollarsHoldMath(source)
        )
      }
      function end(code: Code, prose: boolean): State | undefined {
        effects.exit('chatMathProbe')
        return prose ? ok(code) : nok(code)
      }
    },
  }
}

function charOf(code: Code): string {
  return code !== null && code > 0 ? String.fromCharCode(code) : ''
}

/** Set while parsing so the block construct can look ahead; empty disables it. */
export type ChatMathSource = { text: string }

/** Display math block, emitted as remark-math's flow node. */
function mathBlock(source: ChatMathSource): Construct {
  return {
    name: 'chatMathBlock',
    concrete: true,
    tokenize(effects, ok, nok) {
      const context = this
      const startOffset = context.now().offset
      const close = mathBlockClose(source.text, startOffset)
      if (!close) return nok
      const { start: closeStart, end: closeEnd } = close
      const nextLine: Construct = { tokenize: tokenizeNextLine, partial: true }
      let opened = false
      return start

      function start(code: Code): State | undefined {
        effects.enter('mathFlow')
        return fence(code)
      }
      function fence(code: Code): State | undefined {
        effects.enter('mathFlowFence')
        effects.enter('mathFlowFenceSequence')
        return delimiter(code)
      }
      function delimiter(code: Code): State | undefined {
        const offset = context.now().offset
        const inOpener = !opened && (code === DOLLAR || offset - startOffset < 2)
        if (inOpener || (opened && offset < closeEnd)) {
          effects.consume(code)
          return delimiter
        }
        effects.exit('mathFlowFenceSequence')
        effects.exit('mathFlowFence')
        opened = true
        // Enough to interrupt a paragraph.
        if (context.interrupt) return ok(code)
        return between(code)
      }
      function between(code: Code): State | undefined {
        if (code === null) return done(code)
        if (isLineEnding(code)) return effects.check(nextLine, lineEnding, done)(code)
        if (context.now().offset === closeStart) return fence(code)
        effects.enter('mathFlowValue')
        return value(code)
      }
      function lineEnding(code: Code): State | undefined {
        if (context.now().offset >= closeEnd) return done(code)
        effects.enter('lineEnding')
        effects.consume(code)
        effects.exit('lineEnding')
        return between
      }
      function value(code: Code): State | undefined {
        if (code === null || isLineEnding(code) || context.now().offset === closeStart) {
          effects.exit('mathFlowValue')
          return between(code)
        }
        effects.consume(code)
        return value
      }
      function done(code: Code): State | undefined {
        effects.exit('mathFlow')
        return ok(code)
      }

      // Stops where the list item or quote ends.
      function tokenizeNextLine(probe: Effects, found: State, missing: State): State {
        return function start(code: Code): State | undefined {
          if (code === null) return missing(code)
          probe.enter('lineEnding')
          probe.consume(code)
          probe.exit('lineEnding')
          return afterEnding
        }
        function afterEnding(code: Code): State | undefined {
          return context.parser.lazy[context.now().line] ? missing(code) : found(code)
        }
      }
    },
  }
}

/** Must run after remark-math, whose constructs it narrows and whose nodes it reuses. */
export function remarkChatMath(this: Processor, source: ChatMathSource): undefined {
  const data = this.data()
  const block = mathBlock(source)
  for (const extension of data.micromarkExtensions ?? []) {
    if (extension.flow?.[DOLLAR]) extension.flow[DOLLAR] = block
    const inline = extension.text?.[DOLLAR]
    if (inline)
      extension.text![DOLLAR] = [dollarProse, ...(Array.isArray(inline) ? inline : [inline])]
  }
  ;(data.micromarkExtensions ??= []).push({ flow: { [BACKSLASH]: block } })
  ;(data.micromarkExtensions ??= []).push(syntax)
  ;(data.fromMarkdownExtensions ??= []).push(fromMarkdown)
}
