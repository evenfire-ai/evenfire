import { describe, expect, it } from 'vitest'
import { buildDbRunChildName } from '../../../src/workflow/childRecipeFactory.js'

/**
 * Spec: docs/architecture/workflow-recipe-naming.md §2.2–2.4.
 *
 * Every child-recipe name must fit in 63 bytes (Kubernetes label value and
 * DNS-1123 label limits). The name is a `<parent-stem>-<short-run-id>`
 * concatenation where short-run-id is the first 8 hex chars of the run
 * UUID, giving the parent stem 54 bytes of headroom.
 */
describe('buildDbRunChildName (canonical taxonomy)', () => {
  const RUN_UUID = '0842f0c5-8611-4d50-9c2b-92cc7c4ffcb6'
  const SHORT_RUN_ID = '0842f0c5'

  it('uses the first 8 hex chars of the run UUID as the suffix', () => {
    const name = buildDbRunChildName('e2e-ondemand-simple', RUN_UUID)
    expect(name).toBe(`e2e-ondemand-simple-${SHORT_RUN_ID}`)
  })

  it('preserves short parent names unchanged', () => {
    const name = buildDbRunChildName('short', RUN_UUID)
    expect(name).toBe(`short-${SHORT_RUN_ID}`)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('always emits ≤ 63 bytes for production-sized parent names', () => {
    const cases = [
      'e2e-ondemand-simple', // 19
      'competitive-intel-report', // 24
      'research-summary-workflow', // 25
      'enterprise-ai-orchestration-platform-benchmark', // 46
      'autonomous-code-review-tooling-marketplace-sweep', // 48
      'a'.repeat(54), // exactly at the 54-byte parent budget
      'a'.repeat(55), // one byte over — must be trimmed to 54
      'a'.repeat(120), // pathological length
    ]
    for (const parent of cases) {
      const name = buildDbRunChildName(parent, RUN_UUID)
      expect(name.length, `parent="${parent}" produced "${name}"`).toBeLessThanOrEqual(63)
    }
  })

  it('trims a trailing hyphen on the parent stem to avoid double-dashes', () => {
    // Parent of 55 chars where char 55 is '-' — the truncation to 54 would
    // otherwise leave `foo-` + `-` + suffix = `foo--<suffix>`.
    const parent = 'pre-fix-with-trailing-dash-' + 'x'.repeat(28)
    const name = buildDbRunChildName(parent, RUN_UUID)
    expect(name).not.toContain('--')
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('lowercases the run-id suffix', () => {
    const upperUuid = '0842F0C5-8611-4D50-9C2B-92CC7C4FFCB6'
    const name = buildDbRunChildName('parent', upperUuid)
    expect(name.endsWith(`-${SHORT_RUN_ID}`)).toBe(true)
  })

  it('falls back to the literal "workflow" when the parent truncates to empty', () => {
    // Parent is 56 hyphens — truncated to 54 hyphens, trailing-dash strip
    // leaves an empty string → `workflow` fallback per §2.4.
    const parent = '-'.repeat(56)
    const name = buildDbRunChildName(parent, RUN_UUID)
    expect(name).toBe(`workflow-${SHORT_RUN_ID}`)
  })

  it('is deterministic: same (parent, run) always produces the same name', () => {
    const a = buildDbRunChildName('competitive-intel-report', RUN_UUID)
    const b = buildDbRunChildName('competitive-intel-report', RUN_UUID)
    expect(a).toBe(b)
  })

  it('different run IDs produce different suffixes even for the same parent', () => {
    const a = buildDbRunChildName('parent', '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    const b = buildDbRunChildName('parent', '22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    expect(a).not.toBe(b)
    expect(a).toBe('parent-11111111')
    expect(b).toBe('parent-22222222')
  })
})
