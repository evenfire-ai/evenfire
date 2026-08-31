// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { DESKTOP_ROUTES } from '../../../constants/navigation'
import { useNavigationController } from '../useNavigationController'

describe('useNavigationController — context detail deep-link tab', () => {
  it('defaults selectedContextTab to "agents"', () => {
    const { result } = renderHook(() => useNavigationController())
    expect(result.current.selectedContextTab).toBe('agents')
  })

  it('handleOpenContextDetails(id, tab) lands on that context + tab + detail route', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() => result.current.handleOpenContextDetails('ctx-1', 'mcp-servers'))
    expect(result.current.selectedContext).toBe('ctx-1')
    expect(result.current.selectedContextTab).toBe('mcp-servers')
    expect(result.current.navItem).toBe(DESKTOP_ROUTES.contextDetails)
  })

  it('defaults the tab to "agents" when omitted (existing callers unchanged)', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() => result.current.handleOpenContextDetails('ctx-2', 'mcp-servers'))
    act(() => result.current.handleOpenContextDetails('ctx-3'))
    expect(result.current.selectedContext).toBe('ctx-3')
    expect(result.current.selectedContextTab).toBe('agents')
  })

  it('ignores an empty contextId', () => {
    const { result } = renderHook(() => useNavigationController())
    act(() => result.current.handleOpenContextDetails('', 'mcp-servers'))
    expect(result.current.selectedContext).toBeNull()
    expect(result.current.selectedContextTab).toBe('agents')
  })
})
