import type {
  AdministrativeEventInputV1,
  AdministrativeServerBindingV1,
  ControlApiLocalAdministrativePrincipalV1,
} from './contracts.js'

/**
 * The first local vertical is intentionally closed: callers may record only
 * the committed configuration of the governed tracing control-plane surface.
 * The caller supplies this context from its own mutation transaction, never
 * from an HTTP body.
 */
export type ControlApiLocalAdministrativeContextV1 = Readonly<{
  sourceEventId: string
  requestId: string | null
  environment: string
}>

export const CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1: ControlApiLocalAdministrativePrincipalV1 =
  {
    kind: 'control_api_local',
    sourceService: 'control-api',
    serviceSub: 'governed-tracing',
    credentialId: 'control-api-local',
    allowedKinds: ['service_action'],
  }

/** Resolves the closed local event without admitting a remote authority path. */
export class ControlApiLocalAdministrativeBindingResolver {
  resolve(
    context: ControlApiLocalAdministrativeContextV1,
    input: AdministrativeEventInputV1
  ): AdministrativeServerBindingV1 | null {
    if (
      input.kind !== 'service_action' ||
      input.sourceEventId !== context.sourceEventId ||
      !isNonEmpty(context.sourceEventId) ||
      !isNonEmpty(context.environment)
    ) {
      return null
    }

    return {
      action: 'configuration_mutation',
      outcome: 'committed',
      operatorSub: null,
      operationId: null,
      relatedRunId: null,
      requestId: nullableNonEmpty(context.requestId),
      targetType: 'configuration',
      targetRef: 'control-api/governed-tracing',
      environment: context.environment,
      tenantId: null,
      teamId: null,
      namespace: null,
      sourceAuditRef: null,
    }
  }
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0 && !value.includes('\0')
}

function nullableNonEmpty(value: string | null): string | null {
  return value !== null && isNonEmpty(value) ? value : null
}
