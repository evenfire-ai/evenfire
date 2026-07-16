export const STATELESS_ALLOW_CRON_MANAGE_ENV = 'CLERUM_STATELESS_ALLOW_CRON_MANAGE'
export const STATELESS_LIFECYCLE_ENV = 'CLERUM_STATELESS_LIFECYCLE'

type EnvReader = Record<string, string | undefined>

export class StatelessCronPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StatelessCronPolicyError'
  }
}

export function envFlagEnabled(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true'
}

export function statelessCronManageAllowed(env: EnvReader = process.env): boolean {
  return envFlagEnabled(env[STATELESS_ALLOW_CRON_MANAGE_ENV])
}

export function statelessLifecycleEnabled(env: EnvReader = process.env): boolean {
  return envFlagEnabled(env[STATELESS_LIFECYCLE_ENV])
}

export function statelessCronSchedulesAllowed(
  statelessLifecycle: boolean,
  env: EnvReader = process.env
): boolean {
  return !statelessLifecycle || statelessCronManageAllowed(env)
}

export function assertStatelessCronPolicyConfig(inputs: {
  statelessLifecycle: boolean
  allowCronManage?: boolean
  enableApproval: boolean
}): void {
  const allowCronManage = inputs.allowCronManage ?? statelessCronManageAllowed()

  if (inputs.statelessLifecycle && allowCronManage && !inputs.enableApproval) {
    throw new StatelessCronPolicyError(
      `${STATELESS_ALLOW_CRON_MANAGE_ENV}=true on a stateless host requires ` +
        `CLERUM_ENABLE_APPROVAL=true because cron_manage create/enable must remain HITL-gated.`
    )
  }
}
