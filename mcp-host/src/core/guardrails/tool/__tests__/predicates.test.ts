/**
 * Typed predicate tests (spec §6.1). Covers the four predicate types + the
 * documented bypass concerns (command shell-wrapper, path prefix trick, url
 * canonicalization, credentials-in-URL).
 */
import { describe, expect, it } from 'vitest'
import { type ArgumentPredicate, evaluatePredicate, resolvePointer } from '../predicates'

const P = (
  p: Partial<ArgumentPredicate> & Pick<ArgumentPredicate, 'type' | 'pointer' | 'op'>
): ArgumentPredicate => ({ value: undefined, ...p })

describe('resolvePointer (RFC-6901, constrained)', () => {
  it('resolves nested pointers and returns undefined for missing', () => {
    const args = { a: { b: [10, 20] }, 'x/y': 1 }
    expect(resolvePointer(args, '/a/b/1')).toBe(20)
    expect(resolvePointer(args, '/a/missing')).toBeUndefined()
    expect(resolvePointer(args, '/x~1y')).toBe(1) // ~1 → "/"
    expect(resolvePointer(args, '')).toBe(args)
  })
  it('throws on a malformed pointer', () => {
    expect(() => resolvePointer({}, 'no-slash')).toThrow()
  })
})

describe('path predicate', () => {
  it('outside: /etc/passwd is outside /workspace; a workspace path is not', () => {
    const outside = P({ type: 'path', pointer: '/path', op: 'outside', value: '/workspace' })
    expect(evaluatePredicate({ path: '/etc/passwd' }, outside)).toBe(true)
    expect(evaluatePredicate({ path: '/workspace/notes.txt' }, outside)).toBe(false)
  })
  it('under is boundary-safe — no prefix trick', () => {
    const under = P({ type: 'path', pointer: '/path', op: 'under', value: '/workspace' })
    expect(evaluatePredicate({ path: '/workspace/a' }, under)).toBe(true)
    expect(evaluatePredicate({ path: '/workspace-evil/a' }, under)).toBe(false)
  })
  it('resolves .. before containment', () => {
    const under = P({ type: 'path', pointer: '/path', op: 'under', value: '/workspace' })
    expect(evaluatePredicate({ path: '/workspace/../etc/passwd' }, under)).toBe(false)
  })
})

describe('url predicate', () => {
  const scheme = P({ type: 'url', pointer: '/url', op: 'scheme_in', value: ['https'] })
  const host = P({ type: 'url', pointer: '/url', op: 'host_in', value: ['api.github.com'] })
  const port = P({ type: 'url', pointer: '/url', op: 'port_in', value: [443] })

  it('matches scheme/host/port with canonicalization', () => {
    // Uppercase host + trailing dot canonicalize to the allowlisted host.
    expect(evaluatePredicate({ url: 'https://API.GitHub.com./x' }, host)).toBe(true)
    expect(evaluatePredicate({ url: 'https://api.github.com/x' }, scheme)).toBe(true)
    expect(evaluatePredicate({ url: 'https://api.github.com/x' }, port)).toBe(true) // default 443
  })
  it('rejects credentials-in-URL', () => {
    expect(evaluatePredicate({ url: 'https://user:pw@api.github.com/x' }, host)).toBe(false)
  })
  it('non-matching host', () => {
    expect(evaluatePredicate({ url: 'https://evil.example/x' }, host)).toBe(false)
  })
})

describe('command predicate (shell-wrapper caveat)', () => {
  const exeRm = P({ type: 'command', pointer: '/command', op: 'executable_is', value: 'rm' })
  const rf = P({ type: 'command', pointer: '/command', op: 'argv_prefix', value: ['-rf'] })

  it('matches structured rm -rf; basename match for /bin/rm', () => {
    expect(evaluatePredicate({ command: ['rm', '-rf', '/tmp/x'] }, exeRm)).toBe(true)
    expect(evaluatePredicate({ command: ['/bin/rm', '-rf', '/'] }, exeRm)).toBe(true)
    expect(evaluatePredicate({ command: ['rm', '-rf', '/tmp/x'] }, rf)).toBe(true)
    expect(evaluatePredicate({ command: ['rm', '-v', 'file'] }, rf)).toBe(false)
  })
  it('a shell string never matches executable_is (the documented bypass)', () => {
    // `sh -c "rm -rf /"` — argv[0] is sh, so an rm rule does not fire (spec §6.1/§12.3).
    expect(evaluatePredicate({ command: ['sh', '-c', 'rm -rf /'] }, exeRm)).toBe(false)
  })
  it('accepts the {executable, args} shape too', () => {
    expect(evaluatePredicate({ command: { executable: 'rm', args: ['-rf', '/'] } }, exeRm)).toBe(
      true
    )
  })
})

describe('json predicate', () => {
  it('one_of / equals with canonical key order; exists; contains', () => {
    const oneOf = P({
      type: 'json',
      pointer: '/repository',
      op: 'one_of',
      value: ['octo/prod', 'octo/infra'],
    })
    expect(evaluatePredicate({ repository: 'octo/prod' }, oneOf)).toBe(true)
    expect(evaluatePredicate({ repository: 'octo/app' }, oneOf)).toBe(false)

    const eq = P({ type: 'json', pointer: '/o', op: 'equals', value: { a: 1, b: 2 } })
    expect(evaluatePredicate({ o: { b: 2, a: 1 } }, eq)).toBe(true) // key order canonicalized

    const exists = P({ type: 'json', pointer: '/maybe', op: 'exists' })
    expect(evaluatePredicate({ maybe: null }, exists)).toBe(true)
    expect(evaluatePredicate({}, exists)).toBe(false)

    const contains = P({ type: 'json', pointer: '/tags', op: 'contains', value: 'prod' })
    expect(evaluatePredicate({ tags: ['dev', 'prod'] }, contains)).toBe(true)
  })
})

describe('malformed predicate fails closed (throws)', () => {
  it('unknown op throws', () => {
    expect(() =>
      evaluatePredicate({ path: '/x' }, P({ type: 'path', pointer: '/path', op: 'nope' }))
    ).toThrow()
  })
})
