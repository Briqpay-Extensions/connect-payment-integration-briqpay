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
  briqpaySessionId: Type.String(),
  paymentOutcome: PaymentOutcomeSchema,
})

export const DecisionRequestSchema = Type.Object({
  sessionId: Type.String(),
  decision: Type.Enum(BRIQPAY_DECISION),
  rejectionType: Type.Optional(Type.Enum(BRIQPAY_REJECT_TYPE)),
  hardError: Type.Optional(
    Type.Object({
      message: Type.String(),
    }),
  ),
  softErrors: Type.Optional(
    Type.Array(
      Type.Object({
        message: Type.String(),
      }),
    ),
  ),
})

export const NotificationRequestSchema = Type.Object({
  event: Type.Enum(BRIQPAY_WEBHOOK_EVENT),
  status: Type.Enum(BRIQPAY_WEBHOOK_STATUS),
  sessionId: Type.String(),
  captureId: Type.Optional(Type.String()),
  refundId: Type.Optional(Type.String()),
  autoCaptured: Type.Optional(Type.Boolean()),
  isPreExistingCapture: Type.Optional(Type.Boolean()),
})

export type PaymentRequestSchemaDTO = Static<typeof PaymentRequestSchema>
export type PaymentResponseSchemaDTO = Static<typeof PaymentResponseSchema>
export type DecisionRequestSchemaDTO = Static<typeof DecisionRequestSchema>
export type NotificationRequestSchemaDTO = Static<typeof NotificationRequestSchema>

export const ConfigResponseSchema = Type.Any()
