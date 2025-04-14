import { Static, Type } from "@sinclair/typebox";

export enum PaymentOutcome {
  APPROVED = "approved",
  REJECTED = "rejected",
  PENDING = "pending",
}

export const PaymentOutcomeSchema = Type.Enum(PaymentOutcome);

export const PaymentRequestSchema = Type.Object({
  paymentMethod: Type.Object({
    type: Type.String(),
    poNumber: Type.Optional(Type.String()),
    invoiceMemo: Type.Optional(Type.String()),
  }),
  briqpaySessionId: Type.String(),
  paymentOutcome: PaymentOutcomeSchema,
});

export type PaymentRequestSchemaDTO = Static<typeof PaymentRequestSchema>;
