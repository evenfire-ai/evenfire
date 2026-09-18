import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ToolNameMap } from '../src/toolNameMap.js'

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, createHash: vi.fn(actual.createHash) }
})

describe('ToolNameMap', () => {
  it('preserves compliant names and reverses opaque canonical names', () => {
    const names = [
      'tool_A-2',
      'x'.repeat(64),
      'files.read',
      'mcp:lookup',
      'x'.repeat(129),
      'tool name',
      '工具@read',
    ]
    const map = new ToolNameMap(names)
    for (const name of names) {
      expect(map.toWire(name)).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(map.fromWire(map.toWire(name))).toBe(name)
    }
    expect(map.toWire(names[0])).toBe(names[0])
    expect(map.toWire(names[1])).toBe(names[1])
    expect(new Set(names.map(name => map.toWire(name))).size).toBe(names.length)
  })
  it('is stable across order, duplicate history, and unrelated inventory additions', () => {
    const names = ['files.read', 'history:removed', 'safe']
    const first = new ToolNameMap(names)
    const next = new ToolNameMap(['other:new', ...names.toReversed(), ...names])
    for (const name of names) expect(next.toWire(name)).toBe(first.toWire(name))
  })
  it('reserves legitimate alias-shaped canonical names and occupied suffixes', () => {
    const canonical = 'files.read'
    const base = new ToolNameMap([canonical]).toWire(canonical)
    const names = [canonical, base, `${base}_0`, `${base}_1`]
    const first = new ToolNameMap(names)
    const reversed = new ToolNameMap(names.toReversed())
    expect(first.toWire(canonical)).toBe(`${base}_2`)
    for (const name of names) {
      expect(first.fromWire(first.toWire(name))).toBe(name)
      expect(reversed.toWire(name)).toBe(first.toWire(name))
    }
    expect(first.toWire(base)).toBe(base)
  })
  it('resolves hash collisions with distinct bounded candidates', () => {
    const hash = { update: () => hash, digest: () => 'a'.repeat(64) }
    vi.mocked(createHash).mockReturnValueOnce(hash as unknown as ReturnType<typeof createHash>)
    vi.mocked(createHash).mockReturnValueOnce(hash as unknown as ReturnType<typeof createHash>)
    const map = new ToolNameMap(['a.b', 'a:b'])
    expect(map.toWire('a:b')).toBe(`${map.toWire('a.b')}_0`)
    expect(map.fromWire(map.toWire('a.b'))).toBe('a.b')
    expect(map.fromWire(map.toWire('a:b'))).toBe('a:b')
  })
  it('accepts exact registered canonical echoes', () => {
    const name = '工具@read record'
    const map = new ToolNameMap([name])
    expect(map.fromWire(name)).toBe(name)
    expect(map.fromWire(`${name} extra`)).toBeUndefined()
  })
  it('does not manufacture canonical targets from unknown aliases or unsafe names', () => {
    const map = new ToolNameMap(['files.read'])
    expect(map.fromWire('__grok_tool_unknown')).toBeUndefined()
    expect(map.fromWire('unknown.read')).toBeUndefined()
    expect(map.fromWire('ordinary_unknown')).toBe('ordinary_unknown')
    expect(() => map.toWire('missing')).toThrow('Unknown canonical tool name')
  })
})
