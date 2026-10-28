import { Alert, Button } from 'antd'
import type { ToastStackProps } from './types'

// Each toast div sets its own role (role="status" for info/success,
// role="alert" for error). Those roles carry implicit aria-live values
// (polite for status, assertive for alert), so we do NOT set aria-live on
// the container -- duplicating it caused double-announcements on screen
// readers for error toasts.
export function ToastStack({ items, onDismiss }: ToastStackProps) {
  if (!items.length) return null

  return (
    <aside className="toast-stack">
      {items.map(item => (
        <Alert
          action={
            item.action ? (
              <Button
                htmlType="button"
                onClick={() => {
                  item.action?.onAction()
                  onDismiss?.(item.id)
                }}
                size="small"
              >
                {item.action.label}
              </Button>
            ) : undefined
          }
          key={item.id}
          title={item.text}
          role={item.tone === 'error' ? 'alert' : 'status'}
          showIcon
          type={item.tone === 'warn' ? 'warning' : item.tone}
        />
      ))}
    </aside>
  )
}

export type { ToastStackProps } from './types'
