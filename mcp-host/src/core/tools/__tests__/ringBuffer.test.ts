import { describe, expect, it } from 'vitest'
import { RingBuffer } from '../ringBuffer'

describe('RingBuffer', () => {
  it('returns empty contents and empty snapshot when no data has been appended', () => {
    const buf = new RingBuffer(1024)
    expect(buf.contents()).toBe('')
    expect(buf.snapshot()).toBe('')
  })

  it('returns concatenated chunks within capacity', () => {
    const buf = new RingBuffer(1024)
    buf.append('hello\n')
    buf.append('world\n')
    expect(buf.contents()).toBe('hello\nworld\n')
  })

  it('snapshot() returns contents and clears the dirty flag', () => {
    const buf = new RingBuffer(1024)
    buf.append('a\n')
    expect(buf.snapshot()).toBe('a\n')
    // No new append → snapshot returns empty (not dirty).
    expect(buf.snapshot()).toBe('')
  })

  it('snapshot() returns empty immediately when nothing appended since last snapshot()', () => {
    const buf = new RingBuffer(1024)
    buf.append('a\n')
    buf.snapshot() // consumes dirty flag
    expect(buf.snapshot()).toBe('')
    buf.append('b\n')
    expect(buf.snapshot()).toBe('a\nb\n')
  })

  it('contents() returns content regardless of dirty flag state', () => {
    const buf = new RingBuffer(1024)
    buf.append('data\n')
    buf.snapshot() // clears dirty
    expect(buf.contents()).toBe('data\n') // still returns everything
  })

  it('evicts oldest chunks when capacity is exceeded', () => {
    // Each chunk is 16 bytes. Capacity 32 bytes → at most 2 chunks retained after append of a 3rd.
    const buf = new RingBuffer(32)
    buf.append('AAAAAAAAAAAAAAA\n') // 16 bytes (15 A's + \n)
    buf.append('BBBBBBBBBBBBBBB\n') // 16 bytes
    buf.append('CCCCCCCCCCCCCCC\n') // 16 bytes — triggers eviction
    // Oldest ("AAAA...") is evicted; buffer retains last 2 chunks.
    expect(buf.contents()).not.toContain('A')
    expect(buf.contents()).toContain('B')
    expect(buf.contents()).toContain('C')
  })

  it('preserves line boundaries after eviction — buffer never starts mid-line', () => {
    // Append a big chunk that will be evicted, then a chunk that starts mid-line.
    // The head-trim logic must cut the new head at its first newline.
    const buf = new RingBuffer(10)
    buf.append('firstline\n') // 10 bytes exactly
    buf.append('partOfLine1moreText\nnewline\n') // append triggers eviction of "firstline\n"
    // After eviction, head chunk "partOfLine1moreText\nnewline\n" must be trimmed
    // at its first newline, so contents() starts with "newline\n".
    const contents = buf.contents()
    expect(contents.startsWith('newline\n')).toBe(true)
    expect(contents).not.toContain('partOfLine1')
  })

  it('leaves head unchanged when new head chunk has no newline', () => {
    // Edge case: if the head chunk has no newline at all, leave it — eventually
    // another newline-bearing chunk will arrive and alignment will recover.
    const buf = new RingBuffer(10)
    buf.append('firstline\n')
    buf.append('noNewlineHere') // triggers eviction; head now has no \n
    // Content should include the chunk as-is (no trim because no newline to align at).
    const contents = buf.contents()
    expect(contents).toBe('noNewlineHere')
  })

  it('handles multi-byte UTF-8 correctly in the byte accounting', () => {
    // 'é' is 2 bytes in UTF-8.
    const buf = new RingBuffer(10)
    buf.append('éé\n') // 2 + 2 + 1 = 5 bytes
    buf.append('éé\n') // 5 bytes — total 10, still within cap
    buf.append('x\n') // 2 bytes — triggers eviction
    // Verify the buffer didn't panic on multibyte boundary accounting.
    expect(buf.contents().length).toBeGreaterThan(0)
  })
})
