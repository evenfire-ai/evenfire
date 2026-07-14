/**
 * computedValuesEvaluator.ts
 *
 * Safe expression evaluator for WorkflowRecipe computedValues (WORKLOADRECIPE-SPEC §5.5).
 * Parses and evaluates a limited expression language using recursive descent.
 * NO eval/Function — fully sandboxed.
 *
 * Supported:
 *   - inputs.KEY references
 *   - Arithmetic: + - * /
 *   - String concatenation (+ with string operands)
 *   - Comparison: > < >= <= == !=
 *   - Ternary: EXPR ? VALUE_A : VALUE_B
 *   - Parentheses for grouping
 *   - Numeric literals, string literals (single/double quoted)
 */
import type { ComputedValue } from '../types'

// ─── Error ──────────────────────────────────────────────────────────────────

export class ComputedValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComputedValueError'
  }
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

type TokenType =
  | 'number'
  | 'string'
  | 'identifier'
  | 'dot'
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'lparen'
  | 'rparen'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'eq'
  | 'neq'
  | 'question'
  | 'colon'
  | 'eof'

interface Token {
  type: TokenType
  value: string
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < expression.length) {
    const ch = expression[i]

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    // Number literal
    if (ch >= '0' && ch <= '9') {
      let num = ''
      while (
        i < expression.length &&
        ((expression[i] >= '0' && expression[i] <= '9') || expression[i] === '.')
      ) {
        num += expression[i]
        i++
      }
      tokens.push({ type: 'number', value: num })
      continue
    }

    // String literal (single or double quoted)
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++ // skip opening quote
      let str = ''
      while (i < expression.length && expression[i] !== quote) {
        if (expression[i] === '\\' && i + 1 < expression.length) {
          i++
          str += expression[i]
        } else {
          str += expression[i]
        }
        i++
      }
      if (i >= expression.length) {
        throw new ComputedValueError(`Unterminated string literal in expression: ${expression}`)
      }
      i++ // skip closing quote
      tokens.push({ type: 'string', value: str })
      continue
    }

    // Identifier (a-z, A-Z, _, 0-9)
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let ident = ''
      while (
        i < expression.length &&
        ((expression[i] >= 'a' && expression[i] <= 'z') ||
          (expression[i] >= 'A' && expression[i] <= 'Z') ||
          (expression[i] >= '0' && expression[i] <= '9') ||
          expression[i] === '_')
      ) {
        ident += expression[i]
        i++
      }
      tokens.push({ type: 'identifier', value: ident })
      continue
    }

    // Two-character operators
    if (ch === '>' && expression[i + 1] === '=') {
      tokens.push({ type: 'gte', value: '>=' })
      i += 2
      continue
    }
    if (ch === '<' && expression[i + 1] === '=') {
      tokens.push({ type: 'lte', value: '<=' })
      i += 2
      continue
    }
    if (ch === '=' && expression[i + 1] === '=') {
      tokens.push({ type: 'eq', value: '==' })
      i += 2
      continue
    }
    if (ch === '!' && expression[i + 1] === '=') {
      tokens.push({ type: 'neq', value: '!=' })
      i += 2
      continue
    }

    // Single-character operators
    const singleCharMap: Record<string, TokenType> = {
      '.': 'dot',
      '+': 'plus',
      '-': 'minus',
      '*': 'star',
      '/': 'slash',
      '(': 'lparen',
      ')': 'rparen',
      '>': 'gt',
      '<': 'lt',
      '?': 'question',
      ':': 'colon',
    }

    if (singleCharMap[ch]) {
      tokens.push({ type: singleCharMap[ch], value: ch })
      i++
      continue
    }

    throw new ComputedValueError(`Unexpected character '${ch}' in expression: ${expression}`)
  }

  tokens.push({ type: 'eof', value: '' })
  return tokens
}

// ─── Parser (recursive descent) ────────────────────────────────────────────

class Parser {
  private tokens: Token[]
  private pos = 0
  private inputs: Record<string, unknown>
  private expression: string

  constructor(tokens: Token[], inputs: Record<string, unknown>, expression: string) {
    this.tokens = tokens
    this.inputs = inputs
    this.expression = expression
  }

  private peek(): Token {
    return this.tokens[this.pos]
  }

  private advance(): Token {
    const t = this.tokens[this.pos]
    this.pos++
    return t
  }

  private expect(type: TokenType): Token {
    const t = this.peek()
    if (t.type !== type) {
      throw new ComputedValueError(
        `Expected ${type} but got ${t.type} ('${t.value}') in expression: ${this.expression}`
      )
    }
    return this.advance()
  }

