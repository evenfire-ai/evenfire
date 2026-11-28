import { describe, expect, it, vi } from 'vitest'
import {
  GIT_READ_MIN_VERSION,
  type GitProbeDeps,
  parseGitVersion,
  probeGitReadWith,
} from '../probe'

const ROOT_DIR = { uid: 0, mode: 0o40755 }
const ROOT_BIN = { uid: 0, mode: 0o100755 }

function deps(overrides: Partial<GitProbeDeps> = {}): GitProbeDeps {
  return {
    exists: file => file === '/usr/bin/git',
    realpath: file => file,
    stat: file => (file === '/usr/bin' ? ROOT_DIR : ROOT_BIN),
    version: () => 'git version 2.39.5\n',
    ...overrides,
  }
}

describe('parseGitVersion', () => {
  it('reads plain, Apple and newer banners and rejects anything else', () => {
    expect(parseGitVersion('git version 2.39.5\n')).toEqual([2, 39, 5])
    expect(parseGitVersion('git version 2.50.1 (Apple Git-155)\n')).toEqual([2, 50, 1])
    expect(parseGitVersion('git version 2.55.0')).toEqual([2, 55, 0])
    expect(parseGitVersion('version 2.39.5')).toBeNull()
    expect(parseGitVersion('git version 2.39')).toBeNull()
  })
})

describe('probeGitReadWith', () => {
  it('the floor is 2.38.0: 2.37.7 is too old, 2.38.0 and newer are available', () => {
    expect(GIT_READ_MIN_VERSION).toEqual([2, 38, 0])
    expect(probeGitReadWith(deps({ version: () => 'git version 2.37.7\n' }))).toEqual({
      available: false,
      reason: 'too_old',
    })
    for (const [banner, version] of [
      ['git version 2.38.0\n', [2, 38, 0]],
      ['git version 2.39.5\n', [2, 39, 5]],
      ['git version 2.50.1 (Apple Git-155)\n', [2, 50, 1]],
      ['git version 2.55.0\n', [2, 55, 0]],
      ['git version 3.0.0\n', [3, 0, 0]],
    ] as const) {
      expect(probeGitReadWith(deps({ version: () => banner }))).toEqual({
        available: true,
        gitPath: '/usr/bin/git',
        version,
      })
    }
  })

  it('takes /usr/bin/git first, then /bin/git, and nothing else', () => {
    expect(probeGitReadWith(deps({ exists: () => false }))).toEqual({
      available: false,
      reason: 'absent',
    })
    expect(
      probeGitReadWith(
        deps({
          exists: file => file === '/bin/git',
          stat: file => (file === '/bin' ? ROOT_DIR : ROOT_BIN),
        })
      )
    ).toMatchObject({ available: true, gitPath: '/bin/git' })
    const checked: string[] = []
    probeGitReadWith(
      deps({
        exists: file => {
          checked.push(file)
          return false
        },
      })
    )
    expect(checked).toEqual(['/usr/bin/git', '/bin/git'])
  })

  it('runs the realpath of the binary and checks that file and its directory', () => {
    const stat = vi.fn((file: string) => (file === '/usr/libexec/git-core' ? ROOT_DIR : ROOT_BIN))
    const version = vi.fn(() => 'git version 2.39.5\n')
    expect(
      probeGitReadWith(deps({ realpath: () => '/usr/libexec/git-core/git', stat, version }))
    ).toEqual({ available: true, gitPath: '/usr/libexec/git-core/git', version: [2, 39, 5] })
    expect(stat.mock.calls.map(([file]) => file)).toEqual([
      '/usr/libexec/git-core/git',
      '/usr/libexec/git-core',
    ])
    expect(version).toHaveBeenCalledWith('/usr/libexec/git-core/git')
  })

  it('a binary or directory not owned by root, or group or other writable, is unsafe', () => {
    const version = vi.fn(() => 'git version 2.39.5\n')
    const cases: Array<(file: string) => { uid: number; mode: number }> = [
      file => (file === '/usr/bin' ? ROOT_DIR : { uid: 0, mode: 0o100775 }),
      file => (file === '/usr/bin' ? ROOT_DIR : { uid: 0, mode: 0o100757 }),
      file => (file === '/usr/bin' ? ROOT_DIR : { uid: 1000, mode: 0o100755 }),
      file => (file === '/usr/bin' ? { uid: 0, mode: 0o40777 } : ROOT_BIN),
      file => (file === '/usr/bin' ? { uid: 501, mode: 0o40755 } : ROOT_BIN),
    ]
    for (const stat of cases) {
      expect(probeGitReadWith(deps({ stat, version }))).toEqual({
        available: false,
        reason: 'unsafe_owner',
      })
    }
    expect(version).not.toHaveBeenCalled()
    expect(probeGitReadWith(deps({ version }))).toMatchObject({ available: true })
    expect(version).toHaveBeenCalledTimes(1)
  })

  it('a spawn error, a timeout or an unreadable banner is probe_failed', () => {
    const timeout = Object.assign(new Error('spawnSync /usr/bin/git ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    })
    expect(
      probeGitReadWith(
        deps({
          version: () => {
            throw timeout
          },
        })
      )
    ).toEqual({ available: false, reason: 'probe_failed' })
    expect(probeGitReadWith(deps({ version: () => 'xcrun: error: no developer tools' }))).toEqual({
      available: false,
      reason: 'probe_failed',
    })
    expect(
      probeGitReadWith(
        deps({
          realpath: () => {
            throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
          },
        })
      )
    ).toEqual({ available: false, reason: 'probe_failed' })
  })
})

describe('probeGitRead', () => {
  it('spawns git once for any number of calls', async () => {
    // A fresh module, so the memo starts empty without a test-only reset.
    vi.resetModules()
    const { probeGitRead } = await import('../probe')
    const version = vi.fn(() => 'git version 2.39.5\n')
    const first = probeGitRead(deps({ version }))
    const second = probeGitRead(deps({ version }))
    expect(second).toBe(first)
    expect(version).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ available: true })
  })
})
