import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { BriqpayOperationService } from '../../../src/services/briqpay/operation.service'
import { mockGetCartResult } from '../../utils/mock-cart-data'
import Briqpay from '../../../src/libs/briqpay/BriqpayService'
import { PaymentOutcome } from '../../../src/dtos/briqpay-payment.dto'
import type { CommercetoolsCartService, CommercetoolsPaymentService } from '@commercetools/connect-payments-sdk'
import type { Cart as PlatformCart } from '@commercetools/platform-sdk'

// Mock apiRoot
jest.mock('../../../src/libs/commercetools/api-root')

// Mock payment SDK
jest.mock('../../../src/payment-sdk', () => ({
  appLogger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}))

// Mock actions module to avoid paymentSDK initialization issues
jest.mock('../../../src/connectors/actions', () => ({
  getBriqpayTypeKey: jest.fn<() => Promise<string>>().mockResolvedValue('briqpay-session-id'),
  clearBriqpayTypeKeyCache: jest.fn(),
}))

// Mock context functions
jest.mock('../../../src/libs/fastify/context/context', () => ({
  getCartIdFromContext: jest.fn().mockReturnValue('cart-id'),
  getFutureOrderNumberFromContext: jest.fn().mockReturnValue(undefined),
  getPaymentInterfaceFromContext: jest.fn().mockReturnValue('Briqpay'),
}))

// Mock Briqpay service
jest.mock('../../../src/libs/briqpay/BriqpayService')

// Get mocked functions
const mockedBriqpay = jest.mocked(Briqpay)

