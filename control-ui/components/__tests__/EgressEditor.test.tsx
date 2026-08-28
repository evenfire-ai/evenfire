import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EgressEditor } from '../EgressEditor'

afterEach(() => {
  cleanup()
})

describe('EgressEditor', () => {
  it('associates the exact-CIDR labels with their editable controls', () => {
    render(<EgressEditor allowCidr onChange={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Egress mode'), { target: { value: 'exact-cidr' } })

    expect(screen.getByLabelText(/^Allowed CIDRs\/IPs/)).toBeInstanceOf(HTMLTextAreaElement)
    expect(screen.getByLabelText(/^Allowed ports/)).toBeInstanceOf(HTMLInputElement)
  })
})
