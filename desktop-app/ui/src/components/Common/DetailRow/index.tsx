import type { DetailRowProps } from './types'

export function DetailRow({ label, value }: DetailRowProps) {
  return (
    <div className="detail-row">
      <span className="detail-key">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  )
}

export type { DetailRowProps } from './types'
