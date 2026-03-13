import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { BriqpaySessionService } from '../../../src/services/briqpay/session.service'
import { mockGetCartResult } from '../../utils/mock-cart-data'
import Briqpay from '../../../src/libs/briqpay/BriqpayService'
import type { CommercetoolsCartService, Cart } from '@commercetools/connect-payments-sdk'

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

// Mock Briqpay service
jest.mock('../../../src/libs/briqpay/BriqpayService')

// Get mocked functions
const mockedBriqpay = jest.mocked(Briqpay)

// Helper to get a Cart typed to the SDK's version (avoids duplicate node_modules type mismatch)
const getCart = () => mockGetCartResult() as unknown as Cart

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
      const mockCart = getCart()
      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: mockCart.id }),
        amountPlanned,
        'localhost',
        undefined,
      )
      expect(result.sessionId).toBe('new-session-id')
    })

    test('should retrieve existing session and compare cart', async () => {
      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as unknown as Cart

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
      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as unknown as Cart

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
      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as unknown as Cart

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
      const mockCart = getCart()
      mockedBriqpay.createSession.mockRejectedValue(new Error('Create failed'))

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      await expect(sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')).rejects.toThrow(
        'Failed to create Briqpay payment session',
      )
    })

    test('should create new session when getSession fails for existing session', async () => {
      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as unknown as Cart

      mockedBriqpay.getSession.mockRejectedValue(new Error('Session not found'))

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.createSession).toHaveBeenCalled()
      expect(result.sessionId).toBe('new-session-id')
    })
  })

  describe('compareCartWithSession - edge cases', () => {
    test('should trigger update when cart item count differs', async () => {
      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'en',
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
            cart: [],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
    })

    test('should handle cart with missing locale', async () => {
      const baseCart = getCart()
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
      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'de',
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
      const baseCart = getCart()
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

  describe('compareCartWithSession - US sales tax mode', () => {
    afterEach(() => {
      delete process.env.BRIQPAY_TREAT_US_AS_ROW
    })

    test('should return matching session when sales_tax item matches cart totalTax', async () => {
      delete process.env.BRIQPAY_TREAT_US_AS_ROW

      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        country: 'US',
        shippingAddress: { country: 'US' },
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
        taxedPrice: {
          totalNet: { centAmount: 114000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
          totalGross: { centAmount: 119000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
          totalTax: { centAmount: 5000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
          taxPortions: [],
        },
        lineItems: [
          {
            ...baseCart.lineItems[0],
            taxRate: { name: 'US Tax', amount: 0, includedInPrice: false, country: 'US' },
            taxedPrice: {
              totalNet: { centAmount: 119000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
              totalGross: {
                centAmount: 119000,
                currencyCode: 'USD',
                type: 'centPrecision' as const,
                fractionDigits: 2,
              },
              totalTax: { centAmount: 0, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
              taxPortions: [],
            },
          },
        ],
      } as unknown as Cart

      // Session has 2 items: 1 regular line item + 1 sales_tax synthetic item
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'USD',
            cart: [
              {
                productType: 'physical',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                quantity: 1,
                quantityUnit: 'pcs',
                unitPrice: 119000,
                unitPriceIncVat: 119000,
                taxRate: 0,
                totalAmount: 119000,
                totalVatAmount: 0,
              },
              {
                productType: 'sales_tax',
                reference: 'sales-tax',
                name: 'Sales Tax',
                totalTaxAmount: 5000,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'USD', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      // Cart matches session — no update needed, returns existing session
      expect(mockedBriqpay.updateSession).not.toHaveBeenCalled()
      expect(result.sessionId).toBe('existing-session-id')
    })

    test('should trigger update when sales_tax item is missing from session', async () => {
      delete process.env.BRIQPAY_TREAT_US_AS_ROW

      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        country: 'US',
        shippingAddress: { country: 'US' },
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
        taxedPrice: {
          totalNet: { centAmount: 114000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
          totalGross: { centAmount: 119000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
          totalTax: { centAmount: 5000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
          taxPortions: [],
        },
        lineItems: [
          {
            ...baseCart.lineItems[0],
            taxRate: { name: 'US Tax', amount: 0, includedInPrice: false, country: 'US' },
            taxedPrice: {
              totalNet: { centAmount: 119000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
              totalGross: {
                centAmount: 119000,
                currencyCode: 'USD',
                type: 'centPrecision' as const,
                fractionDigits: 2,
              },
              totalTax: { centAmount: 0, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
              taxPortions: [],
            },
          },
        ],
      } as unknown as Cart

      // Session has only 1 regular item — missing the sales_tax item.
      // Item count mismatch: expected 2 (1 line item + 1 sales_tax), got 1.
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'USD',
            cart: [
              {
                productType: 'physical',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                quantity: 1,
                quantityUnit: 'pcs',
                unitPrice: 119000,
                unitPriceIncVat: 119000,
                taxRate: 0,
                totalAmount: 119000,
                totalVatAmount: 0,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'USD', fractionDigits: 2 }

      await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      // Missing sales_tax item → item count mismatch → triggers update
      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
    })

    test('should trigger update when sales_tax totalTaxAmount does not match cart totalTax', async () => {
      delete process.env.BRIQPAY_TREAT_US_AS_ROW

      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        country: 'US',
        shippingAddress: { country: 'US' },
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
        taxedPrice: {
          totalNet: { centAmount: 114000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
          totalGross: { centAmount: 119000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
          totalTax: { centAmount: 5000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
          taxPortions: [],
        },
        lineItems: [
          {
            ...baseCart.lineItems[0],
            taxRate: { name: 'US Tax', amount: 0, includedInPrice: false, country: 'US' },
            taxedPrice: {
              totalNet: { centAmount: 119000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
              totalGross: {
                centAmount: 119000,
                currencyCode: 'USD',
                type: 'centPrecision' as const,
                fractionDigits: 2,
              },
              totalTax: { centAmount: 0, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
              taxPortions: [],
            },
          },
        ],
      } as unknown as Cart

      // Session has correct item count (2), but sales_tax amount is stale (3000 vs cart's 5000)
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'USD',
            cart: [
              {
                productType: 'physical',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                quantity: 1,
                quantityUnit: 'pcs',
                unitPrice: 119000,
                unitPriceIncVat: 119000,
                taxRate: 0,
                totalAmount: 119000,
                totalVatAmount: 0,
              },
              {
                productType: 'sales_tax',
                reference: 'sales-tax',
                name: 'Sales Tax',
                totalTaxAmount: 3000,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'USD', fractionDigits: 2 }

      await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      // totalTaxAmount mismatch (3000 !== 5000) → triggers update
      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
    })

    test('should skip sales_tax validation when BRIQPAY_TREAT_US_AS_ROW is true', async () => {
      process.env.BRIQPAY_TREAT_US_AS_ROW = 'true'

      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        country: 'US',
        shippingAddress: { country: 'US' },
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
        lineItems: [
          {
            ...baseCart.lineItems[0],
            taxRate: { name: 'US Tax', amount: 0.1, includedInPrice: false, country: 'US' },
            taxedPrice: {
              totalNet: { centAmount: 119000, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
              totalGross: {
                centAmount: 130900,
                currencyCode: 'USD',
                type: 'centPrecision' as const,
                fractionDigits: 2,
              },
              totalTax: { centAmount: 11900, currencyCode: 'USD', type: 'centPrecision' as const, fractionDigits: 2 },
              taxPortions: [],
            },
          },
        ],
      } as unknown as Cart

      // ROW mode: session has only the regular item, no sales_tax item
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'USD',
            cart: [
              {
                productType: 'physical',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                quantity: 1,
                quantityUnit: 'pcs',
                unitPrice: 119000,
                unitPriceIncVat: 130900,
                taxRate: 0.1,
                totalAmount: 130900,
                totalVatAmount: 11900,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'USD', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      // ROW mode: no sales_tax validation, session matches normally
      expect(mockedBriqpay.updateSession).not.toHaveBeenCalled()
      expect(result.sessionId).toBe('existing-session-id')
    })

    test('should skip sales_tax validation for non-US country', async () => {
      delete process.env.BRIQPAY_TREAT_US_AS_ROW

      const baseCart = getCart()
      const mockCart = {
        ...baseCart,
        locale: 'en',
        country: 'SE',
        shippingAddress: { country: 'SE' },
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
        lineItems: [
          {
            ...baseCart.lineItems[0],
            taxRate: { name: '25% VAT', amount: 0.25, includedInPrice: true, country: 'SE' },
            taxedPrice: {
              totalNet: { centAmount: 95200, currencyCode: 'SEK', type: 'centPrecision' as const, fractionDigits: 2 },
              totalGross: {
                centAmount: 119000,
                currencyCode: 'SEK',
                type: 'centPrecision' as const,
                fractionDigits: 2,
              },
              totalTax: { centAmount: 23800, currencyCode: 'SEK', type: 'centPrecision' as const, fractionDigits: 2 },
              taxPortions: [],
            },
          },
        ],
      } as unknown as Cart

      // Non-US: session has only the regular item, no sales_tax item expected
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'SEK',
            cart: [
              {
                productType: 'physical',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                quantity: 1,
                quantityUnit: 'pcs',
                unitPrice: 95200,
                unitPriceIncVat: 119000,
                taxRate: 0.25,
                totalAmount: 119000,
                totalVatAmount: 23800,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'SEK', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      // Non-US: no sales_tax validation, session matches normally
      expect(mockedBriqpay.updateSession).not.toHaveBeenCalled()
      expect(result.sessionId).toBe('existing-session-id')
    })
  })
})
