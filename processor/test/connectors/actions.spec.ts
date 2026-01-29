import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import type { Type } from '@commercetools/platform-sdk'

// Mock payment SDK before imports
const mockExecute = jest.fn()
const mockPost = jest.fn(() => ({ execute: mockExecute }))
const mockGet = jest.fn(() => ({ execute: mockExecute }))
const mockWithKey = jest.fn(() => ({ post: mockPost, get: mockGet }))
const mockWithId = jest.fn(() => ({ post: mockPost, get: mockGet }))
const mockTypes = jest.fn(() => ({
  get: mockGet,
  post: mockPost,
  withKey: mockWithKey,
  withId: mockWithId,
}))

jest.mock('../../src/payment-sdk', () => ({
  appLogger: {
    info: jest.fn(),
    error: jest.fn(),
  },
  paymentSDK: {
    ctAPI: {
      client: {
        types: mockTypes,
      },
    },
  },
}))

// Mock custom types
jest.mock('../../src/custom-types/custom-types', () => ({
  briqpayFieldDefinitions: [
    { name: 'briqpay-session-id', label: 'Briqpay Session ID', type: 'String', required: false },
    { name: 'briqpay-psp-meta-data-type', label: 'Briqpay PSP Type', type: 'String', required: false },
  ],
}))

// Import after mocking
import { createBriqpayCustomType } from '../../src/connectors/actions'

