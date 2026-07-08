/**
 * In-process grep-based full-text search over workspace markdown files.
 *
 * Scoring algorithm:
 * 1. Tokenize query into keywords (lowercase, strip punctuation)
 * 2. For each .md file, split into paragraphs (split on \n\n)
 * 3. For each paragraph, count keyword matches
 * 4. score = matches / totalKeywords (0.0–1.0)
 * 5. Boost: recent daily logs get 1.2x recency multiplier
 * 6. Boost: identity files (MEMORY.md, IDENTITY.md) get 1.1x
 * 7. Return top-N paragraphs sorted by score descending
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { SearchConfig, SearchResult } from './types'

const RECENCY_BOOST_FILES = /^daily\//
const IDENTITY_BOOST_FILES = /^(MEMORY|IDENTITY)\.md$/

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

async function collectMarkdownFiles(
  dir: string,
  base: string,
  excludeTopLevel?: ReadonlySet<string>
): Promise<string[]> {
  const files: string[] = []
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    // Skip excluded top-level dirs (e.g. `users/` on the collective instance)
    // so a collective search never traverses other users' subtrees.
    if (dir === base && excludeTopLevel?.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(base, full)
    if (entry.isDirectory()) {
      const sub = await collectMarkdownFiles(full, base, excludeTopLevel)
      files.push(...sub)
    } else if (entry.name.endsWith('.md')) {
      files.push(rel)
    }
  }
  return files
}

export async function searchWorkspace(
  workspacePath: string,
  query: string,
  config?: Partial<SearchConfig>,
  excludeTopLevel?: readonly string[]
): Promise<SearchResult[]> {
  const limit = config?.limit ?? 10
  const minScore = config?.minScore ?? 0.0

  const keywords = tokenize(query)
  if (keywords.length === 0) return []

  const mdFiles = await collectMarkdownFiles(
    workspacePath,
    workspacePath,
    excludeTopLevel ? new Set(excludeTopLevel) : undefined
  )
  const results: SearchResult[] = []

  for (const relPath of mdFiles) {
    const absPath = path.join(workspacePath, relPath)
    let fileContent: string
    try {
      fileContent = await fs.readFile(absPath, 'utf-8')
    } catch {
      continue
    }

    const paragraphs = fileContent.split(/\n\n+/)
    let lineOffset = 1

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim()
      if (!trimmed) {
        lineOffset += paragraph.split('\n').length
        continue
      }

      const lower = trimmed.toLowerCase()
      const matchCount = keywords.reduce((acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0)

      if (matchCount === 0) {
        lineOffset += paragraph.split('\n').length
        continue
      }

      let score = matchCount / keywords.length

      if (RECENCY_BOOST_FILES.test(relPath)) score = score * 1.2
      if (IDENTITY_BOOST_FILES.test(relPath)) score = score * 1.1

      if (score >= minScore) {
        results.push({
          path: relPath,
          content: trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed,
          score: Math.round(score * 1000) / 1000,
          lineNumber: lineOffset,
        })
      }

      lineOffset += paragraph.split('\n').length
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}
