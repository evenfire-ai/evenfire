import type { LlmHookResource } from '../lib/api'

// Structured view over the LlmHook CR `spec` (typed `AnyRecord` in lib/api).
// The reconciler writes the oneOf target shape; only one branch is populated.
export type LlmHookTarget = {
  image?: { ref?: string; port?: number }
  service?: { name?: string; namespace?: string; port?: number }
  remote?: { baseUrl?: string }
}

export type LlmHookLifecyclePoint = 'preCall' | 'moderate' | 'postCallSuccess' | 'onError'

export type LlmHookCapability =
  | 'may_deny'
  | 'may_rewrite'
  | 'may_substitute_result'
  | 'may_add_context'

export type LlmHookSpecView = {
  target?: LlmHookTarget
  path?: string
  lifecyclePoints?: LlmHookLifecyclePoint[]
  order?: number
  failMode?: 'open' | 'closed'
  capabilities?: LlmHookCapability[]
}

export type LlmHookRef = { name: string }

export type GuardrailHooksTableProps = {
  items: LlmHookResource[]
  onUninstall?: (hook: LlmHookRef) => Promise<void>
  uninstallingKey?: string | null
  onRefresh?: () => void
  refreshing?: boolean
  loading?: boolean
}
