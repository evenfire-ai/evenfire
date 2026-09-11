import React from 'react'
import { TEAMS_SETUP_GUIDE_URL } from '@constants/teams'

/**
 * Both Teams panels used to jump straight to "run the CLI command", which
 * quietly assumes two things: that the operator already has an authenticated
 * Teams CLI, and that their tenant permits sideloading a custom app at all. An
 * operator can hit either assumption being false, and the failure shows up far
 * from its cause -- an install that never completes, or a command that has
 * nothing to copy into.
 *
 * `teams status` checks both in one command, so lead with it rather than let
 * either gap surface later as a confusing failure.
 */
export function TeamsSetupPrerequisites() {
  return (
    <section className="cu-teams-setup">
      <div>
        <p className="cu-section-title">Before you start</p>
        <p className="cu-muted">Two things need to be true before the command below will work.</p>
      </div>
      <ol className="cu-teams-setup__instructions">
        <li>
          Install and sign in to the Teams CLI: <code>npm install -g @microsoft/teams.cli</code>,
          then <code>teams login</code>.
        </li>
        <li>
          Your organization also has to allow custom app upload (sideloading), or the bot this
          creates cannot be installed. Run <code>teams status</code>: it proves both prerequisites
          in one command, printing <code>Sideloading: enabled</code> once the tenant allows it. A{' '}
          <code>disabled</code> result usually means an admin policy has not propagated yet, not
          that anything is broken.
        </li>
      </ol>
      <p className="cu-muted">
        <a className="cu-link" href={TEAMS_SETUP_GUIDE_URL} target="_blank" rel="noreferrer">
          Read the full Teams setup guide →
        </a>
      </p>
    </section>
  )
}
