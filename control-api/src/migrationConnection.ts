function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`[ControlAPI:Migrate] ${name} is required`)
  return value
}

export function resolveMigrationConnectionString(env: NodeJS.ProcessEnv): string {
  const explicit = env.CONTROL_API_PG_CONNECTION_STRING?.trim()
  if (explicit) return explicit

  const url = new URL('postgresql://localhost')
  url.hostname = required(env, 'CONTROL_API_MIGRATION_PG_HOST')
  url.port = env.CONTROL_API_MIGRATION_PG_PORT?.trim() || '5432'
  url.username = required(env, 'POSTGRES_USER')
  url.password = required(env, 'POSTGRES_PASSWORD')
  url.pathname = `/${encodeURIComponent(required(env, 'POSTGRES_DB'))}`
  return url.toString()
}
