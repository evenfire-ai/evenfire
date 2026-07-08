import type { ToastStackProps } from './types'

// Each toast div sets its own role (role="status" for info/success,
// role="alert" for error). Those roles carry implicit aria-live values
// (polite for status, assertive for alert), so we do NOT set aria-live on
// the container -- duplicating it caused double-announcements on screen
// readers for error toasts.
export function ToastStack({ items }: ToastStackProps) {
  if (!items.length) return null

  return (
    <aside className="toast-stack">
      {items.map(item => (
        <div
          key={item.id}
          role={item.tone === 'error' ? 'alert' : 'status'}
          className={`toast tone-${item.tone}`}
        >
          <span aria-hidden className="toast-icon">
            {item.tone === 'success' ? '●' : item.tone === 'error' ? '!' : 'i'}
          </span>
          <span>{item.text}</span>
        </div>
      ))}
    </aside>
  )
}

export type { ToastStackProps } from './types'
