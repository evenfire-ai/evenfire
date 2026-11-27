import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HostTabPage from '../page'

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  })
)

vi.mock('next/navigation', () => ({ notFound }))
vi.mock('../../page', () => ({ default: () => <div>Host details</div> }))

const call = (tab: string) => HostTabPage({ params: Promise.resolve({ tab }) })

describe('HostTabPage', () => {
  beforeEach(() => {
    notFound.mockClear()
  })

  it('with tab approval-settings renders and does not call notFound', async () => {
    const element = await call('approval-settings')

    expect(element).toBeTruthy()
    expect(notFound).not.toHaveBeenCalled()
  })

  it('calls notFound for an unknown tab', async () => {
    await expect(call('approvals')).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalledTimes(1)
  })
})
