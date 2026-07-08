export type WorkflowSummary = {
  namespace: string
  name: string
  status?: string
  createdAt?: string
  triggerableByUser: boolean
}
