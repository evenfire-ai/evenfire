import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'md' | 'sm'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  block?: boolean
  size?: ButtonSize
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
