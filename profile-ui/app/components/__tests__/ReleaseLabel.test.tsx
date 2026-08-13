import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ReleaseLabel } from '@components/ReleaseLabel'
import { refreshReleaseIdentity, resetReleaseIdentityCache } from '@lib/releaseIdentity'

const api = vi.hoisted(() => ({
  getDesktopRelease: vi.fn(),
}))

vi.mock('@lib/api', () => ({
  getDesktopRelease: api.getDesktopRelease,
}))

beforeEach(() => {
  resetReleaseIdentityCache()
  api.getDesktopRelease.mockReset()
})

afterEach(cleanup)

describe('ReleaseLabel', () => {
  it('names the platform release read from the release manifest', async () => {
    api.getDesktopRelease.mockResolvedValue({ releaseId: 'v0.6.0', desktopVersion: '0.6.0' })

    render(<ReleaseLabel />)

    expect(await screen.findByText('Release v0.6.0')).toBeInTheDocument()
  })

  it('holds a placeholder line while the release is being read', () => {
    api.getDesktopRelease.mockReturnValue(new Promise(() => {}))

    render(<ReleaseLabel />)

    expect(screen.getByText('Release ...')).toBeInTheDocument()
  })

  it('says the release is unavailable instead of throwing when the read fails', async () => {
    api.getDesktopRelease.mockRejectedValue(new Error('503 Service Unavailable'))

    render(<ReleaseLabel />)

    expect(await screen.findByText('Release unavailable')).toBeInTheDocument()
  })

  // The portal's package version is a per-commit counter, not a release
  // coordinate. Showing it here is the defect this component replaced.
  it('never falls back to the profile-ui package version', async () => {
    api.getDesktopRelease.mockRejectedValue(new Error('401 Unauthorized'))

    render(<ReleaseLabel />)

    expect(await screen.findByText('Release unavailable')).toBeInTheDocument()
    expect(screen.queryByText(/Version 0\.1\./)).not.toBeInTheDocument()
  })

  // The settings Refresh button drives refreshReleaseIdentity(). A label that
  // caught a transient failure must heal in place, without remounting.
  it('heals a mounted label in place when a later read succeeds', async () => {
    api.getDesktopRelease.mockRejectedValueOnce(new Error('503 Service Unavailable'))

    render(<ReleaseLabel />)
    expect(await screen.findByText('Release unavailable')).toBeInTheDocument()

    api.getDesktopRelease.mockResolvedValue({ releaseId: 'v0.6.0' })
    await act(async () => {
      await refreshReleaseIdentity()
    })

    expect(screen.getByText('Release v0.6.0')).toBeInTheDocument()
  })

  it('publishes one read to every mounted label', async () => {
    api.getDesktopRelease.mockResolvedValue({ releaseId: 'v0.6.0' })

    render(
      <>
        <ReleaseLabel className="first" />
        <ReleaseLabel className="second" />
      </>
    )

    expect(await screen.findAllByText('Release v0.6.0')).toHaveLength(2)
    expect(api.getDesktopRelease).toHaveBeenCalledTimes(1)
  })

  it('reads the release once and shares it with later mounts', async () => {
    api.getDesktopRelease.mockResolvedValue({ releaseId: 'v0.6.0' })

    const first = render(<ReleaseLabel />)
    expect(await screen.findByText('Release v0.6.0')).toBeInTheDocument()
    first.unmount()

    render(<ReleaseLabel />)
    expect(screen.getByText('Release v0.6.0')).toBeInTheDocument()
    expect(api.getDesktopRelease).toHaveBeenCalledTimes(1)
  })
})
