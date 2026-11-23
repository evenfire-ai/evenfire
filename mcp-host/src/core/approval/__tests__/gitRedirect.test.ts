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
  ])('matches %s', (command, subcommand) => {
    expect(matchTypedGitRead(command)).toMatchObject({ subcommand })
  })

  it.each([
    ['git status', false],
    ['git log -3', false],
    ['git log --oneline --stat', false],
    ['git --no-pager log -5', false],
    ['git branch -a -vv', false],
    ['git show', true],
    ['git diff HEAD~1 -- a.txt', true],
    ['git grep -n TODO', true],
    ['git blame a.txt', true],
    ['git cat-file -p HEAD', true],
    ['git log -p', true],
    ['git log -3p', true],
    ['git log --patch', true],
    ['git log -U0', true],
    ['git log -S needle', true],
    ['git log -Gx', true],
    ['git log --word-diff', true],
    ['git log -L 1,2:a.txt', true],
    ['git log --cc', true],
  ])('%s returns content: %s', (command, content) => {
    expect(matchTypedGitRead(command)?.content).toBe(content)
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
    'cd a&&b&&c && git log',
    'git log < f',
    'git branch -D x',
    'git tag -d v1',
    'git tag -v v1',
    'git tag -v',
    'git branch --contains',
    'git branch --set-upstream-to=x',
    'git diff --output=x',
    'git log --output=out.txt -p',
  ])('does not redirect %s', command => {
    expect(matchTypedGitRead(command)).toBeNull()
  })
})
