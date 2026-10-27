// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Button, theme } from 'antd'
import { AntDesignProvider } from '../AntDesignProvider'

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

function ThemeProbe() {
  const { token } = theme.useToken()
  return (
    <>
      <span data-testid="background-token">{token.colorBgBase}</span>
      <Button>Small control</Button>
    </>
  )
}

describe('AntDesignProvider', () => {
  it('uses small controls and follows the existing root light/dark theme owner', async () => {
    document.documentElement.setAttribute('data-theme', 'light')
    render(
      <AntDesignProvider>
        <ThemeProbe />
      </AntDesignProvider>
    )

    const lightBackgroundToken = screen.getByTestId('background-token').textContent
    expect(screen.getByRole('button', { name: 'Small control' }).className).toContain('ant-btn-sm')

    act(() => document.documentElement.setAttribute('data-theme', 'dark'))

    await waitFor(() => {
      expect(screen.getByTestId('background-token').textContent).not.toBe(lightBackgroundToken)
    })
  })
})
