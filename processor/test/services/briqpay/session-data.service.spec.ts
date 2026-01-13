import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { BriqpaySessionDataService } from '../../../src/services/briqpay/session-data.service'
import {
  BriqpayFullSessionResponse,
  ExtractedBriqpayCustomFields,
} from '../../../src/services/types/briqpay-session-data.type'

// Mock apiRoot
const mockOrderGet = jest.fn<
  () => Promise<{
    body: { id: string; version: number; custom?: { type: { id: string }; fields: Record<string, unknown> } }
  }>
>()
const mockOrderPostExecute = jest.fn<() => Promise<{ body: { id: string; version: number } }>>()
const mockOrderPost = jest
  .fn<(args: { body: { version: number; actions: unknown[] } }) => { execute: typeof mockOrderPostExecute }>()
  .mockReturnValue({ execute: mockOrderPostExecute })
jest.mock('../../../src/libs/commercetools/api-root', () => ({
  apiRoot: {
    orders: () => ({
      withId: () => ({
        get: () => ({ execute: mockOrderGet }),
        post: mockOrderPost,
      }),
    }),
  },
}))

// Mock payment SDK
jest.mock('../../../src/payment-sdk', () => ({
  appLogger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}))

// Mock fetch globally
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>
global.fetch = mockFetch

describe('BriqpaySessionDataService', () => {
  let service: BriqpaySessionDataService

  // Store original env
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()

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

  describe('fetchFullSession', () => {
    test('should fetch session data successfully', async () => {
      const mockSessionData: BriqpayFullSessionResponse = {
        sessionId: 'test-session-id',
        status: 'completed',
        data: {
          pspMetadata: {
            description: 'Test description',
          },
          transactions: [
            {
              reservationId: 'res-123',
              pspId: 'psp-456',
            },
          ],
        },
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSessionData),
      } as Response)

      const result = await service.fetchFullSession('test-session-id')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://dev-api.briqpay.com/v3/session/test-session-id',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      )
      expect(result).toEqual(mockSessionData)
    })

    test('should throw error when API returns non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('Session not found'),
      } as Response)

      await expect(service.fetchFullSession('invalid-session')).rejects.toThrow(
        'Failed to fetch Briqpay session invalid-session: 404 Not Found',
      )
    })
  })

  describe('extractCustomFields', () => {
    test('should extract all available PSP metadata fields', () => {
      const sessionData: BriqpayFullSessionResponse = {
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
      const sessionData: BriqpayFullSessionResponse = {
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
      const sessionData: BriqpayFullSessionResponse = {
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
      const sessionData: BriqpayFullSessionResponse = {
        sessionId: 'test-session',
      }

      const result = service.extractCustomFields(sessionData)

      expect(result).toEqual({})
    })

    test('should skip undefined, null, and empty string values', () => {
      const sessionData: BriqpayFullSessionResponse = {
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
      const sessionData: BriqpayFullSessionResponse = {
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
      const sessionData: BriqpayFullSessionResponse = {
        sessionId: 'test-session',
        data: {
          transactions: [],
        },
      }

      const result = service.extractCustomFields(sessionData)

      expect(result).toEqual({})
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
          custom: { type: { id: 'type-id' }, fields: {} },
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
  })

  describe('ingestSessionDataToOrder', () => {
    test('should fetch session, extract fields, and update order', async () => {
      const mockSessionData: BriqpayFullSessionResponse = {
        sessionId: 'session-123',
        data: {
          pspMetadata: {
            description: 'Test description',
          },
          transactions: [
            {
              reservationId: 'res-123',
            },
          ],
        },
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSessionData),
      } as Response)

      mockOrderGet.mockResolvedValueOnce({
        body: {
          id: 'order-123',
          version: 1,
          custom: { type: { id: 'type-id' }, fields: {} },
        },
      })

      mockOrderPostExecute.mockResolvedValueOnce({
        body: { id: 'order-123', version: 2 },
      })

      await service.ingestSessionDataToOrder('session-123', 'order-123')

      expect(mockFetch).toHaveBeenCalledWith('https://dev-api.briqpay.com/v3/session/session-123', expect.any(Object))

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

    test('should propagate errors from fetchFullSession', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Server error'),
      } as Response)

      await expect(service.ingestSessionDataToOrder('session-123', 'order-123')).rejects.toThrow(
        'Failed to fetch Briqpay session session-123: 500 Internal Server Error',
      )
    })
  })
})
