import { Button } from '@components/Common'

/**
 * Controls the agent's desktop viewer window.
 *
 * IMPORTANT: This button is mounted in AgentsPage for now, but is designed to be
 * relocatable. It has no side-effects of its own and pulls all state/handlers
 * from props — drop it anywhere (AppHeader actions, sidebar, chat panel, etc.)
 * and it will work as long as the parent provides these four props.
 *
 * To move:
 *   1. Remove the <DesktopButton /> from AgentsPage (or wherever it's mounted)
 *   2. Mount it elsewhere
 *   3. Thread the same four props (status, error, onOpen, onClose)
 *      from useWorkspaceController through to the new parent
 */
export type DesktopButtonProps = {
  status: 'inactive' | 'starting' | 'running' | 'error'
  error: string | null
  onOpen: () => void
  onClose: () => void
  disabled?: boolean
}

export function DesktopButton({ status, error, onOpen, onClose, disabled }: DesktopButtonProps) {
  if (status === 'inactive') {
    return (
      <Button
        color="neutral"
        onClick={onOpen}
        disabled={disabled}
        data-testid="open-desktop-btn"
        size="xs"
        variant="ghost"
      >
        Open Desktop
      </Button>
    )
  }
  if (status === 'starting') {
    return (
      <Button color="neutral" disabled data-testid="desktop-starting-btn" size="xs" variant="ghost">
        Starting...
      </Button>
    )
  }
  if (status === 'running') {
    return (
      <>
        <Button
          color="neutral"
          onClick={onOpen}
          disabled={disabled}
          data-testid="focus-desktop-btn"
          size="xs"
          variant="ghost"
        >
          Focus Desktop
        </Button>
        <Button
          color="neutral"
          onClick={onClose}
          disabled={disabled}
          data-testid="close-desktop-btn"
          size="xs"
          variant="ghost"
        >
          Close Desktop
        </Button>
      </>
    )
  }
  // error
  return (
    <Button
      color="neutral"
      onClick={onOpen}
      disabled={disabled}
      data-testid="desktop-retry-btn"
      size="xs"
      title={error ?? 'Desktop error'}
      variant="ghost"
    >
      Retry Desktop
    </Button>
  )
}
