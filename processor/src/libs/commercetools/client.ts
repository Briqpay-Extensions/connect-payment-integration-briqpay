import {
  type AuthMiddlewareOptions,
  ClientBuilder,
  type HttpMiddlewareOptions,
  type HttpUserAgentOptions,
} from '@commercetools/ts-client'
import { config } from '../../config/config'
import packageJSON from '../../../package.json'

const connectScopes = [
  'manage_orders',
  'manage_sessions',
  'manage_types',
  'manage_payments',
  'manage_checkout_transactions',
  'manage_checkout_payment_intents',
  'view_key_value_documents',
  'view_states',
  'view_types',
  'view_product_selections',
  'view_attribute_groups',
  'view_shopping_lists',
  'view_shipping_methods',
  'view_categories',
  'view_discount_codes',
  'view_products',
  'view_cart_discounts',
  'view_stores',
  'view_tax_categories',
  'view_order_edits',
  'view_sessions',
]

const authMiddlewareOptions: AuthMiddlewareOptions = {
  host: config.authUrl,
  projectKey: config.projectKey,
  credentials: {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  },
  scopes: connectScopes.map((scope) => `${scope}:${config.projectKey}`),
  httpClient: fetch,
}

const httpMiddlewareOptions: HttpMiddlewareOptions = {
  host: config.apiUrl,
  includeRequestInErrorResponse: true,
  includeOriginalRequest: true,
  httpClient: fetch,
}

const userAgentOptions: HttpUserAgentOptions = {
  libraryName: packageJSON.name,
  libraryVersion: packageJSON.version,
}

export const ctpClient = new ClientBuilder()
  .withProjectKey(config.projectKey)
  .withClientCredentialsFlow(authMiddlewareOptions)
  .withHttpMiddleware(httpMiddlewareOptions)
  .withUserAgentMiddleware(userAgentOptions)
  .withLoggerMiddleware()
  .build()
