/**
 * The notes-history check fails closed: when the notes listing does not
 * exit cleanly, a content call is refused rather than run without the check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as path from 'path'
import { runPreflight } from '../preflight'
import { type GitSpawn, spawnGit } from '../runner'
import { type Fixture, makeFixture, makeRepo, params, requireGit } from './gitFixtures'

let fx: Fixture
let gitPath: string

beforeAll(() => {
  gitPath = requireGit()
  fx = makeFixture()
  makeRepo(path.join(fx.root, 'r'), 'a.txt', 'a\n')
})

afterAll(() => fx?.cleanup())

const isNotesListing = (argv: readonly string[]): boolean =>
  argv[0] === 'for-each-ref' && argv.includes('refs/notes/')

async function verdictWith(spawn: GitSpawn): Promise<{ result: unknown; listed: number }> {
  let listed = 0
  const counting: GitSpawn = (git, argv, options) => {
    if (isNotesListing(argv)) listed++
    return spawn(git, argv, options)
  }
  const result = await runPreflight({
    root: fx.root,
    verifyCallerRoot: false,
    gitPath,
    params: params({ subcommand: 'show', directory: 'r', revisions: ['HEAD'] }),
    timeoutMs: 10_000,
    spawn: counting,
  })
  return { result, listed }
}

describe('the notes listing fails closed', () => {
  it.each([
    ['exits non-zero', { exitCode: 128, stdout: '', stderr: 'fatal', outcome: 'exited' as const }],
    ['fails to start', { exitCode: null, stdout: '', stderr: '', outcome: 'error' as const }],
    ['ends abnormally', { exitCode: null, stdout: '', stderr: '', outcome: 'failed' as const }],
  ])('a content call is refused when the listing %s', async (_label, failure) => {
    const failing: GitSpawn = (git, argv, options) =>
      isNotesListing(argv) ? Promise.resolve(failure) : spawnGit(git, argv, options)
    expect(await verdictWith(failing)).toEqual({
      result: { kind: 'refused', category: 'preflight_failed' },
      listed: 1,
    })
  })

  it('witness: with a working listing the same call passes the check', async () => {
    const { result, listed } = await verdictWith(spawnGit)
    expect(listed).toBe(1)
    expect(result).toMatchObject({ kind: 'ok' })
  })
})
