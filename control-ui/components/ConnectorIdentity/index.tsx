import { getConnectorPresentation } from '@lib/connectorPresentation'
import type { ConnectorIdentityProps } from './types'

export function ConnectorIdentity({ name, iconOnly = false }: ConnectorIdentityProps) {
  const connector = getConnectorPresentation(name)
  const icon = (
    <span className="cu-connector-icon" aria-hidden="true">
      <img
        className={
          connector.darkIcon
            ? 'cu-connector-icon__base cu-connector-icon__base--themed'
            : 'cu-connector-icon__base'
        }
        src={connector.icon}
        alt=""
        width={24}
        height={24}
      />
      {connector.darkIcon ? (
        <img
          className="cu-connector-icon__on-dark"
          src={connector.darkIcon}
          alt=""
          width={24}
          height={24}
        />
      ) : null}
    </span>
  )
  if (iconOnly) return icon
  return (
    <span className="cu-connector-identity" title={name}>
      {icon}
      <span className="cu-registry-name">{connector.name}</span>
    </span>
  )
}
