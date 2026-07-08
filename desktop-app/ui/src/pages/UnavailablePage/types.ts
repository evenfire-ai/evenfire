import type { DependencyHealth } from '../../../../src/types'

export type UnavailablePageProps = {
  busy: boolean
  health: DependencyHealth | null
  onRetry: () => void
}
