/**
 * T1.1 — unit tests for the structured summary parser
 * (`core/conversation/structuredSummaryParser.ts`). Cases mirror the plan
 * §6.4 table; one test per row plus a couple of edge cases.
 */
import { describe, expect, it } from 'vitest'
import { parseStructuredSummary } from '../structuredSummaryParser'

const FULL_TEMPLATE = `## Active Task
Refactor the auth middleware.

## Goal
Ship the rewrite without breaking existing tokens.

## Constraints & Preferences
- No breaking changes to the public API.
- Prefer pure functions.

## Completed Actions
1. [shell_exec] ran 'npm test' → exit 0
2. [fs_read] read auth.ts
3. [fs_write] updated middleware.ts

## Active State
middleware.ts open, npm test green.

## In Progress
Wiring the new token validator.

## Blocked
Waiting for product to confirm the deprecation window.

## Key Decisions
Use jose for JWT verification (not jsonwebtoken).

## Resolved Questions
RS256 is the canonical algorithm.

## Pending User Asks
Confirm whether HS256 fallback should stay.

## Relevant Files
- src/auth/middleware.ts
- src/auth/tokenValidator.ts

## Remaining Work
Wire the validator into the request pipeline.

## Critical Context
The previous middleware leaked tokens via console.error.

## Memory Writes (verbatim)
MEMORY.md: § User prefers jose over jsonwebtoken.
§ Project uses Vitest for unit tests.`

describe('parseStructuredSummary', () => {
  it('parses full template with all sections', () => {
    const parsed = parseStructuredSummary(FULL_TEMPLATE)
    expect(parsed.parseStatus).toBe('ok')
    expect(parsed.activeTask).toBe('Refactor the auth middleware.')
    expect(parsed.goal).toBe('Ship the rewrite without breaking existing tokens.')
    expect(parsed.constraintsAndPreferences).toContain('No breaking changes')
    expect(parsed.completedActions).toHaveLength(3)
    expect(parsed.completedActions[0]).toBe("[shell_exec] ran 'npm test' → exit 0")
    expect(parsed.activeState).toContain('middleware.ts open')
    expect(parsed.inProgress).toBe('Wiring the new token validator.')
    expect(parsed.blocked).toContain('Waiting for product')
    expect(parsed.keyDecisions).toContain('Use jose')
    expect(parsed.resolvedQuestions).toContain('RS256')
    expect(parsed.pendingUserAsks).toContain('HS256 fallback')
    expect(parsed.relevantFiles).toEqual(['src/auth/middleware.ts', 'src/auth/tokenValidator.ts'])
    expect(parsed.remainingWork).toContain('Wire the validator')
    expect(parsed.criticalContext).toContain('leaked tokens')
    expect(parsed.memoryWrites).toContain('MEMORY.md')
    expect(parsed.memoryWrites).toContain('jose over jsonwebtoken')
    expect(parsed.warnings).toHaveLength(0)
  })

  it('parses partial template (only Active Task)', () => {
    const parsed = parseStructuredSummary('## Active Task\nDo X\n')
    expect(parsed.parseStatus).toBe('partial')
    expect(parsed.activeTask).toBe('Do X')
    expect(parsed.goal).toBeNull()
    expect(parsed.completedActions).toEqual([])
  })

  it('falls back when LLM returns prose without headers', () => {
    const raw = "Sure! Here's a summary: the user asked us to refactor and we did Y."
    const parsed = parseStructuredSummary(raw)
    expect(parsed.parseStatus).toBe('fallback')
    expect(parsed.rawBody).toBe(raw)
    expect(parsed.activeTask).toBeNull()
  })

  it('parses Memory Writes strictly when anchored to MEMORY.md', () => {
    const raw = `## Active Task\nDo X\n\n## Memory Writes (verbatim)\nMEMORY.md: User prefers TypeScript.`
    const parsed = parseStructuredSummary(raw)
    expect(parsed.memoryWrites).toBe('MEMORY.md: User prefers TypeScript.')
    expect(parsed.warnings).toHaveLength(0)
  })

  it('warns on malformed Memory Writes (paraphrase without anchor)', () => {
    const raw = `## Active Task\nDo X\n\n## Memory Writes\n(memory was updated, see above)`
    const parsed = parseStructuredSummary(raw)
    expect(parsed.memoryWrites).toBeNull()
    expect(parsed.warnings).toContain('memory_writes_no_anchor')
  })

  it('tolerates extra whitespace in headers', () => {
    const raw = `##   Active Task   \nDo something.`
    const parsed = parseStructuredSummary(raw)
    expect(parsed.activeTask).toBe('Do something.')
  })

  it('matches case-insensitive headers', () => {
    const raw = `## active task\nDo something.`
    const parsed = parseStructuredSummary(raw)
    expect(parsed.activeTask).toBe('Do something.')
  })

  it('parses Completed Actions as a numbered list', () => {
    const raw = `## Completed Actions\n1. a\n2. b\n3. c`
    const parsed = parseStructuredSummary(raw)
    expect(parsed.completedActions).toEqual(['a', 'b', 'c'])
  })

  it('parses Relevant Files as a bullet list', () => {
    const raw = `## Relevant Files\n- src/foo.ts\n- src/bar.ts`
    const parsed = parseStructuredSummary(raw)
    expect(parsed.relevantFiles).toEqual(['src/foo.ts', 'src/bar.ts'])
  })

  it('accepts "Constraints & Preferences" with ampersand', () => {
    const raw = `## Constraints & Preferences\nKeep changes minimal.`
    const parsed = parseStructuredSummary(raw)
    expect(parsed.constraintsAndPreferences).toBe('Keep changes minimal.')
  })

  it('parses Memory Writes anchored to USER.md as well', () => {
    const raw = `## Memory Writes\nUSER.md: § sender prefers concise replies`
    const parsed = parseStructuredSummary(raw)
    expect(parsed.memoryWrites).toContain('USER.md')
    expect(parsed.warnings).toHaveLength(0)
  })

  it('warns when Memory Writes section is present but empty', () => {
    const raw = `## Memory Writes\n`
    const parsed = parseStructuredSummary(raw)
    expect(parsed.memoryWrites).toBeNull()
    expect(parsed.warnings).toContain('memory_writes_empty')
  })

  it('keeps rawBody equal to the input regardless of parse status', () => {
    const parsed = parseStructuredSummary(FULL_TEMPLATE)
    expect(parsed.rawBody).toBe(FULL_TEMPLATE)
  })
})
