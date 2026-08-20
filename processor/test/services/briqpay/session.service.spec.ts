import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { BriqpaySessionService } from '../../../src/services/briqpay/session.service'
import { mockGetCartResult } from '../../utils/mock-cart-data'
import Briqpay from '../../../src/libs/briqpay/BriqpayService'
import type { CommercetoolsCartService, Cart } from '@commercetools/connect-payments-sdk'
import { apiRoot } from '../../../src/libs/commercetools/api-root'
import {
  SessionAlreadyCompletedError,
  SessionInitializationPendingError,
  SessionNotFoundError,
} from '../../../src/libs/errors/briqpay-errors'
import { appLogger } from '../../../src/payment-sdk'

// Mock apiRoot
jest.mock('../../../src/libs/commercetools/api-root')

// Mock payment SDK
jest.mock('../../../src/payment-sdk', () => ({
  appLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

// Mock actions module to avoid paymentSDK initialization issues
jest.mock('../../../src/connectors/actions', () => ({
  getBriqpayTypeKey: jest.fn<() => Promise<string>>().mockResolvedValue('briqpay-session-id'),
  clearBriqpayTypeKeyCache: jest.fn(),
}))

jest.mock('../../../src/libs/briqpay/BriqpayService', () => {
  const actual = jest.requireActual('../../../src/libs/briqpay/BriqpayService') as Record<string, unknown>
  return {
    __esModule: true,
    ...actual,
    default: {
      createSession: jest.fn(),
      getSession: jest.fn(),
      updateSession: jest.fn(),
      buildSessionUpdateRequest: jest.fn(),
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

// Hash the payload builder reports for the current cart, vs the one a create returns.
const BUILT_HASH = 'hash-of-current-cart'
const CREATED_HASH = 'hash-recorded-at-create'

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
      session: {
        sessionId: 'new-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        data: { order: { amountIncVat: 119000, currency: 'EUR', cart: [] } },
      },
      syncedPayloadHash: CREATED_HASH,
    } as never)

    // Amounts match the built payload by default, so an in-sync cart takes the GET path.
    mockedBriqpay.getSession.mockResolvedValue({
      sessionId: 'existing-session-id',
      htmlSnippet: '<div>Briqpay</div>',
      data: { order: { currency: 'EUR', amountIncVat: 119000, amountExVat: 100000, cart: [] } },
    } as never)

    mockedBriqpay.updateSession.mockResolvedValue({
      sessionId: 'updated-session-id',
      htmlSnippet: '<div>Briqpay Updated</div>',
    } as never)

    mockedBriqpay.buildSessionUpdateRequest.mockResolvedValue({
      body: '{"data":{}}',
      hash: BUILT_HASH,
      amounts: { currency: 'EUR', amountIncVat: 119000, amountExVat: 100000 },
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

  describe('updateCTCartWithBriqpaySession - checkoutTransactionItemId persistence', () => {
    test('writes the checkoutTransactionItemId setCustomField when present and changed', async () => {
      const { post } = buildCapturingApiRoot()
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-1' })
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)

      await sessionService.updateCTCartWithBriqpaySession(cart, {
        briqpaySessionId: 'sess-1',
        checkoutTransactionItemId: 'cti-abc',
      })

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

      await sessionService.updateCTCartWithBriqpaySession(cart, {
        briqpaySessionId: 'sess-1',
        checkoutTransactionItemId: 'cti-abc',
      })

      expect(post).not.toHaveBeenCalled()
      // Snapshot already in sync: the no-op path must not spend a getCart round trip either
      expect(mockCtCartService.getCart).not.toHaveBeenCalled()
    })

    test('sets the custom type first on a first-entry cart and writes all fields with the returned version', async () => {
      const { post } = buildCapturingApiRoot()
      const bareCart: Cart = { ...getCart(), version: 1, custom: undefined }
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(bareCart)

      await sessionService.updateCTCartWithBriqpaySession(bareCart, {
        briqpaySessionId: 'sess-1',
        futureOrderNumber: '80087238',
        checkoutTransactionItemId: 'cti-abc',
      })

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

  describe('updateCTCartWithBriqpaySession - 409 ConcurrentModification retry', () => {
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

      await sessionService.updateCTCartWithBriqpaySession(staleCart, {
        briqpaySessionId: 'sess-1',
        checkoutTransactionItemId: 'cti-abc',
      })

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
        sessionService.updateCTCartWithBriqpaySession(staleCart, {
          briqpaySessionId: 'sess-1',
          checkoutTransactionItemId: 'cti-abc',
        }),
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

      await sessionService.updateCTCartWithBriqpaySession(bareCart, {
        briqpaySessionId: 'sess-1',
        checkoutTransactionItemId: 'cti-abc',
      })

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

      await sessionService.updateCTCartWithBriqpaySession(staleCart, {
        briqpaySessionId: 'sess-1',
        futureOrderNumber: '80087238',
        checkoutTransactionItemId: 'cti-abc',
      })

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
        sessionService.updateCTCartWithBriqpaySession(activeCart, {
          briqpaySessionId: 'sess-1',
          checkoutTransactionItemId: 'cti-abc',
        }),
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
        sessionService.updateCTCartWithBriqpaySession(cartWithOldSession, {
          briqpaySessionId: 'sess-new',
          checkoutTransactionItemId: 'cti-abc',
        }),
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
        sessionService.updateCTCartWithBriqpaySession(activeCart, {
          briqpaySessionId: 'sess-1',
          checkoutTransactionItemId: 'cti-abc',
        }),
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
        sessionService.updateCTCartWithBriqpaySession(activeCart, {
          briqpaySessionId: 'sess-1',
          checkoutTransactionItemId: 'cti-abc',
        }),
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
        sessionService.updateCTCartWithBriqpaySession(cartWithFields({}, 1), {
          briqpaySessionId: 'sess-1',
          checkoutTransactionItemId: 'cti-abc',
        }),
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
        sessionService.updateCTCartWithBriqpaySession(activeCart, {
          briqpaySessionId: 'sess-1',
          checkoutTransactionItemId: 'cti-abc',
        }),
      ).rejects.toThrow('The cart is not in active state.')
    })

    test('propagates non-409 errors without retrying', async () => {
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-1' }, 119)
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValue(Object.assign(new Error('bad request'), { statusCode: 400 }))
      const { post } = buildApiRootWithExecute(execute)

      await expect(
        sessionService.updateCTCartWithBriqpaySession(cart, {
          briqpaySessionId: 'sess-1',
          checkoutTransactionItemId: 'cti-abc',
        }),
      ).rejects.toThrow('bad request')

      expect(post).toHaveBeenCalledTimes(1)
    })
  })

  describe('updateCTCartWithBriqpaySession - synced payload hash', () => {
    const metadata = { briqpaySessionId: 'sess-1', syncedPayloadHash: 'hash-abc' }

    test('writes the hash when it differs from the stored one', async () => {
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-1', 'briqpay-synced-payload-hash': 'hash-old' })
      const { post } = buildCapturingApiRoot()
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)

      await sessionService.updateCTCartWithBriqpaySession(cart, metadata)

      expect(post).toHaveBeenCalledWith({
        body: {
          version: cart.version,
          actions: [{ action: 'setCustomField', name: 'briqpay-synced-payload-hash', value: 'hash-abc' }],
        },
      })
    })

    test('skips the write entirely when the stored hash already matches', async () => {
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-1', 'briqpay-synced-payload-hash': 'hash-abc' })
      const { post } = buildCapturingApiRoot()

      await sessionService.updateCTCartWithBriqpaySession(cart, metadata)

      expect(post).not.toHaveBeenCalled()
      expect(mockCtCartService.getCart).not.toHaveBeenCalled()
    })

    test('leaves the stored hash untouched when the caller passes none', async () => {
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-1', 'briqpay-synced-payload-hash': 'hash-old' })
      const { post } = buildCapturingApiRoot()

      // A session that could not be synced (completed/initializing) reports no hash, and
      // clearing the marker would claim Briqpay holds a payload it does not.
      await sessionService.updateCTCartWithBriqpaySession(cart, { briqpaySessionId: 'sess-1' })

      expect(post).not.toHaveBeenCalled()
    })

    test('retries without the hash when the field is not yet on the cart custom type', async () => {
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-old' })
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)

      // postDeploy adds the field after the new version already serves traffic; a 400 here
      // must not take checkout down for what is only an optimisation.
      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValueOnce(
          Object.assign(new Error("Field definition for 'briqpay-synced-payload-hash' does not exist"), {
            statusCode: 400,
            code: 'InvalidOperation',
          }),
        )
        .mockResolvedValue({ body: { version: 42 } })
      const { post } = buildApiRootWithExecute(execute)

      await sessionService.updateCTCartWithBriqpaySession(cart, metadata)

      expect(post).toHaveBeenLastCalledWith({
        body: {
          version: cart.version,
          actions: [{ action: 'setCustomField', name: 'briqpay-session-id', value: 'sess-1' }],
        },
      })
      expect(appLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ field: 'briqpay-synced-payload-hash' }),
        expect.stringContaining('post-deploy'),
      )
    })

    test('propagates the original error when the retry without the hash also fails', async () => {
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-old' })
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)

      const execute = jest
        .fn<() => Promise<{ body: { version: number } }>>()
        .mockRejectedValue(
          Object.assign(new Error('The cart is not in active state.'), { statusCode: 400, code: 'InvalidOperation' }),
        )
      buildApiRootWithExecute(execute)

      await expect(sessionService.updateCTCartWithBriqpaySession(cart, metadata)).rejects.toThrow(
        'The cart is not in active state.',
      )
    })
  })

  describe('resolveBriqpaySession', () => {
    const amountPlanned = { centAmount: 119000, currencyCode: 'EUR', fractionDigits: 2 }

    const cartWithSession = (fields: Record<string, string> = {}) =>
      ({
        ...getCart(),
        locale: 'en',
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id', ...fields },
        },
      }) as unknown as Cart

    test('creates a session when the cart has none, without building or fetching one', async () => {
      const mockCart = getCart()

      const result = await sessionService.resolveBriqpaySession(mockCart, amountPlanned, 'localhost')

      expect(mockedBriqpay.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: mockCart.id }),
        amountPlanned,
        'localhost',
        undefined,
      )
      expect(mockedBriqpay.buildSessionUpdateRequest).not.toHaveBeenCalled()
      expect(mockedBriqpay.getSession).not.toHaveBeenCalled()
      expect(mockedBriqpay.updateSession).not.toHaveBeenCalled()
      expect(result.session.sessionId).toBe('new-session-id')
      expect(result.syncedPayloadHash).toBe(CREATED_HASH)
    })

    test('only GETs when the stored hash matches - the whole point of the marker', async () => {
      const cart = cartWithSession({ 'briqpay-synced-payload-hash': BUILT_HASH })

      const result = await sessionService.resolveBriqpaySession(cart, amountPlanned, 'localhost')

      // Exactly one call: the amount check reads this same response rather than fetching again.
      expect(mockedBriqpay.getSession).toHaveBeenCalledTimes(1)
      expect(mockedBriqpay.getSession).toHaveBeenCalledWith('existing-session-id')
      expect(mockedBriqpay.updateSession).not.toHaveBeenCalled()
      expect(result.session.sessionId).toBe('existing-session-id')
      expect(result.syncedPayloadHash).toBe(BUILT_HASH)
    })

    test('updates when the hash is absent, which is every cart predating the field', async () => {
      const result = await sessionService.resolveBriqpaySession(cartWithSession(), amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalledWith(
        'existing-session-id',
        expect.objectContaining({ hash: BUILT_HASH }),
      )
      expect(result.session.sessionId).toBe('updated-session-id')
      expect(result.syncedPayloadHash).toBe(BUILT_HASH)
    })

    test('updates when the stored hash is stale', async () => {
      const cart = cartWithSession({ 'briqpay-synced-payload-hash': 'hash-of-an-older-cart' })

      await sessionService.resolveBriqpaySession(cart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
    })

    test('treats a non-string stored hash as stale rather than throwing', async () => {
      const cart = {
        ...getCart(),
        custom: {
          type: { typeId: 'type' as const, id: 'briqpay-session-id' },
          fields: { 'briqpay-session-id': 'existing-session-id', 'briqpay-synced-payload-hash': 42 },
        },
      } as unknown as Cart

      await sessionService.resolveBriqpaySession(cart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
    })

    test('re-syncs when the marker claims in-sync but Briqpay holds different amounts', async () => {
      const cart = cartWithSession({ 'briqpay-synced-payload-hash': BUILT_HASH })
      // Concurrent /config calls can leave the marker describing a payload Briqpay is
      // not holding, so the GET response - not the marker - decides.
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        data: { order: { currency: 'EUR', amountIncVat: 100000, amountExVat: 90000, cart: [] } },
      } as never)

      const result = await sessionService.resolveBriqpaySession(cart, amountPlanned, 'localhost')

      expect(mockedBriqpay.updateSession).toHaveBeenCalled()
      expect(result.session.sessionId).toBe('updated-session-id')
    })

    test('creates a replacement when an update reports the session no longer exists', async () => {
      const cart = cartWithSession()
      mockedBriqpay.updateSession.mockRejectedValue(new SessionNotFoundError('session gone'))

      const result = await sessionService.resolveBriqpaySession(cart, amountPlanned, 'localhost', 'ord-1')

      expect(mockedBriqpay.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: cart.id }),
        amountPlanned,
        'localhost',
        'ord-1',
      )
      expect(result.session.sessionId).toBe('new-session-id')
    })

    test('creates a replacement when the in-sync GET reports the session no longer exists', async () => {
      const cart = cartWithSession({ 'briqpay-synced-payload-hash': BUILT_HASH })
      mockedBriqpay.getSession.mockRejectedValue(new SessionNotFoundError('session gone'))

      const result = await sessionService.resolveBriqpaySession(cart, amountPlanned, 'localhost')

      expect(mockedBriqpay.createSession).toHaveBeenCalled()
      expect(result.session.sessionId).toBe('new-session-id')
    })

    test('returns a completed session untouched and records no hash', async () => {
      const cart = cartWithSession()
      mockedBriqpay.updateSession.mockRejectedValue(new SessionAlreadyCompletedError('already completed'))
      mockedBriqpay.getSession.mockResolvedValue({
        sessionId: 'existing-session-id',
        htmlSnippet: '<div>Briqpay</div>',
        moduleStatus: { payment: { orderStatus: 'order_pending' } },
        data: { order: { currency: 'EUR', amountIncVat: 119000, amountExVat: 100000, cart: [] } },
      } as never)

      const result = await sessionService.resolveBriqpaySession(cart, amountPlanned, 'localhost')

      expect(mockedBriqpay.createSession).not.toHaveBeenCalled()
      expect(result.session.sessionId).toBe('existing-session-id')
      // Undefined leaves the stored marker alone: the payload was never applied.
      expect(result.syncedPayloadHash).toBeUndefined()
    })

    test('returns an initializing session as-is so the widget still renders', async () => {
      const cart = cartWithSession()
      mockedBriqpay.updateSession.mockRejectedValue(new SessionInitializationPendingError('still initializing'))

      const result = await sessionService.resolveBriqpaySession(cart, amountPlanned, 'localhost')

      expect(result.session.sessionId).toBe('existing-session-id')
      expect(result.syncedPayloadHash).toBeUndefined()
      expect(mockedBriqpay.createSession).not.toHaveBeenCalled()
    })

    test('propagates a generic update failure instead of creating a replacement', async () => {
      mockedBriqpay.updateSession.mockRejectedValue(new Error('Briqpay update exploded'))

      await expect(sessionService.resolveBriqpaySession(cartWithSession(), amountPlanned, 'localhost')).rejects.toThrow(
        'Briqpay update exploded',
      )

      expect(mockedBriqpay.createSession).not.toHaveBeenCalled()
    })

    test('propagates a generic GET failure on the in-sync path', async () => {
      const cart = cartWithSession({ 'briqpay-synced-payload-hash': BUILT_HASH })
      mockedBriqpay.getSession.mockRejectedValue(new Error('Briqpay API error: {"error":{"code":"INVALID_DATA"}}'))

      await expect(sessionService.resolveBriqpaySession(cart, amountPlanned, 'localhost')).rejects.toThrow(
        'Briqpay API error',
      )

      expect(mockedBriqpay.createSession).not.toHaveBeenCalled()
    })
  })

  describe('syncCTCartToBriqpaySession', () => {
    test('updates Briqpay and records the resulting hash on the cart', async () => {
      const cart = cartWithFields({ 'briqpay-session-id': 'sess-1' })
      const { post } = buildCapturingApiRoot()
      jest.mocked(mockCtCartService.getCart).mockResolvedValue(cart)

      await sessionService.syncCTCartToBriqpaySession(cart, 'sess-1', {
        centAmount: 119000,
        currencyCode: 'EUR',
        fractionDigits: 2,
      })

      expect(mockedBriqpay.updateSession).toHaveBeenCalledWith('sess-1', expect.objectContaining({ hash: BUILT_HASH }))
      expect(post).toHaveBeenCalledWith({
        body: {
          version: cart.version,
          actions: [{ action: 'setCustomField', name: 'briqpay-synced-payload-hash', value: BUILT_HASH }],
        },
      })
    })
  })
})
