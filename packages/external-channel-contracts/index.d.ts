export type AdmissionRefusalReason =
  | 'receipt_invalid'
  | 'no_match'
  | 'identity_quarantined'
  | 'excluded'
  | 'not_eligible_guest'
  | 'not_eligible_external'
  | 'not_eligible_deactivated'
  | 'not_eligible_bot'
  | 'lookup_permission_missing'
  | 'eligibility_unavailable'
  | 'audience_not_ready'
  | 'missing_agent_grant'
  | 'missing_channel_grant'

export type PauseOutcome = 'approved' | 'approved_always' | 'denied' | 'timed_out' | 'cancelled' | 'superseded'

export type CallbackRefusal =
  | 'not_an_action'
  | 'request_mismatch'
  | 'decision_mismatch'
  | 'unknown_request'
  | 'already_decided'
  | 'expired'
  | 'not_admitted'
  | 'not_responder'
  | 'wrong_conversation'

export type ConversationKind = 'direct' | 'group' | 'channel'
export type PauseActionDecision = 'approve' | 'approve_always' | 'deny' | 'connect'
export type ExecutionPrincipalKind = 'member' | 'bot'
export type ChannelMedium = 'slack' | 'teams'

export type PauseAction = { readonly decision: PauseActionDecision; readonly token: string }

export type ProviderEventReceiptClaims = {
  readonly ver: 1
  readonly medium: ChannelMedium
  /** "<namespace>/<name>" of the CommunicationChannel */
  readonly channelRef: string
  readonly hostRef: string
  /** Slack workspace id of the installation; Teams tenant id */
  readonly providerScopeId: string
  /** Slack Enterprise Grid organization id of the installation when the verified body carries one; always null for Teams */
  readonly providerOrgId: string | null
  /** Slack user id; Teams aadObjectId */
  readonly providerAccountId: string
  /** Teams from.id; always null for Slack */
  readonly deliveryAlias: string | null
  /** Slack: the sender's own team or enterprise id when the event carries one */
  readonly senderScopeId: string | null
  /** Slack channel id; Teams conversation id without ";messageid=" */
  readonly conversationId: string
  /** set on eventKind 'message'; null on 'action' */
  readonly conversationKind: ConversationKind | null
  readonly threadRootId: string | null
  readonly messageId: string
  readonly eventId: string
  readonly eventKind: 'message' | 'action'
  /** always null on 'message'; on 'action', null when the clicked value is not a pause action value */
  readonly action: PauseAction | null
  readonly attestedBy: 'control-api' | 'approval-reader'
  readonly jti: string
  readonly iat: number
  /** exp - iat = PROVIDER_EVENT_RECEIPT_TTL_SECONDS */
  readonly exp: number
}

export type ChannelAdmissionEvent = {
  readonly providerAccountId: string
  readonly deliveryAlias: string | null
  readonly conversationId: string
  readonly conversationKind: ConversationKind | null
  readonly threadRootId: string | null
  readonly messageId: string
  readonly eventKind: 'message' | 'action'
  readonly action: PauseAction | null
}

export type ChannelAdmission =
  | {
      readonly outcome: 'admitted'
      readonly memberId: string
      readonly identityId: string
      readonly audienceMode: 'members' | 'workspace'
      readonly policyVersion: number
      readonly event: ChannelAdmissionEvent
    }
  | {
      readonly outcome: 'refused'
      readonly reason: AdmissionRefusalReason
      readonly notice: 'private' | 'origin_generic' | 'none'
      /** null only for 'receipt_invalid' */
      readonly event: ChannelAdmissionEvent | null
    }

export type OriginRoute = {
  readonly medium: ChannelMedium
  readonly channelRef: string
  readonly conversationId: string
  readonly conversationKind: ConversationKind
  readonly threadRootId: string | null
  readonly replyStyle: 'thread' | 'conversation' | 'quote'
  readonly quotedMessageId?: string
}

export type Stage1ExecutionPrincipal = {
  readonly kind: 'member'
  readonly memberId: string
  readonly identityId: string
  readonly conversationKind: ConversationKind
  readonly policyVersion: number
}

/** Thrown by every validator; `code` is fixed per contract. */
export type ContractErrorCode =
  | 'invalid_provider_event_receipt'
  | 'invalid_channel_admission'
  | 'invalid_origin_route'
  | 'invalid_execution_principal'
  | 'stage1_bot_principal'
  | 'unknown_principal_kind'

export type ContractError = Error & { readonly code: ContractErrorCode }

export declare const ADMISSION_REFUSAL_REASONS: readonly AdmissionRefusalReason[]
export declare const PAUSE_OUTCOMES: readonly PauseOutcome[]
export declare const CALLBACK_REFUSALS: readonly CallbackRefusal[]
export declare const CONVERSATION_KINDS: readonly ConversationKind[]
export declare const PROVIDER_EVENT_RECEIPT_AUDIENCE: 'evenfire-provider-event'
export declare const PROVIDER_EVENT_RECEIPT_HEADER_TYPE: 'provider-event-receipt+jwt'
export declare const PROVIDER_EVENT_RECEIPT_TTL_SECONDS: 600
export declare const PAUSE_ACTION_DECISIONS: readonly PauseActionDecision[]
export declare const PAUSE_ACTION_VALUE_PATTERN: RegExp
export declare const EXECUTION_PRINCIPAL_KINDS: readonly ExecutionPrincipalKind[]

export declare function parsePauseActionValue(text: unknown): PauseAction | null
export declare function validateProviderEventReceiptClaims(value: unknown): ProviderEventReceiptClaims
export declare function validateChannelAdmission(value: unknown): ChannelAdmission
export declare function validateOriginRoute(value: unknown): OriginRoute
export declare function validateStage1ExecutionPrincipal(value: unknown): Stage1ExecutionPrincipal