  /**
   * Grammar (lowest to highest precedence):
   *   ternary     → comparison ('?' ternary ':' ternary)?
   *   comparison  → addition (('>'|'<'|'>='|'<='|'=='|'!=') addition)?
   *   addition    → multiplication (('+' | '-') multiplication)*
   *   multiplication → unary (('*' | '/') unary)*
   *   unary       → ('-')? primary
   *   primary     → NUMBER | STRING | '(' ternary ')' | inputs.KEY
   */

  parse(): unknown {
    const result = this.parseTernary()
    if (this.peek().type !== 'eof') {
      throw new ComputedValueError(
        `Unexpected token '${this.peek().value}' at end of expression: ${this.expression}`
      )
    }
    return result
  }

  private parseTernary(): unknown {
    const condition = this.parseComparison()

    if (this.peek().type === 'question') {
      this.advance() // consume '?'
      const trueValue = this.parseTernary()
      this.expect('colon')
      const falseValue = this.parseTernary()
      return condition ? trueValue : falseValue
    }

    return condition
  }

  private parseComparison(): unknown {
    let left = this.parseAddition()

    const t = this.peek()
    if (
      t.type === 'gt' ||
      t.type === 'lt' ||
      t.type === 'gte' ||
      t.type === 'lte' ||
      t.type === 'eq' ||
      t.type === 'neq'
    ) {
      this.advance()
      const right = this.parseAddition()
      const l = left as number
      const r = right as number
      switch (t.type) {
        case 'gt':
          return l > r
        case 'lt':
          return l < r
        case 'gte':
          return l >= r
        case 'lte':
          return l <= r
        case 'eq':
          return left === right
        case 'neq':
          return left !== right
      }
    }

    return left
  }

  private parseAddition(): unknown {
    let left = this.parseMultiplication()

    while (this.peek().type === 'plus' || this.peek().type === 'minus') {
      const op = this.advance()
      const right = this.parseMultiplication()

      if (op.type === 'plus') {
        if (typeof left === 'string' || typeof right === 'string') {
          left = String(left) + String(right)
        } else {
          left = (left as number) + (right as number)
        }
      } else {
        left = (left as number) - (right as number)
      }
    }

    return left
  }

  private parseMultiplication(): unknown {
    let left = this.parseUnary()

    while (this.peek().type === 'star' || this.peek().type === 'slash') {
      const op = this.advance()
      const right = this.parseUnary()

      if (op.type === 'star') {
        left = (left as number) * (right as number)
      } else {
        if ((right as number) === 0) {
          throw new ComputedValueError(`Division by zero in expression: ${this.expression}`)
        }
        left = (left as number) / (right as number)
      }
    }

    return left
  }

  private parseUnary(): unknown {
    if (this.peek().type === 'minus') {
      this.advance()
      const val = this.parsePrimary()
      return -(val as number)
    }
    return this.parsePrimary()
  }

  private parsePrimary(): unknown {
    const t = this.peek()

    // Number literal
    if (t.type === 'number') {
      this.advance()
      return parseFloat(t.value)
    }

    // String literal
    if (t.type === 'string') {
      this.advance()
      return t.value
    }

    // Parenthesized expression
    if (t.type === 'lparen') {
      this.advance() // consume '('
      const val = this.parseTernary()
      this.expect('rparen')
      return val
    }

    // inputs.KEY reference
    if (t.type === 'identifier' && t.value === 'inputs') {
      this.advance() // consume 'inputs'
      this.expect('dot')
      const key = this.expect('identifier')
      if (!(key.value in this.inputs)) {
        throw new ComputedValueError(
          `Unresolved reference 'inputs.${key.value}' in expression: ${this.expression}`
        )
      }
      return this.inputs[key.value]
    }

    throw new ComputedValueError(
      `Unexpected token '${t.value}' (${t.type}) in expression: ${this.expression}`
    )
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Evaluates an array of ComputedValue definitions against resolved inputs.
 * Values are evaluated in order, and each result is added to the inputs
 * so subsequent expressions can reference earlier computed values via `inputs.NAME`.
 *
 * @param computed  - Array of { name, expression } from WorkflowRecipeSpec.computed
 * @param inputs    - Resolved input values
 * @returns Map of computed name to evaluated value
 */
export function evaluateComputedValues(
  computed: ComputedValue[],
  inputs: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  // Clone inputs so computed values can reference earlier computed values
  const mergedInputs: Record<string, unknown> = { ...inputs }

  for (const cv of computed) {
    const tokens = tokenize(cv.expression)
    const parser = new Parser(tokens, mergedInputs, cv.expression)
    const value = parser.parse()
    result[cv.name] = value
    // Make this computed value available for subsequent expressions
    mergedInputs[cv.name] = value
  }

  return result
}
