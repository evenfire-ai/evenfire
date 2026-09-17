import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TablePanelHeader } from '../TablePanelHeader'

function WrappedButton({ children }: { children: ReactNode }) {
  return <button type="button">{children}</button>
}

describe('TablePanelHeader interactive subtitles', () => {
  it('does not clamp content supplied through a custom interactive component', () => {
    render(<TablePanelHeader subtitle={<WrappedButton>Open guide</WrappedButton>} title="Help" />)

    expect(screen.getByRole('button', { name: 'Open guide' })).toBeVisible()
    expect(document.querySelector('.cu-table-panel__description')).toBeNull()
  })
})
