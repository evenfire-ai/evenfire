import { describe, expect, it } from 'vitest'
import { matchTypedGitRead } from '../gitRedirect'

describe('matchTypedGitRead', () => {
  it.each([
    ['git status', 'status'],
    ['git -C service log -3', 'log'],
    ['git --no-pager log -5', 'log'],
    ['cd service && git status', 'status'],
    ['git stash list', 'stash'],
    ["git tag -l 'v1.*'", 'tag'],
    ['git branch --contains abc', 'branch'],
    ['git remote -v', 'remote'],
    ['git remote get-url origin', 'remote'],
    ['git reflog', 'reflog'],
    ['git reflog -10', 'reflog'],
    ['git reflog show', 'reflog'],
    ['git worktree list', 'worktree'],
    ['git branch -a -vv', 'branch'],
    ['git branch --show-current', 'branch'],
    ['git diff HEAD~1 -- a.txt', 'diff'],
  ])('redirects %s', (command, subcommand) => {
    expect(matchTypedGitRead(command)).toEqual({ subcommand })
  })

  it.each([
    'git stash',
    'git branch -d x',
    'git branch x',
    'git tag v1',
    'git remote add o u',
    'git reflog expire',
    'git -c x=y log',
    'git log | head',
    'X=1 git status',
    'git status; rm x',
    'git log $(cat f)',
    'git log `cat f`',
    'git commit -m x',
    'git status > out.txt',
    'git status & rm x',
    'cd a && cd b && git status',
    'cd a && git status && rm x',
    'git --git-dir=x status',
    'git',
    'gitk status',
    'git status\nrm x',
  ])('does not redirect %s', command => {
    expect(matchTypedGitRead(command)).toBeNull()
  })
})
