import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { BriqpaySessionService } from '../../../src/services/briqpay/session.service'
import { mockGetCartResult } from '../../utils/mock-cart-data'
import Briqpay from '../../../src/libs/briqpay/BriqpayService'
import type { CommercetoolsCartService, Cart } from '@commercetools/connect-payments-sdk'
import { apiRoot } from '../../../src/libs/commercetools/api-root'

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

// Mock Briqpay service methods but keep the real mapCustomLineItem — the session
// comparison relies on it to mirror what createSession/updateSession actually send.
jest.mock('../../../src/libs/briqpay/BriqpayService', () => {
  const actual = jest.requireActual('../../../src/libs/briqpay/BriqpayService') as Record<string, unknown>
  return {
    __esModule: true,
    ...actual,
    default: {
      createSession: jest.fn(),
      getSession: jest.fn(),
      updateSession: jest.fn(),
      capture: jest.fn(),
      refund: jest.fn(),
      makeDecision: jest.fn(),
      cancel: jest.fn(),
      healthCheck: jest.fn(),
    },
  }
})

// Get mocked functions
const mockedBriqpay = jest.mocked(Briqpay)

// Helper to get a Cart typed to the SDK's version (avoids duplicate node_modules type mismatch)
const getCart = () => mockGetCartResult() as unknown as Cart

