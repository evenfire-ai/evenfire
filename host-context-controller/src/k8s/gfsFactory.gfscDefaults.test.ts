import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  DEFAULT_GFSC_AGENT_READ_RL_PER_MIN_PER_REPLICA,
  DEFAULT_GFSC_AGENT_WRITE_RL_PER_MIN_PER_REPLICA,
  MAX_GFSC_AGENT_RL_PER_MIN_PER_REPLICA,
} from './gfsFactory'

/**
 * HCC writes the agent budgets into every gfsc pod, and gfsc has its own
 * defaults and ceiling for an image that rolls out before the operator's env.
 * The two packages share no module, so this reads gfsc's source and fails when
 * either side changes a value alone.
 */
const GFSC_CONFIG = resolve(__dirname, '../../../gfs-controller/src/config.ts')

function exportedNumericConst(sourceFile: ts.SourceFile, symbol: string): number {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const exported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== symbol) continue
      const initializer = declaration.initializer
      if (initializer === undefined || !ts.isNumericLiteral(initializer)) {
        throw new Error(`${symbol} in ${GFSC_CONFIG} must be initialized with a numeric literal`)
      }
      return Number(initializer.text)
    }
  }
  throw new Error(`${symbol} is not an exported const in ${GFSC_CONFIG}`)
}

describe('gfsc agent budget defaults', () => {
  it('L18: HCC defaults and ceiling equal the ones gfsc applies on its own', () => {
    const source = readFileSync(GFSC_CONFIG, 'utf8')
    const sourceFile = ts.createSourceFile(GFSC_CONFIG, source, ts.ScriptTarget.Latest, true)
    expect({
      read: exportedNumericConst(sourceFile, 'AGENT_READ_RL_PER_MIN_DEFAULT'),
      write: exportedNumericConst(sourceFile, 'AGENT_WRITE_RL_PER_MIN_DEFAULT'),
      max: exportedNumericConst(sourceFile, 'AGENT_RL_PER_MIN_MAX'),
    }).toEqual({
      read: DEFAULT_GFSC_AGENT_READ_RL_PER_MIN_PER_REPLICA,
      write: DEFAULT_GFSC_AGENT_WRITE_RL_PER_MIN_PER_REPLICA,
      max: MAX_GFSC_AGENT_RL_PER_MIN_PER_REPLICA,
    })
  })
})