describe('BriqpayOperationService', () => {
  let operationService: BriqpayOperationService

  const mockCtCartService = {
    getCart: jest.fn(),
    getCartByPaymentId: jest.fn(),
    addPayment: jest.fn(),
    getPaymentAmount: jest.fn(),
  } as unknown as CommercetoolsCartService

  const mockCtPaymentService = {
    updatePayment: jest.fn(),
    createPayment: jest.fn(),
    hasTransactionInState: jest.fn(),
  } as unknown as CommercetoolsPaymentService

  const mockSessionId = 'briqpay-session-123'
  const mockCaptureId = 'capture-123'

  const basePayment = {
    id: 'payment-id-1',
    version: 1,
    interfaceId: 'psp-ref-1',
    amountPlanned: { centAmount: 119000, currencyCode: 'EUR', type: 'centPrecision' as const, fractionDigits: 2 },
    paymentMethodInfo: {},
    paymentStatus: {},
    transactions: [
      {
        id: 'tx-auth-1',
        type: 'Authorization' as const,
        amount: { centAmount: 119000, currencyCode: 'EUR', type: 'centPrecision' as const, fractionDigits: 2 },
        interactionId: mockSessionId,
        state: 'Success' as const,
      },
    ],
    createdAt: '2024-01-01T00:00:00Z',
    lastModifiedAt: '2024-01-01T00:00:00Z',
  }

  const paymentWithCapture = {
    ...basePayment,
    transactions: [
      ...basePayment.transactions,
      {
        id: 'tx-charge-1',
        type: 'Charge' as const,
        amount: { centAmount: 119000, currencyCode: 'EUR', type: 'centPrecision' as const, fractionDigits: 2 },
        interactionId: mockCaptureId,
        state: 'Success' as const,
      },
    ],
  }

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.BRIQPAY_TREAT_US_AS_ROW

    operationService = new BriqpayOperationService(mockCtCartService, mockCtPaymentService)

    // Default mock implementations
    mockedBriqpay.capture.mockResolvedValue({
      captureId: mockCaptureId,
      status: PaymentOutcome.APPROVED,
    } as never)

    mockedBriqpay.refund.mockResolvedValue({
      refundId: 'refund-123',
      status: PaymentOutcome.APPROVED,
    } as never)

    mockedBriqpay.cancel.mockResolvedValue({
      status: PaymentOutcome.APPROVED,
    } as never)

    jest.mocked(mockCtPaymentService.updatePayment).mockResolvedValue(basePayment as never)
  })

  afterEach(() => {
    delete process.env.BRIQPAY_TREAT_US_AS_ROW
    jest.restoreAllMocks()
  })

  /**
   * Creates a mock CT cart for the given country with optional taxedPrice.
   */
  const buildCartForCountry = (country: string, totalTaxCentAmount?: number): PlatformCart => {
    const cart = mockGetCartResult()
    const cartWithCountry = {
      ...cart,
      country,
      taxedPrice:
        totalTaxCentAmount !== undefined
          ? {
              totalNet: {
                type: 'centPrecision' as const,
                centAmount: 119000 - totalTaxCentAmount,
                currencyCode: 'EUR',
                fractionDigits: 2,
              },
              totalGross: {
                type: 'centPrecision' as const,
                centAmount: 119000,
                currencyCode: 'EUR',
                fractionDigits: 2,
              },
              totalTax: {
                type: 'centPrecision' as const,
                centAmount: totalTaxCentAmount,
                currencyCode: 'EUR',
                fractionDigits: 2,
              },
              taxPortions: [],
            }
          : undefined,
      totalPrice: { type: 'centPrecision' as const, centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 },
    } as unknown as PlatformCart

    return cartWithCountry
  }

  describe('capturePayment — US sales tax mode', () => {
    test('should pass salesTaxOverride when country is US and BRIQPAY_TREAT_US_AS_ROW is not set', async () => {
      const usCart = buildCartForCountry('US', 5000)
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(usCart as never)

      await operationService.capturePayment({
        amount: { centAmount: 119000, currencyCode: 'EUR' },
        payment: basePayment as never,
      })

      expect(mockedBriqpay.capture).toHaveBeenCalledWith(usCart, basePayment.amountPlanned, mockSessionId, {
        enabled: true,
        totalTaxCentAmount: 5000,
      })
    })

    test('should NOT pass salesTaxOverride when country is US but BRIQPAY_TREAT_US_AS_ROW is true', async () => {
      process.env.BRIQPAY_TREAT_US_AS_ROW = 'true'

      const usCart = buildCartForCountry('US', 5000)
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(usCart as never)

      await operationService.capturePayment({
        amount: { centAmount: 119000, currencyCode: 'EUR' },
        payment: basePayment as never,
      })

      expect(mockedBriqpay.capture).toHaveBeenCalledWith(usCart, basePayment.amountPlanned, mockSessionId, undefined)
    })

    test('should NOT pass salesTaxOverride when country is non-US', async () => {
      const seCart = buildCartForCountry('SE', 5000)
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(seCart as never)

      await operationService.capturePayment({
        amount: { centAmount: 119000, currencyCode: 'EUR' },
        payment: basePayment as never,
      })

      expect(mockedBriqpay.capture).toHaveBeenCalledWith(seCart, basePayment.amountPlanned, mockSessionId, undefined)
    })
  })

  describe('refundPayment — US sales tax mode', () => {
    test('should pass salesTaxOverride when country is US and BRIQPAY_TREAT_US_AS_ROW is not set', async () => {
      const usCart = buildCartForCountry('US', 5000)
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(usCart as never)

      await operationService.refundPayment({
        amount: { centAmount: 119000, currencyCode: 'EUR' },
        payment: paymentWithCapture as never,
      })

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(
        usCart,
        paymentWithCapture.amountPlanned,
        mockSessionId,
        mockCaptureId,
        { enabled: true, totalTaxCentAmount: 5000 },
      )
    })

    test('should NOT pass salesTaxOverride when country is US but BRIQPAY_TREAT_US_AS_ROW is true', async () => {
      process.env.BRIQPAY_TREAT_US_AS_ROW = 'true'

      const usCart = buildCartForCountry('US', 5000)
      jest.mocked(mockCtCartService.getCartByPaymentId).mockResolvedValue(usCart as never)

      await operationService.refundPayment({
        amount: { centAmount: 119000, currencyCode: 'EUR' },
        payment: paymentWithCapture as never,
      })

      expect(mockedBriqpay.refund).toHaveBeenCalledWith(
        usCart,
        paymentWithCapture.amountPlanned,
        mockSessionId,
        mockCaptureId,
        undefined,
      )
    })
  })
})
