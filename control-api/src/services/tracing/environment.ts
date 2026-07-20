function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

function requireTracingEnv(name: string, fallbackNames: readonly string[] = []): string {
  const names = [name, ...fallbackNames]
  for (const candidate of names) {
    const value = trimmedEnv(candidate)
    if (value) return value
  }
  throw new Error(`Missing required governed tracing environment variable: ${names.join(' or ')}`)
}

function localTracingEnvironmentDefault(): string {
  return process.env.NODE_ENV === 'test' ? 'test' : 'development'
}

export function canonicalTracingEnvironment(): string {
  return (
    trimmedEnv('TRACING_ENVIRONMENT') ??
    (process.env.NODE_ENV === 'production'
      ? requireTracingEnv('TRACING_ENVIRONMENT')
      : localTracingEnvironmentDefault())
  )
}

export function canonicalTracingClusterName(): string {
  return (
    trimmedEnv('TRACING_CLUSTER_NAME') ??
    trimmedEnv('KUBERNETES_CLUSTER_NAME') ??
    (process.env.NODE_ENV === 'production'
      ? requireTracingEnv('TRACING_CLUSTER_NAME', ['KUBERNETES_CLUSTER_NAME'])
      : 'local-cluster')
  )
}

export function canonicalTracingClusterLocation(): string {
  return (
    trimmedEnv('TRACING_CLUSTER_LOCATION') ??
    trimmedEnv('KUBERNETES_CLUSTER_LOCATION') ??
    (process.env.NODE_ENV === 'production'
      ? requireTracingEnv('TRACING_CLUSTER_LOCATION', ['KUBERNETES_CLUSTER_LOCATION'])
      : '')
  )
}
