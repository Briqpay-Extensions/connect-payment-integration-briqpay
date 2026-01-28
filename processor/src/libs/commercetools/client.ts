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
  'view_key_value_documents',
  'view_states',
  'view_product_selections',
  'view_attribute_groups',
  'view_shopping_lists',
  'view_shipping_methods',
  'manage_sessions',
  'manage_types',
  'manage_checkout_payment_intents',
  'view_categories',
  'manage_key_value_documents',
  'view_discount_codes',
  'view_products',
  'view_cart_discounts',
  'manage_payments',
  'view_stores',
  'manage_checkout_transactions',
  'view_tax_categories',
  'view_order_edits',
  'manage_checkout_sessions',
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
