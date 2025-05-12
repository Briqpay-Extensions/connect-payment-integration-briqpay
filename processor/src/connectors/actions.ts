import { briqpaySessionIdCustomType } from '../custom-types/custom-types'
import { appLogger, paymentSDK } from '../payment-sdk'

export async function createBriqpayCustomType(key: string): Promise<void> {
  const apiClient = paymentSDK.ctAPI.client

  try {
    // First check if the custom type already exists
    const getRes = await apiClient
      .types()
      .get({
        queryArgs: {
          where: `key="${key}"`,
        },
      })
      .execute()

    if (getRes.body.results.length > 0) {
      appLogger.info({ id: getRes.body.results[0].id }, 'Briqpay custom type already exists')
      return
    }

    // If it doesn't exist, create it
    const postRes = await apiClient
      .types()
      .post({
        body: {
          key,
          name: { en: 'Briqpay Session' },
          resourceTypeIds: ['line-item', 'shopping-list', 'order'],
          fieldDefinitions: [
            {
              type: { name: 'String' },
              name: briqpaySessionIdCustomType.name,
              label: { en: 'Session ID' },
              required: true,
            },
          ],
        },
      })
      .execute()

    appLogger.info({ id: postRes.body?.id }, 'Briqpay custom type created successfully')
  } catch (error) {
    appLogger.error({ error: (error as any)?.body || error }, 'Failed to create Briqpay custom type')
    throw error
  }
}

export async function storeProcessorUrl(key: string) {
  return paymentSDK.ctAPI.client
    .customObjects()
    .post({
      body: {
        container: 'briqpay-config',
        key,
        value: {
          url: process.env.CONNECT_SERVICE_URL,
        },
      },
    })
    .execute()
}
