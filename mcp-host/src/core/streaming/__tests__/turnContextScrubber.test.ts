import { describe, expect, it } from 'vitest'
import { TurnContextScrubber } from '../turnContextScrubber'

describe('TurnContextScrubber (T2.2)', () => {
  it('strips a complete fence inside a single chunk', () => {
    const s = new TurnContextScrubber()
    expect(s.process('pre<turn-context>foo</turn-context>post')).toBe('prepost')
    expect(s.flush()).toBe('')
  })

  it('strips a fence whose marker is split across chunks (open)', () => {
    const s = new TurnContextScrubber()
    let out = ''
    out += s.process('pre<turn-c')
    out += s.process('ontext>foo</turn-context>post')
    out += s.flush()
    expect(out).toBe('prepost')
  })

  it('strips a fence whose close is split across chunks', () => {
    const s = new TurnContextScrubber()
    let out = ''
    out += s.process('pre<turn-context>foo</turn-cont')
    out += s.process('ext>post')
    out += s.flush()
    expect(out).toBe('prepost')
  })

  it('drops content of an unclosed fence on flush', () => {
    const s = new TurnContextScrubber()
    let out = ''
    out += s.process('pre<turn-context>foo')
    out += s.flush()
    expect(out).toBe('pre')
  })

  it('emits passthrough when there is no fence', () => {
    const s = new TurnContextScrubber()
    expect(s.process('hello world')).toBe('hello world')
    expect(s.flush()).toBe('')
  })

  it('handles multiple sequential fences', () => {
    const s = new TurnContextScrubber()
    const input = 'a<turn-context>x</turn-context>b<turn-context>y</turn-context>c'
    let out = ''
    out += s.process(input)
    out += s.flush()
    expect(out).toBe('abc')
  })

  it('holds back a prefix-of-open at chunk boundary so it does not leak', () => {
    const s = new TurnContextScrubber()
    let out = ''
    out += s.process('hello <turn-')
    // <turn- is a prefix of <turn-context> — should be buffered, not emitted yet.
    expect(out).toBe('hello ')
    out += s.process('context>secret</turn-context>!')
    out += s.flush()
    expect(out).toBe('hello !')
  })
})
