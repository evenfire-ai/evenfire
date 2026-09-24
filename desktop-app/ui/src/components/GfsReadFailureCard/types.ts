import type { GfsDiscoveryFailure } from '@hooks/domain/useGfsBrowserController'

export interface GfsReadFailureCardProps {
  failure: GfsDiscoveryFailure
  onRetry: () => void
}
