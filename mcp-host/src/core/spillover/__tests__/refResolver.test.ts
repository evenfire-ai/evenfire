import { describe, expect, it } from 'vitest'
import { buildSpilloverRef, parseSpilloverRef } from '../refResolver'

describe('refResolver', () => {
  describe('buildSpilloverRef', () => {
    it('builds canonical URI for valid segments', () => {
      expect(buildSpilloverRef('task-1', 'call_42')).toBe('spillover://task-1/call_42.json')
    })

    it('rejects taskId with slashes or null bytes', () => {
      expect(() => buildSpilloverRef('a/b', 'c')).toThrow(/Invalid spillover taskId/)
      expect(() => buildSpilloverRef('a\0b', 'c')).toThrow(/Invalid spillover taskId/)
    })

    it('rejects toolCallId with traversal', () => {
      expect(() => buildSpilloverRef('a', '../b')).toThrow(/Invalid spillover toolCallId/)
    })
  })

  describe('parseSpilloverRef', () => {
    it('parses a well-formed URI', () => {
      expect(parseSpilloverRef('spillover://task-1/call_42.json')).toEqual({
        taskId: 'task-1',
        toolCallId: 'call_42',
      })
    })

    it('returns null for non-spillover prefixes', () => {
      expect(parseSpilloverRef('https://example.com')).toBeNull()
      expect(parseSpilloverRef('file:///tmp/x')).toBeNull()
    })

    it('returns null for missing .json suffix', () => {
      expect(parseSpilloverRef('spillover://task-1/call_42')).toBeNull()
    })

    it('returns null for traversal in segments', () => {
      expect(parseSpilloverRef('spillover://../etc/passwd.json')).toBeNull()
      expect(parseSpilloverRef('spillover://task/../etc.json')).toBeNull()
    })

    it('returns null for non-string input', () => {
      expect(parseSpilloverRef(undefined)).toBeNull()
      expect(parseSpilloverRef(null)).toBeNull()
      expect(parseSpilloverRef(42)).toBeNull()
    })
  })
})
