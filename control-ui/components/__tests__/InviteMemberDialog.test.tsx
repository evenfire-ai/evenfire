import { render, screen } from '@testing-library/react'
import { InviteMemberDialog } from '@components/InviteMemberDialog'
import type { InviteMemberDialogProps } from '@components/InviteMemberDialog/types'

const props: InviteMemberDialogProps = {
  isOpen: true,
  busy: false,
  name: '',
  email: '',
  role: 'member',
  teamId: '',
  teams: [],
  onClose: () => undefined,
  onNameChange: () => undefined,
  onEmailChange: () => undefined,
  onRoleChange: () => undefined,
  onTeamChange: () => undefined,
  onSubmit: () => undefined,
}

it('tells the inviter the member link stays available for seven days', () => {
  render(<InviteMemberDialog {...props} />)

  expect(
    screen.getByText('An invitation link will be sent and remain available for 7 days.')
  ).toBeInTheDocument()
})

it('shows the seven-day notice in the embedded team invitation form', () => {
  render(
    <InviteMemberDialog
      {...props}
      embedded
      showFooter={false}
      teamId="team-1"
      teams={[{ id: 'team-1', name: 'Example team' }]}
      lockedTeamId="team-1"
    />
  )

  expect(
    screen.getByText('An invitation link will be sent and remain available for 7 days.')
  ).toBeInTheDocument()
})
