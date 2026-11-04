import type { DbClient } from '../db.js'
import { MIGRATION_EXECUTION_POLICY } from './migrationExecutionPolicy.js'

export type OnlineIndexDefinition = Readonly<{
  migrationVersion: '0131_user_access_foundation'
  name: string
  table: string
  unique?: boolean
  createSql: string
}>

export const PR1_ONLINE_INDEX_PLAN: readonly OnlineIndexDefinition[] = Object.freeze([
  {
    migrationVersion: '0131_user_access_foundation',
    name: 'team_members_user_active_idx',
    table: 'team_members',
    createSql: `CREATE INDEX CONCURRENTLY team_members_user_active_idx
      ON team_members (user_id, status, team_id) INCLUDE (role, updated_at)`,
  },
  {
    migrationVersion: '0131_user_access_foundation',
    name: 'user_contexts_context_user_idx',
    table: 'user_contexts',
    createSql: `CREATE INDEX CONCURRENTLY user_contexts_context_user_idx
      ON user_contexts (context_id, user_id)`,
  },
  {
    migrationVersion: '0131_user_access_foundation',
    name: 'team_contexts_context_team_idx',
    table: 'team_contexts',
    createSql: `CREATE INDEX CONCURRENTLY team_contexts_context_team_idx
      ON team_contexts (context_id, team_id)`,
  },
  {
    migrationVersion: '0131_user_access_foundation',
    name: 'user_agents_agent_user_idx',
    table: 'user_agents',
    createSql: `CREATE INDEX CONCURRENTLY user_agents_agent_user_idx
      ON user_agents (agent_name, user_id)`,
  },
  {
    migrationVersion: '0131_user_access_foundation',
    name: 'team_agents_agent_team_idx',
    table: 'team_agents',
    createSql: `CREATE INDEX CONCURRENTLY team_agents_agent_team_idx
      ON team_agents (agent_name, team_id)`,
  },
])

type IndexSqlToken = Readonly<{
  kind: 'identifier' | 'quoted_identifier' | 'string' | 'number' | 'operator' | 'punctuation'
  value: string
}>

function tokenizeIndexDefinition(value: string): IndexSqlToken[] {
  const tokens: IndexSqlToken[] = []
  const operators = ['->>', '#>>', '::', '||', '->', '#>', '<=', '>=', '<>', '!=', '@>', '<@']
  let offset = 0

  while (offset < value.length) {
    const char = value[offset]!
    if (/\s/.test(char)) {
      offset += 1
      continue
    }
    if (value.startsWith('--', offset)) {
      const newline = value.indexOf('\n', offset + 2)
      offset = newline < 0 ? value.length : newline + 1
      continue
    }
    if (value.startsWith('/*', offset)) {
      let depth = 1
      offset += 2
      while (offset < value.length && depth > 0) {
        if (value.startsWith('/*', offset)) {
          depth += 1
          offset += 2
        } else if (value.startsWith('*/', offset)) {
          depth -= 1
          offset += 2
        } else {
          offset += 1
        }
      }
      if (depth !== 0) throw new Error('Unterminated comment in online index definition')
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      const start = offset
      offset += 1
      let closed = false
      while (offset < value.length) {
        if (value[offset] === quote) {
          if (value[offset + 1] === quote) {
            offset += 2
            continue
          }
          offset += 1
          closed = true
          break
        }
        offset += 1
      }
      if (!closed) throw new Error('Unterminated quoted token in online index definition')
      tokens.push({
        kind: quote === '"' ? 'quoted_identifier' : 'string',
        value: value.slice(start, offset),
      })
      continue
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(char)) {
      const start = offset
      offset += 1
      while (offset < value.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(value[offset]!)) {
        offset += 1
      }
      tokens.push({ kind: 'identifier', value: value.slice(start, offset).toLowerCase() })
      continue
    }
    if (/[0-9]/.test(char)) {
      const start = offset
      offset += 1
      while (offset < value.length && /[A-Za-z0-9_.]/.test(value[offset]!)) offset += 1
      tokens.push({ kind: 'number', value: value.slice(start, offset) })
      continue
    }
    const operator = operators.find(candidate => value.startsWith(candidate, offset))
    if (operator) {
      tokens.push({ kind: 'operator', value: operator })
      offset += operator.length
      continue
    }
    tokens.push({
      kind: '()[],.;'.includes(char) ? 'punctuation' : 'operator',
      value: char,
    })
    offset += 1
  }

  return tokens
}

