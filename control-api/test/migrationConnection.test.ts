import { describe, expect, it } from 'vitest'
import { resolveMigrationConnectionString } from '../src/migrationConnection.js'

describe('migration Postgres connection', () => {
  it('uses an explicitly supplied migration DSN', () => {
    const explicit = new URL('postgresql://database.example/profiles')
    explicit.username = 'migration-user'
    explicit.password = ['fixture', 'value'].join('-')

    expect(
      resolveMigrationConnectionString({ CONTROL_API_PG_CONNECTION_STRING: explicit.toString() })
    ).toBe(explicit.toString())
  })

  it('builds an encoded DSN from the control-postgres Secret fields', () => {
    const reservedValue = ['fixture', '@:/?#', 'value'].join('')
    const resolved = resolveMigrationConnectionString({
      CONTROL_API_MIGRATION_PG_HOST: 'control-postgres.control-plane.svc.cluster.local',
      CONTROL_API_MIGRATION_PG_PORT: '5432',
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: reservedValue,
      POSTGRES_DB: 'profiles',
    })
    const url = new URL(resolved)

    expect(url.hostname).toBe('control-postgres.control-plane.svc.cluster.local')
    expect(url.port).toBe('5432')
    expect(decodeURIComponent(url.username)).toBe('postgres')
    expect(decodeURIComponent(url.password)).toBe(reservedValue)
    expect(url.pathname).toBe('/profiles')
  })

  it('fails closed when a required Secret field is absent', () => {
    expect(() =>
      resolveMigrationConnectionString({
        CONTROL_API_MIGRATION_PG_HOST: 'control-postgres.control-plane.svc.cluster.local',
        POSTGRES_USER: 'postgres',
        POSTGRES_DB: 'profiles',
      })
    ).toThrow('POSTGRES_PASSWORD is required')
  })
})
