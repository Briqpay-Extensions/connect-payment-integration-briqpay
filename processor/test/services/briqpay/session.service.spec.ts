import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { BriqpaySessionService } from '../../../src/services/briqpay/session.service'
import { mockGetCartResult } from '../../utils/mock-cart-data'
import Briqpay from '../../../src/libs/briqpay/BriqpayService'
import type { CommercetoolsCartService } from '@commercetools/connect-payments-sdk'
import type { Cart } from '@commercetools/platform-sdk'

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
  getBriqpayTypeKey: jest.fn().mockResolvedValue('briqpay-session-id'),
  clearBriqpayTypeKeyCache: jest.fn(),
}))

// Mock Briqpay service
jest.mock('../../../src/libs/briqpay/BriqpayService')

// Get mocked functions
const mockedBriqpay = jest.mocked(Briqpay)

describe('BriqpaySessionService', () => {
  let sessionService: BriqpaySessionService
  const mockCtCartService = {
    getPaymentAmount: jest.fn(),
  } as unknown as CommercetoolsCartService

  beforeEach(() => {
    jest.clearAllMocks()
    sessionService = new BriqpaySessionService(mockCtCartService)

    // Default mock implementations
    mockedBriqpay.createSession.mockResolvedValue({
      sessionId: 'new-session-id',
      htmlSnippet: '<div>Briqpay</div>',
      data: { order: { amountIncVat: 119000, currency: 'EUR', cart: [] } },
    } as never)

    mockedBriqpay.getSession.mockResolvedValue({
      sessionId: 'existing-session-id',
      htmlSnippet: '<div>Briqpay</div>',
      data: { order: { amountIncVat: 119000, currency: 'EUR', cart: [] } },
    } as never)

    mockedBriqpay.updateSession.mockResolvedValue({
      sessionId: 'updated-session-id',
      htmlSnippet: '<div>Briqpay Updated</div>',
    } as never)
    jest.mocked(mockCtCartService.getPaymentAmount).mockResolvedValue({
      centAmount: 119000,
      currencyCode: 'EUR',
      fractionDigits: 2,
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('createOrUpdateBriqpaySession', () => {
    test('should create new session when no existing session', async () => {
      const mockCart = mockGetCartResult()
      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.createSession).toHaveBeenCalledWith(
        mockCart,
        amountPlanned,
        'localhost',
        undefined,
        undefined,
      )
      expect(result.sessionId).toBe('new-session-id')
    })

    test('should retrieve existing session and compare cart', async () => {
      const baseCart = mockGetCartResult()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as Cart

      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'EUR',
            cart: [],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.getSession).toHaveBeenCalledWith('existing-session-id')
      expect(result.sessionId).toBeDefined()
    })

    test('should update session when cart amount differs', async () => {
      const baseCart = mockGetCartResult()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as Cart

      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        data: { order: { amountIncVat: 100000, currency: 'EUR', cart: [] } },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
      expect(result.sessionId).toBe('updated-session-id')
    })

    test('should create new session when update fails', async () => {
      const baseCart = mockGetCartResult()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as Cart

      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        data: { order: { amountIncVat: 100000, currency: 'EUR', cart: [] } },
      } as never)

      mockedBriqpay.updateSession.mockRejectedValue(new Error('Update failed'))

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.createSession).toHaveBeenCalled()
      expect(result.sessionId).toBe('new-session-id')
    })

    test('should throw SessionError when all session operations fail', async () => {
      const mockCart = mockGetCartResult()
      mockedBriqpay.createSession.mockRejectedValue(new Error('Create failed'))

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      await expect(sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')).rejects.toThrow(
        'Failed to create Briqpay payment session',
      )
    })

    test('should create new session when getSession fails for existing session', async () => {
      const baseCart = mockGetCartResult()
      const mockCart = {
        ...baseCart,
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as Cart

      mockedBriqpay.getSession.mockRejectedValue(new Error('Session not found'))

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.createSession).toHaveBeenCalled()
      expect(result.sessionId).toBe('new-session-id')
    })
  })

  describe('compareCartWithSession - edge cases', () => {
    test('should trigger update when cart item count differs', async () => {
      const baseCart = mockGetCartResult()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as Cart

      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'EUR',
            cart: [],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
    })

    test('should handle cart with missing locale', async () => {
      const baseCart = mockGetCartResult()
      const mockCart = {
        ...baseCart,
        locale: undefined,
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as unknown as Cart

      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'EUR',
            cart: [{ name: 'item', reference: 'ref' }],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      try {
        await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')
      } catch (e) {
        expect((e as Error).message).toContain('locale')
      }
    })

    test('should trigger update when cart item name is missing in locale', async () => {
      const baseCart = mockGetCartResult()
      const mockCart = {
        ...baseCart,
        locale: 'de',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as Cart

      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'EUR',
            cart: [
              {
                productType: 'physical',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                quantity: 1,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
    })

    test('should handle sales_tax product type in session cart', async () => {
      const baseCart = mockGetCartResult()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
        lineItems: [
          {
            ...baseCart.lineItems[0],
            taxedPrice: {
              totalNet: { centAmount: 100000, currencyCode: 'EUR', type: 'centPrecision' as const, fractionDigits: 2 },
              totalGross: {
                centAmount: 119000,
                currencyCode: 'EUR',
                type: 'centPrecision' as const,
                fractionDigits: 2,
              },
              totalTax: { centAmount: 19000, currencyCode: 'EUR', type: 'centPrecision' as const, fractionDigits: 2 },
              taxPortions: [],
            },
          },
        ],
      } as unknown as Cart

      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'EUR',
            cart: [
              {
                productType: 'sales_tax',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                totalTaxAmount: 19000,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(result.sessionId).toBeDefined()
    })
  })
})