function matchingParen(tokens: readonly IndexSqlToken[], start: number): number {
  if (tokens[start]?.value !== '(') return -1
  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]!.value === '(') depth += 1
    else if (tokens[index]!.value === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function removeWholeExpressionWrappers(tokens: readonly IndexSqlToken[]): IndexSqlToken[] {
  let result = [...tokens]
  while (result.length >= 2 && matchingParen(result, 0) === result.length - 1) {
    result = result.slice(1, -1)
  }
  return result
}

function splitTopLevel(tokens: readonly IndexSqlToken[]): IndexSqlToken[][] {
  const values: IndexSqlToken[][] = [[]]
  let depth = 0
  for (const token of tokens) {
    if (token.value === '(') depth += 1
    else if (token.value === ')') depth -= 1
    if (token.value === ',' && depth === 0) values.push([])
    else values[values.length - 1]!.push(token)
  }
  return values
}

function isSingleAtom(tokens: readonly IndexSqlToken[]): boolean {
  if (tokens.length === 1) return true
  return (
    tokens.length === 3 &&
    (tokens[0]!.kind === 'identifier' ||
      tokens[0]!.kind === 'quoted_identifier' ||
      tokens[0]!.kind === 'string' ||
      tokens[0]!.kind === 'number') &&
    tokens[1]!.value === '::' &&
    tokens[2]!.kind === 'identifier'
  )
}

function normalizeKnownTextCoercions(
  tokens: IndexSqlToken[],
  inCatalogUtf8Bytes: boolean
): IndexSqlToken[] {
  const result = [...tokens]
  for (let index = 0; index + 2 < result.length; index += 1) {
    const value = result[index]!
    if (result[index + 1]!.value !== '::' || result[index + 2]!.value !== 'text') continue

    const before = result[index - 1]?.value
    const after = result[index + 3]?.value
    const knownCatalogColumn =
      inCatalogUtf8Bytes &&
      value.kind === 'identifier' &&
      (value.value === 'recipe_namespace' || value.value === 'recipe_name')
    // These are the exact unknown-literal-to-text coercions emitted by
    // pg_get_indexdef for the fixed PR1 plan: JSON text keys, the slash
    // separator, and workflow_runs.actor_type's text predicate.
    const knownStringOperand =
      value.kind === 'string' &&
      (((value.value === "'userId'" || value.value === "'teamId'") &&
        (before === '->>' || before === '?')) ||
        (value.value === "'/'" && (before === '||' || after === '||')) ||
        (value.value === "'user'" && before === '=' && result[index - 2]?.value === 'actor_type'))

    if (knownCatalogColumn || knownStringOperand) result.splice(index + 1, 2)
  }
  return result
}

function normalizeExpression(
  tokens: readonly IndexSqlToken[],
  inCatalogUtf8Bytes = false
): IndexSqlToken[] {
  let result = removeWholeExpressionWrappers(tokens)

  // Recurse into function arguments so catalog_utf8_bytes' deparser-added
  // grouping can be compared without flattening a grouped arithmetic operand.
  for (let index = 0; index + 1 < result.length; index += 1) {
    if (result[index]!.kind !== 'identifier' || result[index + 1]!.value !== '(') continue
    const end = matchingParen(result, index + 1)
    if (end <= index + 1) continue
    const isCatalogFunction = result[index]!.value === 'catalog_utf8_bytes'
    const args = splitTopLevel(result.slice(index + 2, end)).map(argument =>
      normalizeExpression(argument, inCatalogUtf8Bytes || isCatalogFunction)
    )
    const normalizedArgs = args.flatMap((arg, argumentIndex) =>
      argumentIndex === 0 ? arg : [{ kind: 'punctuation' as const, value: ',' }, ...arg]
    )
    result.splice(index + 2, end - index - 2, ...normalizedArgs)
  }

  // PostgreSQL may add parentheses around a single operand while deparsing an
  // index expression. Remove only wrappers whose contents are an atomic token
  // (or that atom's explicit cast); grouped binary expressions remain intact.
  for (let index = result.length - 1; index >= 0; index -= 1) {
    if (result[index]!.value !== '(') continue
    const end = matchingParen(result, index)
    if (end <= index) continue
    const inner = result.slice(index + 1, end)
    if (isSingleAtom(inner)) {
      result.splice(index, end - index + 1, ...inner)
    }
  }

  result = normalizeKnownTextCoercions(result, inCatalogUtf8Bytes)

  // Normalize the deparser's left grouping for the repository's text
  // concatenation catalog keys. Other grouped operators are deliberately kept.
  let changed = true
  while (changed) {
    changed = false
    let depth = 0
    for (let index = 0; index < result.length; index += 1) {
      const token = result[index]!
      if (token.value === '(') depth += 1
      else if (token.value === ')') depth -= 1
      else if (depth === 0 && token.value === '||') {
        const leftStart = (() => {
          let nested = 0
          for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            if (result[cursor]!.value === ')') nested += 1
            else if (result[cursor]!.value === '(') {
              if (nested === 0) return cursor
              nested -= 1
            } else if (nested === 0 && result[cursor]!.value === '||') {
              return cursor + 1
            }
          }
          return 0
        })()
        if (result[leftStart]?.value !== '(') continue
        const leftEnd = matchingParen(result, leftStart)
        if (leftEnd !== index - 1) continue
        const left = result.slice(leftStart + 1, leftEnd)
        let innerDepth = 0
        const hasNestedConcat = left.some((candidate, candidateIndex) => {
          if (candidate.value === '(') innerDepth += 1
          else if (candidate.value === ')') innerDepth -= 1
          return innerDepth === 0 && candidate.value === '||' && candidateIndex > 0
        })
        if (!hasNestedConcat) continue
        result.splice(leftStart, leftEnd - leftStart + 1, ...left)
        changed = true
        break
      }
    }
  }

  return result
}

