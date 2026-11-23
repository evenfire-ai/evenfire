/**
 * The environment of every git process `git_read` starts, including the probe.
 *
 * It is a literal: nothing comes from `process.env`, the Host's env allowlist
 * or the ConfigStore. So `GIT_CONFIG_PARAMETERS`, `GIT_DIR`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_OBJECT_DIRECTORY` and credential
 * variables never reach git.
 */

/**
 * Config keys forced through `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`. They
 * stop git from running programs (fsmonitor, hooks, pager, ssh, signing,
 * alternate-refs commands), from recursing into submodules, from using any
 * transport, and from rewriting the index on a worktree diff
 * (`diff.autoRefreshIndex`; `GIT_OPTIONAL_LOCKS=0` covers only status).
 * `diff.external` is not forced: an empty value breaks `git diff`.
 */
export const GIT_READ_FORCED_KEYS: readonly (readonly [string, string])[] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['core.sshCommand', 'false'],
  ['core.alternateRefsCommand', 'false'],
  ['submodule.recurse', 'false'],
  ['status.submoduleSummary', 'false'],
  ['log.showSignature', 'false'],
  ['gpg.program', 'false'],
  ['protocol.allow', 'never'],
  ['protocol.ext.allow', 'never'],
  ['protocol.file.allow', 'never'],
  ['safe.bareRepository', 'explicit'],
  ['diff.autoRefreshIndex', 'false'],
]

/**
 * The environment for one git process. `ceiling` is `dirname(realpath(root))`,
 * so repository discovery never leaves the workspace's parent; the probe passes
 * an empty string.
 */
export function gitReadEnv(ceiling: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: '/dev/null/home',
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_CONFIG_COUNT: String(GIT_READ_FORCED_KEYS.length),
  }
  GIT_READ_FORCED_KEYS.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return Object.freeze(env)
}
