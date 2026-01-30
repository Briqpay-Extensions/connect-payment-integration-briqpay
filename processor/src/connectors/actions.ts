import { appLogger, paymentSDK } from '../payment-sdk'
import { type FieldDefinition, type Type, type TypeAddFieldDefinitionAction } from '@commercetools/platform-sdk'
import {
  briqpayCustomTypeKey,
  type BriqpayFieldDefinition,
  briqpayFieldDefinitions,
} from '../custom-types/custom-types'

// Lazy getter for apiClient to avoid initialization issues in tests
function getApiClient() {
  return paymentSDK.ctAPI.client
}

// Cache for the resolved type key at runtime
let cachedBriqpayTypeKey: string | null = null

function toFieldDefinition(field: BriqpayFieldDefinition) {
  return {
    name: field.name,
    label: { en: field.label },
    type: { name: 'String' as const },
    required: field.required,
  }
}

/**
 * Wraps an async operation with proper error logging.
 * Logs the error with appLogger before re-throwing so it appears in CT dashboard.
 */
async function withErrorLogging<T>(
  operation: () => Promise<T>,
  context: { action: string; key?: string; typeId?: string },
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined

    appLogger.error(
      {
        ...context,
        error: errorMessage,
        stack: errorStack,
      },
      `Failed to ${context.action}: ${errorMessage}`,
    )

    throw error
  }
}

/**
 * Finds a custom type by key AND resourceTypeId.
 *
 * In commercetools, the unique identifier for a Type is the combination of `key` + `resourceTypeIds`,
 * NOT just the key alone. This means multiple types can exist with the same key but different
 * resourceTypeIds (e.g., one for 'order', another for 'shipping').
 *
 * Using `.withKey({ key })` would return ANY type with that key, which could be from another
 * connector that uses the same key for a different resource type.
 *
 * @param key - The custom type key to search for
 * @param resourceTypeId - The resource type that the custom type must be associated with
 * @returns The matching Type if found, null otherwise
 */
async function findTypeByKeyAndResourceType(key: string, resourceTypeId: string): Promise<Type | null> {
  appLogger.info(
    { key, resourceTypeId },
    `Searching for custom type with key "${key}" and resourceTypeId "${resourceTypeId}"`,
  )

  return withErrorLogging(
    async () => {
      const response = await getApiClient()
        .types()
        .get({
          queryArgs: {
            where: `key="${key}" and resourceTypeIds contains any ("${resourceTypeId}")`,
            limit: 1,
          },
        })
        .execute()

      const foundType = response.body.results[0] ?? null

      if (foundType) {
        appLogger.info(
          { key, resourceTypeId, typeId: foundType.id, foundResourceTypeIds: foundType.resourceTypeIds },
          `Found custom type with id ${foundType.id} matching key "${key}" and resourceTypeId "${resourceTypeId}"`,
        )
      } else {
        appLogger.info(
          { key, resourceTypeId },
          `No custom type found with key "${key}" and resourceTypeId "${resourceTypeId}"`,
        )
      }

      return foundType as Type | null
    },
    { action: 'find type by key and resourceTypeId', key },
  )
}

/**
 * Finds all custom types that use a specific resourceTypeId.
 *
 * @param resourceTypeId - The resource type to search for (e.g., 'order')
 * @returns Array of all types that have this resourceTypeId
 */
async function findAllTypesByResourceType(resourceTypeId: string): Promise<Type[]> {
  appLogger.info({ resourceTypeId }, `Searching for all custom types with resourceTypeId "${resourceTypeId}"`)

  return withErrorLogging(
    async () => {
      const response = await getApiClient()
        .types()
        .get({
          queryArgs: {
            where: `resourceTypeIds contains any ("${resourceTypeId}")`,
            // Get all results, not just one
            limit: 500, // Reasonable upper limit for number of types
          },
        })
        .execute()

      const foundTypes = response.body.results

      appLogger.info(
        {
          resourceTypeId,
          typeCount: foundTypes.length,
          types: foundTypes.map((t) => ({ key: t.key, id: t.id })),
        },
        `Found ${foundTypes.length} custom types with resourceTypeId "${resourceTypeId}"`,
      )

      return foundTypes as Type[]
    },
    { action: 'find all types by resourceTypeId', typeId: resourceTypeId },
  )
}

/**
 * Checks for field name conflicts and prefixes them if needed.
 *
 * This function handles three cases:
 * 1. Field doesn't exist → return as-is (will be added)
 * 2. Field exists AND is already a Briqpay field (starts with "briqpay-") → return as-is (already ours, will be skipped by filter)
 * 3. Field exists AND is NOT a Briqpay field → prefix with "briqpay-" (real conflict with another connector's field)
 *
 * @param fieldsToAdd - Briqpay fields we want to add
 * @param existingFields - Fields already in the target type
 * @returns Fields with real conflicts prefixed (e.g., 'session-id' -> 'briqpay-session-id')
 */
