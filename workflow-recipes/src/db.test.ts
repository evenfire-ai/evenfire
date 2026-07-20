import { describe, expect, it } from 'vitest'
import type { DbConfig } from './config.js'
import { createPoolConfig } from './db.js'

const BASE_CONFIG: DbConfig = {
  connectionString: undefined,
  host: 'fallback-db',
  port: 5432,
  user: 'fallback-user',
  password: 'fallback-password',
  database: 'fallback-database',
  ssl: false,
  poolMax: 4,
  instanceId: 'test-instance',
  leaderPollMs: 10_000,
  runPollMs: 30_000,
}

describe('createPoolConfig', () => {
  it('uses the runtime DSN without overriding its scoped identity', () => {
    const config = createPoolConfig({
      ...BASE_CONFIG,
      connectionString: 'postgresql://workflow_recipes_runtime:secret@db:5432/profiles',
    })

    expect(config).toMatchObject({
      connectionString: 'postgresql://workflow_recipes_runtime:secret@db:5432/profiles',
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 60_000,
    })
    expect(config).not.toHaveProperty('host')
    expect(config).not.toHaveProperty('port')
    expect(config).not.toHaveProperty('user')
    expect(config).not.toHaveProperty('password')
    expect(config).not.toHaveProperty('database')
  })

  it('uses individual connection fields only when no DSN is configured', () => {
    expect(createPoolConfig(BASE_CONFIG)).toMatchObject({
      host: 'fallback-db',
      port: 5432,
      user: 'fallback-user',
      password: 'fallback-password',
      database: 'fallback-database',
      max: 4,
    })
  })
})