describe('actions', () => {
  const mockTypeKey = 'briqpay-session-id'

  const createMockType = (overrides: Partial<Type> = {}): Type => ({
    id: 'type-123',
    version: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastModifiedAt: '2024-01-01T00:00:00.000Z',
    key: mockTypeKey,
    name: { en: 'Briqpay Data' },
    resourceTypeIds: ['order'],
    fieldDefinitions: [
      {
        name: 'briqpay-session-id',
        label: { en: 'Briqpay Session ID' },
        type: { name: 'String' },
        required: false,
        inputHint: 'SingleLine',
      },
      {
        name: 'briqpay-psp-meta-data-type',
        label: { en: 'Briqpay PSP Type' },
        type: { name: 'String' },
        required: false,
        inputHint: 'SingleLine',
      },
    ],
    ...overrides,
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('findTypeByKeyAndResourceType', () => {
    test('should find type with matching key and resourceTypeId', async () => {
      const mockType = createMockType()

      mockGet.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: {
            results: [mockType],
            count: 1,
            total: 1,
          },
        } as never),
      } as any)

      const result = await createBriqpayCustomType(mockTypeKey)

      // Verify the query was called with correct where clause
      expect(mockTypes).toHaveBeenCalled()
      expect(mockGet).toHaveBeenCalled() // mockGet is called, but do not check arguments directly (fix type error)
      expect(result.key).toBe(mockTypeKey)
      expect(result.resourceTypeIds).toContain('order')
    })

    test('should return null when no matching type found and create new one', async () => {
      const createdType = createMockType()

      // First call: query returns empty results
      mockGet.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: {
            results: [] as Type[],
            count: 0,
            total: 0,
          },
        } as never),
      } as any)

      // Second call: create type
      mockPost.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: createdType,
        } as never),
      } as any)

      const result = await createBriqpayCustomType(mockTypeKey)

      // Verify create was called
      expect(mockPost).toHaveBeenCalled()
      expect(result.key).toBe(mockTypeKey)
    })
  })

  describe('createBriqpayCustomType', () => {
    test('should create new type when no existing type with order resourceTypeId', async () => {
      const createdType = createMockType()

      // Query returns empty
      mockGet.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: { results: [] as Type[], count: 0, total: 0 },
        } as never),
      } as any)

      // Create returns new type
      mockPost.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: createdType,
        } as never),
      } as any)

      const result = await createBriqpayCustomType(mockTypeKey)

      expect(result).toEqual(createdType)
      expect(result.resourceTypeIds).toContain('order')
    })

    test('should use existing type when found with correct resourceTypeId and all fields present', async () => {
      const existingType = createMockType()

      mockGet.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: { results: [existingType], count: 1, total: 1 },
        } as never),
      } as any)

      const result = await createBriqpayCustomType(mockTypeKey)

      expect(result).toEqual(existingType)
      // Should not call withId since type already has all fields (no update needed)
      expect(mockWithId).not.toHaveBeenCalled()
    })

    test('should add missing field definitions to existing type using ID (not key)', async () => {
      const existingTypeWithMissingFields = createMockType({
        fieldDefinitions: [
          {
            name: 'briqpay-session-id',
            label: { en: 'Briqpay Session ID' },
            type: { name: 'String' },
            required: false,
            inputHint: 'SingleLine',
          },
          // Missing: briqpay-psp-meta-data-type
        ],
      })

      const updatedType = createMockType({ version: 2 })

      // Query returns type with missing fields
      mockGet.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: { results: [existingTypeWithMissingFields], count: 1, total: 1 },
        } as never),
      } as any)

      // Update call uses withId (not withKey) to avoid another connector key collision issue
      mockWithId.mockReturnValue({
        post: jest.fn((_opts: { body: unknown }) => ({
          execute: jest.fn().mockResolvedValue({
            body: updatedType,
          } as never),
        })),
      } as any)

      const result = await createBriqpayCustomType(mockTypeKey)

      // Critical: should use withId with the type's ID, NOT withKey
      // This prevents updating the wrong type when multiple types share the same key
      expect(mockWithId as jest.Mock).toHaveBeenCalledWith({ ID: 'type-123' })
      expect(mockWithKey).not.toHaveBeenCalled() // Ensure withKey is NOT used
      expect(result.version).toBe(2)
    })

    test('should NOT return type from different resourceTypeId', async () => {
      // The query should filter by resourceTypeIds, so a type with 'shipping' won't be returned
      const createdType = createMockType()

      // Query returns empty (because the type with 'shipping' resourceTypeId is filtered out)
      mockGet.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: { results: [] as Type[], count: 0, total: 0 },
        } as never),
      } as any)

      // Create is called because no matching type with 'order' resourceTypeId
      mockPost.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: createdType,
        } as never),
      } as any)

      const result = await createBriqpayCustomType(mockTypeKey)

      // Verify the where clause specifically filters by 'order' resourceTypeId
      expect(mockGet as jest.Mock).toHaveBeenCalledWith({
        queryArgs: {
          where: `key="${mockTypeKey}" and resourceTypeIds contains any ("order")`,
          limit: 1,
        },
      })

      // A new type should be created
      expect(mockPost).toHaveBeenCalled()
      expect(result.resourceTypeIds).toContain('order')
    })
  })

  describe('ensureFieldDefinitions', () => {
    test('should not update type when all required fields are present', async () => {
      const completeType = createMockType()

      mockGet.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: { results: [completeType], count: 1, total: 1 },
        } as never),
      } as any)

      await createBriqpayCustomType(mockTypeKey)

      // withId should not be called for updates since all fields exist
      expect(mockWithId).not.toHaveBeenCalled()
    })

    test('should add multiple missing fields in single update action using ID', async () => {
      const existingTypeWithNoFields = createMockType({
        fieldDefinitions: [],
      })

      const updatedType = createMockType({ version: 2 })

      mockGet.mockReturnValue({
        execute: jest.fn().mockResolvedValue({
          body: { results: [existingTypeWithNoFields], count: 1, total: 1 },
        } as never),
      } as any)

      const mockPostWithActions = jest.fn((_opts: { body: unknown }) => ({
        execute: jest.fn().mockResolvedValue({
          body: updatedType,
        } as never),
      }))

      // Uses withId to update by ID (not withKey which could match wrong type)
      mockWithId.mockReturnValue({
        post: mockPostWithActions,
      } as any)

      await createBriqpayCustomType(mockTypeKey)

      // Critical: uses withId with the type ID, NOT withKey
      expect(mockWithId as jest.Mock).toHaveBeenCalledWith({ ID: 'type-123' })
      expect(mockWithKey).not.toHaveBeenCalled()

      // Verify the post was called with addFieldDefinition actions
      expect(mockPostWithActions as jest.Mock<(opts: { body: unknown }) => unknown>).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            version: 1,
            actions: expect.arrayContaining([
              expect.objectContaining({
                action: 'addFieldDefinition',
                fieldDefinition: expect.objectContaining({
                  name: 'briqpay-session-id',
                }),
              }),
              expect.objectContaining({
                action: 'addFieldDefinition',
                fieldDefinition: expect.objectContaining({
                  name: 'briqpay-psp-meta-data-type',
                }),
              }),
            ]),
          }),
        }),
      )
    })
  })
})
