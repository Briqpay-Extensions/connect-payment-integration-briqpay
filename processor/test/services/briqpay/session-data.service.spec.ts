import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { BriqpaySessionDataService } from '../../../src/services/briqpay/session-data.service'
import { ExtractedBriqpayCustomFields } from '../../../src/services/types/briqpay-session-data.type'

// Mock actions module to avoid paymentSDK initialization issues
jest.mock('../../../src/connectors/actions', () => ({
  getBriqpayTypeKey: jest.fn<() => Promise<string>>().mockResolvedValue('briqpay-session-id'),
  clearBriqpayTypeKeyCache: jest.fn(),
}))

// Mock apiRoot
const mockOrderGet = jest.fn<
  () => Promise<{
    body: {
      id: string
      version: number
      custom?: { type: { id: string; key?: string }; fields: Record<string, unknown> }
    }
  }>
>()
const mockOrderPostExecute = jest.fn<() => Promise<{ body: { id: string; version: number } }>>()
const mockOrderPost = jest
  .fn<(args: { body: { version: number; actions: unknown[] } }) => { execute: typeof mockOrderPostExecute }>()
  .mockReturnValue({ execute: mockOrderPostExecute })

const mockCartGet = jest.fn<
  () => Promise<{
    body: {
      id: string
      version: number
      custom?: { type: { id: string; key?: string }; fields: Record<string, unknown> }
    }
  }>
>()
const mockCartPostExecute = jest.fn<() => Promise<{ body: { id: string; version: number } }>>()
const mockCartPost = jest
  .fn<(args: { body: { version: number; actions: unknown[] } }) => { execute: typeof mockCartPostExecute }>()
  .mockReturnValue({ execute: mockCartPostExecute })

const mockTypeGetExecute = jest.fn<() => Promise<{ body: { fieldDefinitions: { name: string }[] } }>>()
mockTypeGetExecute.mockResolvedValue({
  body: {
    fieldDefinitions: [
      { name: 'briqpay-session-id' },
      { name: 'briqpay-psp-meta-data-description' },
      { name: 'briqpay-transaction-data-reservation-id' },
    ],
  },
})

const mockTypeWithId = jest.fn<() => { get: () => { execute: typeof mockTypeGetExecute } }>()
mockTypeWithId.mockReturnValue({ get: () => ({ execute: mockTypeGetExecute }) })

const mockTypes = jest.fn<() => { withId: typeof mockTypeWithId }>()
mockTypes.mockReturnValue({ withId: mockTypeWithId })

jest.mock('../../../src/libs/commercetools/api-root', () => ({
  apiRoot: {
    orders: () => ({
      withId: () => ({
        get: () => ({ execute: mockOrderGet }),
        post: mockOrderPost,
      }),
    }),
    carts: () => ({
      withId: () => ({
        get: () => ({ execute: mockCartGet }),
        post: mockCartPost,
      }),
    }),
    types: () => mockTypes(),
  },
}))

