import { SessionHeaderAuthenticationHook } from '@commercetools/connect-payments-sdk'
import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import {
  BRIQPAY_DECISION,
  ConfigResponseSchema,
  DecisionRequestSchema,
  DecisionRequestSchemaDTO,
  DecisionResponseSchema,
  NotificationRequestSchemaDTO,
  PaymentRequestSchema,
  PaymentRequestSchemaDTO,
  PaymentResponseSchema,
  PaymentResponseSchemaDTO,
} from '../dtos/briqpay-payment.dto'
import { BriqpayPaymentService } from '../services/briqpay-payment.service'
import { appLogger } from '../payment-sdk'

type PaymentRoutesOptions = {
  paymentService: BriqpayPaymentService
  sessionHeaderAuthHook: SessionHeaderAuthenticationHook
}

export const paymentRoutes = (fastify: FastifyInstance, opts: FastifyPluginOptions & PaymentRoutesOptions) => {
  fastify.get<{ Reply: any }>(
    '/config',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        response: {
          200: ConfigResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Use preview hostname if environment variable is set, otherwise use request hostname
      const previewHostname = process.env.PREVIEW_HOSTNAME
      const hostname = previewHostname || request.hostname

      // Get client origin for dynamic redirect URL construction
      const clientOrigin = request.headers.origin || request.headers.referer

      const paymentConfig = await opts.paymentService.config(hostname, clientOrigin)
      reply.code(200).send(paymentConfig)
    },
  )

  fastify.post<{ Body: DecisionRequestSchemaDTO; Reply: { success: boolean; decision: BRIQPAY_DECISION } }>(
    '/decision',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        body: DecisionRequestSchema,
        response: {
          200: DecisionResponseSchema,
        },
      },
    },
    async (request, reply) => {
      appLogger.info(
        {
          sessionId: request.body.sessionId,
          decision: request.body.decision,
        },
        'Processing decision request',
      )

      const result = await opts.paymentService.makeDecision({
        sessionId: request.body.sessionId,
        decision: request.body.decision,
        rejectionType: request.body.rejectionType,
        hardError: request.body.hardError,
        softErrors: request.body.softErrors,
      })

      return reply.status(200).send(result)
    },
  )

  fastify.post<{ Body: PaymentRequestSchemaDTO; Reply: PaymentResponseSchemaDTO }>(
    '/payments',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        body: PaymentRequestSchema,
        response: {
          200: PaymentResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const resp = await opts.paymentService.createPayment({
        data: request.body,
      })

      return reply.status(200).send(resp)
    },
  )

  fastify.post<{ Body: NotificationRequestSchemaDTO }>(
    '/notifications',
    {
      // Authentication will be done through HMAC verification if BRIQPAY_WEBHOOK_SECRET is configured
      preHandler: [],
    },
    async (request, reply) => {
      // Get the signature header for HMAC verification (if configured)
      const signatureHeader = request.headers['x-briq-signature'] as string | undefined

      // Get raw body for HMAC verification - Fastify stores it when rawBody option is enabled
      const rawBody = (request as unknown as { rawBody?: string }).rawBody

      await opts.paymentService.processNotification({
        data: request.body,
        signatureHeader,
        rawBody,
      })

      return reply.status(200).send('[accepted]')
    },
  )
}
