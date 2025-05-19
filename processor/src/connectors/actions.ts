import { briqpaySessionIdCustomType } from '../custom-types/custom-types'
import { appLogger, paymentSDK } from '../payment-sdk'
import { type Type } from '@commercetools/platform-sdk'

const apiClient = paymentSDK.ctAPI.client

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
          en: 'Briqpay Session ID',
        },
        resourceTypeIds: ['order'],
        fieldDefinitions: [
          {
            name: briqpaySessionIdCustomType.name,
            label: {
              en: 'Briqpay Session ID',
            },
            type: {
              name: 'String',
            },
            required: false,
          },
        ],
      },
    })
    .execute()
  const customType = response.body

  if (!customType) {
    throw new Error(`Custom type with key ${key} was not created`)
  }

  return customType
}

async function createFieldDefinitionOnType(customType: Type): Promise<Type> {
  appLogger.info(
    { customTypeKey: customType.key },
    `Creating briqpaySessionId field on custom type with key ${customType.key}`,
  )

  const response = await apiClient
    .types()
    .withKey({ key: customType.key })
    .post({
      body: {
        version: customType.version,
        actions: [
          {
            action: 'addFieldDefinition',
            fieldDefinition: {
              name: briqpaySessionIdCustomType.name,
              label: {
                en: 'Briqpay Session ID',
              },
              type: {
                name: 'String',
              },
              required: false,
            },
          },
        ],
      },
    })
    .execute()
  const updatedCustomType = response.body

  if (!updatedCustomType) {
    throw new Error(`Custom type with key ${customType.key} is not updated`)
  }

  return updatedCustomType
}

async function updateType(key: string): Promise<Type> {
  const response = await apiClient.types().withKey({ key }).get().execute()
  let customType = response.body

  const briqpaySessionId = customType.fieldDefinitions.find(
    ({ name }: { name: string }) => name === briqpaySessionIdCustomType.name,
  )

  if (!customType.resourceTypeIds.includes('order')) {
    appLogger.info({ key }, `Custom type with key ${key} does not have order resource type`)
    customType = await createType(key)
  }
  if (!briqpaySessionId) {
    appLogger.info({ key }, `Custom type with key ${key} does not have briqpaySessionId field`)
    customType = await createFieldDefinitionOnType(customType)
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
    },
    `Custom type version ${type!.version} with key ${type!.key} exists and has briqpaySessionId field set up.`,
  )

  return type
}
