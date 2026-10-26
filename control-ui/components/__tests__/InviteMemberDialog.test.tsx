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