describe('BriqpaySessionService', () => {
  let sessionService: BriqpaySessionService
  const mockCtCartService = {
    getPaymentAmount: jest.fn(),
    getCart: jest.fn(),
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

  const cartWithFields = (fields: Record<string, string>, version = 1): Cart => ({
    ...getCart(),
    version,
    custom: { type: { typeId: 'type', id: 'briqpay-type' }, fields },
  })

  const buildApiRootWithExecute = (execute: jest.Mock) => {
    const post = jest.fn().mockReturnValue({ execute })
    const withId = jest.fn().mockReturnValue({ post })
    ;(apiRoot.carts as unknown as jest.Mock).mockReturnValue({ withId })

    return { post }
  }

  const buildCapturingApiRoot = () => {
    // Distinctive version (not fetched+1) so assertions on it prove the code used the
    // POST response version, not an incremented fetched one
    const execute = jest.fn<() => Promise<{ body: { version: number } }>>().mockResolvedValue({ body: { version: 42 } })

    return buildApiRootWithExecute(execute)
  }

  describe('updateCartWithBriqpaySession - checkoutTransactionItemId persistence', () => {
    test('writes the checkoutTransactionItemId setCustomField when present and changed', async () => {
      const { post } = buildCapturingApiRoot()
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-1' })
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)

      await sessionService.updateCartWithBriqpaySession(cart, 'sess-1', undefined, 'cti-abc')

      expect(post).toHaveBeenCalledWith({
        body: {
          version: 1,
          actions: [{ action: 'setCustomField', name: 'briqpay-checkout-transaction-item-id', value: 'cti-abc' }],
        },
      })
    })

    test('does NOT write the field when the persisted value already matches', async () => {
      const { post } = buildCapturingApiRoot()
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-1', 'briqpay-checkout-transaction-item-id': 'cti-abc' })
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)

      await sessionService.updateCartWithBriqpaySession(cart, 'sess-1', undefined, 'cti-abc')

      expect(post).not.toHaveBeenCalled()
      // Snapshot already in sync: the no-op path must not spend a getCart round trip either
      expect(mockCtCartService.getCart).not.toHaveBeenCalled()
    })

    test('sets the custom type first on a first-entry cart and writes all fields with the returned version', async () => {
      const { post } = buildCapturingApiRoot()
      const bareCart: Cart = { ...getCart(), version: 1, custom: undefined }
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(bareCart)

      await sessionService.updateCartWithBriqpaySession(bareCart, 'sess-1', '80087238', 'cti-abc')

      expect(post).toHaveBeenCalledTimes(2)
      expect(post).toHaveBeenNthCalledWith(1, {
        body: {
          version: 1,
          actions: [{ action: 'setCustomType', type: { key: 'briqpay-session-id', typeId: 'type' } }],
        },
      })
      // The field write must use the version returned by the setCustomType post, not the fetched one
      expect(post).toHaveBeenNthCalledWith(2, {
        body: {
          version: 42,
          actions: [
            { action: 'setCustomField', name: 'briqpay-session-id', value: 'sess-1' },
            { action: 'setCustomField', name: 'briqpay-future-order-number', value: '80087238' },
            { action: 'setCustomField', name: 'briqpay-checkout-transaction-item-id', value: 'cti-abc' },
          ],
        },
      })
    })
  })

  describe('updateCartWithBriqpaySession - 409 ConcurrentModification retry', () => {
    const conflictError = () => Object.assign(new Error('conflict'), { statusCode: 409 })

    test('re-fetches the cart and retries with the fresh version when CT rejects the write with 409', async () => {
      const staleCart = cartWithFields({ 'briqpay-session-id': 'sess-1' }, 119)
      const freshCart = cartWithFields({ 'briqpay-session-id': 'sess-1' }, 125)
      jest.mocked(mockCtCartService.getCart).mockResolvedValueOnce(staleCart).mockResolvedValueOnce(freshCart)

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValueOnce(conflictError())
        .mockResolvedValueOnce({ body: { version: 126 } })
      const { post } = buildApiRootWithExecute(execute)

      await sessionService.updateCartWithBriqpaySession(staleCart, 'sess-1', undefined, 'cti-abc')

      expect(post).toHaveBeenCalledTimes(2)
      expect(post).toHaveBeenLastCalledWith({
        body: {
          version: 125,
          actions: [{ action: 'setCustomField', name: 'briqpay-checkout-transaction-item-id', value: 'cti-abc' }],
        },
      })
    })

    test('skips the retry write when a concurrent writer already persisted the same values', async () => {
      const staleCart = cartWithFields({ 'briqpay-session-id': 'sess-1' }, 119)
      const freshCart = cartWithFields(
        { 'briqpay-session-id': 'sess-1', 'briqpay-checkout-transaction-item-id': 'cti-abc' },
        125,
      )
      jest.mocked(mockCtCartService.getCart).mockResolvedValueOnce(staleCart).mockResolvedValueOnce(freshCart)

      const execute = jest.fn<() => Promise<{ body: { version: number } }>>().mockRejectedValueOnce(conflictError())
      const { post } = buildApiRootWithExecute(execute)

      await expect(
        sessionService.updateCartWithBriqpaySession(staleCart, 'sess-1', undefined, 'cti-abc'),
      ).resolves.toBeUndefined()

      expect(post).toHaveBeenCalledTimes(1)
    })

    test('retries after a 409 on setCustomType and skips the type write when the retry sees it already set', async () => {
      const bareCart: Cart = { ...getCart(), version: 1, custom: undefined }
      const freshCart = cartWithFields({ 'briqpay-session-id': 'sess-1' }, 5)
      jest.mocked(mockCtCartService.getCart).mockResolvedValueOnce(bareCart).mockResolvedValueOnce(freshCart)

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValueOnce(conflictError())
        .mockResolvedValueOnce({ body: { version: 6 } })
      const { post } = buildApiRootWithExecute(execute)

      await sessionService.updateCartWithBriqpaySession(bareCart, 'sess-1', undefined, 'cti-abc')

      expect(post).toHaveBeenCalledTimes(2)
      expect(post).toHaveBeenNthCalledWith(1, {
        body: {
          version: 1,
          actions: [{ action: 'setCustomType', type: { key: 'briqpay-session-id', typeId: 'type' } }],
        },
      })
      // The retry re-evaluates the custom-type branch against the fresh cart: type already
      // set by a concurrent writer, so only the missing field is written, with the fresh version
      expect(post).toHaveBeenNthCalledWith(2, {
        body: {
          version: 5,
          actions: [{ action: 'setCustomField', name: 'briqpay-checkout-transaction-item-id', value: 'cti-abc' }],
        },
      })
    })

    test('does not overwrite a futureOrderNumber persisted by a concurrent writer during retry', async () => {
      const staleCart = cartWithFields({ 'briqpay-session-id': 'sess-1' }, 119)
      const freshCart = cartWithFields(
        { 'briqpay-session-id': 'sess-1', 'briqpay-future-order-number': '11111111' },
        125,
      )
      jest.mocked(mockCtCartService.getCart).mockResolvedValueOnce(staleCart).mockResolvedValueOnce(freshCart)

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValueOnce(conflictError())
        .mockResolvedValueOnce({ body: { version: 126 } })
      const { post } = buildApiRootWithExecute(execute)

      await sessionService.updateCartWithBriqpaySession(staleCart, 'sess-1', '80087238', 'cti-abc')

      expect(post).toHaveBeenCalledTimes(2)
      expect(post).toHaveBeenNthCalledWith(1, {
        body: {
          version: 119,
          actions: [
            { action: 'setCustomField', name: 'briqpay-future-order-number', value: '80087238' },
            { action: 'setCustomField', name: 'briqpay-checkout-transaction-item-id', value: 'cti-abc' },
          ],
        },
      })
      // Write-once: the concurrently persisted futureOrderNumber wins; only the still-missing field is written
      expect(post).toHaveBeenNthCalledWith(2, {
        body: {
          version: 125,
          actions: [{ action: 'setCustomField', name: 'briqpay-checkout-transaction-item-id', value: 'cti-abc' }],
        },
      })
    })

    test('treats 400 InvalidOperation as a benign no-op when the cart was ordered mid-update', async () => {
      const activeCart: Cart = { ...cartWithFields({ 'briqpay-session-id': 'sess-1' }, 119), cartState: 'Active' }
      const orderedCart: Cart = { ...activeCart, cartState: 'Ordered' }
      jest.mocked(mockCtCartService.getCart).mockResolvedValueOnce(activeCart).mockResolvedValueOnce(orderedCart)

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValue(
          Object.assign(new Error('The cart is not in active state.'), { statusCode: 400, code: 'InvalidOperation' }),
        )
      const { post } = buildApiRootWithExecute(execute)

      await expect(
        sessionService.updateCartWithBriqpaySession(activeCart, 'sess-1', undefined, 'cti-abc'),
      ).resolves.toBeUndefined()

      expect(post).toHaveBeenCalledTimes(1)
    })

    test('rethrows 400 InvalidOperation for a replacement session when the cart was ordered (blocks double charge)', async () => {
      const cartWithOldSession: Cart = {
        ...cartWithFields({ 'briqpay-session-id': 'sess-old' }, 119),
        cartState: 'Active',
      }
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cartWithOldSession)

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValue(
          Object.assign(new Error('The cart is not in active state.'), { statusCode: 400, code: 'InvalidOperation' }),
        )
      buildApiRootWithExecute(execute)

      await expect(
        sessionService.updateCartWithBriqpaySession(cartWithOldSession, 'sess-new', undefined, 'cti-abc'),
      ).rejects.toThrow('The cart is not in active state.')
    })

    test('rethrows 400 InvalidOperation when the cart is Frozen (transient state, not proof of an order)', async () => {
      const activeCart: Cart = { ...cartWithFields({ 'briqpay-session-id': 'sess-1' }, 119), cartState: 'Active' }
      const frozenCart: Cart = { ...activeCart, cartState: 'Frozen' }
      jest.mocked(mockCtCartService.getCart).mockResolvedValueOnce(activeCart).mockResolvedValueOnce(frozenCart)

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValue(
          Object.assign(new Error('The cart is not in active state.'), { statusCode: 400, code: 'InvalidOperation' }),
        )
      buildApiRootWithExecute(execute)

      await expect(
        sessionService.updateCartWithBriqpaySession(activeCart, 'sess-1', undefined, 'cti-abc'),
      ).rejects.toThrow('The cart is not in active state.')
    })

    test('rethrows 400 InvalidOperation when the cart is still Active (misconfiguration, not an ordered cart)', async () => {
      const activeCart: Cart = { ...cartWithFields({ 'briqpay-session-id': 'sess-1' }, 119), cartState: 'Active' }
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(activeCart)

      const execute = jest.fn<() => Promise<{ body: { version: number } }>>().mockRejectedValue(
        Object.assign(new Error("Field definition for 'briqpay-session-id' does not exist on type 'x'."), {
          statusCode: 400,
          code: 'InvalidOperation',
        }),
      )
      const { post } = buildApiRootWithExecute(execute)

      await expect(
        sessionService.updateCartWithBriqpaySession(activeCart, 'sess-1', undefined, 'cti-abc'),
      ).rejects.toThrow('Field definition')

      expect(post).toHaveBeenCalledTimes(1)
    })

    test('propagates 404 (cart deleted mid-flight) so no payable widget renders for a gone cart', async () => {
      jest
        .mocked(mockCtCartService.getCart)
        .mockRejectedValue(Object.assign(new Error('cart not found'), { statusCode: 404 }))

      const execute = jest.fn<() => Promise<{ body: { version: number } }>>()
      const { post } = buildApiRootWithExecute(execute)

      await expect(
        sessionService.updateCartWithBriqpaySession(cartWithFields({}, 1), 'sess-1', undefined, 'cti-abc'),
      ).rejects.toThrow('cart not found')

      expect(post).not.toHaveBeenCalled()
    })

    test('rethrows 400 InvalidOperation when the state probe finds the cart deleted', async () => {
      const activeCart: Cart = { ...cartWithFields({ 'briqpay-session-id': 'sess-1' }, 119), cartState: 'Active' }
      jest
        .mocked(mockCtCartService.getCart)
        .mockResolvedValueOnce(activeCart)
        .mockRejectedValueOnce(Object.assign(new Error('cart not found'), { statusCode: 404 }))

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValue(
          Object.assign(new Error('The cart is not in active state.'), { statusCode: 400, code: 'InvalidOperation' }),
        )
      buildApiRootWithExecute(execute)

      await expect(
        sessionService.updateCartWithBriqpaySession(activeCart, 'sess-1', undefined, 'cti-abc'),
      ).rejects.toThrow('The cart is not in active state.')
    })

    test('propagates non-409 errors without retrying', async () => {
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-1' }, 119)
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValue(Object.assign(new Error('bad request'), { statusCode: 400 }))
      const { post } = buildApiRootWithExecute(execute)

      await expect(sessionService.updateCartWithBriqpaySession(cart, 'sess-1', undefined, 'cti-abc')).rejects.toThrow(
        'bad request',
      )

      expect(post).toHaveBeenCalledTimes(1)
    })
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

    test('should handle cart with missing locale by falling back to en', async () => {
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
        htmlSnippet: '<div>Briqpay</div>',
        data: {
          order: {
            amountIncVat: 119000,
            currency: 'EUR',
            cart: [{ name: 'item', reference: 'ref' }],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      // Should NOT throw - falls back to 'en' locale and proceeds with comparison.
      // Comparison may fail on item names (test mock data mismatch) but that's ok -
      // the key assertion is that it doesn't throw a ValidationError.
      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')
      expect(result.sessionId).toBeDefined()
    })

    test('should NOT update session when cart including custom line item matches', async () => {
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
            cart: [
              {
                productType: 'physical',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                quantity: 1,
                unitPrice: 119000,
              },
              {
                productType: 'physical',
                reference: 'customLineItem-id-1',
                name: 'customLineItem-name-1',
                quantity: 1,
                unitPrice: 119000,
                taxRate: 0,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).not.toHaveBeenCalled()
      expect(mockedBriqpay.createSession).not.toHaveBeenCalled()
      expect(result.sessionId).toBe('existing-session-id')
    })

    test('should trigger update when custom line item is missing from session', async () => {
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
            cart: [
              {
                productType: 'physical',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                quantity: 1,
                unitPrice: 119000,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
    })

    test('should trigger update when custom line item price differs from session', async () => {
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
            cart: [
              {
                productType: 'physical',
                reference: baseCart.lineItems[0].id,
                name: 'lineitem-name-1',
                quantity: 1,
                unitPrice: 119000,
              },
              {
                productType: 'physical',
                reference: 'customLineItem-id-1',
                name: 'customLineItem-name-1',
                quantity: 1,
                unitPrice: 100000, // stale price in session; cart says 119000
                taxRate: 0,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
    })

    test('should exclude negative custom line items from session comparison', async () => {
      const baseCart = getCart()
      const negativeCustomLineItem = {
        ...baseCart.customLineItems[0],
        money: { ...baseCart.customLineItems[0].money, centAmount: -2503 },
        totalPrice: { ...baseCart.customLineItems[0].totalPrice, centAmount: -2503 },
      }
      const mockCart = {
        ...baseCart,
        locale: 'en',
        customLineItems: [negativeCustomLineItem],
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id' },
        },
      } as unknown as Cart

      // Session cart holds the mapped discount line for the negative custom line item;
      // both sides must filter it out so the comparison still matches.
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
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
                unitPrice: 119000,
              },
              {
                productType: 'discount',
                reference: 'customLineItem-id-1',
                name: 'customLineItem-name-1',
                quantity: 1,
                unitPrice: -2503,
                taxRate: 0,
              },
            ],
          },
        },
      } as never)

      const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

      const result = await sessionService.createOrUpdateBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).not.toHaveBeenCalled()
      expect(result.sessionId).toBe('existing-session-id')
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
})
