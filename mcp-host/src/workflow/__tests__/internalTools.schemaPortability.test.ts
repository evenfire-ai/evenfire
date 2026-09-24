/**
 * Tool schemas reach every provider verbatim — Anthropic as `input_schema`,
 * OpenAI and the OpenAI-compatible endpoints as `parameters`, Bedrock as the
 * Converse `inputSchema`, and Gemini through @google/genai's schema conversion
 * — with nothing in this repo translating them first.
 *
 * The rules below are the constructs one of those paths actually breaks on, not
 * a guess at the strictest dialect: banning type lists and `anyOf` would make
 * the validators reject numeric cells and KPI values. @google/genai converts
 * both itself (see internalTools.schemaGemini.test.ts); what it passes through
 * untranslated — `oneOf`, `$ref` and the like — is what the Gemini API rejects.
 */
import { describe, expect, it } from 'vitest'
import { INTERNAL_TOOLS } from '../internalTools'

/** Tools whose arguments are free-form by contract, not a described shape. */
const FREE_FORM_TOOLS = new Set(['clerum__trigger_workflow'])

/** The generators this suite governs. */
const ARTIFACT_TOOLS = INTERNAL_TOOLS.filter(
  t => t.name.startsWith('clerum__generate_') && !FREE_FORM_TOOLS.has(t.name)
)

/**
 * Keywords @google/genai copies into the Gemini request untranslated. The
 * Gemini API does not know them and rejects the whole declaration.
 */
const UNTRANSLATED_KEYWORDS = [
  'oneOf',
  'allOf',
  'not',
  '$ref',
  '$defs',
  'const',
  'patternProperties',
  'dependencies',
  'if',
  'then',
  'else',
]

interface Violation {
  tool: string
  path: string
  detail: string
}

type Node = Record<string, unknown>

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function typesOf(node: Node): string[] {
  if (Array.isArray(node.type)) return node.type as string[]
  return typeof node.type === 'string' ? [node.type] : []
}

/**
 * Visit every schema node, including the branches of an `anyOf`, and report
 * those that break `check`.
 */
function scan(check: (node: Node) => string | undefined): Violation[] {
  const out: Violation[] = []
  for (const tool of ARTIFACT_TOOLS) {
    const visit = (node: unknown, path: string): void => {
      if (!isNode(node)) return
      const bad = check(node)
      if (bad) out.push({ tool: tool.name, path: path || '(root)', detail: bad })
      if (isNode(node.properties)) {
        for (const [k, v] of Object.entries(node.properties)) visit(v, `${path}.${k}`)
      }
      if (node.items !== undefined) visit(node.items, `${path}[]`)
      if (Array.isArray(node.anyOf)) node.anyOf.forEach((b, i) => visit(b, `${path}|${i}`))
    }
    visit(tool.parameters, '')
  }
  return out
}

function report(vs: Violation[]): string {
  return vs.map(v => `  ${v.tool}${v.path} — ${v.detail}`).join('\n')
}

describe('artifact tool schemas stay portable across providers', () => {
  it('registers the generators this suite is meant to cover', () => {
    // Guards against the suite silently covering nothing if naming changes.
    expect(ARTIFACT_TOOLS.length).toBeGreaterThanOrEqual(6)
  })

  it('never uses a keyword the Gemini conversion passes through untranslated', () => {
    const bad = scan(node => {
      const hit = UNTRANSLATED_KEYWORDS.find(k => node[k] !== undefined)
      return hit ? `uses ${hit}` : undefined
    })
    expect(bad, `rejected by the Gemini API after conversion:\n${report(bad)}`).toEqual([])
  })

  it('never sets both a type and anyOf on one node', () => {
    // @google/genai throws "type and anyOf cannot be both populated".
    const bad = scan(node =>
      node.type !== undefined && node.anyOf !== undefined ? 'type and anyOf together' : undefined
    )
    expect(bad, report(bad)).toEqual([])
  })

  it('never makes null the only type a standalone node allows', () => {
    // @google/genai throws "type: null can not be the only possible type" for
    // such a node. A `{ type: 'null' }` branch inside `anyOf` is different: the
    // conversion folds it into `nullable: true` and never recurses into it, so
    // branches are exempt here.
    const bad: Violation[] = []
    for (const tool of ARTIFACT_TOOLS) {
      const visit = (node: unknown, path: string): void => {
        if (!isNode(node)) return
        const t = typesOf(node)
        if (t.length > 0 && t.every(x => x === 'null')) {
          bad.push({ tool: tool.name, path, detail: 'null is the only type' })
        }
        if (isNode(node.properties)) {
          for (const [k, v] of Object.entries(node.properties)) visit(v, `${path}.${k}`)
        }
        if (node.items !== undefined) visit(node.items, `${path}[]`)
        if (Array.isArray(node.anyOf)) {
          node.anyOf.forEach((b, i) => {
            if (isNode(b) && typesOf(b).every(x => x === 'null') && typesOf(b).length > 0) return
            visit(b, `${path}|${i}`)
          })
        }
      }
      visit(tool.parameters, '')
    }
    expect(bad, report(bad)).toEqual([])
  })

  it('gives every array an items schema', () => {
    // An array without `items` has no element shape; OpenAI rejects the whole
    // function declaration for it.
    const bad = scan(node =>
      typesOf(node).includes('array') && node.items === undefined
        ? 'array without items'
        : undefined
    )
    expect(bad, `arrays need an items schema:\n${report(bad)}`).toEqual([])
  })

  it('only enumerates strings', () => {
    // The Gemini schema's enum is a list of strings.
    const bad = scan(node =>
      Array.isArray(node.enum) && node.enum.some(e => typeof e !== 'string')
        ? 'non-string enum value'
        : undefined
    )
    expect(bad, report(bad)).toEqual([])
  })

  it('describes every property the model has to fill in', () => {
    const bad: Violation[] = []
    for (const tool of ARTIFACT_TOOLS) {
      const visit = (node: unknown, path: string): void => {
        if (!isNode(node)) return
        if (isNode(node.properties)) {
          for (const [k, v] of Object.entries(node.properties)) {
            if (isNode(v) && typeof v.description !== 'string') {
              bad.push({ tool: tool.name, path: `${path}.${k}`, detail: 'no description' })
            }
            visit(v, `${path}.${k}`)
          }
        }
        if (node.items !== undefined) visit(node.items, `${path}[]`)
        if (Array.isArray(node.anyOf)) node.anyOf.forEach((b, i) => visit(b, `${path}|${i}`))
      }
      visit(tool.parameters, '')
    }
    expect(bad, `a property with no description is a guess:\n${report(bad)}`).toEqual([])
  })

  it('names its required fields and keeps them declared', () => {
    for (const tool of ARTIFACT_TOOLS) {
      const params = tool.parameters as Node
      expect(params.type, `${tool.name} root type`).toBe('object')
      const props = params.properties as Node
      expect(props, `${tool.name} has no properties`).toBeTruthy()
      for (const key of (params.required as string[]) ?? []) {
        expect(props[key], `${tool.name} requires "${key}" but never declares it`).toBeTruthy()
      }
    }
  })

  it('describes every tool itself', () => {
    for (const tool of ARTIFACT_TOOLS) {
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(40)
    }
  })
})
