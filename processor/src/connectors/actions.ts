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

async function checkIfCustomTypeExistsByKey(key: string) {
  try {
    const response = await apiClient.types().withKey({ key }).head().execute()
    return response.statusCode === 200
  } catch {
    return false
  }
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

  return customType
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

  return updatedCustomType
}

export async function updateType(key: string): Promise<Type> {
  const response = await apiClient.types().withKey({ key }).get().execute()
  let customType = response.body

  if (!customType.resourceTypeIds.includes('order')) {
    appLogger.info({ key }, `Custom type with key ${key} does not have order resource type`)
    customType = await createType(key)
    return customType
  }

  const existingFieldNames = new Set(customType.fieldDefinitions.map((f) => f.name))
  const missingFields = briqpayFieldDefinitions.filter((field) => !existingFieldNames.has(field.name))

  if (missingFields.length > 0) {
    appLogger.info(
      { key, missingFields: missingFields.map((f) => f.name) },
      `Custom type with key ${key} is missing ${missingFields.length} field(s)`,
    )
    customType = await addMissingFieldDefinitions(customType, missingFields)
  }

  return customType
}

export async function createBriqpayCustomType(key: string): Promise<Type | undefined> {
  const briqpayCustomTypeExists = await checkIfCustomTypeExistsByKey(key)

  let type: Type | undefined
  if (briqpayCustomTypeExists) {
    appLogger.info({ key }, `Custom type with key ${key}`)
    type = await updateType(key)
  } else {
    appLogger.info({ key }, `Custom Type not found, creating with key ${key}`)
    type = await createType(key)
  }

  appLogger.info(
    {
      version: type!.version,
      key: type!.key,
      fieldCount: type!.fieldDefinitions.length,
    },
    `Custom type version ${type!.version} with key ${type!.key} exists with ${type!.fieldDefinitions.length} Briqpay fields.`,
  )

  return type
}
