export type HostItem = {
  metadata?: { name?: string; namespace?: string }
  spec?: Record<string, unknown> & {
    lifecycle?: { stateless?: boolean }
  }
  status?: Record<string, unknown> & {
    conditions?: Array<{
      message?: string
      reason?: string
      status?: string
      type?: string
    }>
    lifecycle?: { state?: string; reason?: string }
  }
}

export type HostRef = { name: string; namespace: string }
