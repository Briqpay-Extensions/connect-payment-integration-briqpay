import {
  type ByProjectKeyRequestBuilder,
  createApiBuilderFromCtpClient,
  type Type,
  type TypeAddFieldDefinitionAction,
} from '@commercetools/platform-sdk'
import { type BriqpayFieldDefinition, briqpayFieldDefinitions } from '../custom-types/custom-types'
import { createPostDeployClient, getProjectKey } from './post-deploy-client'
import { postDeployLogger } from './post-deploy-logger'

const logger = postDeployLogger

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

    logger.error(
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
 */
async function findTypeByKeyAndResourceType(
  apiRoot: ByProjectKeyRequestBuilder,
  key: string,
  resourceTypeId: string,
): Promise<Type | null> {
  logger.info(
    { key, resourceTypeId },
    `Searching for custom type with key "${key}" and resourceTypeId "${resourceTypeId}"`,
  )

  return withErrorLogging(
    async () => {
      const response = await apiRoot
        .types()
        .get({
          queryArgs: {
            where: `key="${key}" and resourceTypeIds contains "${resourceTypeId}"`,
            limit: 1,
          },
        })
        .execute()

      const foundType = response.body.results[0] ?? null

      if (foundType) {
        logger.info(
          { key, resourceTypeId, typeId: foundType.id, foundResourceTypeIds: foundType.resourceTypeIds },
          `Found custom type with id ${foundType.id} matching key "${key}" and resourceTypeId "${resourceTypeId}"`,
        )
      } else {
        logger.info(
          { key, resourceTypeId },
          `No custom type found with key "${key}" and resourceTypeId "${resourceTypeId}"`,
        )
      }

      return foundType as Type | null
    },
    { action: 'find type by key and resourceTypeId', key },
  )
}

async function createType(apiRoot: ByProjectKeyRequestBuilder, key: string): Promise<Type> {
  const fieldDefinitions = briqpayFieldDefinitions.map(toFieldDefinition)

  logger.info(
    { key, resourceTypeIds: ['order'], fieldCount: fieldDefinitions.length },
    `Creating new custom type with key "${key}" for resourceTypeId "order"`,
  )

  return withErrorLogging(
    async () => {
      const response = await apiRoot
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

      logger.info(
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
 */
async function addMissingFieldDefinitions(
  apiRoot: ByProjectKeyRequestBuilder,
  customType: Type,
  missingFields: BriqpayFieldDefinition[],
): Promise<Type> {
  if (missingFields.length === 0) {
    return customType
  }

  logger.info(
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
      const response = await apiRoot
        .types()
        .withId({ ID: customType.id })
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
 */
async function ensureFieldDefinitions(apiRoot: ByProjectKeyRequestBuilder, customType: Type): Promise<Type> {
  const existingFieldNames = new Set(customType.fieldDefinitions.map((f) => f.name))
  const missingFields = briqpayFieldDefinitions.filter((field) => !existingFieldNames.has(field.name))

  if (missingFields.length === 0) {
    logger.info(
      { key: customType.key, fieldCount: customType.fieldDefinitions.length },
      `Custom type with key ${customType.key} has all required fields`,
    )
    return customType
  }

  logger.info(
    { key: customType.key, missingFields: missingFields.map((f) => f.name) },
    `Custom type with key ${customType.key} is missing ${missingFields.length} field(s)`,
  )

  return addMissingFieldDefinitions(apiRoot, customType, missingFields)
}

/**
 * Creates or updates the Briqpay custom type for orders.
 *
 * This is a standalone version for post-deploy that doesn't depend on
 * the payment-sdk initialization (which requires Fastify request context).
 */
export async function createBriqpayCustomTypeForPostDeploy(key: string): Promise<Type> {
  logger.info({ key }, `Starting custom type creation/update for key "${key}"`)

  // Create a standalone client for post-deploy
  const client = createPostDeployClient()
  const projectKey = getProjectKey()
  const apiRoot = createApiBuilderFromCtpClient(client).withProjectKey({ projectKey })

  const existingType = await findTypeByKeyAndResourceType(apiRoot, key, 'order')

  let type: Type
  if (existingType) {
    logger.info(
      { key, resourceTypeIds: existingType.resourceTypeIds },
      `Found existing custom type with key ${key} and 'order' resource type`,
    )
    type = await ensureFieldDefinitions(apiRoot, existingType)
  } else {
    logger.info({ key }, `No custom type found with key ${key} and 'order' resource type, creating new one`)
    type = await createType(apiRoot, key)
  }

  logger.info(
    {
      version: type.version,
      key: type.key,
      fieldCount: type.fieldDefinitions.length,
    },
    `Custom type version ${type.version} with key ${type.key} exists with ${type.fieldDefinitions.length} Briqpay fields.`,
  )

  return type
}
