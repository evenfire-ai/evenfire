// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { WindowTitleBar } from '..'

afterEach(() => cleanup())

describe('WindowTitleBar control semantics', () => {
  it('groups the named native window controls', () => {
    render(<WindowTitleBar />)

    const controls = screen.getByRole('group', { name: 'Window controls' })
    expect(within(controls).getAllByRole('button')).toHaveLength(3)
  })
})
