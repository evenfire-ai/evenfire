export type CreateFlowIconKey =
  | 'broadcast'
  | 'cable'
  | 'group-work'
  | 'key'
  | 'robot'
  | 'settings'
  | 'shared-files'
  | 'store'
  | 'users'
  | 'workflow'

export type CreateFlowLoadingConfig = {
  backLabel: string
  iconKey: CreateFlowIconKey
  primaryActionLabel?: string
  secondaryActionLabel?: string
  stepFlowClassName?: string
  steps: readonly string[]
  subtitle: string
  title: string
}

export type CreateFlowSkeletonProps = CreateFlowLoadingConfig & {
  backDisabled?: boolean
  className?: string
  onBack?: () => void
}

export type CreateFlowLoadingScreenProps = CreateFlowLoadingConfig