function resolveFieldConflicts(
  fieldsToAdd: BriqpayFieldDefinition[],
  existingFields: any[], // Using any here to avoid importing FieldDefinition from platform-sdk if not needed, but it's already imported
): BriqpayFieldDefinition[] {
  const existingFieldNames = new Set(existingFields.map((f) => f.name))

  return fieldsToAdd.map((field) => {
    if (existingFieldNames.has(field.name)) {
      // If the existing field already starts with "briqpay-", it's our field from a previous deployment
      // Don't prefix it - the subsequent filter will exclude it since it already exists
      if (field.name.startsWith('briqpay-')) {
        appLogger.info(
          { fieldName: field.name },
          `Field "${field.name}" already exists (Briqpay field from previous deployment), skipping`,
        )
        return field
      }

      // Real conflict: a non-Briqpay field with the same name exists
      appLogger.warn(
        { fieldName: field.name },
        `Field name conflict detected with non-Briqpay field. Prefixing "${field.name}" with "briqpay-"`,
      )
      return {
        ...field,
        name: `briqpay-${field.name}`,
      }
    }
    return field
  })
}

async function createType(key: string): Promise<Type> {
  const fieldDefinitions = briqpayFieldDefinitions.map(toFieldDefinition)

  appLogger.info(
    { key, resourceTypeIds: ['order'], fieldCount: fieldDefinitions.length },
    `Creating new custom type with key "${key}" for resourceTypeId "order"`,
  )

  return withErrorLogging(
    async () => {
      const response = await getApiClient()
        .types()
        .post({
          body: {
            key,
            name: {
              en: 'Briqpay Data',
            },
            resourceTypeIds: ['order'],
            fieldDefinitions,
          },
        })
        .execute()

      const customType = response.body

      if (!customType) {
        throw new Error(`Custom type with key ${key} was not created - empty response body`)
      }

      appLogger.info(
        { key, typeId: customType.id, version: customType.version },
        `Successfully created custom type with id ${customType.id} (key: ${key})`,
      )

      return customType as Type
    },
    { action: 'create custom type', key },
  )
}

/**
 * Adds missing field definitions to an existing custom type.
 *
 * IMPORTANT: Uses `.withId({ ID })` instead of `.withKey({ key })` because in commercetools,
 * the key alone is NOT unique - it's the combination of `key + resourceTypeIds` that makes
 * a type unique. Using `.withKey()` could accidentally update the wrong type if another
 * connector uses the same key for a different resource type.
 *
 * @param customType - The custom type to update (must have a valid id)
 * @param missingFields - The field definitions to add
 * @returns The updated custom type
 */
async function addMissingFieldDefinitions(customType: Type, missingFields: BriqpayFieldDefinition[]): Promise<Type> {
  if (missingFields.length === 0) {
    return customType
  }

  appLogger.info(
    {
      customTypeId: customType.id,
      customTypeKey: customType.key,
      resourceTypeIds: customType.resourceTypeIds,
      missingFields: missingFields.map((f) => f.name),
    },
    `Adding ${missingFields.length} missing field(s) on custom type with id ${customType.id} (key: ${customType.key})`,
  )

  const actions: TypeAddFieldDefinitionAction[] = missingFields.map((field) => ({
    action: 'addFieldDefinition',
    fieldDefinition: toFieldDefinition(field),
  }))

  return withErrorLogging(
    async () => {
      const response = await getApiClient()
        .types()
        .withId({ ID: customType.id }) // Use ID instead of key to avoid ambiguity
        .post({
          body: {
            version: customType.version,
            actions,
          },
        })
        .execute()

      const updatedCustomType = response.body

      if (!updatedCustomType) {
        throw new Error(`Custom type with id ${customType.id} (key: ${customType.key}) was not updated`)
      }

      return updatedCustomType as Type
    },
    { action: 'add field definitions', key: customType.key, typeId: customType.id },
  )
}

/**
 * Ensures that a custom type has all required field definitions.
 *
 * This function assumes the custom type already has the correct resourceTypeIds,
 * as that filtering should be done by `findTypeByKeyAndResourceType`.
 *
 * @param customType - The existing custom type to check and update
 * @returns The custom type (updated if fields were added)
 */
async function ensureFieldDefinitions(customType: Type): Promise<Type> {
  const existingFieldNames = new Set(customType.fieldDefinitions.map((f) => f.name))
  const missingFields = briqpayFieldDefinitions.filter((field) => !existingFieldNames.has(field.name))

  if (missingFields.length === 0) {
    appLogger.info(
      { key: customType.key, fieldCount: customType.fieldDefinitions.length },
      `Custom type with key ${customType.key} has all required fields`,
    )
    return customType
  }

  appLogger.info(
    { key: customType.key, missingFields: missingFields.map((f) => f.name) },
    `Custom type with key ${customType.key} is missing ${missingFields.length} field(s)`,
  )

  return addMissingFieldDefinitions(customType, missingFields)
}

