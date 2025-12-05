import { FastifyInstance } from 'fastify'
import { paymentSDK } from '../../payment-sdk'
import { paymentRoutes } from '../../routes/briqpay-payment.route'
import { BriqpayPaymentService } from '../../services/briqpay-payment.service'

export default async function (server: FastifyInstance) {
  const briqpayPaymentService = new BriqpayPaymentService({
    ctCartService: paymentSDK.ctCartService,
    ctPaymentService: paymentSDK.ctPaymentService,
  })

  await server.register(paymentRoutes, {
    paymentService: briqpayPaymentService,
    sessionHeaderAuthHook: paymentSDK.sessionHeaderAuthHookFn,
  })
}
