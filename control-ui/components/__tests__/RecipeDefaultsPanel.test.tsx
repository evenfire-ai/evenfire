import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_OPERATOR_DEFAULTS } from '../../lib/recipeDefaults'
import type { OperatorDefaults } from '../../lib/recipeTypes'
import { RecipeDefaultsPanel } from '../RecipeDefaultsPanel'

afterEach(cleanup)

function renderPanel(defaults = DEFAULT_OPERATOR_DEFAULTS, onChange = vi.fn()) {
  return render(<RecipeDefaultsPanel defaults={defaults} onChange={onChange} />)
}

describe('RecipeDefaultsPanel', () => {
  it('renders all section titles', () => {
    renderPanel()
    expect(screen.getByText('Security')).toBeInTheDocument()
    expect(screen.getByText('Storage')).toBeInTheDocument()
    expect(screen.getByText(/Default Resources/)).toBeInTheDocument()
    expect(screen.getByText('Target Namespaces')).toBeInTheDocument()
    expect(screen.getByText('Container Registry')).toBeInTheDocument()
  })

  it('shows default capability values', () => {
    renderPanel()
    const input = screen.getByDisplayValue(/CHOWN/)
    expect(input).toBeInTheDocument()
  })

  it('shows default storage class', () => {
    renderPanel()
    expect(screen.getByDisplayValue('standard')).toBeInTheDocument()
  })

  it('shows default namespace for MCP workloads', () => {
    renderPanel()
    expect(screen.getByDisplayValue('mcp-server')).toBeInTheDocument()
  })

  it('calls onChange when capabilities are updated', () => {
    const onChange = vi.fn()
    renderPanel(DEFAULT_OPERATOR_DEFAULTS, onChange)
    const capInput = screen.getByDisplayValue(/CHOWN/)
    fireEvent.change(capInput, { target: { value: 'NET_BIND_SERVICE' } })
    expect(onChange).toHaveBeenCalledOnce()
    const updated = onChange.mock.calls[0][0] as OperatorDefaults
    expect(updated.security.allowedCapabilities).toContain('NET_BIND_SERVICE')
  })

  it('calls onChange when maxRunAsUser changes', () => {
    const onChange = vi.fn()
    renderPanel(DEFAULT_OPERATOR_DEFAULTS, onChange)
    const input = screen.getByDisplayValue('65534')
    fireEvent.change(input, { target: { value: '1000' } })
    expect(onChange).toHaveBeenCalledOnce()
    const updated = onChange.mock.calls[0][0] as OperatorDefaults
    expect(updated.security.maxRunAsUser).toBe(1000)
  })

  it('calls onChange when requireNonRoot checkbox toggled', () => {
    const onChange = vi.fn()
    renderPanel(DEFAULT_OPERATOR_DEFAULTS, onChange)
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    expect(onChange).toHaveBeenCalledOnce()
    const updated = onChange.mock.calls[0][0] as OperatorDefaults
    expect(updated.security.requireNonRoot).toBe(false)
  })

  it('calls onChange when storage class is updated', () => {
    const onChange = vi.fn()
    renderPanel(DEFAULT_OPERATOR_DEFAULTS, onChange)
    const input = screen.getByDisplayValue('standard')
    fireEvent.change(input, { target: { value: 'do-block-storage' } })
    expect(onChange).toHaveBeenCalledOnce()
    const updated = onChange.mock.calls[0][0] as OperatorDefaults
    expect(updated.storage.defaultStorageClass).toBe('do-block-storage')
  })

  it('does not mutate the original defaults object', () => {
    const original = JSON.parse(JSON.stringify(DEFAULT_OPERATOR_DEFAULTS)) as OperatorDefaults
    const onChange = vi.fn()
    renderPanel(DEFAULT_OPERATOR_DEFAULTS, onChange)
    const capInput = screen.getByDisplayValue(/CHOWN/)
    fireEvent.change(capInput, { target: { value: 'KILL' } })
    expect(DEFAULT_OPERATOR_DEFAULTS.security.allowedCapabilities).toEqual(
      original.security.allowedCapabilities
    )
  })
})
