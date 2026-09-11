import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'ghost-danger' | 'danger'
export type ButtonSize = 'md' | 'sm'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  block?: boolean
  /** Square, padding-free button sized for a single glyph. */
  icon?: boolean
  size?: ButtonSize
  /** Disables the button and swaps its content for a spinner. */
  loading?: boolean
  /** Borderless treatment for buttons sitting in a table or panel toolbar. */
  toolbar?: boolean
  variant?: ButtonVariant
}

export type FieldProps = {
  children: ReactNode
  description?: ReactNode
  error?: ReactNode
  htmlFor?: string
  label?: ReactNode
  required?: boolean
}

export type FormSectionProps = {
  children: ReactNode
  description?: ReactNode
  title: ReactNode
  // Renders the section behind a disclosure toggle, for settings that most
  // installs leave alone. Collapsed shows the title only, so the section costs
  // one line until someone opens it.
  collapsible?: boolean
  // Optional controlled state. Left out, the section owns its own and starts
  // closed. Passed, the owner holds it — which is what a section needs when it
  // lives inside a subtree that unmounts (a wizard step), or when what should
  // be open depends on data that has not arrived at first render.
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  compact?: boolean
  invalid?: boolean
  monospace?: boolean
  narrow?: boolean
}

export type SelectInputProps = SelectHTMLAttributes<HTMLSelectElement> & {
  compact?: boolean
  invalid?: boolean
  narrow?: boolean
}

export type TextAreaInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean
  monospace?: boolean
}

export type CheckboxFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  description?: ReactNode
  label: ReactNode
}
