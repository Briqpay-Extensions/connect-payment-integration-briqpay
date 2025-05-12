import { SessionHeaderAuthenticationHook } from '@commercetools/connect-payments-sdk'
import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import {
  ConfigResponseSchema,
  DecisionRequestSchema,
  DecisionRequestSchemaDTO,
  NotificationRequestSchemaDTO,
  PaymentRequestSchema,
  PaymentRequestSchemaDTO,
  PaymentResponseSchema,
  PaymentResponseSchemaDTO,
} from '../dtos/briqpay-payment.dto'
import { BriqpayPaymentService } from '../services/briqpay-payment.service'
import Briqpay from '../libs/briqpay/BriqpayService'

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
    async (_, reply) => {
      const config = await opts.paymentService.config()
      reply.code(200).send(config)
    },
  )

  fastify.post<{ Body: DecisionRequestSchemaDTO; Reply: void }>(
    '/decision',
    {
      preHandler: [opts.sessionHeaderAuthHook.authenticate()],
      schema: {
        body: DecisionRequestSchema,
      },
    },
    async (request, reply) => {
      await Briqpay.makeDecision(request.body.sessionId, { decision: request.body.decision })
      return reply.status(204).send()
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
      // Authentication will be done through Briqpay for hooks
      preHandler: [],
    },
    async (request, reply) => {
      await opts.paymentService.processNotification({
        data: request.body,
      })

      return reply.status(200).send('[accepted]')
    },
  )
}
