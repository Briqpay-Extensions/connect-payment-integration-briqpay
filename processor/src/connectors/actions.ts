import { briqpaySessionIdCustomType } from '../custom-types/custom-types'
import { log } from '../libs/logger'
import { paymentSDK } from '../payment-sdk'

export async function createBriqpayCustomType(): Promise<void> {
  const apiClient = paymentSDK.ctAPI.client

  try {
    // First check if the custom type already exists
    const getRes = await apiClient
      .types()
      .get({
        queryArgs: {
          where: `key="${briqpaySessionIdCustomType.key}"`,
        },
      })
      .execute()

    if (getRes.body.results.length > 0) {
      log.info('Briqpay custom type already exists', getRes.body.results[0].id)
      return
    }

    // If it doesn't exist, create it
    const postRes = await apiClient
      .types()
      .post({
        body: {
          key: briqpaySessionIdCustomType.key,
          name: { en: 'Briqpay Session' },
          resourceTypeIds: ['line-item', 'shopping-list', 'order'],
          fieldDefinitions: [
            {
              type: { name: 'String' },
              name: briqpaySessionIdCustomType.briqpaySessionId,
              label: { en: 'Session ID' },
              required: true,
            },
          ],
        },
      })
      .execute()

    log.info('Briqpay custom type created successfully', postRes.body?.id)
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log.error('Failed to create Briqpay custom type', (error as any)?.body || error)
    throw error
  }
}

export async function storeProcessorUrl() {
  return paymentSDK.ctAPI.client
    .customObjects()
    .post({
      body: {
        container: 'briqpay-config',
        key: 'processor-url',
        value: {
          url: process.env.CONNECT_SERVICE_URL,
        },
      },
    })
    .execute()
}
