import { paymentSDK } from '../payment-sdk'
import { BriqpayPaymentService } from '../services/briqpay-payment.service'

const paymentService = new BriqpayPaymentService({
  ctCartService: paymentSDK.ctCartService,
  ctPaymentService: paymentSDK.ctPaymentService,
})

export const app = {
  services: {
    paymentService,
  },
}