// Mock payment SDK
jest.mock('../../../src/payment-sdk', () => ({
  appLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

describe('BriqpaySessionDataService', () => {
  let service: BriqpaySessionDataService

  // Store original env
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()

    // Reset mocks to default behavior
    mockOrderGet.mockResolvedValue({
      body: {
        id: 'order-123',
        version: 1,
        custom: { type: { id: 'type-id', key: 'briqpay-session-id' }, fields: {} },
      },
    })

    mockCartGet.mockResolvedValue({
      body: {
        id: 'cart-123',
        version: 1,
        custom: { type: { id: 'type-id', key: 'briqpay-session-id' }, fields: {} },
      },
    })

    // Set required env variables
    process.env = {
      ...originalEnv,
      BRIQPAY_BASE_URL: 'https://dev-api.briqpay.com/v3',
      BRIQPAY_USERNAME: 'test-user',
      BRIQPAY_SECRET: 'test-secret',
    }

    service = new BriqpaySessionDataService()
  })

  afterEach(() => {
    process.env = originalEnv
    jest.restoreAllMocks()
  })

  describe('constructor', () => {
    test('should throw error when BRIQPAY_BASE_URL is missing', () => {
      delete process.env.BRIQPAY_BASE_URL
      expect(() => new BriqpaySessionDataService()).toThrow(
        'Missing required Briqpay environment variables: BRIQPAY_BASE_URL, BRIQPAY_USERNAME, BRIQPAY_SECRET',
      )
    })

    test('should throw error when BRIQPAY_USERNAME is missing', () => {
      delete process.env.BRIQPAY_USERNAME
      expect(() => new BriqpaySessionDataService()).toThrow(
        'Missing required Briqpay environment variables: BRIQPAY_BASE_URL, BRIQPAY_USERNAME, BRIQPAY_SECRET',
      )
    })

    test('should throw error when BRIQPAY_SECRET is missing', () => {
      delete process.env.BRIQPAY_SECRET
      expect(() => new BriqpaySessionDataService()).toThrow(
        'Missing required Briqpay environment variables: BRIQPAY_BASE_URL, BRIQPAY_USERNAME, BRIQPAY_SECRET',
      )
    })
  })

  describe('extractCustomFields', () => {
    test('should extract all available PSP metadata fields', () => {
      const sessionData = {
        sessionId: 'test-session',
        data: {
          pspMetadata: {
            customerFacingReference: 'REF-123',
            description: 'Test description',
            type: 'invoice',
            payerEmail: 'test@example.com',
            payerFirstName: 'John',
            payerLastName: 'Doe',
          },
        },
      }

      const result = service.extractCustomFields(sessionData)

      expect(result).toEqual({
        'briqpay-psp-meta-data-customer-facing-reference': 'REF-123',
        'briqpay-psp-meta-data-description': 'Test description',
        'briqpay-psp-meta-data-type': 'invoice',
        'briqpay-psp-meta-data-payer-email': 'test@example.com',
        'briqpay-psp-meta-data-payer-first-name': 'John',
        'briqpay-psp-meta-data-payer-last-name': 'Doe',
      })
    })

    test('should extract all available transaction data fields', () => {
      const sessionData = {
        sessionId: 'test-session',
        data: {
          transactions: [
            {
              reservationId: 'res-123',
              secondaryReservationId: 'sec-res-456',
              pspId: 'psp-789',
              pspDisplayName: 'Invoice',
              pspIntegrationName: 'Ratepay - Invoice',
            },
          ],
        },
      }

      const result = service.extractCustomFields(sessionData)

      expect(result).toEqual({
        'briqpay-transaction-data-reservation-id': 'res-123',
        'briqpay-transaction-data-secondary-reservation-id': 'sec-res-456',
        'briqpay-transaction-data-psp-id': 'psp-789',
        'briqpay-transaction-data-psp-display-name': 'Invoice',
        'briqpay-transaction-data-psp-integration-name': 'Ratepay - Invoice',
      })
    })

    test('should extract combined PSP metadata and transaction data', () => {
      const sessionData = {
        sessionId: 'test-session',
        data: {
          pspMetadata: {
            description: 'KA0376778N1',
          },
          transactions: [
            {
              reservationId: '17-20251205240773668',
              secondaryReservationId: 'RIUS.U091.8WHW.1MT6',
              pspId: '14ff2352-2b48-411d-801e-cb8bbea56bf4',
              pspDisplayName: 'Invoice',
              pspIntegrationName: 'Ratepay - Invoice',
            },
          ],
        },
      }

      const result = service.extractCustomFields(sessionData)

      expect(result).toEqual({
        'briqpay-psp-meta-data-description': 'KA0376778N1',
        'briqpay-transaction-data-reservation-id': '17-20251205240773668',
        'briqpay-transaction-data-secondary-reservation-id': 'RIUS.U091.8WHW.1MT6',
        'briqpay-transaction-data-psp-id': '14ff2352-2b48-411d-801e-cb8bbea56bf4',
        'briqpay-transaction-data-psp-display-name': 'Invoice',
        'briqpay-transaction-data-psp-integration-name': 'Ratepay - Invoice',
      })
    })

    test('should return empty object when no data is present', () => {
      const sessionData = {
        sessionId: 'test-session',
      }

      const result = service.extractCustomFields(sessionData)

      expect(result).toEqual({})
    })

    test('should skip undefined, null, and empty string values', () => {
      const sessionData = {
        sessionId: 'test-session',
        data: {
          pspMetadata: {
            description: 'Valid description',
            type: undefined,
            payerEmail: '',
          },
          transactions: [
            {
              reservationId: 'res-123',
              pspId: undefined,
            },
          ],
        },
      }

      const result = service.extractCustomFields(sessionData)

      expect(result).toEqual({
        'briqpay-psp-meta-data-description': 'Valid description',
        'briqpay-transaction-data-reservation-id': 'res-123',
      })
      expect(result).not.toHaveProperty('briqpay-psp-meta-data-type')
      expect(result).not.toHaveProperty('briqpay-psp-meta-data-payer-email')
      expect(result).not.toHaveProperty('briqpay-transaction-data-psp-id')
    })

    test('should use first transaction when multiple transactions exist', () => {
      const sessionData = {
        sessionId: 'test-session',
        data: {
          transactions: [
            {
              reservationId: 'first-res',
              pspDisplayName: 'First PSP',
            },
            {
              reservationId: 'second-res',
              pspDisplayName: 'Second PSP',
            },
          ],
        },
      }

      const result = service.extractCustomFields(sessionData)

      expect(result['briqpay-transaction-data-reservation-id']).toBe('first-res')
      expect(result['briqpay-transaction-data-psp-display-name']).toBe('First PSP')
    })

    test('should handle empty transactions array', () => {
      const sessionData = {
        sessionId: 'test-session',
        data: {
          transactions: [],
        },
      }

      const result = service.extractCustomFields(sessionData)

      expect(result).toEqual({})
    })

    test('ignores unknown fields Briqpay may add to pspMetadata and transactions', () => {
      const sessionData = {
        sessionId: 'test-session',
        data: {
          pspMetadata: { description: 'desc', futurePspField: 'ignored' },
          transactions: [{ reservationId: 'res-123', futureTxField: 'ignored' }],
        },
      }

      const result = service.extractCustomFields(sessionData)

      expect(result).toEqual({
        'briqpay-psp-meta-data-description': 'desc',
        'briqpay-transaction-data-reservation-id': 'res-123',
      })
    })
  })

  describe('updateOrderCustomFields', () => {
    test('should update order with custom fields when order has existing custom type', async () => {
      const customFields: ExtractedBriqpayCustomFields = {
        'briqpay-psp-meta-data-description': 'Test description',
        'briqpay-transaction-data-reservation-id': 'res-123',
      }

      mockOrderGet.mockResolvedValueOnce({
        body: {
          id: 'order-123',
          version: 1,
          custom: { type: { id: 'type-id', key: 'briqpay-session-id' }, fields: {} },
        },
      })

      mockOrderPostExecute.mockResolvedValueOnce({
        body: { id: 'order-123', version: 2 },
      })

      await service.updateOrderCustomFields('order-123', customFields)

      expect(mockOrderPost).toHaveBeenCalledWith({
        body: {
          version: 1,
          actions: [
            {
              action: 'setCustomField',
              name: 'briqpay-psp-meta-data-description',
              value: 'Test description',
            },
            {
              action: 'setCustomField',
              name: 'briqpay-transaction-data-reservation-id',
              value: 'res-123',
            },
          ],
        },
      })
    })

    test('should set custom type first when order has no custom type', async () => {
      const customFields: ExtractedBriqpayCustomFields = {
        'briqpay-psp-meta-data-description': 'Test description',
      }

      mockOrderGet.mockResolvedValueOnce({
        body: {
          id: 'order-123',
          version: 1,
          custom: undefined,
        },
      })

      // First call sets the custom type
      mockOrderPostExecute.mockResolvedValueOnce({
        body: { id: 'order-123', version: 2 },
      })

      // Second call sets the custom fields
      mockOrderPostExecute.mockResolvedValueOnce({
        body: { id: 'order-123', version: 3 },
      })

      await service.updateOrderCustomFields('order-123', customFields)

      // Should have been called twice
      expect(mockOrderPost).toHaveBeenCalledTimes(2)

      // First call should set the custom type
      expect(mockOrderPost).toHaveBeenNthCalledWith(1, {
        body: {
          version: 1,
          actions: [
            {
              action: 'setCustomType',
              type: {
                key: 'briqpay-session-id',
                typeId: 'type',
              },
            },
          ],
        },
      })

      // Second call should set the custom fields
      expect(mockOrderPost).toHaveBeenNthCalledWith(2, {
        body: {
          version: 2,
          actions: [
            {
              action: 'setCustomField',
              name: 'briqpay-psp-meta-data-description',
              value: 'Test description',
            },
          ],
        },
      })
    })

    test('should not update when no custom fields to set', async () => {
      const customFields: ExtractedBriqpayCustomFields = {}

      await service.updateOrderCustomFields('order-123', customFields)

      expect(mockOrderGet).not.toHaveBeenCalled()
      expect(mockOrderPost).not.toHaveBeenCalled()
    })

    test('skips the write when every value already matches the resource fields', async () => {
      const customFields: ExtractedBriqpayCustomFields = {
        'briqpay-psp-meta-data-description': 'Test description',
        'briqpay-transaction-data-reservation-id': 'res-123',
      }

      // Resource already holds identical values - re-ingesting on every webhook must not POST,
      // otherwise each one bumps the version and spams order-changed messages.
      mockOrderGet.mockResolvedValueOnce({
        body: {
          id: 'order-123',
          version: 4,
          custom: {
            type: { id: 'type-id', key: 'briqpay-session-id' },
            fields: {
              'briqpay-psp-meta-data-description': 'Test description',
              'briqpay-transaction-data-reservation-id': 'res-123',
            },
          },
        },
      })

      await service.updateOrderCustomFields('order-123', customFields)

      expect(mockOrderPost).not.toHaveBeenCalled()
    })

    test('posts only the fields whose value changed', async () => {
      const customFields: ExtractedBriqpayCustomFields = {
        'briqpay-psp-meta-data-description': 'New description',
        'briqpay-transaction-data-reservation-id': 'res-123',
      }

      // reservation-id is unchanged, description differs - only the differing field is posted.
      mockOrderGet.mockResolvedValueOnce({
        body: {
          id: 'order-123',
          version: 4,
          custom: {
            type: { id: 'type-id', key: 'briqpay-session-id' },
            fields: {
              'briqpay-psp-meta-data-description': 'Old description',
              'briqpay-transaction-data-reservation-id': 'res-123',
            },
          },
        },
      })

      mockOrderPostExecute.mockResolvedValueOnce({
        body: { id: 'order-123', version: 5 },
      })

      await service.updateOrderCustomFields('order-123', customFields)

      expect(mockOrderPost).toHaveBeenCalledTimes(1)
      expect(mockOrderPost).toHaveBeenCalledWith({
        body: {
          version: 4,
          actions: [
            {
              action: 'setCustomField',
              name: 'briqpay-psp-meta-data-description',
              value: 'New description',
            },
          ],
        },
      })
    })
  })

  describe('ingestSessionDataToOrder', () => {
    test('extracts fields from the payload session and updates the order', async () => {
      const session = {
        sessionId: 'session-123',
        htmlSnippet: '',
        data: {
          pspMetadata: { description: 'Test description' },
          transactions: [{ reservationId: 'res-123' }],
        },
      }

      mockOrderGet.mockResolvedValueOnce({
        body: {
          id: 'order-123',
          version: 1,
          custom: { type: { id: 'type-id', key: 'briqpay-session-id' }, fields: {} },
        },
      })

      mockOrderPostExecute.mockResolvedValueOnce({
        body: { id: 'order-123', version: 2 },
      })

      await service.ingestSessionDataToOrder(session, 'order-123')

      expect(mockOrderPost).toHaveBeenCalledWith({
        body: {
          version: 1,
          actions: expect.arrayContaining([
            {
              action: 'setCustomField',
              name: 'briqpay-psp-meta-data-description',
              value: 'Test description',
            },
            {
              action: 'setCustomField',
              name: 'briqpay-transaction-data-reservation-id',
              value: 'res-123',
            },
          ]),
        },
      })
    })

    test('propagates errors from the commercetools order update', async () => {
      const session = {
        sessionId: 'session-123',
        htmlSnippet: '',
        data: {
          pspMetadata: { description: 'Test description' },
          transactions: [{ reservationId: 'res-123' }],
        },
      }

      const serverError = Object.assign(new Error('Internal Server Error'), { statusCode: 500 })
      mockOrderGet.mockRejectedValueOnce(serverError)

      await expect(service.ingestSessionDataToOrder(session, 'order-123')).rejects.toBe(serverError)
    })

    test('drops fields not defined on the order custom type so the rest still write', async () => {
      // Session carries a field (psp-integration-name) the merchant type does NOT define -
      // the type mock only has session-id, psp-meta-data-description, reservation-id.
      const session = {
        sessionId: 'session-123',
        htmlSnippet: '',
        data: {
          transactions: [
            {
              reservationId: 'res-123',
              pspIntegrationName: 'Nuvei - Google Pay',
            },
          ],
        },
      }

      mockOrderGet.mockResolvedValueOnce({
        body: {
          id: 'order-123',
          version: 1,
          custom: { type: { id: 'type-id', key: 'briqpay-session-id' }, fields: {} },
        },
      })

      mockOrderPostExecute.mockResolvedValueOnce({ body: { id: 'order-123', version: 2 } })

      await service.ingestSessionDataToOrder(session, 'order-123')

      // The defined field is written; the undefined one is filtered out (not sent to CT),
      // so the whole POST is not rejected.
      const postedActions = mockOrderPost.mock.calls[0][0].body.actions
      expect(postedActions).toContainEqual({
        action: 'setCustomField',
        name: 'briqpay-transaction-data-reservation-id',
        value: 'res-123',
      })
      expect(postedActions).not.toContainEqual(
        expect.objectContaining({ name: 'briqpay-transaction-data-psp-integration-name' }),
      )
    })
  })

  describe('updateResourceCustomFields (cart target)', () => {
    const customFields: ExtractedBriqpayCustomFields = {
      'briqpay-psp-meta-data-description': 'Test description',
      'briqpay-transaction-data-reservation-id': 'res-123',
    }

    test('updates the cart fields when the cart already has the briqpay custom type', async () => {
      mockCartGet.mockResolvedValueOnce({
        body: { id: 'cart-1', version: 4, custom: { type: { id: 'type-id', key: 'briqpay-session-id' }, fields: {} } },
      })
      mockCartPostExecute.mockResolvedValueOnce({ body: { id: 'cart-1', version: 5 } })

      await service.updateResourceCustomFields({ resource: 'cart', id: 'cart-1' }, customFields)

      expect(mockCartPost).toHaveBeenCalledTimes(1)
      expect(mockCartPost).toHaveBeenCalledWith({
        body: {
          version: 4,
          actions: [
            { action: 'setCustomField', name: 'briqpay-psp-meta-data-description', value: 'Test description' },
            { action: 'setCustomField', name: 'briqpay-transaction-data-reservation-id', value: 'res-123' },
          ],
        },
      })
      // Cart target must never touch the order builder
      expect(mockOrderPost).not.toHaveBeenCalled()
    })

    test('sets the custom type first when the cart has none', async () => {
      mockCartGet.mockResolvedValueOnce({ body: { id: 'cart-1', version: 1, custom: undefined } })
      mockCartPostExecute
        .mockResolvedValueOnce({ body: { id: 'cart-1', version: 2 } })
        .mockResolvedValueOnce({ body: { id: 'cart-1', version: 3 } })

      await service.updateResourceCustomFields({ resource: 'cart', id: 'cart-1' }, customFields)

      expect(mockCartPost).toHaveBeenCalledTimes(2)
      expect(mockCartPost).toHaveBeenNthCalledWith(1, {
        body: {
          version: 1,
          actions: [{ action: 'setCustomType', type: { key: 'briqpay-session-id', typeId: 'type' } }],
        },
      })
      expect(mockCartPost).toHaveBeenNthCalledWith(2, {
        body: {
          version: 2,
          actions: [
            { action: 'setCustomField', name: 'briqpay-psp-meta-data-description', value: 'Test description' },
            { action: 'setCustomField', name: 'briqpay-transaction-data-reservation-id', value: 'res-123' },
          ],
        },
      })
    })

    test('writes the boolean briqpay-autocaptured value to the cart', async () => {
      mockCartGet.mockResolvedValueOnce({
        body: { id: 'cart-1', version: 1, custom: { type: { id: 'type-id', key: 'briqpay-session-id' }, fields: {} } },
      })
      mockCartPostExecute.mockResolvedValueOnce({ body: { id: 'cart-1', version: 2 } })

      await service.updateResourceCustomFields({ resource: 'cart', id: 'cart-1' }, { 'briqpay-autocaptured': true })

      expect(mockCartPost).toHaveBeenCalledWith({
        body: { version: 1, actions: [{ action: 'setCustomField', name: 'briqpay-autocaptured', value: true }] },
      })
    })

    test('treats a 404 (cart already ordered/deleted) as a benign no-op', async () => {
      const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 })
      mockCartGet.mockRejectedValueOnce(notFound)

      await expect(
        service.updateResourceCustomFields({ resource: 'cart', id: 'cart-1' }, customFields),
      ).resolves.toBeUndefined()

      expect(mockCartPost).not.toHaveBeenCalled()
    })

    test('treats a 400 InvalidOperation (cart already converted to an order) as a benign no-op', async () => {
      const invalidOp = Object.assign(new Error('InvalidOperation'), { statusCode: 400, code: 'InvalidOperation' })
      mockCartGet.mockResolvedValueOnce({
        body: { id: 'cart-1', version: 1, custom: { type: { id: 'type-id', key: 'briqpay-session-id' }, fields: {} } },
      })
      mockCartPostExecute.mockRejectedValueOnce(invalidOp)

      await expect(
        service.updateResourceCustomFields({ resource: 'cart', id: 'cart-1' }, customFields),
      ).resolves.toBeUndefined()
    })

    test('propagates a non-benign cart error (e.g. 500) instead of swallowing it', async () => {
      const serverError = Object.assign(new Error('Internal Server Error'), { statusCode: 500 })
      mockCartGet.mockRejectedValueOnce(serverError)

      await expect(service.updateResourceCustomFields({ resource: 'cart', id: 'cart-1' }, customFields)).rejects.toBe(
        serverError,
      )
    })

    test('retries on 409 and re-derives version and the custom-type branch each attempt', async () => {
      const conflict = Object.assign(new Error('Conflict'), { statusCode: 409 })

      // Attempt 1: cart has no custom type -> setCustomType post conflicts.
      // Attempt 2: a concurrent writer has set the type and bumped the version -> a single
      // setCustomField against the fresh version succeeds (no second setCustomType).
      mockCartGet
        .mockResolvedValueOnce({ body: { id: 'cart-1', version: 1, custom: undefined } })
        .mockResolvedValueOnce({
          body: {
            id: 'cart-1',
            version: 9,
            custom: { type: { id: 'type-id', key: 'briqpay-session-id' }, fields: {} },
          },
        })
      mockCartPostExecute.mockRejectedValueOnce(conflict).mockResolvedValueOnce({ body: { id: 'cart-1', version: 10 } })

      await service.updateResourceCustomFields({ resource: 'cart', id: 'cart-1' }, customFields)

      expect(mockCartPost).toHaveBeenCalledTimes(2)
      expect(mockCartPost).toHaveBeenNthCalledWith(2, {
        body: {
          version: 9,
          actions: [
            { action: 'setCustomField', name: 'briqpay-psp-meta-data-description', value: 'Test description' },
            { action: 'setCustomField', name: 'briqpay-transaction-data-reservation-id', value: 'res-123' },
          ],
        },
      })
    })
  })

  describe('ingestSessionDataToCart', () => {
    test('extracts fields from the payload session and stages them on the cart', async () => {
      const session = {
        sessionId: 'session-123',
        htmlSnippet: '',
        data: {
          pspMetadata: { description: 'Test description' },
          transactions: [{ reservationId: 'res-123' }],
        },
      }

      mockCartPostExecute.mockResolvedValueOnce({ body: { id: 'cart-123', version: 2 } })

      await service.ingestSessionDataToCart(session, 'cart-123')

      expect(mockCartPost).toHaveBeenCalledWith({
        body: {
          version: 1,
          actions: expect.arrayContaining([
            { action: 'setCustomField', name: 'briqpay-psp-meta-data-description', value: 'Test description' },
            { action: 'setCustomField', name: 'briqpay-transaction-data-reservation-id', value: 'res-123' },
          ]),
        },
      })
      expect(mockOrderPost).not.toHaveBeenCalled()
    })

    test('propagates errors from the commercetools cart update', async () => {
      const session = {
        sessionId: 'session-123',
        htmlSnippet: '',
        data: {
          pspMetadata: { description: 'Test description' },
          transactions: [{ reservationId: 'res-123' }],
        },
      }

      const serverError = Object.assign(new Error('Internal Server Error'), { statusCode: 500 })
      mockCartGet.mockRejectedValueOnce(serverError)

      await expect(service.ingestSessionDataToCart(session, 'cart-123')).rejects.toBe(serverError)
    })
  })
})
