import { appLogger, paymentSDK } from '../payment-sdk'
import { type Type, type TypeAddFieldDefinitionAction } from '@commercetools/platform-sdk'
import { type BriqpayFieldDefinition, briqpayFieldDefinitions } from '../custom-types/custom-types'

const apiClient = paymentSDK.ctAPI.client

function toFieldDefinition(field: BriqpayFieldDefinition) {
  return {
    name: field.name,
    label: { en: field.label },
    type: { name: 'String' as const },
    required: field.required,
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
  const response = await apiClient
    .types()
    .get({
      queryArgs: {
        where: `key="${key}" and resourceTypeIds contains "${resourceTypeId}"`,
        limit: 1,
      },
    })
    .execute()

  return (response.body.results[0] ?? null) as Type | null
}

async function createType(key: string): Promise<Type> {
  const response = await apiClient
    .types()
    .post({
      body: {
        key,
        name: {
          en: 'Briqpay Data',
        },
        resourceTypeIds: ['order'],
        fieldDefinitions: briqpayFieldDefinitions.map(toFieldDefinition),
      },
    })
    .execute()
  const customType = response.body

  if (!customType) {
    throw new Error(`Custom type with key ${key} was not created`)
  }

  return customType as Type
}

async function addMissingFieldDefinitions(customType: Type, missingFields: BriqpayFieldDefinition[]): Promise<Type> {
  if (missingFields.length === 0) {
    return customType
  }

  appLogger.info(
    { customTypeKey: customType.key, missingFields: missingFields.map((f) => f.name) },
    `Adding ${missingFields.length} missing field(s) on custom type with key ${customType.key}`,
  )

  const actions: TypeAddFieldDefinitionAction[] = missingFields.map((field) => ({
    action: 'addFieldDefinition',
    fieldDefinition: toFieldDefinition(field),
  }))

  const response = await apiClient
    .types()
    .withKey({ key: customType.key })
    .post({
      body: {
        version: customType.version,
        actions,
      },
    })
    .execute()

  const updatedCustomType = response.body

  if (!updatedCustomType) {
    throw new Error(`Custom type with key ${customType.key} is not updated`)
  }

  return updatedCustomType as Type
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
  const existingType = await findTypeByKeyAndResourceType(key, 'order')

  let type: Type
  if (existingType) {
    appLogger.info(
      { key, resourceTypeIds: existingType.resourceTypeIds },
      `Found existing custom type with key ${key} and 'order' resource type`,
    )
    type = await ensureFieldDefinitions(existingType)
  } else {
    appLogger.info({ key }, `No custom type found with key ${key} and 'order' resource type, creating new one`)
    type = await createType(key)
  }

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
