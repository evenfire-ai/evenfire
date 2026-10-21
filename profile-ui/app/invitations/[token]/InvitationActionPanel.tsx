import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { Button } from '@components/Button'
import { FormField } from '@components/FormField'
import { TextInput } from '@components/TextInput'

type InvitationAction = 'accept' | 'password'
type SubmittingAction = InvitationAction | null

type InvitationActionPanelProps =
  | {
      mode: 'outcome-unknown'
      loginHref: string
      forgotPasswordHref: string
    }
  | {
      mode: 'password-setup'
      isPasswordReset: boolean
      busy: boolean
      submitting: SubmittingAction
      password: string
      confirmPassword: string
      onPasswordChange: (value: string) => void
      onConfirmPasswordChange: (value: string) => void
      onPasswordKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
      onPasswordAction: (
        event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>
      ) => void
    }
  | { mode: 'password-updated'; loginHref: string }
  | {
      mode: 'used'
      loginHref: string
      isPasswordReset: boolean
      forgotPasswordHref: string
    }
  | { mode: 'link-error'; loginHref: string }
  | { mode: 'terminal'; loginHref: string; forgotPasswordHref?: string }
  | { mode: 'expired'; loginHref: string }
  | {
      mode: 'accept'
      busy: boolean
      submitting: SubmittingAction
      onAcceptAction: (
        event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>
      ) => void
    }

function buttonLabel(submitting: SubmittingAction, kind: InvitationAction, label: string) {
  if (submitting !== kind) return label
  return (
    <span className="cu-btn__content">
      <span className="cu-btn__spinner" aria-hidden="true" />
      <span>{kind === 'accept' ? 'Accepting...' : 'Saving...'}</span>
    </span>
  )
}

export function InvitationActionPanel(props: InvitationActionPanelProps) {
  switch (props.mode) {
    case 'outcome-unknown':
      return (
        <div className="stack">
          <a className="cu-btn cu-btn--primary" href={props.loginHref}>
            Try signing in
          </a>
          <a className="cu-btn" href={props.forgotPasswordHref}>
            Request a new recovery link
          </a>
        </div>
      )
    case 'password-setup':
      return (
        <div className="stack">
          <div className="form-card">
            <strong>{props.isPasswordReset ? 'Set a new password' : 'Set your password'}</strong>
            <div className="muted">
              Use at least 8 characters. This password stays with your Evenfire account.
            </div>
            <FormField label="Password">
              <TextInput
                name="password"
                type="password"
                placeholder="At least 8 characters"
                value={props.password}
                onChange={event => props.onPasswordChange(event.currentTarget.value)}
                onKeyDown={props.onPasswordKeyDown}
                disabled={props.busy}
                minLength={8}
                required
              />
            </FormField>
            <FormField label="Confirm password">
              <TextInput
                name="confirmPassword"
                type="password"
                placeholder="Repeat your password"
                value={props.confirmPassword}
                onChange={event => props.onConfirmPasswordChange(event.currentTarget.value)}
                onKeyDown={props.onPasswordKeyDown}
                disabled={props.busy}
                minLength={8}
                required
              />
            </FormField>
          </div>
          <Button
            type="button"
            disabled={props.busy}
            onClick={props.onPasswordAction}
            onPointerDown={props.onPasswordAction}
          >
            {buttonLabel(
              props.submitting,
              'password',
              props.isPasswordReset ? 'Reset password' : 'Set password and continue'
            )}
          </Button>
        </div>
      )
    case 'password-updated':
      return (
        <div className="stack">
          <p className="body-copy">
            Your password has been updated. Sign in with your new password to continue.
          </p>
          <a className="cu-btn cu-btn--primary" href={props.loginHref}>
            Sign in
          </a>
        </div>
      )
    case 'used':
      return (
        <div className="stack">
          <p className="body-copy">
            This invitation has already been used. Sign in with your password to continue.
          </p>
          <a className="cu-btn cu-btn--primary" href={props.loginHref}>
            Sign in
          </a>
          {props.isPasswordReset ? (
            <a className="cu-btn" href={props.forgotPasswordHref}>
              Request a new recovery link
            </a>
          ) : null}
        </div>
      )
    case 'link-error':
      return (
        <div className="stack">
          <a className="cu-btn" href={props.loginHref}>
            Sign in
          </a>
        </div>
      )
    case 'terminal':
      return (
        <div className="stack">
          <a className="cu-btn cu-btn--primary" href={props.loginHref}>
            Sign in
          </a>
          {props.forgotPasswordHref ? (
            <a className="cu-btn" href={props.forgotPasswordHref}>
              Request a new recovery link
            </a>
          ) : null}
        </div>
      )
    case 'expired':
      return (
        <div className="stack">
          <div className="message message--error-plain">This invitation has expired.</div>
          <a className="cu-btn" href={props.loginHref}>
            Sign in
          </a>
        </div>
      )
    case 'accept':
      return (
        <div>
          <Button
            type="button"
            disabled={props.busy}
            onClick={props.onAcceptAction}
            onPointerDown={props.onAcceptAction}
          >
            {buttonLabel(props.submitting, 'accept', 'Accept invitation')}
          </Button>
        </div>
      )
  }
  return null
}
