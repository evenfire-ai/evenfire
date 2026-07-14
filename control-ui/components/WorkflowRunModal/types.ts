// Property descriptor extracted from a recipe spec.inputContract.properties
// entry. The spec stores them as `Record<string, unknown>`, so types here are
// optional — the modal copes with missing/invalid metadata by falling back to
// a plain text input.
export type InputContractProperty = {
  type?: 'string' | 'number' | 'boolean'
  default?: unknown
  description?: string
  enum?: unknown[]
}

export type InputContractProperties = Record<string, InputContractProperty>

export type WorkflowRunModalProps = {
  // Recipe identity used to address the trigger endpoint.
  name: string
  namespace: string
  // Optional declared inputs; when absent, the modal renders an empty form
  // and the server-side defaults from inputContract take over.
  inputs?: InputContractProperties
  // Display-only metadata from spec.triggers.onDemand.requiresApproval.
  requiresApproval?: boolean
  onClose: () => void
  // Fired after a successful trigger so the parent can show a banner and/or
  // open the status modal. Receives the trigger response so callers can link
  // to the run by id later if needed.
  onStarted: (info: { recipeName: string; namespace: string; runId?: string }) => void
}
