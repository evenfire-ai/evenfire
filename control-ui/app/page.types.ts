export type ApiList<T = Record<string, unknown>> = { items?: T[] }

export type DashboardHostResource = {
  metadata?: {
    name?: string
    namespace?: string
  }
}

export type HostRef = {
  name: string
  namespace: string
}

export type ContextRef = {
  name: string
}