function normalizePredicate(tokens: readonly IndexSqlToken[]): IndexSqlToken[] {
  const result = removeWholeExpressionWrappers(tokens)
  for (let index = result.length - 1; index >= 0; index -= 1) {
    if (result[index]!.value !== '(') continue
    const end = matchingParen(result, index)
    if (end <= index) continue
    const inner = result.slice(index + 1, end)
    let depth = 0
    const hasTopLevelBoolean = inner.some(token => {
      if (token.value === '(') depth += 1
      else if (token.value === ')') depth -= 1
      return (
        depth === 0 &&
        token.kind === 'identifier' &&
        (token.value === 'and' || token.value === 'or')
      )
    })
    const before = result[index - 1]?.value
    const after = result[end + 1]?.value
    const isPredicateTermBoundary =
      (before === undefined ||
        before === 'where' ||
        before === 'and' ||
        before === 'or' ||
        before === '(') &&
      (after === undefined || after === 'and' || after === 'or' || after === ')')
    if (isPredicateTermBoundary && !hasTopLevelBoolean) {
      result.splice(index, end - index + 1, ...inner)
    }
  }
  return normalizeExpression(result)
}

function canonicalizeIndexDdl(tokens: IndexSqlToken[]): IndexSqlToken[] {
  const result = [...tokens]
  if (result.at(-1)?.value === ';') result.pop()

  const indexToken = result.findIndex(token => token.value === 'index')
  if (indexToken >= 0) {
    let modifierOffset = indexToken + 1
    if (result[modifierOffset]?.value === 'concurrently') {
      result.splice(modifierOffset, 1)
    }
    if (
      result[modifierOffset]?.value === 'if' &&
      result[modifierOffset + 1]?.value === 'not' &&
      result[modifierOffset + 2]?.value === 'exists'
    ) {
      result.splice(modifierOffset, 3)
    }
  }

  const onToken = result.findIndex(token => token.value === 'on')
  if (onToken >= 0) {
    if (result[onToken + 1]?.value === 'public' && result[onToken + 2]?.value === '.') {
      result.splice(onToken + 1, 2)
    }
    const usingToken = result.findIndex(
      (token, index) =>
        index > onToken && token.value === 'using' && result[index + 1]?.value === 'btree'
    )
    if (usingToken >= 0) result.splice(usingToken, 2)

    const keyListStart = result.findIndex((token, index) => index > onToken && token.value === '(')
    const keyListEnd = keyListStart >= 0 ? matchingParen(result, keyListStart) : -1
    if (keyListStart >= 0 && keyListEnd > keyListStart) {
      const parts = splitTopLevel(result.slice(keyListStart + 1, keyListEnd)).map(part =>
        normalizeExpression(removeWholeExpressionWrappers(part))
      )
      result.splice(
        keyListStart + 1,
        keyListEnd - keyListStart - 1,
        ...parts.flatMap((part, index) =>
          index === 0 ? part : [{ kind: 'punctuation' as const, value: ',' }, ...part]
        )
      )
      const adjustedKeyListEnd =
        keyListStart + 1 + parts.reduce((sum, part) => sum + part.length, 0) + parts.length - 1
      const whereToken = result.findIndex(
        (token, index) => index > adjustedKeyListEnd && token.value === 'where'
      )
      if (whereToken >= 0) {
        const predicate = normalizePredicate(result.slice(whereToken + 1))
        result.splice(whereToken + 1, result.length - whereToken - 1, ...predicate)
      }
    }
  }
  return result
}