/**
 * Creates or updates the Briqpay custom type for orders.
 *
 * This function handles the commercetools quirk where `key` alone is not unique -
 * it's the combination of `key + resourceTypeIds` that makes a type unique.
 *
 * The flow:
 * 1. Query for a type with the given key AND resourceTypeId='order'
 * 2. If found, ensure all required field definitions exist
 * 3. If not found, create a new type with the key and 'order' resourceTypeId
 *
 * This approach avoids conflicts with other connectors that may
 * use the same key for different resource types (e.g., 'shipping').
 *
 * @param key - The custom type key to use
 * @returns The created or updated custom type
 */
export async function createBriqpayCustomType(key: string): Promise<Type> {
  // 1. Check if Briqpay's own type exists
  const existingBriqpayType = await findTypeByKeyAndResourceType(key, 'order')

  if (existingBriqpayType) {
    appLogger.info(
      { key, resourceTypeIds: existingBriqpayType.resourceTypeIds },
      `Found existing Briqpay custom type with key ${key} and 'order' resource type`,
    )
    return ensureFieldDefinitions(existingBriqpayType)
  }

  // 2. If not, query for ALL types with resourceTypeId='order'
  const allOrderTypes = await findAllTypesByResourceType('order')

  if (allOrderTypes.length > 0) {
    // 3. Extend the first found type
    const targetType = allOrderTypes[0]
    appLogger.info(
      { targetTypeKey: targetType.key, targetTypeId: targetType.id },
      `Extending existing custom type "${targetType.key}" with Briqpay fields`,
    )

    // Resolve field conflicts before adding
    const fieldsToEnsure = resolveFieldConflicts(briqpayFieldDefinitions, targetType.fieldDefinitions)

    // We need to update ensureFieldDefinitions to accept dynamic fields or just use addMissingFieldDefinitions
    const existingFieldNames = new Set(targetType.fieldDefinitions.map((f) => f.name))
    const missingFields = fieldsToEnsure.filter((field) => !existingFieldNames.has(field.name))

    if (missingFields.length === 0) {
      appLogger.info(
        { key: targetType.key, fieldCount: targetType.fieldDefinitions.length },
        `Custom type with key ${targetType.key} already has all required Briqpay fields`,
      )
      return targetType
    }

    return addMissingFieldDefinitions(targetType, missingFields)
  }

  // 4. Fallback to creating Briqpay type if no existing types found
  appLogger.info({ key }, `No custom types found for "order" resource type, creating new Briqpay type "${key}"`)
  const type = await createType(key)

  appLogger.info(
    {
      version: type.version,
      key: type.key,
      fieldCount: type.fieldDefinitions.length,
    },
    `Custom type version ${type.version} with key ${type.key} exists with ${type.fieldDefinitions.length} Briqpay fields.`,
  )

  return type
}

/**
 * Gets the actual custom type key that contains Briqpay fields.
 *
 * This function is used at runtime to determine which type key to use when
 * setting custom types on carts/orders. Since Briqpay may have extended an
 * existing type (like ingrid-session) instead of creating its own type,
 * we need to find which type actually has the Briqpay fields.
 *
 * The result is cached to avoid repeated API calls.
 *
 * @returns The key of the type that contains Briqpay fields
 */
export async function getBriqpayTypeKey(): Promise<string> {
  // Return cached value if available
  if (cachedBriqpayTypeKey) {
    return cachedBriqpayTypeKey
  }

  const configuredKey = briqpayCustomTypeKey

  // 1. First check if the configured Briqpay type exists
  const briqpayType = await findTypeByKeyAndResourceType(configuredKey, 'order')

  if (briqpayType) {
    appLogger.info({ key: configuredKey }, `Found Briqpay custom type with configured key "${configuredKey}"`)
    cachedBriqpayTypeKey = configuredKey
    return cachedBriqpayTypeKey
  }

  // 2. If not, find any type with 'order' resourceTypeId that has Briqpay fields
  const allOrderTypes = await findAllTypesByResourceType('order')

  // The primary Briqpay field that must exist
  const primaryBriqpayFieldName = briqpayFieldDefinitions[0]?.name || 'briqpay-session-id'

  for (const orderType of allOrderTypes) {
    const hasBriqpayFields = orderType.fieldDefinitions.some(
      (field: FieldDefinition) => field.name === primaryBriqpayFieldName || field.name.startsWith('briqpay-'),
    )

    if (hasBriqpayFields) {
      appLogger.info(
        { foundKey: orderType.key, configuredKey },
        `Found Briqpay fields in custom type "${orderType.key}" (configured key was "${configuredKey}")`,
      )
      cachedBriqpayTypeKey = orderType.key
      return cachedBriqpayTypeKey
    }
  }

  // 3. Fallback to configured key (post-deploy should have created it)
  appLogger.warn(
    { configuredKey },
    `No custom type found with Briqpay fields, falling back to configured key "${configuredKey}"`,
  )
  cachedBriqpayTypeKey = configuredKey
  return cachedBriqpayTypeKey
}

/**
 * Clears the cached Briqpay type key.
 * Useful for testing or when the type configuration changes.
 */
export function clearBriqpayTypeKeyCache(): void {
  cachedBriqpayTypeKey = null
}
