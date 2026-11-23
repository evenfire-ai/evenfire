import { afterEach, describe, expect, it } from 'vitest'
import { GIT_READ_FORCED_KEYS, gitReadEnv } from '../env'

const LITERAL_ENV = {
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
  GIT_CEILING_DIRECTORIES: '/srv/parent',
  GIT_CONFIG_COUNT: '13',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_VALUE_1: '/dev/null',
  GIT_CONFIG_KEY_2: 'core.pager',
  GIT_CONFIG_VALUE_2: 'cat',
  GIT_CONFIG_KEY_3: 'core.sshCommand',
  GIT_CONFIG_VALUE_3: 'false',
  GIT_CONFIG_KEY_4: 'core.alternateRefsCommand',
  GIT_CONFIG_VALUE_4: 'false',
  GIT_CONFIG_KEY_5: 'submodule.recurse',
  GIT_CONFIG_VALUE_5: 'false',
  GIT_CONFIG_KEY_6: 'status.submoduleSummary',
  GIT_CONFIG_VALUE_6: 'false',
  GIT_CONFIG_KEY_7: 'log.showSignature',
  GIT_CONFIG_VALUE_7: 'false',
  GIT_CONFIG_KEY_8: 'gpg.program',
  GIT_CONFIG_VALUE_8: 'false',
  GIT_CONFIG_KEY_9: 'protocol.allow',
  GIT_CONFIG_VALUE_9: 'never',
  GIT_CONFIG_KEY_10: 'protocol.ext.allow',
  GIT_CONFIG_VALUE_10: 'never',
  GIT_CONFIG_KEY_11: 'protocol.file.allow',
  GIT_CONFIG_VALUE_11: 'never',
  GIT_CONFIG_KEY_12: 'safe.bareRepository',
  GIT_CONFIG_VALUE_12: 'explicit',
}

const POISON = {
  GIT_CONFIG_PARAMETERS: "'core.pager'='touch /tmp/poison'",
  GIT_DIR: '/outside/.git',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/outside/objects',
  GIT_OBJECT_DIRECTORY: '/outside/objects',
  GIT_NO_REPLACE_OBJECTS: '0',
  HOME: '/outside/home',
  PYTHONPATH: '/outside/py',
  GIT_ASKPASS: '/outside/askpass',
  GIT_TOKEN: 'fixture-token',
}

describe('gitReadEnv', () => {
  const saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('is exactly the literal table, whatever the process environment holds', () => {
    for (const [key, value] of Object.entries(POISON)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }

    expect(gitReadEnv('/srv/parent')).toEqual(LITERAL_ENV)
  })

  it('forces the 13 keys in a fixed order', () => {
    expect(GIT_READ_FORCED_KEYS.map(([key]) => key)).toEqual([
      'core.fsmonitor',
      'core.hooksPath',
      'core.pager',
      'core.sshCommand',
      'core.alternateRefsCommand',
      'submodule.recurse',
      'status.submoduleSummary',
      'log.showSignature',
      'gpg.program',
      'protocol.allow',
      'protocol.ext.allow',
      'protocol.file.allow',
      'safe.bareRepository',
    ])
  })

  it('passes the ceiling through, empty for the probe', () => {
    expect(gitReadEnv('').GIT_CEILING_DIRECTORIES).toBe('')
    expect(Object.isFrozen(gitReadEnv(''))).toBe(true)
  })
})