export const canonicalOnlineIndexDefinition = (value: string): string =>
  JSON.stringify(
    canonicalizeIndexDdl(tokenizeIndexDefinition(value)).map(token => [token.kind, token.value])
  )

type IndexState = {
  table_name: string
  indisunique: boolean
  indisvalid: boolean
  definition: string
}

async function readIndexState(db: DbClient, name: string): Promise<IndexState | undefined> {
  const result = await db.query(
    `SELECT table_rel.relname AS table_name,
            index_meta.indisunique,
            index_meta.indisvalid,
            pg_get_indexdef(index_meta.indexrelid) AS definition
       FROM pg_class index_rel
       JOIN pg_namespace index_ns ON index_ns.oid = index_rel.relnamespace
       JOIN pg_index index_meta ON index_meta.indexrelid = index_rel.oid
       JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
      WHERE index_ns.nspname = current_schema()
        AND index_rel.relname = $1`,
    [name]
  )
  return result.rows[0] as IndexState | undefined
}

function assertEquivalentIndex(entry: OnlineIndexDefinition, state: IndexState): void {
  if (
    state.table_name !== entry.table ||
    state.indisunique !== Boolean(entry.unique) ||
    canonicalOnlineIndexDefinition(state.definition) !==
      canonicalOnlineIndexDefinition(entry.createSql)
  ) {
    throw new Error(`Non-equivalent existing index: ${entry.name}`)
  }
}

async function withOnlineStatementBound(db: DbClient, work: () => Promise<void>): Promise<void> {
  await db.query(
    `SET statement_timeout = '${MIGRATION_EXECUTION_POLICY.onlineIndexStatementTimeoutMs}ms'`
  )
  try {
    await work()
  } finally {
    await db.query(
      `SET statement_timeout = '${MIGRATION_EXECUTION_POLICY.ordinaryStatementTimeoutMs}ms'`
    )
  }
}

export async function ensureOnlineIndex(db: DbClient, entry: OnlineIndexDefinition): Promise<void> {
  const existing = await readIndexState(db, entry.name)
  if (existing) {
    assertEquivalentIndex(entry, existing)
    if (existing.indisvalid) return
    await withOnlineStatementBound(db, async () => {
      await db.query(`DROP INDEX CONCURRENTLY ${entry.name}`)
    })
  }

  await withOnlineStatementBound(db, async () => {
    await db.query(entry.createSql)
  })
  const created = await readIndexState(db, entry.name)
  if (!created) throw new Error(`Online index was not created: ${entry.name}`)
  assertEquivalentIndex(entry, created)
  if (!created.indisvalid) throw new Error(`Online index is invalid after creation: ${entry.name}`)
}

export async function preparePr1Migration(db: DbClient, version: string): Promise<void> {
  const indexes = PR1_ONLINE_INDEX_PLAN.filter(entry => entry.migrationVersion === version)
  if (indexes.length === 0) return
  for (const index of indexes) await ensureOnlineIndex(db, index)
}
