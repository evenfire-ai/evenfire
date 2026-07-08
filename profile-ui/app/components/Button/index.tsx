import type { ButtonProps } from './types'

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  const classes = ['cu-btn', variant !== 'secondary' ? `cu-btn--${variant}` : '', className]
    .filter(Boolean)
    .join(' ')

  return <button className={classes} type={type} {...props} />
}
