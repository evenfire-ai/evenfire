/**
 * P5: the alternates reader. Each row writes `.git/objects/info/alternates`
 * in a workspace repository, runs real git under git_read's environment as
 * the control (does it print an object that lives only outside the root?),
 * and then the preflight.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { runPreflight } from '../preflight'
import { spawnGit } from '../runner'
import {
  type Fixture,
  controlGit,
  gitw,
  makeFixture,
  makeRepo,
  params,
  requireGit,
} from './gitFixtures'

let fx: Fixture
let gitPath: string
let main: string
let mainObjects: string
let outsideObjects: string
let outsideBlob: string
let insideStore: string
let protectedStore: string

const alternatesFile = (): string => path.join(mainObjects, 'info', 'alternates')

async function verdict(): Promise<string> {
  const result = await runPreflight({
    root: fx.root,
    verifyCallerRoot: false,
    gitPath,
    params: params({ subcommand: 'status', directory: 'repo' }),
    timeoutMs: 10_000,
    spawn: spawnGit,
  })
  return result.kind === 'refused' ? result.category : result.kind
}

function leaks(): boolean {
  return controlGit(fx.root, main, 'cat-file', '-p', outsideBlob).out.includes('SECRET-OBJ')
}

async function row(content: string): Promise<{ control: boolean; verdict: string }> {
  fs.mkdirSync(path.dirname(alternatesFile()), { recursive: true })
  fs.writeFileSync(alternatesFile(), content)
  try {
    return { control: leaks(), verdict: await verdict() }
  } finally {
    fs.rmSync(alternatesFile(), { force: true })
  }
}

function copyStore(destination: string): string {
  fs.cpSync(outsideObjects, destination, { recursive: true })
  return fs.realpathSync(destination)
}

const rel = (to: string): string => path.relative(mainObjects, to)

beforeAll(() => {
  gitPath = requireGit()
  fx = makeFixture()
  outsideBlob = makeRepo(path.join(fx.outside, 'repo'), 's', 'SECRET-OBJ\n')
  outsideObjects = fs.realpathSync(path.join(fx.outside, 'repo', '.git', 'objects'))
  main = path.join(fx.root, 'repo')
  makeRepo(main, 'x', 'WITNESS-MAIN\n')
  mainObjects = fs.realpathSync(path.join(main, '.git', 'objects'))
  insideStore = copyStore(path.join(fx.root, 'shared', 'objects'))
  protectedStore = copyStore(path.join(fx.root, '.clerum-state', 'store', 'objects'))
})

afterAll(() => fx?.cleanup())

describe('git_read alternates reader (P5)', () => {
  it('no alternates file: the control does not leak and the preflight passes', async () => {
    expect(leaks()).toBe(false)
    expect(await verdict()).toBe('ok')
  })

  it('an absolute outside entry is refused', async () => {
    expect(await row(`${outsideObjects}\n`)).toEqual({
      control: true,
      verdict: 'directory_outside_workspace',
    })
  })

  it('an entry relative to the objects dir that leaves the root is refused', async () => {
    expect(await row(`${rel(outsideObjects)}\n`)).toEqual({
      control: true,
      verdict: 'directory_outside_workspace',
    })
  })

  it('a comment line followed by an outside entry is refused', async () => {
    expect(await row(`# c\n${outsideObjects}\n`)).toEqual({
      control: true,
      verdict: 'directory_outside_workspace',
    })
  })

  it('an outside entry after 2 KB of comments, with a trailing slash or no final newline is refused', async () => {
    for (const content of [
      `${'#'.repeat(80)}\n`.repeat(26) + `${outsideObjects}\n`,
      `${outsideObjects}/\n`,
      outsideObjects,
    ]) {
      expect(await row(content)).toEqual({ control: true, verdict: 'directory_outside_workspace' })
    }
  })

  it('a C-quoted outside entry is refused', async () => {
    expect(await row(`"${outsideObjects}"\n`)).toEqual({
      control: true,
      verdict: 'alternates_unsupported',
    })
    const octal = outsideObjects.replace('outside', 'out\\163ide')
    expect(await row(`"${octal}"\n`)).toEqual({ control: true, verdict: 'alternates_unsupported' })
    expect(await row(`"${outsideObjects}\n${outsideObjects}\n`)).toEqual({
      control: true,
      verdict: 'alternates_unsupported',
    })
  })

  it('a nonexistent entry followed by an outside entry is refused', async () => {
    expect(await row(`/nonexistent-git-read/objects\n${outsideObjects}\n`)).toEqual({
      control: true,
      verdict: 'directory_outside_workspace',
    })
  })

  it('a whitespace-only line, CRLF and a leading space are refused', async () => {
    expect(await row(` \n${outsideObjects}\n`)).toEqual({
      control: true,
      verdict: 'alternates_unsupported',
    })
    expect((await row(`${outsideObjects}\r\n`)).verdict).toBe('alternates_unsupported')
    expect((await row(` ${outsideObjects}\n`)).verdict).toBe('alternates_unsupported')
  })

  it('an alternates file over 64 KiB is refused', async () => {
    const big = `${'#'.repeat(1023)}\n`.repeat(65) + `${insideStore}\n`
    expect((await row(big)).verdict).toBe('alternates_unsupported')
  })

  it('an alternates file that is a link or a directory is refused', async () => {
    const target = path.join(fx.root, 'alt-target')
    fs.writeFileSync(target, `${insideStore}\n`)
    fs.symlinkSync(target, alternatesFile())
    try {
      expect(await verdict()).toBe('alternates_unsupported')
    } finally {
      fs.rmSync(alternatesFile(), { force: true })
    }
    fs.mkdirSync(alternatesFile())
    try {
      expect(await verdict()).toBe('alternates_unsupported')
    } finally {
      fs.rmSync(alternatesFile(), { recursive: true, force: true })
    }
  })

  it('a protected store inside the root is refused', async () => {
    expect(await row(`${protectedStore}\n`)).toEqual({
      control: true,
      verdict: 'directory_protected',
    })
  })

  it('an inside alternate and a cycle are accepted', async () => {
    expect(await row(`${insideStore}\n`)).toEqual({ control: true, verdict: 'ok' })
    expect(await row(`${rel(insideStore)}\n`)).toEqual({ control: true, verdict: 'ok' })
    fs.mkdirSync(path.join(insideStore, 'info'), { recursive: true })
    fs.writeFileSync(path.join(insideStore, 'info', 'alternates'), `${mainObjects}\n`)
    try {
      expect((await row(`${insideStore}\n`)).verdict).toBe('ok')
    } finally {
      fs.rmSync(path.join(insideStore, 'info', 'alternates'))
    }
  })

  it('a nested alternate leaving the root is refused, absolute or relative to the nested store', async () => {
    const nested = path.join(insideStore, 'info', 'alternates')
    fs.mkdirSync(path.dirname(nested), { recursive: true })
    try {
      fs.writeFileSync(nested, `${outsideObjects}\n`)
      expect((await row(`${insideStore}\n`)).verdict).toBe('directory_outside_workspace')
      fs.writeFileSync(nested, `${path.relative(insideStore, outsideObjects)}\n`)
      expect(await row(`${insideStore}\n`)).toEqual({
        control: true,
        verdict: 'directory_outside_workspace',
      })
    } finally {
      fs.rmSync(nested, { force: true })
    }
  })

  function chain(count: number): string[] {
    const base = path.join(fx.root, 'chain')
    fs.rmSync(base, { recursive: true, force: true })
    const stores: string[] = []
    for (let i = 1; i <= count; i++) {
      const dir = path.join(base, `s${i}`, 'objects')
      fs.mkdirSync(path.join(dir, 'info'), { recursive: true })
      stores.push(fs.realpathSync(dir))
    }
    for (let i = 0; i < count - 1; i++) {
      fs.writeFileSync(path.join(stores[i], 'info', 'alternates'), `${stores[i + 1]}\n`)
    }
    return stores
  }

  it('a chain of 6 inside stores is accepted', async () => {
    const stores = chain(6)
    fs.cpSync(outsideObjects, stores[5], { recursive: true })
    expect(await row(`${stores[0]}\n`)).toEqual({ control: true, verdict: 'ok' })
  })

  it('a depth-6 alternates file is refused', async () => {
    const stores = chain(7)
    fs.cpSync(outsideObjects, stores[6], { recursive: true })
    // Git ignores the depth-6 file ("nesting too deep"); git_read refuses instead.
    expect(await row(`${stores[0]}\n`)).toEqual({
      control: false,
      verdict: 'alternates_unsupported',
    })
    const six = chain(6)
    fs.writeFileSync(path.join(six[5], 'info', 'alternates'), `${outsideObjects}\n`)
    expect(await row(`${six[0]}\n`)).toEqual({ control: false, verdict: 'alternates_unsupported' })
  })

  it('a chain of 5 whose last file lists an outside store is refused', async () => {
    const stores = chain(5)
    fs.writeFileSync(path.join(stores[4], 'info', 'alternates'), `${outsideObjects}\n`)
    expect(await row(`${stores[0]}\n`)).toEqual({
      control: true,
      verdict: 'directory_outside_workspace',
    })
  })

  it('an alternates file that cannot be lstat-ed for another reason is unreadable', async () => {
    // objects/info as a link to itself: lstat of info/alternates fails with
    // ELOOP for any user, root included.
    const info = path.join(mainObjects, 'info')
    const saved = path.join(mainObjects, 'info.saved')
    fs.renameSync(info, saved)
    fs.symlinkSync(info, info)
    try {
      expect(await verdict()).toBe('alternates_unreadable')
    } finally {
      fs.rmSync(info)
      fs.renameSync(saved, info)
    }
  })

  it('the alternates cap is exactly 64 KiB', async () => {
    const entry = `${insideStore}\n`
    const pad = (size: number): string => `${'#'.repeat(size - entry.length - 1)}\n${entry}`
    expect(Buffer.byteLength(pad(65_536))).toBe(65_536)
    expect((await row(pad(65_536))).verdict).toBe('ok')
    expect((await row(pad(65_537))).verdict).toBe('alternates_unsupported')
  })

  it('setup sanity: the fixture repository works under git_read', () => {
    expect(gitw(main, 'cat-file', '-p', 'HEAD:x')).toBe('WITNESS-MAIN\n')
  })
})
