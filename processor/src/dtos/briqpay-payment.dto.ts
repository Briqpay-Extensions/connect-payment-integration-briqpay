import { Static, Type } from '@sinclair/typebox'

export enum PaymentOutcome {
  APPROVED = 'approved',
  REJECTED = 'rejected',
  PENDING = 'pending',
}

export enum PaymentMethodType {
  BRIQPAY = 'briqpay',
}

export enum BRIQPAY_DECISION {
  ALLOW = 'allow',
  REJECT = 'reject',
}

export enum BRIQPAY_REJECT_TYPE {
  REJECT_WITH_ERROR = 'reject_session_with_error',
  NOTIFY_USER = 'notify_user',
}

export type BriqpayDecisionRequest = {
  decision: BRIQPAY_DECISION
  rejectionType?: BRIQPAY_REJECT_TYPE
  hardError?: {
    message: string
  }
  softErrors?: {
    message: string
  }[]
}

export enum BRIQPAY_WEBHOOK_EVENT {
  SESSION_STATUS = 'session_status',
  ORDER_STATUS = 'order_status',
  CAPTURE_STATUS = 'capture_status',
  REFUND_STATUS = 'refund_status',
}
export enum BRIQPAY_WEBHOOK_STATUS {
  // Orders
  ORDER_PENDING = 'order_pending',
  ORDER_REJECTED = 'order_rejected',
  ORDER_CANCELLED = 'order_cancelled',
  ORDER_APPROVED_NOT_CAPTURED = 'order_approved_not_captured',

  // Captures & refunds
  APPROVED = 'approved',
  PENDING = 'pending',
  REJECTED = 'rejected',
}

export const PaymentResponseSchema = Type.Object({
  paymentReference: Type.String(),
})

export const PaymentOutcomeSchema = Type.Enum(PaymentOutcome)

export const PaymentRequestSchema = Type.Object({
  paymentMethod: Type.Object({
    type: Type.Enum(PaymentMethodType),
  }),
  briqpaySessionId: Type.Optional(Type.String()),
  paymentOutcome: PaymentOutcomeSchema,
})

// SECURITY: Strict input validation for session IDs to prevent injection attacks
const SessionIdPattern = /^[a-zA-Z0-9-_]{1,128}$/
const SafeStringPattern = /^[a-zA-Z0-9\s.,!?'-]{0,500}$/

export const DecisionRequestSchema = Type.Object({
  sessionId: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: SessionIdPattern.source,
  }),
  decision: Type.Enum(BRIQPAY_DECISION),
  rejectionType: Type.Optional(Type.Enum(BRIQPAY_REJECT_TYPE)),
  hardError: Type.Optional(
    Type.Object({
      message: Type.String({ maxLength: 500, pattern: SafeStringPattern.source }),
    }),
  ),
  softErrors: Type.Optional(
    Type.Array(
      Type.Object({
        message: Type.String({ maxLength: 500, pattern: SafeStringPattern.source }),
      }),
      { maxItems: 10 }, // Limit array size to prevent DoS
    ),
  ),
})

export const DecisionResponseSchema = Type.Object({
  success: Type.Boolean(),
  decision: Type.Enum(BRIQPAY_DECISION),
})

export const NotificationRequestSchema = Type.Object({
  event: Type.Enum(BRIQPAY_WEBHOOK_EVENT),
  status: Type.Enum(BRIQPAY_WEBHOOK_STATUS),
  sessionId: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: SessionIdPattern.source,
  }),
  captureId: Type.Optional(
    Type.String({
      maxLength: 128,
      pattern: SessionIdPattern.source,
    }),
  ),
  refundId: Type.Optional(
    Type.String({
      maxLength: 128,
      pattern: SessionIdPattern.source,
    }),
  ),
  autoCaptured: Type.Optional(Type.Boolean()),
  isPreExistingCapture: Type.Optional(Type.Boolean()),
  transaction: Type.Optional(
    Type.Object({
      transactionId: Type.String(),
      status: Type.String(),
      amountIncVat: Type.Number(),
      amountExVat: Type.Optional(Type.Number()),
      currency: Type.String(),
      createdAt: Type.Optional(Type.String()),
      expiresAt: Type.Optional(Type.String()),
      reservationId: Type.Optional(Type.String()),
      secondaryReservationId: Type.Optional(Type.String()),
      pspId: Type.Optional(Type.String()),
      pspDisplayName: Type.Optional(Type.String()),
      pspIntegrationName: Type.Optional(Type.String()),
      email: Type.Optional(Type.String()),
      phoneNumber: Type.Optional(Type.String()),
      reference: Type.Optional(Type.String()),
      pspOrderManagementIds: Type.Optional(
        Type.Object({
          capture: Type.Optional(Type.Object({ apiTransactionId: Type.String() })),
          refund: Type.Optional(Type.Object({ apiTransactionId: Type.String() })),
          cancel: Type.Optional(Type.Object({ apiTransactionId: Type.String() })),
        }),
      ),
    }),
  ),
})

export type PaymentRequestSchemaDTO = Static<typeof PaymentRequestSchema>
export type PaymentResponseSchemaDTO = Static<typeof PaymentResponseSchema>
export type DecisionRequestSchemaDTO = Static<typeof DecisionRequestSchema>
export type NotificationRequestSchemaDTO = Static<typeof NotificationRequestSchema>

export const ConfigResponseSchema = Type.Any()
